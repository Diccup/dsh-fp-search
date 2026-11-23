/**
 * engines/baidu.js — 活卡 · order 6 · 形态=自定义 run（移动版 + parseBaiduMobile）
 *
 * 搬迁自 1.0.0 `ws-engines.js:327-340`（ENGINES.baidu），行为完整不变。
 *
 * ★ 2026-11-07 S9.53：百度改走**移动版**（维护方决定：「移动百度可用，桌面版那个更垃圾」）。
 *   桌面版给的 URL 全是壳链 /baidu.php?url=000000j0xnZgmfstW…（全是广告）⇒ 跨引擎
 *   URL 去重失效 + 摘要 100% 空 + 无原生名次 + 广告占 5/17。移动版 from=0 一次给全。
 *   ⚠️ 入口陷阱：m.baidu.com/s 会回 1,438 B「百度安全验证」；**只有 /from=0/s 能过**。
 *
 * · 移动 UA：不带它拿到的是整个桌面版页面（反爬会按 UA 分流）。
 * · headers 合并顺序**完整沿用参考实现**：`...(opts?.headers ?? {})` 在后 = 调用方可覆盖。
 * · parseBaiduMobile 是 baidu 专属解析器（产 _snippet_raw/_nativeRank/_srcid/tpl/srcid/
 *   site/rank 全套超集字段），随卡搬到本文件。
 *   ⚠️ 但 parseBaiduMobile 在 ws-engines.js 的**导出面**上（33 名之一，钉死项 8），
 *   所以 ws-engines.js 必须 `import { parseBaiduMobile } from './engines/baidu.js'` 再 re-export。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；只 import 叶子件 ../ws-text.js（无环）。
 */
import { stripTags, clip } from '../ws-text.js';

/** 只认 class="c-result result" —— 页面里 class="c-result-content" 是干扰项。 */
const BAIDU_BLOCK_RE = /<div[^>]*class="c-result result"[^>]*>/g;

/**
 * 剔哪些块类型 —— **精确黑名单，不做前缀一刀切**。
 * （1.0.0 实测踩过的坑：`med_` 前缀一刀切会把 `med_drugs_yd_san`、
 * `med_aigc_guru_san` 两条**真结果**也剔了 —— 查「布洛芬 禁忌」只剩 3 条就是它砍的。）
 */
const BAIDU_DROP_TPL = new Set([
    'recommend_list_san',      // 大家都在搜
    'vid_recommend',           // 视频推荐流（haokan/weibo/bilibili）
    'med_mall_recommend_san',  // 医药商城带货
    'med_wenzhen_san',         // 在线问诊入口
]);

/** 前缀剔除：只剔能证明是百度自建营销/挂号通道的族，不做 med_ 这种一刀切。 */
const BAIDU_DROP_TPL_PREFIX = ['fw_', 'gh_'];

/** 移动 UA：移动版百度按 UA 分流，不带它拿到的是桌面页（实测）。 */
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/** htmlToText = stripTags（1.0.0 ws-engines.js:141 完整等价）。 */
function htmlToText(html) { return stripTags(html); }

/**
 * 解析移动百度结果页。
 * @returns {Array} 已剔广告/推荐，**保持原生 order 升序**
 */
