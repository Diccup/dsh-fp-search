/**
 * engines-offline/openalex.js — 离线卡（永不 import）· 真卡
 *
 * 来源：1.0.0 `ws-engines.js:444-450`（N9 注释态条目）。
 *   实测依据：ENGINES.openalex.run() ×8 全 429；直连 api.openalex.org ×3 全 429；
 *   响应体明说「Insufficient budget. Keyless requests from this client, across every
 *   network it uses, share one free daily budget, and it is used up (resets at midnight UTC)」
 *   ⇒ 不是临时限流，是**无 key 的日额度长期耗尽**，一天里大部分时间都拿不到货。
 *
 * 形态 = **真卡**（02 规矩 6）。本卡自带 parse 函数体；
 * 将来加免费 API key 后可原样恢复（挪回 ../engines/ + 重赋 order）。
 *
 * 恢复方式：把本文件挪回 ../engines/ 并按当时表序重赋 order。
 * · 禁 TLA（钉死项 7）。
 */

export default {
    id: 'openalex',
    order: null,          // offline 卡不参与活表键序；恢复时按当时表序重赋
    kind: 'vertical',
    covers: ['academic'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query, limit) => `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}&select=title,doi,primary_location`,
    parse: (json, limit, ctx) => {
        return ctx.normalize((JSON.parse(json)?.results ?? []).map((w) => ({
            title: w.title ?? '',
            url: w.doi ? `https://doi.org/${w.doi}` : (w.primary_location?.landing_page_url ?? ''),
            snippet: '',
        })), limit);
    },
    trash: null,
};
