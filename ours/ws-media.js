/**
 * lane A · MEDIA — image/video extraction + render (契约 §3b, §5).
 * Separate file so MEDIA (media()) never touches ws-engines.js (S55–S61 frozen).
 * Bing is the only keyless machine-readable source: /images/async (35) + /videos/search (47).
 * Network only via opts.getHtml; no fetch/subprocess, no lane B, ESM, Node >= 22.19.
 */
import { clip, failure } from './ws-text.js';

/** Fetch via injected getHtml and interpret the contract envelope (契约 §1, §4). */
async function load(url, scope, opts) {
    const res = await opts.getHtml(url, { engineHint: scope, ...opts });
    if (res?.blocked) throw failure(scope, 'blocked', `challenge shell: ${res.blocked}`);
    if (res?.ok === false)
        throw failure(scope, res?.status ? String(res.status) : 'unavailable', res?.diagnosis || 'getHtml failed');
    if (res?.status !== 200) throw failure(scope, String(res.status), `http ${res.status}`);
    return res.text ?? '';
}

/** Pull every `m="{…}"` JSON blob out of a Bing media page (zero deps; malformed skipped). */
export function extractBlobs(html) {
    const out = [];
    const re = /m="(\{[^"]*\})"/g;
    let m;
    while ((m = re.exec(String(html ?? '')))) {
        try { out.push(JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))); }
        catch { /* malformed blob — skip */ }
    }
    return out;
}

const IMAGE_URL = (q, limit) => `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=1&count=${limit}&mmasync=1`;
const VIDEO_URL = (q) => `https://www.bing.com/videos/search?q=${encodeURIComponent(q)}&FORM=HDRSC4`;

/** image · Bing /images/async. MediaItem: { title, url(=murl), thumb(=turl), src(=purl), w?, h? }. */
function parseImage(text, limit) {
    const items = extractBlobs(text).map((b) => {
        const item = { title: clip(String(b?.t ?? ''), 120), url: b?.murl ?? '', thumb: b?.turl ?? '', src: b?.purl ?? '' };
        if (typeof b?.w === 'number') item.w = b.w;   // Bing carries no w/h today (35/35); emit only if added later.
        if (typeof b?.h === 'number') item.h = b.h;
        return item;
    }).filter((item) => item.url || item.thumb);
    if (items.length === 0) throw failure('bingimg', 'empty', '0 images parsed — markup may have changed');
    return items.slice(0, Math.max(1, limit));
}

/** video · Bing /videos/search. MediaItem: { title, url(=purl), duration? }; dedupe by purl. */
function parseVideo(text, limit) {
    const seen = new Set();
    const items = [];
    for (const b of extractBlobs(text)) {
        const url = b?.purl ?? '';
        if (!url || seen.has(url)) continue;
        seen.add(url);
        items.push({ title: clip(String(b?.vt ?? ''), 120), url, duration: b?.du ?? '' });
        if (items.length >= Math.max(1, limit)) break;
    }
    if (items.length === 0) throw failure('bingvideo', 'empty', '0 videos parsed — markup may have changed');
    return items;
}

export const MEDIA = {
    image: { run: async (q, limit, opts) => parseImage(await load(IMAGE_URL(q, limit), 'bingimg', opts), limit) },
    video: { run: async (q, limit, opts) => parseVideo(await load(VIDEO_URL(q), 'bingvideo', opts), limit) },
};

/** Render a media report (契约 §5 `media:` row). */
function mediaRender(kind, items, query, elapsedMs) {
    const label = kind === 'image' ? 'bingimg' : 'bingvideo';
    const lines = [`${label} · ${items.length} hit(s) · ${elapsedMs}ms · ${query}`];
    items.forEach((item, index) => {
        if (kind === 'image') {
            const dims = item.w && item.h ? ` ${item.w}x${item.h}` : '';
            lines.push(`[${index + 1}] ${item.title}${dims}`, `    ${item.thumb}`, `    ${item.src}`);
        } else {
            lines.push(`[${index + 1}] ${item.title}${item.duration ? ` · ${item.duration}` : ''}`, `    ${item.url}`);
        }
    });
    return lines.join('\n');
}

/** Search images/videos → compact report. Unknown kind / empty query throws structured failure (契约 §4). */
export async function media(kind, query = '', opts = {}) {
    const handler = MEDIA[kind];
    if (handler === undefined)
        throw failure('media', 'engine', `unknown kind "${kind}" (have: ${Object.keys(MEDIA).join(', ')})`);
    if (typeof query !== 'string' || query.trim() === '')
        throw failure('media', 'input', 'query must be a non-empty string');
    const started = Date.now();
    return mediaRender(kind, await handler.run(query, opts.limit ?? 10, opts), query, Date.now() - started);
}
