/**
 * ws-engines.js — lane A · SEARCH engine table + parsers.
 *
 * Why this file exists: the母本 web-search.js carried both the shell (search/page/doctor)
 * and the engines. Splitting them lets the shell stay thin and each engine be
 * independently testable ("坏哪个修哪个"). Network goes ONLY through opts.getHtml
 * (契约 §1): the shell injects it, lane A never calls fetch/child_process directly.
 *
 * Why parseBing is byte-identical to the母本: S55 locks it — the vendored self-test
 * feeds a HTML fixture and expects exactly 3 items. Any drift breaks the release gate.
 *
 * Why the filter pipeline lives here: the owner wants garbage filtered at search time,
 * before results enter context. It is pure rules (no key, no dependency), so it costs
 * zero常驻 token — only the description line in the shell matters for context budget.
 *
 * ESM only, Node >= 22.19 APIs, zero absolute paths, zero host SDK imports.
 */

import { stripTags, clip, normalize, failure } from './ws-text.js';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 移动 UA：移动版百度按 UA 分流，不带它拿到的是桌面页（实测）。 */
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// ===== S3 拆表（N8 批次 1）：移动百度段（原 :26-139）整段搬 engines/baidu.js =====
// parseBaiduMobile 仍在 33 名导出面上（02 v1.3 钉死项 8）⇒ 从卡 re-export。
export { parseBaiduMobile } from './engines/baidu.js';

function htmlToText(html) { return stripTags(html); }

function absolutize(base, href) {
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    try { return new URL(href, base).href; } catch { return href; }
}

/** Fetch via injected getHtml and interpret the contract envelope (契约 §1, §4). */
async function load(url, scope, opts) {
    const res = await opts.getHtml(url, { engineHint: scope, ...opts });
    if (res?.blocked) throw failure(scope, 'blocked', `challenge shell: ${res.blocked}`);
    if (res?.ok === false)
        throw failure(scope, res?.status ? res.status : 'unavailable', res?.diagnosis || 'getHtml failed');
    if (res?.status !== 200) throw failure(scope, res.status, `http ${res.status}`);
    return res.text ?? '';
}

// ===== Parsers =====

/** Bing result page. Byte-identical to母本 — S55 locks it. */
export function parseBing(html, limit = 6) {
    const blocks = String(html ?? '').match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
    const items = blocks.map((block) => {
        const href = (block.match(/<h2[^>]*>[\s\S]*?href="(https?:\/\/[^"]+)"/)
            ?? block.match(/href="(https?:\/\/[^"]+)"/)
            ?? [])[1] ?? '';
        const title = (block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) ?? [])[1] ?? '';
        const snippet = (block.match(/<p[^>]*>([\s\S]*?)<\/p>/) ?? [])[1]
            ?? (block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/) ?? [])[1] ?? '';
        return { title, url: href, snippet };
    });
    return normalize(items, limit);
}

/** DuckDuckGo HTML endpoint. Byte-identical to母本. */
export function parseDdg(html, limit = 6) {
    const blocks = String(html ?? '').match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g)
        ?? String(html ?? '').match(/<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result-snippet"[^>]*>([\s\S]*?)<\/td>)?/g)
        ?? [];
    const items = blocks.map((block) => {
        const link = block.match(/href="([^"]+)"/) ?? [];
        const href = decodeURIComponent((link[1] ?? '').replace(/^\/l\/\?uddg=/, '').split('&')[0]);
        const title = (block.match(/href="[^"]+"[^>]*>([\s\S]*?)<\/a>/) ?? [])[1] ?? '';
        const snippet = (block.match(/class="result(?:__snippet|-snippet)"[^>]*>([\s\S]*?)<\/(?:a|td)>/) ?? [])[1] ?? '';
        return { title, url: href, snippet };
    });
    return normalize(items, limit);
}

