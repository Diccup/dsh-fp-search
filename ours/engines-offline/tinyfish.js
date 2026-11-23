/**
 * engines/tinyfish.js — 活卡 · order 19 · 形态=自定义 run（MCP，但**返回普通 JSON**）
 *
 * 新增于 2026-11-09 片 5（维护方 18:3x「1全接」）。
 *
 * ★★ 本卡最重要的一条实测（与 Reference 不一致，以实测为准）：
 *   `Reference\02` §2.2 与合并稿 §附 都写 TinyFish 是 "MCP + SSE" —— **实测不是**。
 *   2026-11-09 单发预检：`content-type: application/json`，正文无 `event:`/`data:` 行。
 *   ⇒ 解析**按 content-type 判**（`ws-api.callMcp` 已按此实现），不许按"是不是 MCP"猜。
 *
 * 其余形状：
 *   · 请求：POST https://agent.tinyfish.ai/mcp，JSON-RPC tools/call name='search'
 *           **必须带 `X-TinyFish-Access-Mode: keyless`**，少了直接 401（实测）
 *   · 响应：`{jsonrpc,result:{content:[{type:'text',text:"<内层 JSON 字符串>"}]}}` ⇒ 双层 parse
 *   · 内层字段：`results[] = { position, site_name, date?, snippet, title, url }`
 *   · 体积：4,770 B（6 家里较小），中文命中准、0.5–1.6 s
 *
 * 依据：02 项目 2-开发日志 L-009；`Reference\02` §2.2 / §四。
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）。
 */

import { callMcp } from '../ws-api.js';
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://agent.tinyfish.ai/mcp';

export default {
    id: 'tinyfish',
    order: 19,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        // ★ 少这个头就 401（实测）。值固定，不是可选装饰。
        'X-TinyFish-Access-Mode': 'keyless',
    },
    run: async (query, limit, ctx) => {
        const r = await callMcp(ENDPOINT, {
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'X-TinyFish-Access-Mode': 'keyless',
            },
            body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'search', arguments: { query } },
            },
            timeoutMs: ctx?.opts?.timeoutMs,
        });

        if (!r.ok) throw failure('tinyfish', r.status || 'unavailable', r.diagnosis || 'post failed');
        if (r.inner === null) throw failure('tinyfish', 'empty', 'MCP 内层不是 JSON（形状可能变了）');

        const rows = Array.isArray(r.inner.results) ? r.inner.results : [];
        return ctx.normalize(rows.map((o) => ({
            title: o?.title ?? '',
            url: o?.url ?? '',
            snippet: o?.snippet ?? '',
            _site_name: o?.site_name ?? '',   // 卡片层字段，不参与交付
            _date: o?.date ?? '',             // 决议#5：不进交付
        })), limit);
    },
    trash: null,
};
