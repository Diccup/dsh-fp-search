/**
 * engines/nvd.js — 活卡 · order 16 · 形态=声明式（内联 lambda）
 *
 * 搬迁自 1.0.0 `ws-engines.js:472-489`（ENGINES.nvd），行为完整不变。
 * · CVE ID 形查询词走 cveId 参数（keywordSearch 对带连字符的 CVE ID 不命中），其余走 keywordSearch。
 * · NVD 2.0 真实结构: vulnerabilities[].cve.{id,descriptions[],references[]}——旧解析读
 *   cvssData.references（不存在的键）永远 0 命中（2026-10-31 外测修复）。
 * · ★ P3③ NVD 别名映射表 —— **批次 1 不动**（照搬现状）。
 * · 内联 lambda 一类；本卡无 htmlToText 调用（描述原样透传），故不 import ws-text.js。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）。
 */

export default {
    id: 'nvd',
    order: 16,
    kind: 'vertical',
    covers: ['security'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query, limit) => {
        // CVE ID 形查询词走 cveId 参数（keywordSearch 对带连字符的 CVE ID 不命中），其余走 keywordSearch
        const q = String(query).trim();
        const isCveId = /^CVE-\d{4}-\d{4,}$/i.test(q);
        const param = isCveId ? `cveId=${encodeURIComponent(q)}` : `keywordSearch=${encodeURIComponent(query)}`;
        return `https://services.nvd.nist.gov/rest/json/cves/2.0?${param}&resultsPerPage=${limit}`;
    },
    parse: (json, limit, ctx) => {
        // NVD 2.0 真实结构: vulnerabilities[].cve.{id,descriptions[],references[]}——旧解析读 cvssData.references（不存在的键）永远 0 命中（2026-10-31 外测修复）
        const vulns = JSON.parse(json)?.vulnerabilities ?? [];
        return ctx.normalize(vulns.map((v) => {
            const cve = v.cve ?? {};
            return {
                title: cve.id ?? '',
                url: cve.id ? `https://nvd.nist.gov/vuln/detail/${cve.id}` : '',
                snippet: cve.descriptions?.[0]?.value ?? '',
            };
        }), limit);
    },
    trash: null,
};
