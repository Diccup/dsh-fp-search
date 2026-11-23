/**
 * engines/pubmed.js — 活卡 · order 15 · 形态=自定义 run（两段式 esearch→esummary）
 *
 * 搬迁自 1.0.0 `ws-engines.js:451-471`（ENGINES.pubmed），行为完整不变。
 * · 两段式：esearch 拿 id 列表 → esummary 拿元数据。
 * · 无 id 时抛 `failure('pubmed','empty','no ids found')`（码与文案完整沿用参考实现）。
 * · 所有 load 的 scope = 卡 id（transport engineHint 按 id 分流）。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；本卡无自 import 需求。
 */
export default {
    id: 'pubmed',
    order: 15,
    kind: 'vertical',
    covers: ['medical'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    run: async (query, limit, ctx) => {
        const enc = encodeURIComponent(query);
        const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${enc}&retmax=${limit}&retmode=json`;
        const searchText = await ctx.load(searchUrl, 'pubmed', ctx.opts);
        const ids = JSON.parse(searchText)?.esearchresult?.idlist ?? [];
        if (!ids.length) throw ctx.failure('pubmed', 'empty', 'no ids found');
        const idStr = ids.join(',');
        const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${idStr}&retmode=json`;
        const summaryText = await ctx.load(summaryUrl, 'pubmed', ctx.opts);
        const result = JSON.parse(summaryText)?.result ?? {};
        return ctx.normalize(ids.map((id) => {
            const doc = result[id] ?? {};
            return {
                title: doc.title ?? '',
                url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
                snippet: `${doc.source ?? ''} ${doc.pubdate ?? ''}`.trim(),
            };
        }), limit);
    },
    trash: null,
};
