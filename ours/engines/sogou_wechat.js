/**
 * engines/sogou_wechat.js — 活卡 · order 7 · 形态=声明式（htmlRules）
 *
 * 搬迁自 1.0.0 `ws-engines.js:341-346`（ENGINES.sogou_wechat），行为完整不变。
 * · htmlItems 五家之一：只带 htmlRules，由构建器调公共 `htmlItems(rules)` 绑定。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；本卡无自 import 需求。
 */
export default {
    id: 'sogou_wechat',
    order: 7,
    kind: 'vertical',
    covers: ['zh', 'news'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://weixin.sogou.com/weixin?query=${encodeURIComponent(query)}`,
    htmlRules: {
        blockRe: /<li[^>]*id="sogou_vr_[^"]*"[^>]*>[\s\S]*?<\/li>/g,
        titleRe: /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/,
        urlRe: /href="([^"]+)"/,
        snippetRe: /<p[^>]*class="[^"]*txt-info[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    },
    trash: null,
};