/** Bing RSS: machine-readable, stable, ~18x smaller than HTML. Zero dependencies. */
export function parseBingRss(xml, limit = 6) {
    const blocks = String(xml ?? '').match(/<item>[\s\S]*?<\/item>/g) ?? [];
    const items = blocks.map((block) => {
        const title = (block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '';
        const link = (block.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? '';
        const desc = (block.match(/<description>([\s\S]*?)<\/description>/) ?? [])[1] ?? '';
        return { title, url: link, snippet: desc };
    });
    return normalize(items, limit);
}

export function parseWikipedia(json, limit = 6) {
    const hits = JSON.parse(json)?.query?.search ?? [];
    return normalize(hits.map((hit) => ({
        title: hit.title,
        url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
        snippet: hit.snippet,
    })), limit);
}

export function parseGithub(json, limit = 6) {
    const hits = JSON.parse(json)?.items ?? [];
    return normalize(hits.map((hit) => ({
        title: `${hit.full_name} ★${hit.stargazers_count}`,
        url: hit.html_url,
        snippet: `${hit.description ?? ''} ${(hit.topics ?? []).join(' ')}`,
    })), limit);
}

export function parseNpm(json, limit = 6) {
    return normalize((JSON.parse(json)?.objects ?? []).map((entry) => {
        const pkg = entry?.package ?? {};
        return {
            title: `${pkg.name}@${pkg.version} ●${Math.round((entry.score?.final ?? 0) * 100)}`,
            url: pkg.links?.npm ?? `https://www.npmjs.com/package/${pkg.name ?? ''}`,
            snippet: pkg.description ?? '',
        };
    }), limit);
}

// ===== Generic adapters =====

/** Build an HTML→Item parser from regex rules. Used by sogou/so360/etc. */
export function htmlItems(rules) {
    const { blockRe, titleRe, urlRe, snippetRe } = rules;
    return function parse(html, limit = 6) {
        const blocks = String(html ?? '').match(blockRe) ?? [];
        const items = blocks.map((block) => {
            const title = (block.match(titleRe) ?? [])[1] ?? '';
            const url = (block.match(urlRe) ?? [])[1] ?? '';
            const snippet = (block.match(snippetRe) ?? [])[1] ?? '';
            return { title, url, snippet };
        });
        return normalize(items, limit);
    };
}

/** One engine adapter: URL builder + parser → {run} shape. */
function engine(id, urlFor, parse) {
    return {
        run: async (query, limit, opts) => {
            const text = await load(urlFor(query, limit), id, opts);
            return parse(text, limit);
        },
    };
}

// ===== Engines（S3 拆表：一家一卡，静态 import 列表，禁 TLA ⇒ 禁目录扫描，S4 换）=====
// 卡片契约 = 02 定稿 v1.3；order 值 = 07-基线-引擎顺序.txt 表序（禁止按盘点表 # 赋值）。
// 键序是对外文本（renderAggregate 头行 engines: + doctor 行序）⇒ 顺序完整不变 = 行为不变。
import cardBing from './engines/bing.js';
import cardGithub from './engines/github.js';
import cardNpm from './engines/npm.js';
import cardSogou from './engines/sogou.js';
import cardSo360 from './engines/so360.js';
import cardBaidu from './engines/baidu.js';
import cardSogouWechat from './engines/sogou_wechat.js';
import cardBilibili from './engines/bilibili.js';
import cardHackernews from './engines/hackernews.js';
import cardStackoverflow from './engines/stackoverflow.js';
import cardDouban from './engines/douban.js';
import cardMso from './engines/mso.js';
import cardArxiv from './engines/arxiv.js';
import cardCrossref from './engines/crossref.js';
import cardPubmed from './engines/pubmed.js';
import cardNvd from './engines/nvd.js';
import cardPypi from './engines/pypi.js';
// ★ ITERATION-012：API 通道卡接入。判据 = **接入后当下真能用、且没有已证实的配额枯竭**。
//   收：exa（12/12 连测绿、无限流头）、keenable（15/15 连测绿、1000/窗口额度）——
//       两家在 ITERATION-011/012 两轮共 ~40 次调用里零失败。
//   不收（各自实测死因，见 ITERATION-011 / 012）：
//   · firecrawl —— 免 key 额度耗尽，retry-after≈23.7h（已移 engines-offline/）
//   · tinyfish  —— 仅 50 次/网络/天（已移 engines-offline/）
//   · anysearch —— **日免费额度耗尽**：402 `daily_free_quota_exhausted`，
//                  要求改用自动下发的 api_key（已移 engines-offline/）
//   · parallel  —— 免费层 429，`retry-after` ≈ 1 小时（已移 engines-offline/）
//   ★ 教训：这三家早先"冒烟/连打全绿"，但都是**有限配额**，跑量即枯竭。
//     判据必须看响应头（x-ratelimit-*/retry-after）与 body 的 error_code，不能只看 200。
import cardKeenable from './engines/keenable.js';
import cardExa from './engines/exa.js';
// ★ ITERATION-012 新建三张（中文技术 / Rust 生态，补 FP 空白）：
//   juejin 中文技术社区、sov2ex V2EX 全文检索、crates Rust 包仓库。
import cardJuejin from './engines/juejin.js';
import cardSov2ex from './engines/sov2ex.js';
import cardCrates from './engines/crates.js';

const CARDS = [
    cardBing, cardGithub, cardNpm, cardSogou, cardSo360, cardBaidu, cardSogouWechat,
    cardBilibili, cardHackernews, cardStackoverflow, cardDouban, cardMso, cardArxiv,
    cardCrossref, cardPubmed, cardNvd, cardPypi,
    cardKeenable, cardExa,
    cardJuejin, cardSov2ex, cardCrates,
].sort((x, y) => x.order - y.order);

/** 卡片 ctx 注入面（02 v1.3 钉死项 2/4/6）：公共件 + opts 原物。 */
function makeEngineCtx(opts) {
    return {
        load, failure, normalize, htmlItems, htmlToText, stripTags, clip, absolutize,
        MOBILE_UA, parseBing, parseBingRss, parseGithub, parseNpm,
        opts,
    };
}

/** 声明式 parse 三类绑定（钉死项 4/5）：parseKey 公共件 / htmlRules→htmlItems / 内联 parse。 */
function bindParse(card) {
    if (typeof card.parse === 'function') return card.parse;
    if (card.parseKey) {
        const fn = { parseBing, parseBingRss, parseGithub, parseNpm }[card.parseKey];
        if (!fn) throw new Error(`engine card ${card.id}: unknown parseKey ${card.parseKey}`);
        return fn;
    }
    if (card.htmlRules) return htmlItems(card.htmlRules);
    throw new Error(`engine card ${card.id}: no parse form`);
}

function buildEngine(card) {
    if (typeof card.run === 'function') {
        return {
            run: async (query, limit, opts) => card.run(query, limit, makeEngineCtx(opts)),
        };
    }
    const parse = bindParse(card);
    return {
        run: async (query, limit, opts) => {
            const text = await load(card.url(query, limit), card.id, opts);
            return parse(text, limit, makeEngineCtx(opts));
        },
    };
}

export const ENGINES = {};
for (const card of CARDS) ENGINES[card.id] = buildEngine(card);
// netdisk 桩留公共层（规矩 7/C-4）：不进活目录卡、ENGINE_PROFILE 不含它；码与文案完整不变。
ENGINES.netdisk = {
    run: async () => { throw failure('netdisk', 'unavailable', 'netdisk channel reserved, not implemented'); },
};
// ===== 垃圾过滤管道 (抄 dsh-free-search domain_filter.js + url_norm.js 思路) =====

// 注：曾列 'zhihu.com/question'（本意滤知乎问题页），但过滤按 host 匹配、路径被切，
// 实际误伤整个 zhihu.com——知乎问题页是正当结果（2026-11-01 外部会话实测、维护方决定修），
// 移出默认表；确需路径级拦截时在 blockedDomains 显式传（路径规则语义见 isDomainBlocked）。
const DEFAULT_BLOCKED_DOMAINS = [
    'csdn.net', 'blog.csdn.net', 'wenku.baidu.com',
    'docin.com', 'doc88.com', 'renrendoc.com', 'book118.com',
];

export function normalizeDomainList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        let s = String(raw ?? '').trim().toLowerCase();
        if (!s) continue;
        s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
        s = s.split('#')[0].split('?')[0];   // 丢锚与 query；保留路径 → 支持路径级规则（host/path）
        s = s.replace(/^www\./, '').replace(/\.+$/, '');
        if (!s || s === '/') continue;
        const cut = s.indexOf('/');
        const host = cut >= 0 ? s.slice(0, cut) : s;
        const path = cut >= 0 ? s.slice(cut) : '';
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(host) || host.startsWith('.')) continue;
        const rule = path && path !== '/' ? host + path.replace(/\/+$/, '') : host;
        if (seen.has(rule)) continue;
        seen.add(rule);
        out.push(rule);
    }
    return out;
}

