/**
 * engines/sogou.js — 活卡 · order 4 · 形态=声明式（htmlRules）
 *
 * 搬迁自 1.0.0 `ws-engines.js:294-299`（ENGINES.sogou），行为完整不变。
 * · htmlItems 五家之一（sogou/so360/sogou_wechat/douban/pypi）：
 *   本卡**只带 htmlRules 对象**，由构建器/调度器调公共 `htmlItems(rules)` 绑定
 *   （02 v1.2 钉死项）。四条正则完整沿用参考实现。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；本卡无自 import 需求。
 */
export default {
    id: 'sogou',
    order: 4,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    htmlRules: {
        blockRe: /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>[\s\S]*?<\/h3>/g,
        titleRe: /<a[^>]*>([\s\S]*?)<\/a>/,
        urlRe: /href="([^"]+)"/,
        snippetRe: /<\/h3>[\s\S]*?<\/div>/,
    },
    trash: null,
};
