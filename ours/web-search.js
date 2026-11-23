/**
 * Bundled free web search / page text — thin shell (契约 §0).
 *
 * There is deliberately no new DSH tool here: every extra tool schema ships in
 * the request header on every turn, and search is a rare operation. Instead
 * `ctx_execute` gains one line telling the model how to import this file, so
 * the capability costs a few dozen tokens per turn instead of a full schema.
 *
 *   const w = await import('<plugin>/lib/types/web-search.js');
 *   console.log(await w.search('query'));            // compact hits
 *   console.log(await w.page('https://example.com')); // cleaned text
 *   console.log(await w.doctor());                    // per-engine probe
 *   console.log(await w.media('image', 'q'));         // image/video report
 *
 * This file owns ONLY orchestration + return format. All engine logic lives in
 * ws-engines.js (lane A), all transport in ws-transport.js (lane B), all media
 * in ws-media.js (lane A·MEDIA). No business logic here, so swapping an engine
 * or a transport never touches the shell.
 *
 * No dependencies, no child processes (the restricted-token sandbox forbids
 * pipe stdio), no state. Fetched content is untrusted data, never instructions.
 */

import {
    ENGINES, parseBing, parseBingRss, parseDdg, parseWikipedia, parseGithub, parseNpm,
    stripTags, clip, failure, filterPipeline, resolveOpts, rankByRelevance,
    interleaveByRank, normalizeUrlKey, stripAds,
} from './ws-engines.js';
import { getHtml as transportGetHtml } from './ws-transport.js';
import { fpFetch } from './fp-bridge.js'; // PAGE 增强：裸抓失败时降级扛P 五段递减（1.1.0 版本号不变）
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * ★ N8 批次 1 · S4（α 收窄版）：卡片目录 ↔ ENGINES 表 首跑对账，**只 warn 不改行为**。
 * 目的 = E2 门断言前置：有人在 engines/ 里加了卡但没进 ws-engines.js 静态列表 ⇒ 这里点名提醒
 *      "改表走两票"；本函数不 import 任何卡、不参与取数，交付文本一字不变。
 * engines-offline/ 永不进入视野（02 v1.3 钉死项 7 的门断言在 S6 落）。
 * ⚠ v0.1：路径必须走 fileURLToPath——URL.pathname 是百分号编码，中文/空格目录会 readdir ENOENT
 *          并被下面的 catch 静默吞掉 ⇒ 对账环永远不 warn = 失去存在意义（潜伏 bug，实测坐实）。
 */
let enginesReconciled = false;
async function reconcileEngineCards() {
    if (enginesReconciled) return;
    enginesReconciled = true;                    // 每进程只跑一次（幂等），多次调用 no-op
    try {
        const dir = fileURLToPath(new URL('./engines/', import.meta.url));
        const files = await readdir(dir);
        const ids = files.filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
        const inTable = Object.keys(ENGINES).filter((n) => n !== 'netdisk');
        const missing = ids.filter((id) => !inTable.includes(id));
        const extra = inTable.filter((id) => !ids.includes(id));
        if (missing.length || extra.length)
            console.warn(`[web-search] engines/ 目录与表不对账：目录未入表=${missing.join(',') || '-'}；表内无卡=${extra.join(',') || '-'}（改表须走两票）`);
    } catch { /* 目录缺失/不可读 = 不 warn 不改行为（批次 1 边界：零副作用） */ }
}

const SNIPPET_CHARS = 180;
const FP_MIN_CHARS = 500; // 壳判定阈值：正文低于此触发扛P 降级（掘金实测裸抓仅 401 字符导航壳）

/**
 * 交付层的摘要裁剪额度。
 *
 * ★ 2026-11-07 S9.54：180 这个数字从卡片层搬到这里（21 §四 L242「裁在交付前最后一环」）。
 *   卡片层现在留全量（`_snippet_raw`）；只有真的要交给模型时才裁。
 *   实测依据：StackOverflow 补了 `filter=withbody` 后单条 body 最长 3,579 字符、
 *   10 条合计 36,733 字符 —— 不裁就撞 40 KB 的 output-containment。
 */
const DELIVER_SNIPPET_CHARS = 180;

/**
 * 取交付用摘要：优先 `_snippet_raw`，退回 `snippet`，再裁到额度。
 *
 * ★ 2026-11-07 N5：`budget` 参数化。默认仍 180（**现状行为一字不变**）；
 *   需求方要求「全量应该给留一个参数，默认参数只是给 180，但是碰到需要的时候
 *   可以添加一个参数回全部内容」⇒ 传 `fullSnippet:true` 时 budget = Infinity。
 */
