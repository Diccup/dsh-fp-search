/**
 * engines/arxiv.js — 活卡 · order 13 · 形态=声明式（内联 lambda）
 *
 * 搬迁自 1.0.0 `ws-engines.js:417-425`（ENGINES.arxiv），行为完整不变。
 * · 内联 lambda 一类（XML 解析）；htmlToText 用 stripTags 代替（完整等价）。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；只 import 叶子件 ../ws-text.js（无环）。
 */
import { stripTags } from '../ws-text.js';

export default {
    id: 'arxiv',
    order: 13,
    kind: 'vertical',
    covers: ['academic'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query, limit) => `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`,
    parse: (xml, limit, ctx) => {
        const blocks = String(xml ?? '').match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
        return ctx.normalize(blocks.map((b) => {
            const title = (b.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '';
            const link = (b.match(/<id>([\s\S]*?)<\/id>/) ?? [])[1] ?? '';
            const summary = (b.match(/<summary>([\s\S]*?)<\/summary>/) ?? [])[1] ?? '';
            return { title: stripTags(title), url: link, snippet: stripTags(summary) };
        }), limit);
    },
    trash: null,
};
