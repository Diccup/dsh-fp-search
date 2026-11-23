/**
 * blocks/14-tools/index.js — 工具块（tool）
 *
 * 干什么：按 `engine/contract.mjs` 的 OPS 逐个注册 op，把调用分派到各块。**唯一注册点**。
 * 依赖：core / net / fetch / doctor。
 *
 * ★ 分派纪律：本文件只做"参数校验 + 调谁"，**不写业务**。
 *   业务在 02-net（搜索/取正文）、03-fetch（取原件）、04-doctor（体检）。
 *
 * ★ 能力诚实：`IMPL_STATE` 现在三项都是 'live'（片 1–4 已接）。
 *   未装配素材时不会假装能用 —— 各块会抛 `FP_NOT_ASSEMBLED` 并给"怎么办"。
 *   门 G1 的 stubHonest 断言已同批改成 notAssembledHonest（见 verify/tool-surface.mjs 与 L-018）。
 */

import { OPS, WANT_OPS } from '../../contract.mjs';
import { ERR, FpError } from '../01-core/index.js';
import { search as netSearch, page as netPage } from '../02-net/index.js';
import { fetchToDisk } from '../03-fetch/index.js';
import { run as runDoctor } from '../04-doctor/index.js';

export const meta = {
    name: 'tools',
    kind: 'tool',
    deps: ['core', 'net', 'fetch', 'doctor'],
};

/** 每 op 的实装状态。三项已接线 = 'live'。改这里必须同批改门（模块关联表 §五-24）。 */
export const IMPL_STATE = Object.freeze({
    search: 'live',
    fetch: 'live',
    doctor: 'live',
});

/** 参数白名单粗筛（真正语义校验在各 op 内）。 */
function rejectUnknown(op, args, allowed) {
    for (const k of Object.keys(args ?? {})) {
        if (k === 'op') continue;
        if (!allowed.includes(k)) {
            throw new FpError(
                ERR.BAD_ARGS,
                `fp ${op}：不认识的参数 "${k}"（本 op 认：${allowed.filter((x) => x !== 'op').join(' / ') || '无'}）`,
                '改参数名或去掉它；可用参数见本次报错列表。',
            );
        }
    }
}

/**
 * ★ 片 5 · A-10 工具面参数宽容解析（三堆 §11.3 A-10，A 堆归属三方全签）
 *
 * 为什么必须做（N-① 实测，三窗一致）：数组 / 字符串类参数经宿主送到 `entry.call(args)` 这一段
 * **会变形或丢失**：`engines` 传数组 4/4 被吞、传字符串 `"baidu"` 反而被当全量、
 * `loopback` 类布尔 `dryRun:false` 到引擎变 `"false"`（S9.40 同族旧教训）。
 * 不修它，"数组参数进 schema" 或 "开着透传" 只是开了个不通的水阀 —— **静默失效比报错更坏**。
 *
 * 做法：三认（同 A-10 定稿口径）
 *   · 数组：真数组 / 逗号串 / JSON 串 `'["a","b"]'` 三种形态都接
 *   · 数值：number / 纯数字串
 *   · 布尔：boolean / `"true"|"false"|"1"|"0"`
 *
 * 必守：**认不出就抛可读错**（说清正确形状），不许静默当默认值 —— 否则模型只会反复撞墙。
 */

/** 数组三认。返回 string[] 或 null（null = 这个键没给）。形状错抛 FpError。 */
function looseArray(op, key, v) {
    if (v === undefined || v === null) return null;
    if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim() !== '');
    if (typeof v === 'string') {
        const s = v.trim();
        if (s === '') return null;
        // JSON 串形态：'["a","b"]'
        if (s.startsWith('[')) {
            try {
                const parsed = JSON.parse(s);
                if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter((x) => x.trim() !== '');
            } catch { /* 落到下面的逗号形态 */ }
            throw new FpError(ERR.BAD_ARGS,
                `fp ${op}：${key} 长得像 JSON 数组但解析失败：${s.slice(0, 60)}`,
                `正确形状三种任选：["a","b"]（数组）、a,b（逗号串）、'["a","b"]'（JSON 串）`);
        }
        // 逗号 / 空白分隔形态：'a,b' / 'a b'
        return s.split(/[,\s]+/).map((x) => x.trim()).filter((x) => x !== '');
    }
    throw new FpError(ERR.BAD_ARGS,
        `fp ${op}：${key} 要字符串数组，收到 ${typeof v}`,
        `正确形状：["a","b"] 或 "a,b"，不要传 ${typeof v}`);
}

/** 数值三认。认不出抛可读错（不许静默当默认值）。 */
function looseNumber(op, key, v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const s = v.trim();
        if (s === '') return undefined;
        const n = Number(s);
        if (Number.isFinite(n)) return n;
    }
    throw new FpError(ERR.BAD_ARGS,
        `fp ${op}：${key} 要是数字，收到 ${JSON.stringify(v)}`,
        `正确形状：数字 10 或数字串 "10"`);
}