function deliverSnippet(item, budget = DELIVER_SNIPPET_CHARS) {
    return clip(String(item?._snippet_raw ?? item?.snippet ?? '').replace(/\s+/g, ' ').trim(), budget);
}

/** `fullSnippet:true` → 不裁；否则 180。 */
const deliverBudget = (opts) => (opts?.fullSnippet === true ? Infinity : DELIVER_SNIPPET_CHARS);

/** Compact, ready-to-print report (契约 §5 `search:` row — format frozen). */
function render(engine, query, items, elapsedMs, budget = DELIVER_SNIPPET_CHARS) {
    const lines = [`${engine} · ${items.length} hit(s) · ${elapsedMs}ms · ${query}`];
    items.forEach((item, index) => {
        lines.push(`[${index + 1}] ${item.title}`);
        lines.push(`    ${item.url}`);
        const snip = deliverSnippet(item, budget);
        if (snip)
            lines.push(`    ${snip}`);
    });
    return lines.join('\n');
}

/** Aggregate report: every hit tagged with its source engine. */
function renderAggregate(engines, query, items, elapsedMs, budget = DELIVER_SNIPPET_CHARS) {
    const lines = [`search · ${items.length} hit(s) · ${elapsedMs}ms · ${query} · engines: ${engines.join(',')}`];
    items.forEach((item, index) => {
        lines.push(`[${index + 1}] (${item._engine ?? '?'}) ${item.title}`);
        lines.push(`    ${item.url}`);
        const snip = deliverSnippet(item, budget);
        if (snip)
            lines.push(`    ${snip}`);
    });
    return lines.join('\n');
}

/**
 * Resolve the transport the shell hands to engines (契约 §1).
 * Order: explicit `opts.getHtml` → wrap `opts.fetchImpl` (母本 self-test S57/S60/S61
 * inject a fetch stub) → the real lane B `getHtml`.
 */
function resolveGetHtml(options) {
    if (typeof options?.getHtml === 'function')
        return options.getHtml;
    if (typeof options?.fetchImpl === 'function') {
        const fetchImpl = options.fetchImpl;
        return async (url, opts = {}) => {
            const res = await fetchImpl(url, opts);
            if (res?.ok === false)
                return { ok: false, status: res.status, diagnosis: res.statusText || 'http error' };
            return { ok: true, status: res.status, text: await res.text() };
        };
    }
    return transportGetHtml;
}

/**
 * Search and return a compact, ready-to-print report.
 * A failing engine throws with `engine` and `code` so the caller can say why
 * instead of printing an empty result set.
 *
 * Pass `options.engine` for a single engine (mother format). Omit it to run
 * every engine in parallel and merge — hits are deduped, ranked by relevance
 * to the query, and tagged with their source engine.
 */
