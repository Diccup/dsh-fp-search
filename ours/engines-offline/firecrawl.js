/**
 * engines/firecrawl.js — 活卡 · order 23 · 形态=自定义 run（裸 POST JSON，最薄）
 *
 * 新增于 2026-11-09 片 5（维护方 18:3x「1全接」）。
 *
 * 实测形状（02 项目 L-009）：
 *   · 请求：POST https://api.firecrawl.dev/v1/search，**不需要任何特殊头**
 *   · 响应：`application/json`  `{ success:true, data:[ { url, title, description } ], id }`
 *   · 体积：916 B / 3 条 —— **6 家里最薄**，没有 snippet 字段（叫 `description`）
 *
 * ★ 为什么"最薄"还接：需求方要求全接。它的真正价值在 `/v1/scrape`（抓正文），
 *   而那一路接的是 `page()` 兜底腿（另一步，见立项书 §2.1），不是这张搜索卡的事。
 *   本卡只做 search 面，字段薄是它的固有属性、不是 bug。
 *
 * 依据：02 项目 L-009；`Reference\02` §2.5 / §四；三堆 C-1。
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）。
 */

import { callJson } from '../ws-api.js';
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://api.firecrawl.dev/v1/search';

export default {
    id: 'firecrawl',
    order: 23,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    run: async (query, limit, ctx) => {
        const r = await callJson(ENDPOINT, {
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: { query, limit },
            timeoutMs: ctx?.opts?.timeoutMs,
        });

        if (!r.ok) throw failure('firecrawl', r.status || 'unavailable', r.diagnosis || 'post failed');
        if (r.json?.success === false) {
            throw failure('firecrawl', 'unavailable', String(r.json?.error ?? 'success=false'));
        }

        const rows = Array.isArray(r.json?.data) ? r.json.data : [];
        return ctx.normalize(rows.map((o) => ({
            title: o?.title ?? '',
            url: o?.url ?? '',
            snippet: o?.description ?? '',   // ★ 这家没有 snippet，字段叫 description
        })), limit);
    },
    trash: null,
};
