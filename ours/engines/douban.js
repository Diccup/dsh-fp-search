/**
 * engines/douban.js — 活卡 · order 11 · 形态=声明式（htmlRules）
 *
 * 搬迁自 1.0.0 `ws-engines.js:384-389`（ENGINES.douban），行为完整不变。
 * · htmlItems 五家之一：只带 htmlRules，由构建器调公共 `htmlItems(rules)` 绑定。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；本卡无自 import 需求。
 */
export default {
    id: 'douban',
    order: 11,
    kind: 'vertical',
    covers: ['media', 'review'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://www.douban.com/search?q=${encodeURIComponent(query)}`,
    htmlRules: {
        blockRe: /<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/div>/g,
        titleRe: /<a[^>]*>([\s\S]*?)<\/a>/,
        urlRe: /href="([^"]+)"/,
        snippetRe: /<p[^>]*class="[^"]*abstract[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    },
    trash: null,
};
