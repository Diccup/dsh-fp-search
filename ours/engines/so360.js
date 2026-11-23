/**
 * engines/so360.js — 活卡 · order 5 · 形态=声明式（htmlRules）
 *
 * 搬迁自 1.0.0 `ws-engines.js:300-305`（ENGINES.so360），行为完整不变。
 * · htmlItems 五家之一：只带 htmlRules，由构建器调公共 `htmlItems(rules)` 绑定。
 * · 四条正则完整沿用参考实现（urlRe 是二选一捕获组，snippetRe 是二选一）。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；本卡无自 import 需求。
 */
export default {
    id: 'so360',
    order: 5,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}&rn=10`,
    htmlRules: {
        blockRe: /<li[^>]*class="[^"]*res-list[^"]*"[^>]*>[\s\S]*?<\/li>/g,
        titleRe: /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/,
        urlRe: /data-mdurl="([^"]+)"|href="([^"]+)"/,
        snippetRe: /<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>|<span[^>]*class="[^"]*res-list-summary[^"]*"[^>]*>([\s\S]*?)<\/span>/,
    },
    trash: null,
};
