/**
 * engines/parallel.js — 活卡 · order 18 · 形态=自定义 run（MCP + SSE）
 *
 * 新增于 2026-11-09 片 5（维护方 18:3x「1全接」）。形状由实测钉死，不靠文档：
 *   · 请求：POST https://mcp.parallel.ai/mcp，JSON-RPC tools/call
 *           `arguments` **必须同时给 objective + search_queries[数组]**，少一个就 isError
 *   · 响应：`text/event-stream`，`event: message` / `data: {jsonrpc,id,result:{content:[{text}]}}`
 *           内层 text 是**字符串形式的 JSON** ⇒ 双层 parse（`ws-api.mcpInner` 已代劳）
 *   · 内层字段：`results[] = { url, title, publish_date?, excerpts:[str] }`
 *   · 体积：实测 50,093 B / 10 条 / excerpts 单条最长 2,495 字符（3,655 B）
 *     ⇒ **长正文只能进 `_snippet_raw`**，绝不拼进 `snippet`（S9.54 纪律；180 交付不变）
 *
 * 依据：02 项目 2-开发日志 L-009（实测形状表）；`Reference\02-六家免费通道连通性实测` §2.4。
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）；只 import 同 lane 的 `ws-api.js` / `ws-text.js`。
 */

import { callMcp } from '../ws-api.js';
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://mcp.parallel.ai/mcp';

export default {
    id: 'parallel',
    order: 18,
    kind: 'vertical',
    covers: ['news', 'zh', 'ph'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,          // UA 由 ws-api.API_UA 统一给（实测缺 UA 会被 403 的只有 Exa，但统一更稳）
    headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    },
    run: async (query, limit, ctx) => {
        const r = await callMcp(ENDPOINT, {
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'web_search',
                    // objective 用同一句 query：它是给人读的"意图描述"，search_queries 是机器查的串
                    arguments: { objective: query, search_queries: [query] },
                },
            },
            timeoutMs: ctx?.opts?.timeoutMs,
        });

        if (!r.ok) throw failure('parallel', r.status || 'unavailable', r.diagnosis || 'post failed');
        if (r.inner === null) throw failure('parallel', 'empty', 'MCP 内层不是 JSON（形状可能变了）');

        const rows = Array.isArray(r.inner.results) ? r.inner.results : [];
        return ctx.normalize(rows.map((o) => {
            // excerpts 是字符串数组；拼起来是正文级内容（实测 1 条最长 2,495 字符）
            const long = Array.isArray(o?.excerpts) ? o.excerpts.filter((s) => typeof s === 'string' && s.trim() !== '').join('\n\n') : '';
            return {
                title: o?.title ?? '',
                url: o?.url ?? '',
                // snippet 只放短摘要（交付层还要裁 180），长文不进 snippet
                snippet: long.slice(0, 400),
                _snippet_raw: long,        // ★ 全量留卡片层，交付时才裁（S9.54）
                _publish_date: o?.publish_date ?? '',   // 决议#5：不进交付，只备查
            };
        }), limit);
    },
    trash: null,
};