/** 布尔三认。 */
function looseBool(op, key, v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') {
        if (v === 1) return true;
        if (v === 0) return false;
    }
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') return true;
        if (s === 'false' || s === '0' || s === 'no') return false;
    }
    throw new FpError(ERR.BAD_ARGS,
        `fp ${op}：${key} 要 true / false，收到 ${JSON.stringify(v)}`,
        `正确形状：true、false、"true"、"false"、"1"、"0"`);
}

/** 枚举字符串（★ 04 片新增，给 fetch 的 `legs` 用）。认不出 ⇒ 抛可读错并列明合法值。 */
function looseEnumStr(op, key, v, allowed) {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === '') return undefined;
        if (allowed.includes(s)) return s;
        throw new FpError(ERR.BAD_ARGS,
            `fp ${op}：${key} 只认 ${allowed.join(' / ')}，收到「${v.slice(0, 30)}」`,
            `去掉这个参数用默认值，或从 ${allowed.join(' / ')} 里挑一个`);
    }
    throw new FpError(ERR.BAD_ARGS,
        `fp ${op}：${key} 要字符串，收到 ${typeof v}`,
        `正确形状：${allowed.map((a) => `"${a}"`).join(' / ')}`);
}

/** search：query 或 url 二选一（v0 两形态），也可 media。 */
async function callSearch(ctx, args) {
    rejectUnknown('search', args, ['query', 'url', 'engines', 'limit', 'media', 'fullSnippet', 'noFpFallback', 'fpLegTimeoutSec', 'outDir']);

    // ★ A-10：全部参数先过宽容解析（认不出就抛可读错，不静默降级）
    const engines = looseArray('search', 'engines', args.engines);
    const limit = looseNumber('search', 'limit', args.limit);
    const fullSnippet = looseBool('search', 'fullSnippet', args.fullSnippet);
    const noFpFallback = looseBool('search', 'noFpFallback', args.noFpFallback);
    const fpLegTimeoutSec = looseNumber('search', 'fpLegTimeoutSec', args.fpLegTimeoutSec);
    const media = (typeof args.media === 'string' && args.media.trim() !== '') ? args.media.trim() : undefined;

    const hasQuery = typeof args.query === 'string' && args.query.trim() !== '';
    const hasUrl = typeof args.url === 'string' && args.url.trim() !== '';
    const hasMedia = media !== undefined;

    if (hasUrl && !hasQuery && !hasMedia) {
        // 取正文形态
        return await netPage(ctx, {
            url: args.url,
            noFpFallback,
            fpLegTimeoutSec,
            outDir: args.outDir,
        });
    }
    if (!hasQuery) {
        throw new FpError(ERR.NO_TARGET, 'fp search：要么给 query（搜索），要么给 url（取正文）', '补一个 query 或 url 再调。');
    }
    return await netSearch(ctx, {
        query: args.query,
        engines,
        limit,
        media,
        fullSnippet,
    });
}

async function callFetch(ctx, args) {
    rejectUnknown('fetch', args, ['url', 'outDir', 'maxBytes', 'legs']);
    if (typeof args.url !== 'string' || args.url.trim() === '') {
        throw new FpError(ERR.NO_TARGET, 'fp fetch：必须给 url', '补 url 再调。');
    }
    // ★ A-10：maxBytes 也走宽容解析（"1000" 这种数字串不许静默失效）
    const maxBytes = looseNumber('fetch', 'maxBytes', args.maxBytes);
    const legs = looseEnumStr('fetch', 'legs', args.legs, ['auto', 'always', 'off']);
    return await fetchToDisk(ctx, { url: args.url, outDir: args.outDir, maxBytes, legs });
}

async function callDoctor(ctx, args) {
    rejectUnknown('doctor', args, []);
    return await runDoctor(ctx);
}

const CALLS = { search: callSearch, fetch: callFetch, doctor: callDoctor };

export async function init(ctx) {
    const reg = ctx.registry;
    // 只按 contract.OPS 注册 —— 清单少一项这里就少一个 op，门立刻红。
    for (const { op, oneLine } of OPS) {
        const call = CALLS[op];
        if (typeof call !== 'function') throw new Error(`blocks/14-tools: OPS 里有 ${op} 但没有实现分派`);
        // ★ 两个形参严格分开：args = 模型给的操作参数（要过白名单）；runtime = 宿主给的
        //   signal/session 等。混在一起会被白名单当"不认识的参数"拒掉（L-012 实测）。
        reg.registerTool(op, { name: op, oneLine, call: (args, runtime) => call(ctx, args, runtime) });
    }
    // 反向自检：注册出来的名单必须与 contract 的 WANT_OPS 逐名相同（当场炸，不留到门里）。
    const got = reg.toolList().map((t) => t.op);
    if (got.length !== WANT_OPS.length || got.some((o, i) => o !== WANT_OPS[i])) {
        throw new Error(`blocks/14-tools: 注册面 [${got}] 与 contract.WANT_OPS [${WANT_OPS}] 不同源`);
    }
}
