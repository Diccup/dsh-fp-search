/**
 * engines-offline/v2ex.js — 离线卡（永不 import）· 真卡
 *
 * 来源：1.0.0 `ws-engines.js:359-365`（S9.51 注释态条目）。
 *   实测 5,014ms 超时 / 0 条，与 ddg / wikipedia / wikidata / archive 同病。
 *
 * 形态 = **真卡**（02 规矩 6：offline 永不 import，注释态卡反而丢信息 ⇒ 真卡进 offline）。
 *   本卡自带 parse 函数体（内联 lambda 一类），恢复时直接挪回 ../engines/ 即可用。
 *
 * 恢复方式：把本文件挪回 ../engines/ 并按当时表序重赋 order。
 * · 禁 TLA（钉死项 7）。
 */

export default {
    id: 'v2ex',
    order: null,          // offline 卡不参与活表键序；恢复时按当时表序重赋
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://www.v2ex.com/api/topics/search.json?q=${encodeURIComponent(query)}`,
    parse: (json, limit, ctx) => {
        return ctx.normalize((JSON.parse(json) ?? []).map((t) => ({
            title: t.title ?? '',
            url: `https://www.v2ex.com/t/${t.id ?? ''}`,
            snippet: t.content ?? '',
        })), limit);
    },
    trash: null,
};
