/**
 * engines/pypi.js — 活卡 · order 17 · 形态=声明式（htmlRules）
 *
 * 搬迁自 1.0.0 `ws-engines.js:490-495`（ENGINES.pypi），行为完整不变。
 * · htmlItems 五家之一：只带 htmlRules，由构建器调公共 `htmlItems(rules)` 绑定。
 * · ★ P3② pypi 处置 —— **批次 1 不动**（照搬现状，含空壳行为：页面是 JS 空壳，
 *   结构上拿不到 /project/ 链接，属后续批次议题）。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；本卡无自 import 需求。
 */
export default {
    id: 'pypi',
    order: 17,
    kind: 'vertical',
    covers: ['dev'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://pypi.org/search/?q=${encodeURIComponent(query)}`,
    htmlRules: {
        blockRe: /<a[^>]*class="[^"]*package-snippet__name[^"]*"[^>]*>[\s\S]*?<\/a>/g,
        titleRe: />([\s\S]*?)</,
        urlRe: /href="([^"]+)"/,
        snippetRe: /<p[^>]*class="[^"]*package-snippet__description[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    },
    trash: null,
};
