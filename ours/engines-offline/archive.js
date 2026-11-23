/**
 * engines-offline/archive.js — 离线卡（永不 import）· 真卡
 *
 * 来源：1.0.0 `ws-engines.js:506-512`（S9.51 注释态条目）。
 *   两轮实测各 5,006–5,014ms 超时 / 0 条，与 ddg / wikipedia / v2ex 同病。
 *
 * 形态 = **真卡**（02 规矩 6）。本卡自带 parse 函数体，恢复时直接挪回 ../engines/ 即可用。
 *
 * 恢复方式：把本文件挪回 ../engines/ 并按当时表序重赋 order。
 * · 禁 TLA（钉死项 7）。
 */

export default {
    id: 'archive',
    order: null,          // offline 卡不参与活表键序；恢复时按当时表序重赋
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query, limit) => `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=description&output=json&rows=${limit}&page=1`,
    parse: (json, limit, ctx) => {
        return ctx.normalize((JSON.parse(json)?.response?.docs ?? []).map((d) => ({
            title: d.title ?? d.identifier ?? '',
            url: `https://archive.org/details/${d.identifier ?? ''}`,
            snippet: d.description ?? '',
        })), limit);
    },
    trash: null,
};
