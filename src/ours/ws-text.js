/**
 * Shared pure text utilities (owned by 主实现方, frozen interface — see 接口契约.md §0).
 *
 * Why this file exists: lane A (ws-engines.js) and lane B (ws-transport.js) both need
 * stripTags/clip/normalize/failure. Duplicating them would break "坏哪个修哪个", and
 * importing them from web-search.js would create a cycle (the shell imports both lanes).
 * So both lanes import THIS file; it imports nothing but node built-ins.
 *
 * Behaviour is a byte-for-byte extraction of the 1.0.8 module's helpers, so the vendored
 * self-test (S55/S56/S57/S60/S61) keeps passing after the shell is rewired.
 * No absolute paths, no host SDK imports, Node >= 22.19 APIs only.
 */

export const ENTITIES = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
    ['#39', "'"], ['#34', '"'], ['mdash', '—'], ['ndash', '–'], ['hellip', '…'],
    ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '], ['#0183', '·'], ['middot', '·'], ['#183', '·'],
]);

/** Strip markup and decode the entities that survive in snippets. */
export function stripTags(html) {
    let text = String(html ?? '');
    text = text.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ');
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
    text = text.replace(/&#(\d+);/g, (match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
    text = text.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => ENTITIES.get(name) ?? match);
    text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n');
    return text.trim();
}

/** Trim to a character budget without cutting mid-word when avoidable. */
export function clip(text, max) {
    if (text.length <= max)
        return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/**
 * Engine-side normalisation: drop items without a URL, cap count, trim fields.
 *
 * ★ 2026-11-07 S9.54：`snippet` **不再在卡片层裁 180**（21 §四 L242/L250 的要求）。
 *   原话是「snippet 在卡片层不裁 180（裁在交付前最后一环）」——裁的地方改到
 *   web-search.js 的 render/renderAggregate，那里才是"交付"。
 *   本函数额外落两个文档要求的字段：
 *     _snippet_raw  全量摘要（与 snippet 同一个字符串，不额外占内存）
 *     site          由 url 派生的主机名（与 safeHost 同口径）
 *   实测为什么必须裁在交付层：StackOverflow 加 `filter=withbody` 后单条 body 可达
 *   3,579 字符、10 条合计 36,733 字符；若原样交付，10 条就从 2.7 KB 涨到 36 KB+。
 */
export function normalize(items, limit) {
    return items
        .filter((item) => typeof item?.url === 'string' && item.url.length > 0)
        .slice(0, Math.max(1, limit))
        .map((item) => {
            const raw = stripTags(item.snippet || '');
            let site = '';
            try { site = new URL(item.url).hostname.replace(/^www\./, ''); } catch { /* 非 URL 就留空 */ }
            return {
                title: clip(stripTags(item.title || item.url), 120),
                url: item.url,
                snippet: raw,          // 卡片层全量，裁剪在交付层
                _snippet_raw: raw,
                site,
            };
        });
}

/**
 * Structured failure (契约 §4). `engine`/`code` are read by callers and by the
 * self-test, so keep the property names. Never put "grant permission / reopen /
 * reinstall" wording in `detail`.
 */
export function failure(scope, code, detail) {
    const error = new Error(`[${scope}] ${code}: ${detail}`);
    error.engine = scope;
    error.code = code;
    return error;
}