export function isDomainBlocked(url, blockedList = DEFAULT_BLOCKED_DOMAINS) {
    if (!blockedList || blockedList.length === 0) return false;
    let host, path = '';
    try {
        const u = new URL(String(url));
        host = u.hostname.toLowerCase().replace(/^www\./, '');
        path = u.pathname.replace(/\/+$/, '');
    } catch { return false; }
    if (!host) return false;
    return blockedList.some((raw) => {
        const rule = String(raw).toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
        if (!rule) return false;
        const cut = rule.indexOf('/');
        const rHost = cut >= 0 ? rule.slice(0, cut) : rule;
        const rPath = cut >= 0 ? rule.slice(cut) : '';
        const hostHit = host === rHost || host.endsWith('.' + rHost);
        if (!hostHit) return false;
        if (!rPath) return true;   // 纯域规则：整域拦截
        // 路径规则：仅拦该路径前缀（/q 精确或 /q/xxx，不误伤 /qxyz）
        return path === rPath || path.startsWith(rPath + '/');
    });
}

export function filterBlockedDomains(items, blockedList = DEFAULT_BLOCKED_DOMAINS) {
    if (!blockedList || blockedList.length === 0) return items;
    return items.filter((item) => !isDomainBlocked(item?.url, blockedList));
}

export function normalizeUrl(url) {
    try {
        const u = new URL(String(url));
        u.hash = '';
        const params = new URLSearchParams(u.search);
        const trackingKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'fbclid', 'gclid', 'ref', 'referrer', 'source', 'campaign', 'spm', 'from'];
        for (const key of trackingKeys) params.delete(key);
        for (const [key] of params) { if (key.startsWith('utm_')) params.delete(key); }
        u.search = params.toString();
        let path = u.pathname;
        if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
        return `${u.protocol}//${u.host}${path}${u.search ? '?' + u.search : ''}`;
    } catch { return String(url ?? ''); }
}

const MULTI_TLD = /\.(com|org|net|gov|edu|co)\.(cn|uk|jp|br|au|in|us)$/i;

export function getETLDPlusOne(host) {
    const h = String(host ?? '').toLowerCase().replace(/^www\./, '');
    const m = h.match(MULTI_TLD);
    if (m) {
        const parts = h.split('.');
        return parts.slice(-3).join('.');
    }
    const parts = h.split('.');
    return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}

export function sameSite(urlA, urlB) {
    try {
        return getETLDPlusOne(new URL(String(urlA)).hostname) === getETLDPlusOne(new URL(String(urlB)).hostname);
    } catch { return false; }
}

