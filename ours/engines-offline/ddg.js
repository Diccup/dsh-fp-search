/**
 * engines-offline/ddg.js — 离线卡（永不 import）· 壳卡
 *
 * 来源：1.0.0 `ws-engines.js:284`（S9.51 注释态条目，原位保留在活表注释里）。
 *   实测两轮：5,000ms 超时 / 0 条产出，与 v2ex / wikidata / archive 同病。
 *   五家合计把每次 search() 的墙钟钉死在 5.0s，砍掉后 2.4s（22 家并行）。
 *
 * 形态 = **壳卡**（02 规矩 6 + C-3）：parseDdg 是 S55 冻结面的公共件
 * （留 ws-engines.js 原样导出，web-search.js:255 冻结 re-export 依赖它），
 * 所以本卡只带 `parseKey:'parseDdg'`，由构建器按名绑定；
 * **本卡允许 import '../ws-engines.js' 取 parser**（规矩 2 括注：只约束活目录卡；
 * offline 永不 import ⇒ 无环）。
 *
 * 恢复方式：把本文件挪回 ../engines/ 并按当时表序重赋 order 即可。
 * · 禁 TLA（钉死项 7）。
 */
export default {
    id: 'ddg',
    order: null,          // offline 卡不参与活表键序；恢复时按当时表序重赋
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parseKey: 'parseDdg',
    trash: null,
};
