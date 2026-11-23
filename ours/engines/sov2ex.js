/**
 * engines/sov2ex.js — 活卡 · order 25 · 形态=自定义 run（GET JSON，免 key 免特殊头）
 *
 * 新增于 ITERATION-012（维护方「新卡该做做」）。V2EX 站内全文检索，FP 此前无此覆盖。
 *   （注：`engines-offline/v2ex.js` 是**旧卡**，早已因 5s 超时/0 产出被砍进 offline；
 *     本卡是**另一个入口**（sov2ex 第三方索引），不复活旧卡、也不受旧卡判据约束。
 *     两者 id 不同（sov2ex / v2ex），不冲突。）
 *
 * 实测形状（2026-11-21 真机）：
 *   · 请求：GET https://www.sov2ex.com/api/search?q=<q>&size=<n>
 *           **不需要任何头、不需要 key**（实测连打 6 次 + 5 路并发全 200，689ms 内跑完）
 *   · 响应：`application/json`  `{ took, total, hits:[ { _id, _source:{ id,title,content,created,replies,node,member } } ] }`
 *   · URL 自拼：`https://www.v2ex.com/t/{_id}`（响应里**没有**现成 url 字段）
 *   · `content` 是帖子正文（常含 Markdown/代码块）→ 短摘要给 snippet，长文留 `_snippet_raw`
 *   · 耗时：实测 80–213 ms —— **本仓最快的活引擎**
 *
 * 边界（实测）：
 *   · 空 query → HTTP 400 `{"message":"missing keyword"}` ⇒ 按 input 类失败上报
 *   · 超长 query → HTTP 400 `{"message":"too long keyword"}` ⇒ 同上
 *   · 两者都不伪装成"0 条"，避免调用方把"参数非法"误当"没搜到"
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）；只 import 叶子件 ../ws-text.js（无环）。
 */
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://www.sov2ex.com/api/search';

export default {
    id: 'sov2ex',
    order: 25,
    kind: 'vertical',
    covers: ['dev', 'zh'],
    nativeRank: 'relevance',
    quota: null,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    headers: { accept: 'application/json' },
    run: async (query, limit, ctx) => {
        const q = String(query ?? '');
        // 先按实测边界拦：省一次网络往返，且错误分类准确
        if (q.trim() === '') throw failure('sov2ex', 'input', 'query must be a non-empty string');
        if (q.length > 200) throw failure('sov2ex', 'input', 'query too long (server rejects >200)');

        const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&size=${encodeURIComponent(limit)}`;
        const timeoutMs = ctx?.opts?.timeoutMs ?? 5000;

        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let res, text;
        try {
            res = await fetch(url, {
                headers: { accept: 'application/json', 'user-agent': ctx?.ua || 'Mozilla/5.0' },
                signal: ctl.signal,
            });
            text = await res.text();
        } catch (e) {
            if (e?.name === 'AbortError') throw failure('sov2ex', 'unavailable', `timeout: no response within ${timeoutMs}ms`);
            throw failure('sov2ex', 'unavailable', String(e?.message || e).slice(0, 160));
        } finally {
            clearTimeout(timer);
        }

        // 400 是"参数非法"（实测文案 missing/too long keyword），不是"没搜到"
        if (res.status === 400) {
            let why = '';
            try { why = JSON.parse(text)?.message ?? ''; } catch { /* 非 JSON 就留空 */ }
            throw failure('sov2ex', 'input', why || `http 400`);
        }
        if (!res.ok) throw failure('sov2ex', String(res.status), `http ${res.status}`);

        let json;
        try { json = JSON.parse(text); } catch { throw failure('sov2ex', 'unavailable', 'response is not JSON'); }

        const rows = Array.isArray(json?.hits) ? json.hits : [];
        return ctx.normalize(rows.map((h) => {
            const s = h?._source ?? {};
            const id = h?._id ?? s.id ?? '';
            const content = typeof s.content === 'string' ? s.content : '';
            // V2EX 标题里偶见 HTML 实体（如 &quot;），交给外层 stripTags/后续清洗
            return {
                title: s.title ?? '',
                url: id ? `https://www.v2ex.com/t/${id}` : '',
                snippet: content.slice(0, 300),
                _snippet_raw: content,          // ★ 长正文留卡片层（交付层才裁 180）
                _published: s.created ?? '',    // 不进交付（决议#5）
                _replies: s.replies ?? 0,
            };
        }), limit);
    },
    trash: null,
};
