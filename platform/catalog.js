/**
 * platform/catalog.js — 平台侧的工具目录事实（**兜底视图，不是第二份真源**）
 *
 * 为什么有它：平台层要能回答"本插件有几个 op、叫啥"（装载日志、诊断、门对拍），
 *   但平台层**不许静态 import engine/**（会把分层倒过来，FP 沿 CTX 的同一条纪律）。
 *   正规路径是运行时由引擎报上来；这里的常量只在拿不到运行时清单时兜底。
 *
 * ★ 保真纪律：本数组必须与 `engine/contract.mjs` 的 `WANT_OPS` 逐名对拍 ——
 *   `engine/verify/tool-surface.mjs` 会把两者比一遍（它是门，红就是漏改）。
 */

/** 宿主工具面里只有一个位：fp。 */
export const FULL_CATALOG = Object.freeze(['fp']);

/** op 清单兜底视图（真源在 engine/contract.mjs 的 OPS）。 */
export const KNOWN_OPS = Object.freeze(['search', 'fetch', 'doctor']);

/** 部署注记：描述里教模型"这个插件能干什么"的那一段。 */
export function deployNote(ops = KNOWN_OPS) {
    return `fp：网页搜索 / 取正文 / 取原件 / 自检。op：${ops.join(' / ')}`;
}

/** 哪些工具要独占（FP 三个 op 都无状态，没有独占项）。 */
export const EXCLUSIVE_FP_TOOLS = Object.freeze([]);

/** 已挂载的工具名（装载日志与门用）。 */
export function mountedTools() {
    return FULL_CATALOG.slice();
}
