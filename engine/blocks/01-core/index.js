/**
 * blocks/01-core/index.js — 契约块（contract）
 *
 * 装什么：错误形状 + 落点解析 + 「素材装配好了没」的唯一判定口。
 * 依赖：无（全仓最底层）。
 *
 * ★ 为什么"素材在不在"要在这里判一次：
 *   片 0 只建壳，`ours/` `fp/` `deps/` 三组素材**还没装配进包**。
 *   壳必须能**如实报"尚未装配"**，而不是抛一个看不懂的 ENOENT，
 *   更不能假装自己能搜（"抓不到还说自己能用"= 撒谎，比报错更坏）。
 */

export const meta = {
    name: 'core',
    kind: 'contract',
    deps: [],
};

/** FP 的错误形状：带 code，交付层照 code 给"怎么改"。 */
export class FpError extends Error {
    constructor(code, message, hint) {
        super(message);
        this.name = 'FpError';
        this.code = code;
        this.hint = hint;
    }
}

export const ERR = Object.freeze({
    NOT_ASSEMBLED: 'FP_NOT_ASSEMBLED',
    BAD_ARGS: 'FP_BAD_ARGS',
    NO_TARGET: 'FP_NO_TARGET',
    UNKNOWN_OP: 'FP_UNKNOWN_OP',
});

/**
 * 装配态：包根下 `ours/` `fp/` `deps/pylibs/` 三组是否都在。
 * @param {string} pkgRoot 包根绝对路径
 */
export function assemblyState(pkgRoot, existsSync, join) {
    const probe = (rel) => existsSync(join(pkgRoot, rel));
    return {
        root: pkgRoot,
        ours: probe('ours/web-search.js'),
        fp: probe('fp/fpwebsearch.py'),
        pylibs: probe('deps/pylibs/curl_cffi'),
    };
}

/** 装配不全就抛一条人能照着做的错，而不是让 ENOENT 冒到模型脸上。 */
export function requireAssembled(state) {
    const missing = [];
    if (!state.ours) missing.push('ours/（网络面）');
    if (!state.fp) missing.push('fp/（五腿本体）');
    if (!state.pylibs) missing.push('deps/pylibs/（curl_cffi）');
    if (missing.length === 0) return;
    throw new FpError(
        ERR.NOT_ASSEMBLED,
        `FP 素材尚未装配：缺 ${missing.join('、')}（包根 ${state.root}）`,
        '这是施工期正常状态：跑 engine/verify/assemble.mjs 把 ..\\src\\ 的素材逐字节装配进包，再重试。',
    );
}

export function init() { /* 契约块无状态，不需要初始化 */ }
