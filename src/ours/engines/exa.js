/**
 * engines/exa.js — 活卡 · order 22 · 形态=自定义 run（MCP + SSE，且内层是**纯文本**）
 *
 * 新增于 2026-11-09 片 5（维护方 18:3x「1全接」）。
 *
 * 实测形状（02 项目 L-009）：
 *   · 请求：POST https://mcp.exa.ai/mcp，JSON-RPC tools/call name='web_search_exa'
 *           **必须带浏览器 UA**（少了 403）+ **`Accept: application/json, text/event-stream`**
 *           （少了 406）—— 两个头缺一不可，实测
 *   · 响应：`text/event-stream`；`data: {"result":{"content":[{"type":"text","text":"<纯文本>"}]}}`
 *   · ★★ 内层**不是 JSON**，是逐条拼的纯文本块：
 *          `Title: … \nURL: … \nPublished: 2026-11-03T12:35:58.000Z \nAuthor: N/A \nHighlights:\n<正文>`
 *          块与块之间以 `\nTitle: ` 分隔（实测 3 块 / 7,981 字符）
 *          ⇒ **不能用 `mcpInner().inner`**（那对 Exa 恒为 null），要用 `innerText` 自己切
 *
 * ★ 限流（C-4，两份实测矛盾，本片按"有风险"处理）：
 *   `Reference\02` §2.3 / §三实测「4 并发每批恰掉一个」「8 并发 200:4 / 429:4」；
 *   合并稿 §1.4 记「3 并发全 200」。⇒ 进聚合，**靠 A-1 冷却表兜**，并发梯度另测。
 *
 * 依据：02 项目 L-009；`Reference\02` §2.3 / §三 / §四；三堆 C-4。
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）。
 */

import { callMcp, API_UA } from '../ws-api.js';
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://mcp.exa.ai/mcp';

/**
 * 把 Exa 的纯文本块切成条目。
 * 每块形如：Title / URL / Published / Author / Highlights
 * `Highlights:` 之后到下一个 `Title:` 之前都是正文。
 *
 * @param {string} text
 * @returns {{title:string,url:string,published:string,snippet:string}[]}
 */
function parseExaText(text) {
    const raw = String(text ?? '').trim();
    if (raw === '') return [];

    // 按行切块：只在**行首**的 "Title:" 处分段（正文里也可能出现 Title: 字样，但不会顶格）
    const blocks = raw.split(/\r?\n(?=Title:\s)/).filter((b) => b.trim() !== '');
    const out = [];
    for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        let title = '';
        let url = '';
        let published = '';
        let hi = -1;
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (hi < 0) {
                const mt = line.match(/^Title:\s*(.*)$/);
                const mu = line.match(/^URL:\s*(\S+)\s*$/);
                const mp = line.match(/^Published:\s*(.*)$/);
                if (mt) title = mt[1].trim();
                else if (mu) url = mu[1].trim();
                else if (mp) published = mp[1].trim();
                else if (/^Highlights:\s*$/.test(line)) hi = i;
            }
        }
        const body = hi >= 0 ? lines.slice(hi + 1).join('\n').trim() : '';
        if (url !== '') {
            out.push({ title: title || url, url, published, snippet: body });
        }
    }
    return out;
}

export default {
    id: 'exa',
    order: 22,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: API_UA,           // ★ 卡自带 UA（实测缺 UA → 403）
    headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    },
    run: async (query, limit, ctx) => {
        const r = await callMcp(ENDPOINT, {
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'user-agent': API_UA,     // ★ 显式再给一次，不依赖 ws-api 的默认
            },
            body: {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'web_search_exa', arguments: { query, numResults: limit } },
            },
            timeoutMs: ctx?.opts?.timeoutMs,
        });

        if (!r.ok) throw failure('exa', r.status || 'unavailable', r.diagnosis || 'post failed');
        // ★ 这里必须用 innerText 而不是 inner：Exa 的内层是纯文本，inner 恒 null
        if (typeof r.innerText !== 'string' || r.innerText.trim() === '') {
            throw failure('exa', 'empty', 'MCP content[0].text 是空的（形状可能变了）');
        }

        const rows = parseExaText(r.innerText);
        return ctx.normalize(rows.map((o) => ({
            title: o.title,
            url: o.url,
            snippet: o.snippet.slice(0, 400),
            _snippet_raw: o.snippet,      // ★ 长正文留卡片层
            _published: o.published,      // 决议#5：不进交付
        })), limit);
    },
    trash: null,
};

// 仅供门/自测使用（不进卡片契约面；导出名带 __ 前缀与现有 internals 同风格）
export const __parseExaText = parseExaText;
