/**
 * engines/bing.js — 活卡 · order 1 · 形态=自定义 run（RSS 优先 + HTML 兜底）
 *
 * 搬迁自 1.0.0 `ws-engines.js:262-277`（ENGINES.bing），行为完整不变。
 * · 冻结 parser：parseBing / parseBingRss 留 ws-engines.js 公共件（S55 冻结面），
 *   本卡经 ctx 取（ctx.parseBing / ctx.parseBingRss）—— 02 钉死项 4。
 * · `opts.lang ?? 'zh-CN'`：ctx.opts = 调度层传下来的运行参数，与 1.0.0 run 第三参同物。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；本卡无自 import 需求。
 *
 * ★ ITERATION-013 新增：**结果相关性复核**（`relevanceGuard`）。
 *
 * 病因（实测）：bing 对长中文查询会退化成"按首字检索"。查
 *   「微信小程序 支付 回调 验签」返回 10 条全是「微」字条目
 *   （百度百科"微"/汉典"微"/微博/微信官网），**10 条全都只覆盖查询的 9–18%**。
 *   若不放行，这 10 条会占据 bing 的 P0 配额（bing 是 tier 0 主力），
 *   把 keenable/exa 给出的微信支付官方文档压到交付后半段。
 *
 * 判据（用 9 个查询实测标定，**误伤为零**）：
 *   覆盖度 = max(查询汉字在结果中的命中率, 查询英文词在结果中的命中率)
 *   · 正常查询：8/9 的结果覆盖率 ≥50%（多数 100%）；
 *   · 退化查询：10/10 结果全部 <40%。
 *   ⇒ 阈值取 **0.4**，落在两簇之间的巨大空档里。
 *   ★ 只在**整批结果都不合格**时才判定"bing 退化了"，不做逐条裁剪——
 *     逐条裁会误伤正常查询里覆盖率偏低的合法结果（如 react hooks 有 50% 的条目）。
 */
/**
 * 覆盖度：查询的汉字集/英文词集，在结果的 title+snippet 里被覆盖的比例（取两者较大值）。
 * 纯中文、纯英文、中英混排三种查询都能算。
 */
function coverageOf(query, item) {
    const text = `${item?.title ?? ''} ${item?.snippet ?? ''}`;
    const qCjk = [...new Set(String(query).match(/[\u4e00-\u9fff]/g) ?? [])];
    const qWord = [...new Set(String(query).toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length >= 2);
    const tCjk = new Set(text.match(/[\u4e00-\u9fff]/g) ?? []);
    const tWord = new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const cjkRate = qCjk.length ? qCjk.filter((c) => tCjk.has(c)).length / qCjk.length : 0;
    const wordRate = qWord.length ? qWord.filter((w) => tWord.has(w)).length / qWord.length : 0;
    return Math.max(cjkRate, wordRate);
}

/** 相关性阈值：实测正常结果 ≥50%、退化结果 <40%，取 0.4 落在空档里。 */
const RELEVANCE_MIN = 0.4;

/**
 * 整批相关性判定：**全部**条目都低于阈值 ⇒ 认定 bing 退化成"按首字检索"。
 * 只要有一条达标就原样放行（正常查询里总有个别覆盖率偏低的合法结果，不能逐条裁）。
 */
function degraded(query, items) {
    if (!Array.isArray(items) || items.length === 0) return false;
    return items.every((it) => coverageOf(query, it) < RELEVANCE_MIN);
}

export default {
    id: 'bing',
    order: 1,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    run: async (query, limit, ctx) => {
        const enc = encodeURIComponent(query);
        const lang = ctx.opts.lang ?? 'zh-CN';
        // RSS first: machine-readable, stable, 18x smaller. Fall back to HTML.
        try {
            const rssUrl = `https://www.bing.com/search?q=${enc}&format=rss&count=${limit + 2}&setlang=${lang}`;
            const rssText = await ctx.load(rssUrl, 'bing', ctx.opts);
            const items = ctx.parseBingRss(rssText, limit);
            // ★ 退化判定：RSS 给的全是无关联结果时，不直接交出去，改试 HTML 兜底
            if (items.length > 0 && !degraded(query, items)) return items;
        } catch { /* RSS blocked/failed — try HTML */ }
        const htmlUrl = `https://www.bing.com/search?q=${enc}&count=${limit + 2}&setlang=${lang}`;
        const html = await ctx.load(htmlUrl, 'bing', ctx.opts);
        const htmlItems = ctx.parseBing(html, limit);
        // ★ HTML 也退化 ⇒ 抛 empty，让上层按"这家没结果"处理，
        //   而不是把一堆「微」字百科当成 P0 主力结果压过其他引擎的正确答案。
        if (degraded(query, htmlItems)) {
            throw ctx.failure('bing', 'empty', `all ${htmlItems.length} results off-topic (coverage < ${RELEVANCE_MIN}); bing likely degraded to single-char matching`);
        }
        return htmlItems;
    },
    trash: null,
};