export function parseBaiduMobile(html, limit = 10) {
    const src = String(html ?? '');
    const starts = [];
    BAIDU_BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = BAIDU_BLOCK_RE.exec(src)) !== null) starts.push({ at: m.index, head: m[0] });
    if (starts.length === 0) return [];

    const items = [];
    for (let i = 0; i < starts.length; i++) {
        const { at, head } = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1].at : Math.min(at + 40000, src.length);
        const seg = src.slice(at, end);

        const attr = (k) => {
            // ★ 取值必须按"包裹引号内全部内容"抓，不能写 [^'"]*
            //   —— data-log 的值是单引号包的双引号 JSON（data-log='{"fm":"alop",…}'），
            //   [^'"]* 一遇 " 就停，只能抓到 "{"，继而 JSON.parse 全失败、mu 全空、0 条产出。
            const re = new RegExp(`\\b${k}=(['"])([\\s\\S]*?)\\1`);
            const r = head.match(re) ?? [];
            return r[2] ?? '';
        };
        const tpl = attr('tpl');
        const srcid = attr('srcid');
        // 块类型先筛：广告/推荐整块不要（省得后面还要解析它）
        if (tpl && (BAIDU_DROP_TPL.has(tpl) || BAIDU_DROP_TPL_PREFIX.some((p) => tpl.startsWith(p)))) continue;

        // data-log 是单引号包的 JSON，内含 mu（真链）与 order（原生名次）
        let mu = '';
        let order = Number(attr('order')) || 0;
        const dlog = attr('data-log');
        if (dlog) {
            try {
                const j = JSON.parse(dlog.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
                if (j.mu) mu = String(j.mu).replace(/&amp;/g, '&');
                if (Number.isFinite(Number(j.order)) && Number(j.order) > 0) order = Number(j.order);
            } catch { /* 坏 JSON 就靠属性兜底 */ }
        }
        // mu 空 = 无可用链接（note_lead / med_* 部分块如此）
        if (!mu) continue;

        // 标题：www_index/www_specific 用 <h3>；百科块（bk_polysemy）无 h3，退到正文首句
        const h3 = seg.match(/<h3[^>]*>([\s\S]{0,400}?)<\/h3>/);
        let title = h3 ? htmlToText(h3[1]) : '';
        // 摘要：先找 c-abstract，再退到去掉标题后的正文纯文本
        const abs = seg.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]{0,800}?)<\/div>/)
            ?? seg.match(/<span[^>]*class="[^"]*c-color-text[^"]*"[^>]*>([\s\S]{0,800}?)<\/span>/);
        let snippet = abs ? htmlToText(abs[1]) : '';
        if (!title || !snippet) {
            const plain = htmlToText(seg.replace(/<script[\s\S]*?<\/script>/gi, ' '));
            if (!title) title = plain.slice(0, 80);
            if (!snippet) snippet = (title && plain.startsWith(title) ? plain.slice(title.length) : plain).slice(0, 180);
        }
        title = clip(String(title).replace(/\s+/g, ' ').trim(), 120);
        // ★ 2026-11-07 S9.54：卡片层不裁 180（21 §四 L242/L250），全量留在这里，
        //   裁剪挪到 web-search.js 的交付渲染。
        snippet = String(snippet).replace(/\s+/g, ' ').trim();
        if (!title) continue;

        // 卡片字段（21 §四）：_rank 原生名次 / _srcid 块类型 / _snippet_raw 全量摘要 / site 主机名
        let site = '';
        try { site = new URL(mu).hostname.replace(/^www\./, ''); } catch { /* mu 非标准 URL 就留空 */ }
        items.push({ title, url: mu, snippet, _snippet_raw: snippet, tpl, srcid, _srcid: srcid || tpl, site, rank: order });
    }

    // 原生名次升序（推荐流 order=400 已在 tpl 层剔掉，这里只是保序）
    // ★ 这一步是唯一允许的排序：**按引擎自己的名次**，不是按我们的打分。
    items.sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
    return items.slice(0, Math.max(1, limit)).map(({ rank, ...rest }) => ({ ...rest, _rank: rank, _nativeRank: rank }));
}

export default {
    id: 'baidu',
    order: 6,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: MOBILE_UA,
    headers: null,
    run: async (query, limit, ctx) => {
        /**
         * ★ 2026-11-21 分页（维护方定：baidu 翻 **2 页**，与 bing 同理）。
         *   病因：单页实测 1~5 条 —— 一页原始 10 条，经"大家都在搜/视频流"广告剔除
         *        和 mu 空块丢弃后只剩 1~5 条，配额要给 6 席根本拿不出来。
         *   打法：**顺序取 2 页**（pn=0 / pn=10），页间留 PAGE_GAP_MS。
         *        · 顺序不并行：m.baidu.com 对并发请求敏感，并行更易回安全验证。
         *        · 页间隔 300ms：曾疑"太快触发风控"，但 2026-11-21 实测证伪 ——
         *          真因是聚合路径 `allowBridge:false` 让第一发验证页直接失败（已由
         *          web-search.js 的 BRIDGE_ENGINES 修）。开桥后 300ms 足够。
         *        · 够数就停：第 1 页已凑够 limit 就不再打第 2 页。
         *        · 第 2 页失败不影响第 1 页结果 —— 翻页是增强，不是前置。
         *   ⚠️ 入口陷阱照旧：只有 /from=0/s 能过，直接 m.baidu.com/s 会回"百度安全验证"。
         */
        const PAGE_GAP_MS = 300;
        const PAGES = 2;
        const want = Math.max(1, Math.floor(limit));
        const collected = [];
        const seen = new Set();
        let firstPageErr = null;

        for (let page = 0; page < PAGES; page++) {
            if (collected.length >= want) break;
            if (page > 0) await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
            const pn = page * 10;   // baidu 的 pn 是 0-based 偏移

            try {
                const text = await ctx.load(
                    `https://m.baidu.com/from=0/s?word=${encodeURIComponent(query)}&pn=${pn}`,
                    'baidu',
                    {
                        ...ctx.opts,
                        headers: {
                            // 移动 UA：不带它拿到的是整个桌面版页面（反爬会按 UA 分流）
                            'user-agent': MOBILE_UA,
                            'accept-language': 'zh-CN,zh;q=0.9',
                            ...(ctx.opts?.headers ?? {}),
                        },
                    },
                );
                const items = parseBaiduMobile(text, want);
                for (const it of items) {
                    const k = String(it?.url ?? '');
                    if (!k || seen.has(k)) continue;
                    seen.add(k);
                    collected.push(it);
                }
            } catch (err) {
                if (page === 0) { firstPageErr = err; break; }  // 第 1 页失败 = 这家没结果
                /* 第 2 页失败：静默，用已有结果 */
            }
        }

        if (firstPageErr) throw firstPageErr;
        return collected.slice(0, want);
    },
    trash: null,
};
