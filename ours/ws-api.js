/**
 * ws-api.js — lane C · POST JSON / SSE 通道（片 5 · A-3）
 *
 * 为什么单独一个文件：
 *   `ws-transport.js` 的 `getHtml()` 只会 GET（它的 `fetchImpl(url,{redirect,signal,headers})`
 *   连 `method`/`body` 都没有，实测见 02 项目 2-开发日志 L-001）。片 5 要接的 6 家 API
 *   **全是 POST**（Parallel/TinyFish/Exa 还是 MCP JSON-RPC + SSE 响应）⇒ 没有这条通道，
 *   6 张卡连请求都发不出去。
 *
 * 为什么按 content-type 分派、而不是按"是不是 MCP"猜：
 *   ★ 2026-11-09 探针实测（02 项目 L-009）——**TinyFish 是 MCP 但返回 `application/json`**，
 *     Parallel/Exa 是 MCP 且返回 `text/event-stream`。Reference 说"TinyFish 走 SSE"是错的。
 *     按协议猜 = 两种都可能错；按 content-type 判 = 两种都对。
 *
 * 为什么导出的东西这么少：
 *   本文件只管"把请求发出去、把壳剥开"。**解析归卡片**（每家的字段名不同，见 L-009 的形状表），
 *   编排归 `web-search.js`。这样换一家 API 只动一张卡，不动这里。
 *
 * 边界（不许越界）：
 *   · POST 腿**必须**过 `assertSafeUrl`（B-12 自决项；三堆 §11.3）。6 家端点硬编码在卡里，
 *     SSRF 面不新增，但闸照过——将来若有卡改成按参数拼 host，这里不用改就已经兜住。
 *   · `redirect:'manual'`：POST 不跟跳。跟跳会把请求体带到跳转目标（302 → 内网 =
 *     把 POST 变成打内网的锤子），而 `03-fetch` 那边的每跳重过闸是 GET 的路，管不到这里。
 *   · 不写盘、不 spawn 子进程（受限 token 下管道 = EPERM）、无全局状态。
 *
 * ESM only，Node >= 22.19，零第三方依赖，零绝对路径。
 */

import { assertSafeUrl } from './libs/url-guard.js';

/** 与 ws-transport 同一个 UA（6 家里 Exa 无 UA 直接 403、Keenable 400、TinyFish 401，实测）。 */
export const API_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 2_000_000;

/**
 * 发一个 POST JSON 请求。返回形状**刻意与 `ws-transport.getHtml` 对齐**
 * （`ok` / `status` / `text` / `bytes` / `diagnosis`），这样卡片与上层不用记两套。
 *
 * @param {string} url
 * @param {{body?:any, headers?:Record<string,string>, timeoutMs?:number, maxBytes?:number,
 *          fetchImpl?:Function, assertImpl?:Function}} [opts]
 * @returns {Promise<{ok:boolean,status:number,text:string,bytes:number,contentType:string,
 *          via:string,diagnosis?:string,blocked?:boolean}>}
 */
export async function postJson(url, opts = {}) {
    const {
        body,
        headers = {},
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxBytes = DEFAULT_MAX_BYTES,
        fetchImpl = fetch,
        assertImpl,
    } = opts;

    // ① SSRF 闸：卡端点虽是硬编码，照过不误（B-12）。闸抛的是 err('URL_BLOCKED')，
    //    这里转成"失败信封"而不是往上抛 —— 一张卡被闸挡不该让整个聚合抛错。
    const assertSafe = typeof assertImpl === 'function' ? assertImpl : assertSafeUrl;
    let safeUrl;
    try {
        safeUrl = assertSafe(url);
    } catch (e) {
        return {
            ok: false, status: 0, text: '', bytes: 0, contentType: '', via: 'none',
            blocked: true, diagnosis: `url-guard: ${String(e?.message ?? e).slice(0, 200)}`,
        };
    }

    // ② 发请求
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(safeUrl, {
            method: 'POST',
            redirect: 'manual',          // ★ 不跟跳（见头注"边界"）
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'user-agent': API_UA,
                ...headers,
            },
            body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
        });

        const status = res.status;
        const contentType = (typeof res.headers?.get === 'function')
            ? (res.headers.get('content-type') || '')
            : '';

        // 3xx：POST 不跟跳 ⇒ 如实报，别装作成功也别装作网络错
        if (status >= 300 && status < 400) {
            const loc = (typeof res.headers?.get === 'function') ? (res.headers.get('location') || '') : '';
            return {
                ok: false, status, text: '', bytes: 0, contentType, via: 'none',
                diagnosis: `post redirect ${status} → ${loc.slice(0, 120)}（POST 不自动跟跳）`,
            };
        }

        const ab = await res.arrayBuffer();
        let bytes = new Uint8Array(ab);
        if (bytes.length > maxBytes) bytes = bytes.slice(0, maxBytes);
        const text = new TextDecoder('utf-8').decode(bytes);

        return {
            ok: status >= 200 && status < 300,
            status,
            text,
            bytes: bytes.length,
            contentType,
            via: 'post',
            ...(status >= 200 && status < 300 ? {} : { diagnosis: `http ${status}` }),
        };
    } catch (e) {
        const msg = e?.name === 'AbortError'
            ? `timeout: no response within ${timeoutMs}ms`
            : String(e?.message ?? e);
        return { ok: false, status: 0, text: '', bytes: 0, contentType: '', via: 'none', diagnosis: msg };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 把 SSE 正文里的 `data:` 行拼成一个 payload。
 * MCP 的流式约定：每个 `data:` 行是一段**同一条 JSON 的分片**，拼起来才完整。
 * 只在 content-type 确实是 event-stream（或正文确实长得像 SSE）时才该调它。
 *
 * @param {string} text
 * @returns {string|null} 没有 data 行时返回 null
 */
export function unwrapSse(text) {
    const payloads = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const m = line.match(/^data:\s?(.*)$/);
        if (!m) continue;
        const v = m[1].trim();
        if (v === '' || v === '[DONE]') continue;
        payloads.push(v);
    }
    return payloads.length > 0 ? payloads.join('') : null;
}

