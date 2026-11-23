/**
 * engines/stackoverflow.js — 活卡 · order 10 · 形态=声明式（内联 lambda）
 *
 * 搬迁自 1.0.0 `ws-engines.js:377-383`（ENGINES.stackoverflow），行为完整不变。
 * · ★ 2026-11-07 S9.54：补 `&filter=withbody`（20 §G2 / 21 §G2）。
 *   不带时 StackExchange 的 `items[].body` 恒为空 —— 实测 30 条里 0 条有 body（摘要恒 0），
 *   带上后 30/30 全有值（首条 655 字符）。摘要归零会让这条结果在旧字面排序里直接沉底。
 *   body 是 HTML，parse 里先 stripTags 再交给 normalize。
 * · 内联 lambda 一类；stripTags 直接 import 叶子件 ../ws-text.js。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）。
 */
import { stripTags } from '../ws-text.js';

export default {
    id: 'stackoverflow',
    order: 10,
    kind: 'vertical',
    covers: ['dev'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&filter=withbody`,
    parse: (json, limit, ctx) => {
        return ctx.normalize((JSON.parse(json)?.items ?? []).map((q) => ({
            title: q.title ?? '',
            url: q.link ?? '',
            snippet: stripTags(q.body ?? ''),
        })), limit);
    },
    trash: null,
};
