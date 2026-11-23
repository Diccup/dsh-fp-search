/**
 * engines-offline/wikidata.js — 离线卡（永不 import）· 真卡
 *
 * 来源：1.0.0 `ws-engines.js:499-505`（S9.51 注释态条目）。
 *   两轮实测各 5,006–5,014ms 超时 / 0 条，与 ddg / wikipedia / v2ex 同病。
 *
 * 形态 = **真卡**（02 规矩 6）。本卡自带 parse 函数体，恢复时直接挪回 ../engines/ 即可用。
 *
 * 恢复方式：把本文件挪回 ../engines/ 并按当时表序重赋 order。
 * · 禁 TLA（钉死项 7）。
 */

export default {
    id: 'wikidata',
    order: null,          // offline 卡不参与活表键序；恢复时按当时表序重赋
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query, limit) => `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=zh&format=json&limit=${limit}`,
    parse: (json, limit, ctx) => {
        return ctx.normalize((JSON.parse(json)?.search ?? []).map((e) => ({
            title: e.label ?? e.id ?? '',
            url: `https://www.wikidata.org/wiki/${e.id ?? ''}`,
            snippet: e.description ?? '',
        })), limit);
    },
    trash: null,
};
