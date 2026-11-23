/**
 * engines/mso.js — 活卡 · order 12 · 形态=自定义 run（jump 解码 + data-pcurl 兜底）
 *
 * 搬迁自 1.0.0 `ws-engines.js:394-414`（ENGINES.mso），行为完整不变。
 *
 * mso: 360 手机版结果页。jump 链（m.so.com/jump?u=<enc>）携带知乎/抖音/头条/新浪/网易
 * 等全网平台的真实链接，一个引擎通吃中文平台站内内容（2026-11-01 外部会话实测通道，
 * 同关键词复现：知乎/头条/新浪/抖音/163 全命中）。解析：a.alink+jump 解码，卡片 data-pcurl 兜底。
 *
 * · htmlToText 用 stripTags 代替（1.0.0 ws-engines.js:141 完整等价）。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；只 import 叶子件 ../ws-text.js（无环）。
 */
import { stripTags } from '../ws-text.js';

/** htmlToText = stripTags（1.0.0 ws-engines.js:141 完整等价）。 */
function htmlToText(html) { return stripTags(html); }

export default {
    id: 'mso',
    order: 12,
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    run: async (query, limit, ctx) => {
        const text = await ctx.load(`https://m.so.com/s?q=${encodeURIComponent(query)}`, 'mso', ctx.opts);
        const entries = [...String(text).matchAll(/<a class="?alink"?\s+href="([^"]+)"[^>]*>\s*<h3 class="res-title">([\s\S]*?)<\/h3>/g)];
        const selfHost = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
        const items = entries.map((m) => {
            let url = '';
            const jm = String(m[1]).match(/[?&]u=([^&]+)/);
            try { url = jm ? decodeURIComponent(jm[1]) : m[1]; } catch { url = m[1]; }
            // jump 解不出 http 时，回退卡片级明文真链 data-pcurl（位于条目之前的卡片根节点上）
            if (!/^https?:\/\//i.test(url)) {
                const pc = String(text).slice(Math.max(0, m.index - 900), m.index).match(/data-pcurl="([^"]+)"/);
                url = pc?.[1] ?? url;
            }
            const after = String(text).slice(m.index + m[0].length, m.index + m[0].length + 1500);
            const sm = after.match(/class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/);
            return { title: htmlToText(m[2]), url, snippet: sm ? htmlToText(sm[1]) : '' };
        });
        return ctx.normalize(items.filter((it) => /^https?:\/\//i.test(it.url) && !/(^|\.)m\.so\.com$/.test(selfHost(it.url))), limit);
    },
    trash: null,
};
