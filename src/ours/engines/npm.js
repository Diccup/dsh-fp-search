/**
 * engines/npm.js — 活卡 · order 3 · 形态=声明式（parseKey）
 *
 * 搬迁自 1.0.0 `ws-engines.js:291`（ENGINES.npm）。
 * · 冻结 parser parseNpm 留 ws-engines.js 公共件（S55 冻结面），
 *   本卡只带 `parseKey:'parseNpm'`，由构建器按名绑定（钉死项 4/5）。
 * · 禁 TLA；不 import ws-engines.js；本卡无自 import 需求。
 */
export default {
    id: 'npm',
    order: 3,
    kind: 'vertical',
    covers: ['dev'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query, limit) => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`,
    parseKey: 'parseNpm',
    trash: null,
};
