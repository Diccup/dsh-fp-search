/**
 * blocks/02-net/index.js — 网络面块（impl）
 *
 * 装什么：把 `ours/web-search.js` 与它的传输层接进积木面。
 * 依赖：core（要 core 的 FpError / 装配态）。
 *
 * ★ 为什么不直接在本块里 import `ours/web-search.js`：
 *   ① `ours/` 是**装配进来的预放素材**，未装配时 import 会 ENOENT；
 *   ② `--selftest` 与门应该能在"素材不在"时也跑（片 0 就是这么设计的）。
 *   所以这里做**惰性加载 + 诚实报错**：第一次真要用才 import，摸不到就给
 *   `FP_NOT_ASSEMBLED`，让人照着提示去跑 assemble.mjs。
 *
 * ★ 独立性（主人 2026-11-09）：本块只 import 包内 `ours/`，不 import CTX 任何东西。
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { ERR, FpError, assemblyState, requireAssembled } from '../01-core/index.js';

export const meta = {
    name: 'net',
    kind: 'impl',
    deps: ['core'],
};

/** 惰性句柄（进程内只 import 一次）。 */
let _ws = null;

/**
 * ★ 2026-11-21 检查修复轮补记（宿主热重载的坑，实测）：
 *   本块用**动态 import** 装载 `ours/web-search.js`，句柄缓存在模块级变量 `_ws` 里。
 *   宿主的 HMR（`dsh-hmr`）按**静态 import 边**建依赖图，动态 import 的目标
 *   **不是本块的依赖边** ⇒ 只改 `ours/*.js` 时：
 *     ① `ours/web-search.js` 会被判为 stale 并从 ESM 缓存里逐出，
 *     ② 但本块**自身文件没变** ⇒ 不被逐出、不被重新求值 ⇒ `_ws` 仍握着**旧模块**，
 *     ③ 结果：改完 `ours/` 后行为**不变**，直到宿主重启或本块自身也被触碰。
 *   ⇒ 修 `ours/` 下的文件时，**要连带 touch 一下本文件**（或让本块按 pkgRoot 重置句柄），
 *     否则会误以为"改了没用"。这不是 bug，是 HMR 的静态边设计与惰性句柄的叠加结果。
 */

/**
 * 拿到 `ours/web-search.js` 的模块。
 * @param {{pkgRoot:string}} ctx
 */
export async function loadWebSearch(ctx) {
    if (_ws !== null) return _ws;
    const state = assemblyState(ctx.pkgRoot, existsSync, join);
    requireAssembled(state);
    const target = join(ctx.pkgRoot, 'ours', 'web-search.js');
    if (!existsSync(target)) {
        throw new FpError(ERR.NOT_ASSEMBLED, `找不到网络面：${target}`, '跑 engine/verify/assemble.mjs 装配素材。');
    }
    _ws = await import(pathToFileURL(target).href);
    return _ws;
}

/** 搜索（聚合 / 单家）。参数语义见 contract.mjs。 */
export async function search(ctx, { query, engines, limit, media: mediaKind, fullSnippet }) {
    const w = await loadWebSearch(ctx);

    // media 形态：走 ws-media 面（image / video）
    if (typeof mediaKind === 'string' && mediaKind !== '') {
        const kind = mediaKind === 'video' ? 'video' : 'image';
        return await w.media(kind, query ?? '', buildOpts({ engines, limit, fullSnippet }));
    }
    const opts = buildOpts({ engines, limit, fullSnippet });
    if (Array.isArray(engines) && engines.length === 1) opts.engine = engines[0];
    return await w.search(query, opts);
}

/** 取正文（裸抓 → 五段降级）。 */
export async function page(ctx, { url, noFpFallback, fpLegTimeoutSec, outDir }) {
    const w = await loadWebSearch(ctx);
    return await w.page(url, {
        noFpFallback: noFpFallback === true,
        fpLegTimeoutSec,
        fpOutDir: outDir,
    });
}

/** 活引擎逐家探针（doctor 用；07 口径：数量运行时算，6 家未接线卡不计入）。 */
export async function probeEngines(ctx, options = {}) {
    const w = await loadWebSearch(ctx);
    return await w.doctor(options);
}

/** 引擎名清单（doctor 与门要用；不联网）。 */
export async function engineNames(ctx) {
    const w = await loadWebSearch(ctx);
    return Object.keys(w.ENGINES ?? {}).filter((n) => n !== 'netdisk');
}

/**
 * 把 FP 的 op 参数翻译成 `web-search.js` 认识的选项。
 * ★ 只翻译**确实存在**的键，绝不凭空塞参数（塞错键会被上游静默忽略，等于假能力）。
 */
function buildOpts({ engines, limit, fullSnippet }) {
    const opts = {};
    if (Array.isArray(engines) && engines.length > 0) opts.engines = engines;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) opts.limit = Math.floor(limit);
    if (fullSnippet === true) opts.fullSnippet = true;
    return opts;
}

export function init() { /* 无状态；惰性加载在 loadWebSearch 里 */ }