export async function search(query, options = {}) {
    if (typeof query !== 'string' || query.trim() === '')
        throw failure('search', 'input', 'query must be a non-empty string');
    const opts = resolveOpts(options);
    const getHtml = resolveGetHtml(options);

    // --- single engine (mother format, S57-compatible) ---
    if (options.engine) {
        const engine = options.engine;
        const handler = ENGINES[engine];
        if (handler === undefined)
            throw failure('search', 'engine', `unknown engine "${engine}" (have: ${Object.keys(ENGINES).join(', ')})`);
        await reconcileEngineCards();
        const started = Date.now();
        const items = await handler.run(query, opts.limit, { ...options, getHtml });
        // 结果全同站（垂类单域 API 的常态）时跳过同站去重避免 N→1 误杀；混合多站仍去重（2026-10-31 外测修复）
        const hosts = new Set(items.map((it) => { try { return new URL(it?.url ?? '').hostname; } catch { return '?'; } }));
        const filtered = filterPipeline(items, { ...opts, query, noSiteDedupe: hosts.size <= 1 });
        const elapsed = Date.now() - started;
        if (filtered.items.length === 0)
            throw failure(engine, 'empty', `0 results parsed in ${elapsed}ms — the page markup may have changed`);
        return render(engine, query, filtered.items, elapsed, deliverBudget(options));
    }

    // --- aggregate: every engine in parallel ---
    // Fast leg only by default: 22 engines each spawning a bridge Python process
    // is too heavy. Callers who need the bridge on specific engines pass
    // `allowBridge: true` (or use single-engine mode / page()).
    // opts.engines 白名单：resolveOpts 已解析（数组|null），此前被静默忽略、头行沿用参考实现全表（2026-10-31 外测修复）
    const names = (opts.engines ?? Object.keys(ENGINES)).filter((n) => ENGINES[n] && n !== 'netdisk');
    await reconcileEngineCards();
    const started = Date.now();

    /**
     * ★ 2026-11-21 引擎级桥开关（维护方定：方案 A）。
     *
     * 默认 `allowBridge:false` —— 22 家各起一个 Python 桥进程太重，这是对的。
     * 但 **baidu 是个例外**：它第一发常态就是 1,438 字节的「百度安全验证」页
     * （`m.baidu.com/from=0/s` 的风控常规行为），必须让 ws-transport 走桥重抓
     * 才能拿到真页面（实测真页 1.9MB）。不开桥时 getHtml 直接返回验证页 ⇒
     * baidu 抛 `challenge shell: baidu_challenge` ⇒ 在聚合里**恒为 0 条**，
     * 配额给 6 席也永远兑现不了。
     *
     * 代价：每次聚合搜索多起 1 个 Python 进程（约 0.5~1 s）。只给 baidu 一家开。
     */
    const BRIDGE_ENGINES = new Set(['baidu']);

    const settled = await Promise.all(names.map(async (name) => {
        try {
            const its = await ENGINES[name].run(query, opts.limit, {
                ...options,
                getHtml,
                timeoutMs: options.timeoutMs ?? 5000,
                allowBridge: BRIDGE_ENGINES.has(name) ? true : (options.allowBridge ?? false),
            });
            return { name, items: its };
        }
        catch {
            return { name, items: [] };   // one engine failing must not sink the search
        }
    }));
    // --- ① 逐家清洗 + 保留原生顺序（★ 2026-11-07 S9.53）---
    // 顺序就是引擎给的名次，**这一步之后任何人都不许再排序**（21 §3.5 不变量 I1）。
    // 广告/推荐在**交错之前**剔掉：交错会把每家第 1 名抬到前排，
    // 实测 DeepSeek 上百度第 1 名是「豆包工作模式升级」广告 ——
    // 先交错后去广告 = 把广告抬到第 2 名（实现方实测过，别重踩）。
    const groups = [];
    const adLog = [];
    for (const { name, items } of settled) {
        if (items.length === 0) continue;
        // 域名黑名单 + 垃圾过滤照走；**同站去重必须关**（21 §3.6.1：同站不同页不是重复，
        //   DeepSeek 实测 206→22、python asyncio 201→29，平均误杀 86.5%）
        const cleaned = filterPipeline(items, { ...opts, query, noSiteDedupe: true });
        const noAds = stripAds(cleaned.items);
        for (const d of noAds.dropped) adLog.push({ engine: name, ...d });
        // 引擎内 URL 去重（保持原生顺序，只剔完全相同的 URL）
        const inSeen = new Set();
        const keep = [];
        for (const it of noAds.items) {
            const k = normalizeUrlKey(it?.url);
            if (!k || inSeen.has(k)) continue;
            inSeen.add(k);
            keep.push(it);
        }
        if (keep.length > 0) groups.push({ engine: name, items: keep });
    }

    // --- ② 分层交错（核心）：第 r 轮，每家出自己第 r 名 ---
    const top = interleaveByRank(groups, query, opts.limit);
    const elapsed = Date.now() - started;
    if (top.length === 0)
        throw failure('search', 'empty', `0 results from ${names.length} engines in ${elapsed}ms`);
    if (options.debug) top.adLog = adLog;   // 调试用，渲染不看它
    return renderAggregate(names, query, top, elapsed, deliverBudget(options));
}

/* ── ★ 03 片（2026-11-19）：文件识别 ────────────────────────────────────────
 *  SEARCH 取正文只对文本页面有意义。命中非文本内容（图片/视频/音频/PDF/
 *  压缩包/可执行/二进制流等）时，page() 不取正文，直接短路返回
 *  「是什么文件 + 请用 fetch 下载」的提示，避免把二进制解码成的乱码交出去。
 *  双信号：content-type（主）+ URL 后缀（辅，裸抓被反扒拦时只能靠后缀识别）。
 */