/**
 * 按**实测到的 content-type** 把响应正文取成"可 parse 的那一层字符串"。
 *
 * ★ 为什么不信 `content-type` 一个信号：某些站会返回 `application/json` 但正文其实是 SSE
 *   （反向也见过）。所以两个信号取"或"：header 说是 SSE，或正文第一行就是 event:/data:。
 *
 * @param {string} text 原始正文
 * @param {string} contentType 响应头
 * @returns {string} 剥好壳的 payload（可能仍是 JSON 字符串，也可能仍 parse 不了 —— 交给卡片判）
 */
export function apiPayload(text, contentType = '') {
    const raw = String(text ?? '');
    const looksSse = /text\/event-stream/i.test(contentType) || /^\s*(event:|data:)/m.test(raw);
    if (!looksSse) return raw;
    const merged = unwrapSse(raw);
    return merged ?? raw;
}

/**
 * 剥 MCP 的双层 JSON。
 *
 * 实测形状（L-009）：
 *   Parallel：`{"jsonrpc","id","result":{"content":[{"text":"<内层 JSON 字符串>"}]}}`
 *   TinyFish：`{"jsonrpc","result":{"content":[{"type":"text","text":"<内层 JSON 字符串>"}]}}`
 *   Exa     ：`{"result":{"content":[{"type":"text","text":"<纯文本块，不是 JSON>"}]}}`
 *
 * ⇒ 内层**可能是 JSON 也可能不是**（Exa 就是纯文本）。这里只负责把它取出来、
 *   能 parse 就顺手 parse，parse 不了原样放 `innerText` 交给卡片。
 *
 * @param {string} payload 已经过 {@link apiPayload} 的字符串
 * @returns {{outer:any, inner:any, innerText:string}}
 */
export function mcpInner(payload) {
    let outer;
    try {
        outer = JSON.parse(payload);
    } catch {
        return { outer: null, inner: null, innerText: '' };
    }
    const first = outer?.result?.content?.[0] ?? outer?.content?.[0] ?? null;
    const innerText = (first && typeof first.text === 'string') ? first.text : '';
    let inner = null;
    if (innerText) {
        try { inner = JSON.parse(innerText); } catch { inner = null; /* Exa：纯文本，正常 */ }
    }
    return { outer, inner, innerText };
}

/**
 * 一站式取货：POST → 判 content-type → 剥 SSE → 剥 MCP 内层。
 * 卡片里最常见的三行就变成一行。
 *
 * @returns {Promise<{ok:boolean, status:number, bytes:number, contentType:string,
 *          outer:any, inner:any, innerText:string, diagnosis?:string}>}
 */
export async function callMcp(url, { body, headers, timeoutMs, maxBytes, fetchImpl, assertImpl } = {}) {
    const res = await postJson(url, { body, headers, timeoutMs, maxBytes, fetchImpl, assertImpl });
    if (!res.ok) {
        return { ok: false, status: res.status, bytes: res.bytes, contentType: res.contentType, outer: null, inner: null, innerText: '', diagnosis: res.diagnosis };
    }
    const payload = apiPayload(res.text, res.contentType);
    const { outer, inner, innerText } = mcpInner(payload);
    return { ok: true, status: res.status, bytes: res.bytes, contentType: res.contentType, outer, inner, innerText };
}

/**
 * 一站式取货（非 MCP 的裸 JSON API：AnySearch / Keenable / Firecrawl）。
 *
 * @returns {Promise<{ok:boolean, status:number, bytes:number, contentType:string, json:any, diagnosis?:string}>}
 */
export async function callJson(url, { body, headers, timeoutMs, maxBytes, fetchImpl, assertImpl } = {}) {
    const res = await postJson(url, { body, headers, timeoutMs, maxBytes, fetchImpl, assertImpl });
    if (!res.ok) {
        return { ok: false, status: res.status, bytes: res.bytes, contentType: res.contentType, json: null, diagnosis: res.diagnosis };
    }
    const payload = apiPayload(res.text, res.contentType);
    let json = null;
    try { json = JSON.parse(payload); } catch { json = null; }
    return {
        ok: json !== null,
        status: res.status,
        bytes: res.bytes,
        contentType: res.contentType,
        json,
        ...(json === null ? { diagnosis: 'response is not valid JSON' } : {}),
    };
}
