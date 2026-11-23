/**
 * engines/github.js — 活卡 · order 2 · 形态=声明式（parseKey）
 *
 * 搬迁自 1.0.0 `ws-engines.js:290`（ENGINES.github）。
 * · ★ 2026-11-07 S9.54：删掉 `&sort=stars`（维护方 15:5x 已拍）—— GitHub 不传 sort 时
 *   默认就是 best-match 相关度排，带上 sort=stars 等于我们把"按星数"塞在引擎前面。
 * · 冻结 parser parseGithub 留 ws-engines.js 公共件（S55 冻结面），
 *   本卡只带 `parseKey:'parseGithub'`，由构建器按名绑定（钉死项 4/5）。
 * · 禁 TLA；不 import ws-engines.js；本卡无自 import 需求。
 */
export default {
    id: 'github',
    order: 2,
    kind: 'vertical',
    covers: ['dev'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query, limit) => `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
    parseKey: 'parseGithub',
    trash: null,
};
