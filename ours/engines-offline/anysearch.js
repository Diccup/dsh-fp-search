/**
 * engines/anysearch.js — 活卡 · order 20 · 形态=自定义 run（裸 POST JSON，无任何前置）
 *
 * 新增于 2026-11-09 片 5（维护方 18:3x「1全接」）。
 *
 * 实测形状（02 项目 L-009）：
 *   · 请求：POST https://api.anysearch.com/v1/search，**不需要任何特殊头**
 *   · 响应：`application/json`
 *           `{ code:0, message:"success", request_id, data:{ results:[ { title, url, snippet, content } ] } }`
 *   · `content` = 长正文段（≤3840 字）→ **只进 `_snippet_raw`**
 *   · 体积：9,147 B；无日期字段
 *
 * 依据：02 项目 L-009；`Reference\02` §2.5 / §四。
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）。
 */

import { callJson } from '../ws-api.js';
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://api.anysearch.com/v1/search';

export default {
    id: 'anysearch',
    order: 20,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    run: async (query, limit, ctx) => {
        const r = await callJson(ENDPOINT, {
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: { query, max_results: limit, format: 'json' },
            timeoutMs: ctx?.opts?.timeoutMs,
        });

        if (!r.ok) throw failure('anysearch', r.status || 'unavailable', r.diagnosis || 'post failed');

        // 业务层成功判定：code === 0（实测成功态）；非 0 当失败报，不装作空结果
        const code = r.json?.code;
        if (typeof code === 'number' && code !== 0) {
            throw failure('anysearch', 'unavailable', `code=${code} ${r.json?.message ?? ''}`.trim());
        }

        const rows = Array.isArray(r.json?.data?.results) ? r.json.data.results : [];
        return ctx.normalize(rows.map((o) => {
            const body = typeof o?.content === 'string' ? o.content : '';
            return {
                title: o?.title ?? '',
                url: o?.url ?? '',
                snippet: o?.snippet ?? '',
                _snippet_raw: body || (o?.snippet ?? ''),   // ★ 长正文留卡片层
            };
        }), limit);
    },
    trash: null,
};
