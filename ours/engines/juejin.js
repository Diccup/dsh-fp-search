/**
 * engines/juejin.js — 活卡 · order 24 · 形态=自定义 run（GET JSON，免 key 免特殊头）
 *
 * 新增于 ITERATION-012（维护方「新卡该做做」）。中文技术内容，FP 此前无此覆盖。
 *
 * 实测形状（2026-11-21 真机，见 iterations/ITERATION-012）：
 *   · 请求：GET https://api.juejin.cn/search_api/v1/search
 *           `?query=<q>&id_type=0&cursor=0&limit=<n>`
 *           **不需要任何头、不需要 key、无 cookie**（实测连打 6 次 + 5 路并发全 200）
 *   · 响应：`application/json`  `{ err_no:0, err_msg:"success", data:[ { result_type, result_model } ] }`
 *           `result_model.article_info` = `{ article_id, title, brief_content, ctime, ... }`
 *   · ★ `link_url` **实测为空串** ⇒ 必须按 `article_id` 自拼 `https://juejin.cn/post/{id}`
 *     （直接用 link_url 会交出一批空 URL 被 `interleaveByRank` 按 `!key` 全部丢弃）
 *   · `result_type` 实测恒为 2（文章）；其他类型不猜测结构，按"取不到就跳过"处理
 *   · 耗时：实测 192–283 ms（本机最快的活引擎之一）；体积 86 KB / 20 条
 *
 * 边界（实测）：空 query 返回 `err_no` 非 0 / data 为空 ⇒ 走"0 条即抛 empty"的既有语义。
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）；只 import 叶子件 ../ws-text.js（无环）。
 */
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://api.juejin.cn/search_api/v1/search';

export default {
    id: 'juejin',
    order: 24,
    kind: 'vertical',
    covers: ['dev', 'zh'],
    nativeRank: 'relevance',
    quota: null,
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    headers: { accept: 'application/json' },
    run: async (query, limit, ctx) => {
        const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&id_type=0&cursor=0&limit=${encodeURIComponent(limit)}`;
        const timeoutMs = ctx?.opts?.timeoutMs ?? 5000;

        // 自备 abort（本卡不用 ws-api 的 postJson：需要 GET，且保留 ctx 超时语义）
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let text;
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: { accept: 'application/json', 'user-agent': ctx?.ua || 'Mozilla/5.0' },
                signal: ctl.signal,
            });
            if (!res.ok) throw failure('juejin', String(res.status), `http ${res.status}`);
            text = await res.text();
        } catch (e) {
            if (e?.engine) throw e;
            if (e?.name === 'AbortError') throw failure('juejin', 'unavailable', `timeout: no response within ${timeoutMs}ms`);
            throw failure('juejin', 'unavailable', String(e?.message || e).slice(0, 160));
        } finally {
            clearTimeout(timer);
        }

        let json;
        try { json = JSON.parse(text); } catch { throw failure('juejin', 'unavailable', 'response is not JSON'); }
        if (typeof json?.err_no === 'number' && json.err_no !== 0) {
            throw failure('juejin', 'unavailable', `err_no=${json.err_no} ${json.err_msg ?? ''}`.trim());
        }

        const rows = Array.isArray(json?.data) ? json.data : [];
        return ctx.normalize(rows.map((o) => {
            const ai = o?.result_model?.article_info ?? {};
            const id = ai.article_id ?? o?.result_model?.article_id ?? '';
            // ★ link_url 实测空串：能拿到就用，拿不到按 article_id 自拼
            const direct = typeof ai.link_url === 'string' && ai.link_url.trim() !== '' ? ai.link_url : '';
            return {
                title: ai.title ?? '',
                url: direct || (id ? `https://juejin.cn/post/${id}` : ''),
                snippet: ai.brief_content ?? '',
                // ctime 是**秒级**字符串时间戳；只留卡片层，不进交付（决议#5）
                _published: ai.ctime ? new Date(Number(ai.ctime) * 1000).toISOString() : '',
            };
        }), limit);
    },
    trash: null,
};
