/**
 * engines/keenable.js — 活卡 · order 21 · 形态=自定义 run（裸 POST JSON + 一个必带头）
 *
 * 新增于 2026-11-09 片 5（维护方 18:3x「1全接」）。
 *
 * 实测形状（02 项目 L-009）：
 *   · 请求：POST https://api.keenable.ai/v1/search/public
 *           **必须带 `X-Keenable-Title`**（值随便填，但对岸要它存在；少了直接 400
 *           `{"error":"Missing app identifier", ...}` —— 实测）
 *   · 响应：`application/json`
 *           `{ query, mode:"pro", results:[ { title, url, description, snippet } ] }`
 *   · 体积：5,055 B；6 家里最快（823 ms）；`description` 多数为空
 *
 * 依据：02 项目 L-009；`Reference\02` §2.1 / §四。
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）。
 */

import { callJson } from '../ws-api.js';
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://api.keenable.ai/v1/search/public';

/** ★ 这个头不是可选装饰，是硬门槛（实测少了就 400）。值对岸填的是插件名。 */
const APP_TITLE = 'dsh-fp-search';

export default {
    id: 'keenable',
    order: 21,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Keenable-Title': APP_TITLE,
    },
    run: async (query, limit, ctx) => {
        const r = await callJson(ENDPOINT, {
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                'X-Keenable-Title': APP_TITLE,
            },
            body: { query, max_results: limit },
            timeoutMs: ctx?.opts?.timeoutMs,
        });

        if (!r.ok) throw failure('keenable', r.status || 'unavailable', r.diagnosis || 'post failed');

        const rows = Array.isArray(r.json?.results) ? r.json.results : [];
        return ctx.normalize(rows.map((o) => ({
            title: o?.title ?? '',
            url: o?.url ?? '',
            // description 多数为空 ⇒ 有 snippet 用 snippet，没有再用 description 兜
            snippet: (typeof o?.snippet === 'string' && o.snippet.trim() !== '')
                ? o.snippet
                : (o?.description ?? ''),
            _mode: r.json?.mode ?? '',
        })), limit);
    },
    trash: null,
};
