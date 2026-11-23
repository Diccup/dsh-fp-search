/**
 * engines/hackernews.js — 活卡 · order 9 · 形态=声明式（内联 lambda）
 *
 * 搬迁自 1.0.0 `ws-engines.js:366-372`（ENGINES.hackernews），行为完整不变。
 * · 内联 lambda 一类；本卡无 htmlToText 调用（标题/摘要原样透传），故不 import ws-text.js。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）。
 */

export default {
    id: 'hackernews',
    order: 9,
    kind: 'vertical',
    covers: ['dev'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story`,
    parse: (json, limit, ctx) => {
        return ctx.normalize((JSON.parse(json)?.hits ?? []).map((h) => ({
            title: h.title ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
            url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
            snippet: h.story_text ?? '',
        })), limit);
    },
    trash: null,
};
