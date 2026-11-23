/**
 * engines/crates.js — 活卡 · order 26 · 形态=自定义 run（GET JSON，免 key）
 *
 * 新增于 ITERATION-012（维护方「新卡该做做」）。补 Rust 生态：
 * FP 此前垂类只有 npm / pypi（JS / Python 包），**Rust crate 完全没覆盖**。
 *
 * 实测形状（2026-11-21 真机）：
 *   · 请求：GET https://crates.io/api/v1/crates?q=<q>&per_page=<n>
 *           ★ **域名是 `crates.io`，没有 `api.` 子域** —— `api.crates.io` 实测
 *             `ENOTFOUND`（DNS 不存在）。此坑已踩过，写死正确域名。
 *           **不需要 key**；但 crates.io 官方要求可识别的 UA（带 UA 实测 200）
 *   · 响应：`application/json`  `{ crates:[ { id, name, description, downloads, max_version, updated_at, ... } ] }`
 *   · URL 自拼：`https://crates.io/crates/{id}`（响应里有 links 但形态不稳，自拼更可靠）
 *   · 耗时：实测 357–994 ms
 *
 * ★ 为什么 kind=vertical 且 covers=['dev']：
 *   它是包仓库，不是通用网搜；进专业配额（P1）才不会被通用大搜挤掉。
 *   与 npm/pypi 同 covers，靠 `computeQuotas` 的 rarity 机制参与分配（不新增表）。
 *
 * 边界（实测）：
 *   · 无结果的 query 返回 `{ crates: [] }`（200）⇒ 交给上层"0 条即 empty"语义
 *   · 描述可能含 HTML 片段，交给外层 stripTags 清洗
 * · 禁 TLA；不 import `ws-engines.js`（规矩 2）；只 import 叶子件 ../ws-text.js（无环）。
 */
import { failure } from '../ws-text.js';

const ENDPOINT = 'https://crates.io/api/v1/crates';

/**
 * ★ ITERATION-013：crates.io 的 `q=` 对**含中文的查询会崩**（实测）。
 *
 * 病因：crates.io 后端把整个 query 当一串 token 做模糊匹配，中文没有词边界 ⇒
 *   查 "rust tokio 异步运行时" 会返回 cert_by_host / nwebp / wae-database 等
 *   **与 tokio 毫无关系**的 crate（实测 10 条全废，覆盖率 9–18%）。
 *   纯英文查询（"tokio" / "rust tokio"）则正常。
 *
 * 处置两步（都在卡内，不动公共层）：
 *   ① **剥掉中日韩字符**，只拿英文/数字 token 去查（"rust tokio 异步运行时" → "rust tokio"）；
 *      剥完为空 ⇒ 说明是纯中文查询，crate 名本就是英文，直接返回 0 条（不瞎查）。
 *   ② 拿到结果后再做一次**字面相关性复核**，把明显不沾边的丢掉。
 */
function stripCjk(q) {
    return String(q)
        .split(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]+/)
        .filter((s) => s.trim() !== '')
        .join(' ')
        .trim();
}

/** 查询里可用的英文/数字 token（小写、去重、丢掉单字符噪声）。 */
function queryTokens(q) {
    return [...new Set((String(q).toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []).filter((w) => w.length >= 2))];
}

/**
 * 字面相关性：crate 的 name+description 是否覆盖至少一个查询 token。
 * 实测依据：crates.io 的模糊匹配会返回完全无关的包（如 tokio 查询返回 cert_by_host），
 * 而真正相关的包（tokio / tokio-metrics / console-subscriber）名字或描述里必含查询词。
 *
 * 注意：**只要命中一个 token 就留**，不用覆盖率阈值——crate 名常常只含其中一个词
 * （如 "pyo3-asyncio" 对查询 "python asyncio" 只命中 asyncio，但它是正确答案）。
 */
function isRelevant(crate, tokens) {
    if (tokens.length === 0) return true;
    const hay = `${crate?.name ?? ''} ${crate?.description ?? ''}`.toLowerCase();
    return tokens.some((t) => hay.includes(t));
}
const UA = 'dsh-fp-search/0.1.0 (web capability plugin; +https://crates.io/policies)';

export default {
    id: 'crates',
    order: 26,
    kind: 'vertical',
    covers: ['dev'],
    nativeRank: 'relevance',
    quota: null,
    ua: UA,
    headers: { accept: 'application/json' },
    run: async (query, limit, ctx) => {
        // ★ ① 剥掉中文再查（crates.io 对含中文的 query 会给出完全无关的结果）
        const asked = String(query ?? '');
        const effective = stripCjk(asked) || asked.trim();
        // 纯中文查询：crate 名必然是英文，查也只会得到垃圾 ⇒ 直接 0 条，别污染交付
        if (stripCjk(asked) === '' && /[\u4e00-\u9fff]/.test(asked)) return [];

        // ★ 多取一倍：相关性复核会丢条目，取满 limit 条才不至于被过滤后变少
        const fetchN = Math.min(50, Math.max(limit * 2, limit + 5));
        const url = `${ENDPOINT}?q=${encodeURIComponent(effective)}&per_page=${encodeURIComponent(fetchN)}`;
        const timeoutMs = ctx?.opts?.timeoutMs ?? 5000;

        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let res, text;
        try {
            // crates.io 明确要求 UA 标识调用方；沿用卡自带 UA（不放 ctx?.ua，避免被宿主覆盖成浏览器 UA 触发策略）
            res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: ctl.signal });
            text = await res.text();
        } catch (e) {
            if (e?.name === 'AbortError') throw failure('crates', 'unavailable', `timeout: no response within ${timeoutMs}ms`);
            throw failure('crates', 'unavailable', String(e?.message || e).slice(0, 160));
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) throw failure('crates', String(res.status), `http ${res.status}`);

        let json;
        try { json = JSON.parse(text); } catch { throw failure('crates', 'unavailable', 'response is not JSON'); }

        const rows = Array.isArray(json?.crates) ? json.crates : [];
        // ★ ② 相关性复核：多取几条留余量（per_page 已按 limit，这里用原 limit 截断）
        const tokens = queryTokens(effective);
        const kept = rows.filter((c) => isRelevant(c, tokens));
        return ctx.normalize(kept.map((c) => ({
            title: c?.name ?? '',
            url: c?.id ? `https://crates.io/crates/${c.id}` : '',
            snippet: c?.description ?? '',
            _published: c?.updated_at ?? '',   // 不进交付（决议#5）
            _extra: c?.max_version ? `v${c.max_version}` : '',
        })), limit);
    },
    trash: null,
};