const FILE_CT_RULES = [
    [/^image\//i, '图片'],
    [/^video\//i, '视频'],
    [/^audio\//i, '音频'],
    [/^font\//i, '字体'],
    [/application\/pdf/i, 'PDF'],
    [/application\/(x-)?(zip|gzip|x-gzip|tar|x-tar|rar|x-rar|7z|x-7z|bzip2|x-bzip2|xz|x-xz)/i, '压缩包'],
    [/application\/octet-stream/i, '二进制流'],
    [/application\/(x-msdownload|x-executable|x-msdos-program|vnd\.ms-(excel|word|powerpoint)|vnd\.openxmlformats|epub|wasm|java-archive)/i, '文件'],
];
const FILE_EXT_RULES = [
    [/\.(png|jpe?g|gif|webp|bmp|svg|ico|tif?f)$/i, '图片'],
    [/\.(mp4|mkv|mov|avi|webm|flv|wmv|m4v)$/i, '视频'],
    [/\.(mp3|m4a|wav|flac|aac|ogg|wma)$/i, '音频'],
    [/\.pdf$/i, 'PDF'],
    [/\.(zip|gz|tgz|tar|rar|7z|bz2|xz)$/i, '压缩包'],
    [/\.(exe|dll|msi|dmg|deb|rpm|apk|app)$/i, '可执行/安装包'],
    [/\.(woff2?|ttf|otf|eot)$/i, '字体'],
    [/\.(docx?|xlsx?|pptx?|epub|odt|ods|odp)$/i, '文档'],
    [/\.(jar|class|pyc|so|elf)$/i, '程序文件'],
    [/\.(bin|dat|iso|img|parquet|npy|pkl|sqlite|db)$/i, '数据文件'],
];
/** 明确的文本类型：即使后缀可疑也按页面走。 */
const TEXT_CT_RE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|rss|atom|xhtml\+xml))/i;

/** @returns {{kind:string, source:string}|null} 命中非文本文件返回类型描述，否则 null。 */
function classifyFile(contentType, url) {
    const ct = String(contentType ?? '').trim();
    if (ct) {
        const hit = FILE_CT_RULES.find(([re]) => re.test(ct));
        if (hit) return { kind: hit[1], source: 'content-type' };
        if (TEXT_CT_RE.test(ct)) return null;   // 明确文本 ⇒ 不是文件
        // 未知类型：再靠后缀判断
    }
    const ext = FILE_EXT_RULES.find(([re]) => re.test(String(url ?? '')));
    return ext ? { kind: ext[1], source: 'url-ext' } : null;
}

/**
 * 文件提示交付文本：说清是什么、多大、下一步用 fetch。
 * ★ 大小只认 fast 腿的 byteLen（Uint8Array 真实字节数）；桥腿的 meta.bytes 是
 *   utf-8 重编码长度、`bytes` 字段是字符数（关联表 #2 的坑），一律不用于文件大小。
 */
function fileNotice(url, res, hit) {
    const ct = String(res?.contentType ?? '').trim();
    const ctShown = hit.source === 'content-type' ? (ct || '类型未标') : '类型未标';
    const size = res?.via === 'fast' && res?.byteLen ? `${res.byteLen} bytes` : '大小未知';
    const lines = [
        `${url} · file · ${hit.kind} · ${ctShown} · ${size}`,
        `    非文本文件，SEARCH 取正文无意义（只会得到乱码）；下载原始文件请用 fp({op:"fetch", url:"${url}"})。`,
    ];
    if (hit.source === 'url-ext') lines.push('    识别依据：URL 后缀（content-type 未明确标为文件类型）。');
    return lines.join('\n');
}

/**
 * Fetch a page and return readable text, not markup.
 * PAGE 增强：裸抓失败/被墙/壳（正文 < FP_MIN_CHARS）时自动降级扛P 五段递减（http→waf→tls→render→cdp）。
 * options.noFpFallback=true 关降级（恢复 1.1.0 原行为）；options.fpLegTimeoutSec 控每腿秒数（默认 5）。
 * ★ 03 片：裸抓成功但内容是非文本文件时，在壳判定之前短路，直接返回文件提示；
 *   五段降级扛过反扒后拿到的若仍是文件（靠后缀识别），同样不交乱码。
 */
export async function page(url, options = {}) {
    const budget = options.maxChars ?? 6000;
    const res = await resolveGetHtml(options)(url, { engineHint: 'page' });
    let text = '';
    let via = '';
    let bareFail = null;
    // ★ 文件识别（先于壳判定）：二进制/图片/压缩包等非文本内容，取正文必是乱码
    //   ⇒ 短路提示用 fetch，不进入壳判定、不触发五段降级。
    if (res?.ok) {
        const hit = classifyFile(res.contentType, url);
        if (hit) return fileNotice(url, res, hit);
    }
    if (res?.blocked)
        bareFail = failure('page', 'blocked', `challenge shell: ${res.blocked}`);
    else if (res?.ok === false)
        bareFail = failure('page', res?.status ? String(res.status) : 'unavailable', res?.diagnosis || 'getHtml failed');
    else
        text = stripTags(res.text ?? '');
    // 壳判定：导航条/登录墙的典型形态（内容过薄）也走降级，不把 401 字符的空壳当结果交出去
    if (!bareFail && text.length < FP_MIN_CHARS)
        bareFail = failure('page', 'shell', `thin content: ${text.length} chars`);
    if (bareFail && !options.noFpFallback) {
        const fp = await fpFetch(url, { fpLegTimeoutSec: options.fpLegTimeoutSec, outDir: options.fpOutDir });
        if (fp.ok) {
            // ★ 反扒扛过了、拿到的仍是文件（靠后缀识别）⇒ 同样不交乱码，提示用 fetch
            const extHit = classifyFile('', url);
            if (extHit) return fileNotice(url, res, extHit);
            text = stripTags(fp.text ?? '');
            via = ` · via:fp:${fp.leg}`;
        } else {
            // 扛P 也救不回：抛原始错误并附 FP 死因——两级死因都说清楚
            try { bareFail.message = `${bareFail.message} — fp: ${fp.diagnosis}`; } catch {}
            throw bareFail;
        }
    } else if (bareFail) {
        throw bareFail;
    }
    if (!via && res?.via) via = ` · via:${res.via}`;
    const trimmed = clip(text, budget);
    // ★ ITERATION-008：内容层数据围栏（提示注入标记）。
    //   头行（`url · N chars of text · via:...`）**一字不动**，只在正文后追加警示段
    //   ⇒ 不违反 DELIVER_FORMAT 冻结面（G-5 / G4 S-3 不受影响）。
    //   未命中注入特征时返回空串，交付与改前逐字节一致。
    let fenceNote = '';
    try {
        const mod = await import('./fence.js').catch(() => null);
        if (mod && typeof mod.fenceNote === 'function') fenceNote = mod.fenceNote(trimmed);
    } catch { /* 围栏是增强，失败绝不影响交付 */ }
    return `${url} · ${text.length} chars of text${trimmed.length < text.length ? ` (showing ${trimmed.length})` : ''}${via}\n${trimmed}${fenceNote}`;
}

/** Probe every engine once with a fixed query; report ok/fail per engine. */
export async function doctor(options = {}) {
    const probe = 'DeepSeek';
    const getHtml = resolveGetHtml(options);
    // 全并行探测：串行版被不可达引擎逐家拖满 8s+桥重试，全量体检曾到 212s（2026-10-31 外测修复）
    await reconcileEngineCards();
    const results = await Promise.all(Object.keys(ENGINES).filter((n) => n !== 'netdisk').map(async (engine) => {
        const started = Date.now();
        try {
            const items = await ENGINES[engine].run(probe, 3, { ...options, getHtml, timeoutMs: options.timeoutMs ?? 8000 });
            return `${items.length > 0 ? 'OK  ' : 'EMPTY'} ${engine.padEnd(10)} ${items.length} hit(s) ${Date.now() - started}ms`;
        }
        catch (error) {
            return `FAIL ${engine.padEnd(10)} ${String(error.code ?? error.name)} ${Date.now() - started}ms — ${String(error.message).slice(0, 120)}`;
        }
    }));
    return results.join('\n');
}

/** image/video entry point — delegates to lane A·MEDIA (契约 §3b). Injects the transport. */
export async function media(kind, query = '', opts = {}) {
    const m = await import('./ws-media.js');
    return m.media(kind, query, { ...opts, getHtml: resolveGetHtml(opts) });
}

export { parseBing, parseBingRss, parseDdg, parseWikipedia, parseGithub, parseNpm, stripTags, clip, ENGINES };
export const __webSearchInternals = { ENGINES, getHtml: transportGetHtml, clip, render };
