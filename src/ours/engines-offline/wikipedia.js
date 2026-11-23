/**
 * engines-offline/wikipedia.js — 离线卡（永不 import）· 壳卡
 *
 * 来源：1.0.0 `ws-engines.js:285`（S9.51 注释态条目）。
 *   实测两轮：5,000ms 超时 / 0 条产出，与 ddg / v2ex / wikidata / archive 同病。
 *
 * 形态 = **壳卡**（02 规矩 6 + C-3）：parseWikipedia 是 S55 冻结面的公共件
 * （留 ws-engines.js 原样导出，web-search.js:255 冻结 re-export 依赖它），
 * 所以本卡只带 `parseKey:'parseWikipedia'`，由构建器按名绑定。
 *
 * 恢复方式：把本文件挪回 ../engines/ 并按当时表序重赋 order 即可。
 * · 禁 TLA（钉死项 7）。
 */
export default {
    id: 'wikipedia',
    order: null,          // offline 卡不参与活表键序；恢复时按当时表序重赋
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`,
    parseKey: 'parseWikipedia',
    trash: null,
};