export function dedupeBySite(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const norm = normalizeUrl(item?.url);
        if (!norm) continue;
        const key = getETLDPlusOne(safeHost(norm));
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function safeHost(url) {
    try { return new URL(url).hostname; } catch { return ''; }
}

export function filterJunk(items, query = '') {
    const q = String(query ?? '').toLowerCase().trim();
    const out = [];
    for (const item of items) {
        const title = String(item?.title ?? '').trim();
        const snippet = String(item?.snippet ?? '').trim();
        const url = String(item?.url ?? '');
        // Drop empty titles
        if (!title) continue;
        // Drop pure encyclopedia definitions (short, starts with encyclopedia prefix)
        if (title.length < 40 && /^(是|指|定义为|即为|简称|百度百科|维基百科|搜狗百科|360百科|头条百科)/.test(title)) continue;
        // Drop homepage URLs where title doesn't contain the query
        try {
            const u = new URL(url);
            if ((u.pathname === '/' || u.pathname === '') && q && !title.toLowerCase().includes(q)) continue;
        } catch { /* keep */ }
        // Drop if snippet is empty and title is just a URL
        if (!snippet && title === url) continue;
        out.push(item);
    }
    return out;
}

export function filterPipeline(items, opts = {}) {
    if (opts.noFilter) return { items, dropped: 0 };
    const allow = normalizeDomainList(opts.allowDomains ?? []);
    const allowHit = (url) => {
        if (allow.length === 0) return false;
        let host;
        try { host = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
        return allow.some((a) => host === a || host.endsWith('.' + a));
    };
    const blocked = normalizeDomainList([...DEFAULT_BLOCKED_DOMAINS, ...(opts.blockedDomains ?? [])]);
    // allowDomains 豁免口：命中豁免域的条目跳过域名拦截（junk/去重照走）——为误伤规则留的放行闸（2026-11-01）
    let out = items.filter((it) => allowHit(it?.url) || !isDomainBlocked(it?.url, blocked));
    out = filterJunk(out, opts.query ?? '');
    // noSiteDedupe: 垂类单域 API 结果全同站，同站去重会把 N 条杀成 1 条（2026-10-31 外测修复；single 模式自适应传入）
    if (!opts.noSiteDedupe) out = dedupeBySite(out);
    return { items: out, dropped: items.length - out.length };
}

export function resolveOpts(opts = {}) {
    return {
        engines: Array.isArray(opts.engines) && opts.engines.length > 0 ? opts.engines : null,
        blockedDomains: Array.isArray(opts.blockedDomains) ? opts.blockedDomains : [],
        allowDomains: Array.isArray(opts.allowDomains) ? opts.allowDomains : [],
        lang: opts.lang ?? 'zh-CN',
        vertical: opts.vertical ?? null,
        limit: opts.limit ?? 40,
        noFilter: !!opts.noFilter,
    };
}

// ===== Relevance ranking (借鉴 CTX 库 cjk.js 的单字符切分做法) =====

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** Extract every CJK character from text (single chars, not bigrams). */
function cjkChars(text) {
    const out = [];
    for (const ch of String(text ?? '')) {
        if (CJK_RE.test(ch)) out.push(ch);
    }
    return out;
}

// ===== 分层交错排序（2026-11-07 S9.53，详见 Updating/21 §三）=====
//
// 为什么废掉 rankByRelevance：它按"字面重合度"重排，实测有三个结构性硬伤 ——
//   ① 摘要为空率：baidu 100% / stackoverflow 100% / crossref 100% / hackernews 70%。
//      公式 0.6×标题 + 0.4×摘要 ⇒ 摘要空的那半永远 0，百度上限只能到 0.600，
//      而 bing 拿满 1.000 —— 这是公式层面的结构性歧视，不是偏好问题。
//   ② 完全丢掉原生名次。各家返回顺序本来就是相关性排（百度 order=1..11、
//      bing 文档序、github best-match），旧代码只留 _engine 标签，名次扔了。
//   ③ 垂类靠数量碾压：github/npm/stackoverflow/arxiv/crossref/pubmed 各 30 条，
//      通用只有 bing 9 + baidu 16。实测"通用 9% vs 垂类 91%"，前 10 名被 bing(8)+github(2) 占满，
//      百度 16 条全落在第 74–222 名，一条都进不来。
//
// 新算法三层，核心是"引擎内保名次、引擎间分层交错、只按 URL 去重"。

// ===== 广告 / 推荐 清洗（2026-11-07 S9.53）=====
//
// 实测依据（6 查询 67 条，Temp/ads-measure.mjs）：桌面百度的结果 URL 只有两种形状 ——
//   /baidu.php?url=000000j0xnZgmfstW…   ← 推广通道，全部是广告
//   /link?url=…                          ← 自然结果
// 两类的区分是 100% 干净的（67/67 无例外），不需要猜标题措辞。
//
// 实测抓到的广告样本（都是 baidu.php，且都不是用户要的东西）：
//   DeepSeek      → 豆包工作模式升级 / 腾讯ima / 千问AI / 豆包 / qoder
//   量子计算      → 低温恒温器 / [重磅]量子计算报告PDF / 量子化学计算公司 / 8.5GHz离子阱
//   python asyncio→ 淘宝「的python学习」
//   布洛芬 禁忌    → 千问「AI养生」
//   企业所得税税率 → 美国公司纳税 / 企业所得税最新税率表完整版 / 百度教育题目 / 千问
//
// 为什么必须在"排序之前"做：分层交错会把每家第 1 名抬到前排。
// 实测 DeepSeek 上百度第 1 名是「豆包工作模式升级」广告 —— 先交错后去广告 = 把广告抬到第 2 名。

/** 百度推广通道：/baidu.php?url= 且 id 以大量 0 开头。 */
const BAIDU_AD_RE = /\/baidu\.php\?(?:[^#]*&)?url=0{6}/i;
/** 百度"相关推荐"聚合块（不是真实网页，进了就是一条空壳占位）。 */
const BAIDU_REC_RE = /的最新相关信息|相关搜索|大家都在搜|热搜榜/;

/** 单条判广告/推荐。返回剔除理由字符串，'' = 保留。 */
export function adReason(item) {
    const url = String(item?.url ?? '');
    const title = String(item?.title ?? '');
    if (!url) return 'no-url';
    if (BAIDU_AD_RE.test(url)) return 'baidu-ad';
    if (BAIDU_REC_RE.test(title)) return 'recommend';
    return '';
}

/**
 * 整批清洗：剔广告/推荐/无链接。
 * @returns {{items:Array, dropped:Array<{title:string,reason:string}>}}
 */
export function stripAds(items) {
    const kept = [];
    const dropped = [];
    for (const it of items ?? []) {
        const reason = adReason(it);
        if (reason) dropped.push({ title: String(it?.title ?? ''), reason });
        else kept.push(it);
    }
    return { items: kept, dropped };
}

/** 引擎静态声明：kind 通用/垂类，covers 覆盖的内容域（和查询无关）。 */
/**
 * 引擎画像：`kind` 决定分层（general→P0 / vertical→P1或P2），`covers` 决定它算不算"专业命中"。
 *
 * ★ 2026-11-07 N3 重写（维护方决定「可以对能用的引擎都调查一下」）。
 *
 * 旧表的问题：`covers` 是**凭引擎名字猜的**，不是按实际能返回什么内容定的。三处明显错：
 *   ① `github` 标 `security` —— 用"vulnerability"搜 GitHub 得到的是仓库/代码，不是漏洞库条目；
 *      真正给安全条目的是 nvd。GitHub 该是纯 `dev`（找代码/库）。
 *   ② `hackernews` 标 `security` —— HN 是技术社区，安全只是它的一个话题，不是它的领域；
 *      而它对普通技术查询（asyncio / k8s）出的是**讨论帖**，价值高，该算 `dev`。
 *   ③ `douban` / `mso` / `sogou_wechat` 标 `*` 却 kind=vertical —— `*` 在 `engineTier()` 里
 *      直接判 P1，等于"任何查询它都是专业命中"，把 P1 层塞满。
 *
 * 分层口径（`engineTier()` 的实际语义，勿误解）：
 *   - kind=general          → P0（先出牌），covers 写 `*` 表示"什么都能搜"
 *   - kind=vertical + `*`   → **P1**（无条件算专业命中）
 *   - kind=vertical + 具体域 → 该域命中才 P1，否则 P2（垫底但不清零）
 *
 * ⇒ `*` 只该给**通用型社区/聚合站**（它们真的什么话题都有），
 *   不该给"垂类但内容泛"的站。这次把 douban/mso/sogou_wechat 的 `*` 改成实际域。
 */
// ★ S3 拆表：PROFILE 由 17 张活卡的 kind+covers **生成**（covers 单一出处=卡片，02 v1.3 钉死项 3）。
// netdisk 不进（进表 ⇒ engineTier 分支变 + rarity 多一行 = 行为变）。分层口径（engineTier 语义）：
//   kind=general → P0；vertical+['*'] → P1；vertical+具体域 covers 命中 classes → P1，否则 P2。
// 手抄表废止——N3 那三处 covers 勘误已固化进各卡的 covers 字段（08-卡盘点 对照）。
export const ENGINE_PROFILE = Object.fromEntries(
    CARDS.map((c) => [c.id, { kind: c.kind, covers: c.covers }])
);

/**
 * 查询分类关键词表（21 §3.3 实测 14/14 正确；主机投票法只得 10/14，已否决）。
 *
 * ★ 2026-11-07 N10：补英文技术词。原词表只认中文与少数英文，实测下列查询全部
 *   `classes=[]` 被判成「普通查询」，于是 nvd/pubmed/github 的专业配额永远发不出去：
 *     "vulnerability"  classes=[]   ← 安全类
 *     "exploit"        classes=[]   ← 安全类
 *     "malware"        classes=[]   ← 安全类
 *     "aspirin"        classes=[]   ← 医学类
 *   这正是 N1「按可用率算配额」失效的根因：配额分普通/专业两套，而普通/专业由本表定。
 *   ⇒ N10 是 N1 的第①步，不是独立小修。
 */
const QUERY_CLASS_RULES = [
    { cls: ['security', 'dev'], re: /CVE|CWE|漏洞|安全|渗透|提权|XSS|SQL注入|csrf|ransomware|vulnerabilit(?:y|ies)|exploits?|malware|malicious|backdoor|phishing|trojan|zero-?day|privilege escalation|threat actor|security advis\w*|advisory|\bCVE-\d{4}-\d+|log4j|log4shell|shellshock|heartbleed|struts2|spring4shell|eternalblue|ms17-010|dirty\s*pipe|logjam|poodle|Wanna\s*Cry|pythia/i }, // ★ P2（绑 P1 v3）：补漏洞/事件名一族；openssl/xz-utils 等通用产品名按两票令**不入**；minimax 复核修正 Wanna 前多空格致 WannaCry 不命中
    { cls: ['academic'], re: /论文|paper|文献|引用格式|GB\/T|\bdoi\b|期刊|arxiv|cited|citation|preprint|peer[- ]review|journal|conference\s+proceedings|h-?index|\babstract\b|bibliograph\w*|literature\s+review/i },
    { cls: ['medical'], re: /禁忌|布洛芬|药|临床|医学|症状|治疗|剂量|诊断|aspirin|ibuprofen|paracetamol|dosage?|contraindicat\w*|symptoms?|diagnos[ie]s|diagnostic|clinical|placebo|pharmacokinet\w*|adverse\s+(?:effect|reaction)|side\s+effect/i },
    { cls: ['dev'], re: /\b(?:api|sdk|npm|docker|k8s|kubernetes|git|rebase|hooks?|event\s*loop|generics?|泛型|编译|源码|代码|函数|编程|框架|部署|前后端|react|vue|python|javascript|node\.?js|rust|golang|java|sql|asyncio|typescript|webpack|vite|graphql|redis|postgres(?:ql)?|mysql|mongodb|nginx|linux|bash|regex|regexp|cookie|timezone|concurrency|thread\s*safe|memory\s*leak|segfault|stack\s*trace|exception|refactor\w*|middleware|runtime|compiler|interpreter|orm|cli|curl|jwt|oauth|cors|http\/2|grpc|websocket|regex)\b/i },
    // ★ N3：给 covers 里新出现的 media / review / news / zh 这四个域配词表，
    //   否则 douban / sogou_wechat 的 covers 永远命中不了，白写。
    { cls: ['media', 'review'], re: /电影|电视剧|豆瓣|评分|影评|书评|剧评|综艺|纪录片|动漫|动画|OST|原声|演员|导演|票房|口碑|好看吗|值得看|值不值得|\bimdb\b|rotten\s*tomatoes|movie|film|tv\s*series|review|rating/i },
    { cls: ['news', 'zh'], re: /新闻|资讯|报道|快讯|时事|今日|最新消息|发布会|公告|通报|\bnews\b|announc\w*|release\s+notes|changelog/i },
];

/** 查询 → 内容域分类。只决定引擎优先序，**不做准入**。 */
export function classifyQuery(query) {
    const q = String(query ?? '');
    const out = new Set();
    for (const { cls, re } of QUERY_CLASS_RULES) {
        if (re.test(q)) cls.forEach((c) => out.add(c));
    }
    return [...out];
}

/**
 * 查询形态二判（★ 2026-11-07 N1）。
 *
 * 为什么需要：`classifyQuery` 靠关键词表，总有漏网。而 crossref / npm 这两家的
 * 可用率是**双峰**不是偏低（qfmodel 实测 + spark-x2.6 独立复现）：
 *
 *   英文技术词串：crossref 8/10、npm 8/10   ← 高分
 *   中文日常查询：两家 0–2/10               ← 全灭
 *
 * ⇒ 只要查询**整体像英文技术词串**，即使 `classifyQuery` 判不出，也该走专业配额，
 *   否则这两家的正确配额永远发不出来。
 *
 * 判据（保守，宁可漏判不可误判——误判会让日常中文查询吃专业配额）：
 *   ① 不含 CJK 字符
 *   ② 词数 1–6
 *   ③ 至少一个词是 ASCII 技术形态（含 . - _ / 数字，或长度 ≥ 4 的纯字母）
 *   ④ 全部词都是 ASCII 可打印
 */
export function isTechTermQuery(query) {
    const q = String(query ?? '').trim();
    if (!q) return false;
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(q)) return false;   // ① 含中文就不算
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 6) return false;                  // ② 词数
    if (!words.every((w) => /^[\x20-\x7e]+$/.test(w))) return false;           // ④ 全 ASCII
    return words.some((w) => /[._/\\-]|\d/.test(w) || /^[A-Za-z]{4,}$/.test(w)); // ③ 技术形态
}

/** URL 归一：这一条是"同一条结果"的唯一判定依据（21 §3.6.3）。 */
export function normalizeUrlKey(url) {
    let s = String(url ?? '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // 去协议
    s = s.replace(/^www\./, '');                     // 去 www.
    s = s.split('#')[0].split('?')[0];               // 去 #片段与 ?查询串
    s = s.replace(/\/+$/, '');                       // 去尾斜杠
    return s;
}

/** 引擎优先级：P0 通用（先出牌）→ P1 垂类且 covers 命中 → P2 其余垂类（排最后但**不清零**）。 */
export function engineTier(name, queryClasses) {
    const p = ENGINE_PROFILE[name];
    if (!p) return 2;
    if (p.kind === 'general') return 0;
    if (p.covers.includes('*')) return 1;
    return p.covers.some((c) => queryClasses.includes(c)) ? 1 : 2;
}

/**
 * ★ 2026-11-07 N1 · 按可用率算每家配额（维护方决定：**不是绝对值，要计算可用比例**）。
 *
 * 维护方样板（原话）：
 *   普通搜索 10 条：BING 3、百度 3、其他各 1
 *   百度不通：BING 5、其他各 1
 *   专业类：专业 4、BING 2、百度 2、其他 2
 *   「不是绝对值，要你们计算一下可用比例来定这个比例」
 *
 * 算法：把样板当**权重**，实际条数按可用引擎的家数分配（最大余额法），
 * 保证 ① 总条数恰为 limit ② 高权重家先满 ③ 有货的家都能分到。
 *
 * @param {string} query
 * @param {number} limit
 * @param {Array<{name:string, items:Array}>} groups 实际有货的组
 * @returns {Map<string, number>} 每家配额（条）
 */
export function computeQuotas(query, limit, groups) {
    const classes = classifyQuery(query);
    // 形态二判并进专业判定：纯英文技术词串即使词表没命中，也按专业配额走
    const isPro = classes.length > 0 || isTechTermQuery(query);
    const quota = new Map();
    if (!Array.isArray(groups) || groups.length === 0 || limit <= 0) return quota;

    // ★ P1 v3 附带（两票同意）：groups 元素形态统一 —— name 兼容 engine 别名。
    //   历史坑：computeQuotas 直调只认 g.name、interleaveByRank 只认 g.engine，
    //   喂错形态 ⇒ 配额读数 undefined，三方读数分歧就是从这冒的。
    //   统一后同一 groups 两函数读出的每家配额必然一致（内部同一条路径）。
    const names = groups.map((g) => g.name ?? g.engine);
    const has = (n) => names.includes(n);

    // 垂类命中查询领域的家（专业配额里"专业 4"那部分）
    const verticalHit = names.filter((n) => {
        const p = ENGINE_PROFILE[n];
        if (!p || p.kind !== 'vertical') return false;
        if (p.covers.includes('*')) return false;
        return p.covers.some((c) => classes.includes(c));
    });

    /**
     * ★ P1 v3（2026-11-08，两票制 spark+minimax 均确认）：垂类命中家按**稀有度**排序。
     *   判据序：① min(所命中类的 rarity) 升序 → ② 仍同分**保持 groups 传入序**
     *   （V8 sort 稳定，不再另设基准序）。
     *   rarity = 本次 verticalHit 中覆盖该类的家数；覆盖越少 = 该家对该域越独占
     *   （security 只有 nvd → rarity=1 排前；dev 有 5 家 → rarity=5 排后）。
     *   ⚠️ 定稿只有 rarity 一层判据——"covers∩classes 交集数降序"那层是施工时私自加的
     *   扩展（未走两票）。minimax 复核指出后，qfmodel 已按"定稿说 rarity 就是 rarity"
     *   **删掉交集数层**（18 场景实测两层版与仅 rarity 版差异 0/18，删除不改任何数字，
     *   但注释/判据必须与定稿一致，防后人按注释误以为定稿是两层）。
     *   单一出处：rarity 全部由 **ENGINE_PROFILE.covers** 现场统计，**没有第二张表**——
     *   将来 N3 改 covers，rarity 随之变，改一处即可（minimax 提醒，写死在此注）。
     *   背景：改造前 vulnerability/CVE 查询下 nvd 在 6 家摊 4 条中 floor(4/6)=0、
     *   按传入序排末位 ⇒ 配额恒 0，唯一真安全引擎不参与专业交付（三方实测复现）。
     *   ⚠️ 已知副作用（已报备并被两票接受）：peer review 下 douban(rarity=1) 排前
     *   ⇒ douban 1→2、arxiv 2→1。tiebreak 若被换成 ENGINES 表序会引入 pypi/stackoverflow
     *   →hackernews 的非判据性变动——**禁止**（minimax 条件票 + qfmodel 模拟器证实）。
     */
    {
        const rarity = (c) => verticalHit.filter((n) => ENGINE_PROFILE[n].covers.includes(c)).length;
        const hitRar = (n) => Math.min(...ENGINE_PROFILE[n].covers.filter((c) => classes.includes(c)).map(rarity));
        verticalHit.sort((a, b) => hitRar(a) - hitRar(b));
    }

    /**
     * ★ 关键设计（第一版算错，此处已改）：**先把主力家的条数钉死，剩下的名额再摊给"其他各 1"**。
     *
     * 第一版写法是"把 bing 记权重 3、其他每家记权重 1，然后按权重占比分 10 条"——
     * 17 家有货时总权重 = 3+3+15 = 21，bing 只拿到 round(3/21×10)=1 条，**维护方的 3 条根本没兑现**。
     * 维护方的话是「BING 3、百度 3、其他各 1」——这是**先给主力定量，余额再分**，不是按比例摊。
     */
    const reserve = [];   // [name, 条数] —— 先钉死的
    const isMain = (n) => n === 'bing' || n === 'baidu';

    /**
     * ★ 2026-11-21 主力双雄定额（维护方定稿）：
     *   「bing 6 / baidu 6，不足互补，再不足给别人」
     *
     *   规则按顺序执行：
     *     ① bing、baidu 各要 6 席（不管普通查询还是专业查询，统一 6）；
     *     ② 某家供货不足 6 条时，缺口**优先转给另一家**补上；
     *     ③ 两家合计仍补不齐 12 席（或 limit < 12），余额才给"其他各 1"。
     *
     *   与旧写法的区别（旧代码 3 条/2 条，被 `Math.min(3, limit)` 钉死，
     *   limit=40 时 bing 仍只拿 2~3 条，占 7.5% —— 与维护方"按比例"的要求背道而驰）：
     *   现在主力定额是**明确席位**，不再随 limit 缩小；limit < 12 时按 limit 等比压缩。
     */
    const MAIN_EACH = 6;          // 每家目标席位
    const MAIN_SEATS = MAIN_EACH * 2;   // 两家合计 12
    const goodsOf = (n) => groups.find((g) => (g.name ?? g.engine) === n)?.items.length ?? 0;

    {
        // ① 先各要 MAIN_EACH，不超过自身货量与 limit
        const give = new Map();
        for (const n of ['bing', 'baidu']) {
            if (!has(n)) continue;
            give.set(n, Math.min(MAIN_EACH, goodsOf(n), limit));
        }
        // ② 缺口由另一家接替（按 bing → baidu 顺序；某家货量已满则跳过）
        let gap = Math.min(MAIN_SEATS, limit) - [...give.values()].reduce((a, b) => a + b, 0);
        for (const n of ['bing', 'baidu']) {
            if (gap <= 0) break;
            if (!has(n)) continue;
            const room = goodsOf(n) - (give.get(n) ?? 0);
            const add = Math.min(room, gap);
            if (add > 0) { give.set(n, (give.get(n) ?? 0) + add); gap -= add; }
        }
        // ③ 落进 reserve；剩余名额（gap>0 时它自然变小）留给下面"其他各 1"
        for (const [n, k] of give) if (k > 0) reserve.push([n, k]);
    }

    // 专业查询的垂类定额：主线席位已被主力占去，这里只给垂类补一点（合计 4，不抢主力）
    if (isPro && verticalHit.length > 0) {
        let left = Math.min(4, limit);
        const each = Math.floor(left / verticalHit.length);
        let rem = left - each * verticalHit.length;
        for (const n of verticalHit) {
            const give = each + (rem-- > 0 ? 1 : 0);
            if (give > 0) reserve.push([n, give]);
        }
    }

    // 钉死主力后，余额给"其他各 1"（每轮每家 1 条，轮完再轮）
    let left = limit;
    const pinned = new Map();
    for (const [n, k] of reserve) {
        const add = Math.min(k, left, groups.find((g) => (g.name ?? g.engine) === n)?.items.length ?? 0);
        if (add <= 0) continue;
        pinned.set(n, (pinned.get(n) ?? 0) + add);
        left -= add;
    }

    const others = names.filter((n) => !pinned.has(n));
    // 其他家：轮流各给 1，直到余额用尽或全部给满
    let guard = 0;
    while (left > 0 && guard++ < 10000) {
        let moved = false;
        for (const n of others) {
            if (left <= 0) break;
            const g = groups.find((x) => x.name === n);
            if (!g) continue;
            const cur = pinned.get(n) ?? 0;
            if (cur >= g.items.length) continue;
            pinned.set(n, cur + 1);
            left--;
            moved = true;
        }
        if (!moved) break;
    }

    for (const n of names) quota.set(n, pinned.get(n) ?? 0);

    /**
     * ② 余额回收（两个方向都要做）：
     *    a) 某家配额 > 实际有货 → 砍到货量，腾出的名额转给别人
     *    b) 配额合计 < limit（余额没分完，例如只有一家有货）→ 补给还有余货的家
     *    缺 b) 会导致"只有 bing 有货时只交 5 条、明明有 8 条货"——这是第一版漏掉的。
     */
    let deficit = 0;
    for (const g of groups) {
        const q = quota.get(g.name ?? g.engine) ?? 0;
        if (q > g.items.length) {
            deficit += q - g.items.length;
            quota.set(g.name ?? g.engine, g.items.length);
        }
    }
    // b) 余额没分完的也并进 deficit
    const sumQ = [...quota.values()].reduce((a, b) => a + b, 0);
    if (sumQ < limit) deficit += limit - sumQ;

    if (deficit > 0) {
        const rankOf = (n) => (isMain(n) ? 0 : 1);
        const sorted = [...names].sort((a, b) => rankOf(a) - rankOf(b));
        let guard2 = 0;
        while (deficit > 0 && guard2++ < 10000) {
            let moved = false;
            for (const n of sorted) {
                if (deficit <= 0) break;
                const g = groups.find((x) => x.name === n);
                if (!g) continue;
                const cur = quota.get(n) ?? 0;
                if (cur < g.items.length) {
                    quota.set(n, cur + 1);
                    deficit--;
                    moved = true;
                }
            }
            if (!moved) break;
        }
    }
    return quota;
}

/**
 * 分层交错合并排序（21 §3.4 的实现）。
 *
 * @param {Array<{engine:string, items:Array}>} groups 每家的候选序列，**items 必须保持引擎原生顺序**
 * @param {string} query 原始查询（只用来算优先级，不参与打分）
 * @param {number} limit 交付条数上限
 * @returns {Array} 交付序列，每条带 _engine / _rank（原生名次）/ _tier
 *
 * 三条不变量（可在返回结果上机器验证）：
 *   I1 同引擎保序 —— 同一引擎两条，先出现的原生名次更小
 *   I2 无无理由跳取 —— 某家出了第 k 名，则第 1..k-1 名必须已交付或被 URL 去重剔除
 *   I3 URL 唯一 —— 交付里同一归一 URL 最多一条
 *
 * ★ 2026-11-07 N1：从「严格轮流」改成「按配额加权轮流」。
 *   原因（实测）：严格轮流下第 r 轮每家出 1 条，17 家有货时**第 1 轮就满 10 条**，
 *   配额设 3 或 1 完全没区别 —— 这正是 21 号文档测出「单引擎 cap 零收益」的真因：
 *   不是 cap 没用，是**在严格轮流下 cap 根本轮不到第二次**。
 *   改法：第 r 轮只让"配额还没用完"的家出牌，配额 3 的家会连续出 3 轮。
 */
export function interleaveByRank(groups, query, limit) {
    const classes = classifyQuery(query);
    // 引擎按 P0→P1→P2 排；同层保持传入顺序（= ENGINES 表顺序，稳定可复现）
    const ordered = [...groups]
        .filter((g) => Array.isArray(g.items) && g.items.length > 0)
        .map((g) => ({ name: g.engine ?? g.name, tier: engineTier(g.engine ?? g.name, classes), items: g.items }))  // ★ P1 v3：engine/name 双形态兼容（与 computeQuotas 同一口径）
        .sort((a, b) => a.tier - b.tier);

    // ★ N1：先按可用率算配额
    const quotas = computeQuotas(query, limit, ordered);

    const used = new Set();
    const out = [];
    const served = new Map(ordered.map((g) => [g.name, 0]));      // 每家已出几条
    const maxRound = Math.max(0, ...ordered.map((g) => g.items.length));

    // ④ 加权交错：第 r 轮，每家出自己第 r 条（但配额用完的家跳过）
    for (let r = 0; r < maxRound; r++) {
        for (const g of ordered) {
            if (r >= g.items.length) continue;            // 这家已经出完
            const cap = quotas.get(g.name) ?? 0;
            if ((served.get(g.name) ?? 0) >= cap) continue; // ★ N1：配额已满，本轮不出
            const it = g.items[r];
            const key = normalizeUrlKey(it?.url);
            if (!key) continue;                           // 无 URL = 无可用链接，弃
            if (used.has(key)) continue;                  // I3：URL 已占用，弃（指针前进）
            used.add(key);
            served.set(g.name, (served.get(g.name) ?? 0) + 1);
            // ★ 2026-11-07 S9.54：`_nativeRank` 与 `_rank` 同值，两个名字都给 ——
            //   21 §四 的字段名叫 `_nativeRank`，'rank' 这个名字在旧代码里是"我们打的分"，
            //   用一个新名字表明这是**引擎自己的名次**（S9.52 把顺序保住了，名字也要分清）。
            out.push({ ...it, _engine: g.name, _rank: r + 1, _nativeRank: r + 1, _tier: g.tier, _quota: cap });
            if (out.length >= limit) return out;
        }
    }
    return out;
}

/**
 * @deprecated 2026-11-07 S9.53 起聚合排序不再走这里（改用 interleaveByRank）。
 * 保留导出是因为 vendored self-test 与单独调用方可能还在用它；**别再接到交付路径上**。
 * 公式：0.6×标题字面重合 + 0.4×摘要字面重合 —— 摘要为空的引擎上限只有 0.6（见本节头注）。
 */
export function rankByRelevance(items, query) {
    const q = String(query ?? '');
    const qCjk = new Set(cjkChars(q));
    const qWords = new Set((q.toLowerCase().match(/[a-z0-9]+/g) ?? []));
    const scored = items.map((item) => {
        const title = String(item?.title ?? '');
        const snippet = String(item?.snippet ?? '');
        const tCjk = new Set(cjkChars(title));
        const sCjk = new Set(cjkChars(snippet));
        const tWords = new Set((title.toLowerCase().match(/[a-z0-9]+/g) ?? []));
        const sWords = new Set((snippet.toLowerCase().match(/[a-z0-9]+/g) ?? []));
        const cjkHit = qCjk.size ? [...qCjk].filter((c) => tCjk.has(c)).length / qCjk.size : 0;
        const sCjkHit = qCjk.size ? [...qCjk].filter((c) => sCjk.has(c)).length / qCjk.size : 0;
        const wordHit = qWords.size ? [...qWords].filter((w) => tWords.has(w)).length / qWords.size : 0;
        const sWordHit = qWords.size ? [...qWords].filter((w) => sWords.has(w)).length / qWords.size : 0;
        return { ...item, _score: 0.6 * Math.max(cjkHit, wordHit) + 0.4 * Math.max(sCjkHit, sWordHit) };
    });
    return scored.sort((a, b) => b._score - a._score);
}

// Re-export shared helpers the shell may rely on.
export { stripTags, clip, normalize, failure };
