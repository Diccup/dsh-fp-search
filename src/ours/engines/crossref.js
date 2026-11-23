/**
 * engines/crossref.js — 活卡 · order 14 · 形态=声明式（内联 lambda）
 *
 * 搬迁自 1.0.0 `ws-engines.js:431-437`（ENGINES.crossref），行为完整不变。
 * · ★ 2026-11-07 S9.54：`select` 补 `abstract`（20 §G2）。正确写法是 `full`：
 *   猜参数名（title,abstract）会被 Crossref 静默忽略。实测 `select=title,DOI,URL,abstract`
 *   在 5 个查询上只有 1 个查询的 5 条里 3 条带 abstract（其余全是字段不存在），
 *   而 CVE 那类查询本来就不该有摘要 —— 这条的收益只体现在学术查询上，不是"摘要归零"的普适解。
 *   abstract 是带 JATS 标签的 HTML，先 stripTags。
 * · 内联 lambda 一类；stripTags 直接 import 叶子件 ../ws-text.js。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）。
 */
import { stripTags } from '../ws-text.js';

export default {
    id: 'crossref',
    order: 14,
    kind: 'vertical',
    covers: ['academic'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query, limit) => `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&select=title,DOI,URL,abstract`,
    parse: (json, limit, ctx) => {
        return ctx.normalize((JSON.parse(json)?.message?.items ?? []).map((w) => ({
            title: (w.title ?? []).join(' ') ?? '',
            url: w.URL ?? (w.DOI ? `https://doi.org/${w.DOI}` : ''),
            snippet: stripTags(w.abstract ?? ''),
        })), limit);
    },
    trash: null,
};
