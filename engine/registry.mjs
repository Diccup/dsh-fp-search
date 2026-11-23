/**
 * engine/registry.mjs — 积木注册表（FP 自己的，形状照 CTX 成例，**代码不引用 CTX**）
 *
 * 干什么：块注册自己（name/kind/deps/init）；入口只问 registry 要东西。
 *         谁依赖谁写在一处，块内不许跨块 import 实现文件。
 * 边界：只做登记与查找，**不含业务逻辑**；块初始化失败必须在这里可见（不吞）。
 *
 * ★ 与 CTX 的关系：**只抄形状，不 import**。FP 是独立插件（主人 2026-11-09 定），
 *   两边任何一份 registry 改动都不该牵动对方。
 */

import { createLogger } from './libs/log.js';

/** 块的 kind：决定它能被谁依赖（接口块 vs 实现块 vs 横切层）。 */
export const KINDS = Object.freeze(['contract', 'impl', 'crosscut', 'tool', 'entry']);

export function createRegistry(opts = {}) {
    const log = createLogger({ level: opts.level ?? 'info' }).forScope('registry');
    /** @type {Map<string, {name:string,kind:string,deps:string[],dir:string,block:object}>} */
    const blocks = new Map();
    /** @type {Map<string, {op:string, call:(a:object)=>Promise<any>|any}>} */
    const tools = new Map();
    const inited = [];

    /**
     * 登记一块。meta 形状 = { name, kind, deps:[] }。
     * deps 里的名字必须在登记时已存在 —— **只准往下依赖**。
     */
    function register(meta, block, dir) {
        const { name, kind, deps = [] } = meta ?? {};
        if (!name) throw new Error('registry.register(): meta.name 必填');
        if (!KINDS.includes(kind)) throw new Error(`registry.register(${name}): kind=${kind} 不在 ${KINDS.join('/')}`);
        if (blocks.has(name)) throw new Error(`registry.register(${name}): 重复登记`);
        for (const d of deps) {
            if (!blocks.has(d)) throw new Error(`registry.register(${name}): 依赖 ${d} 尚未登记（只准往下依赖）`);
        }
        blocks.set(name, { name, kind, deps, dir, block });
        log.debug(`登记 ${name}（${kind}）deps=[${deps.join(',')}]`);
    }

    /** 按登记顺序初始化（登记顺序天然是拓扑序，因为 deps 有存在性检查）。 */
    async function initAll(ctx) {
        for (const { name, block } of blocks.values()) {
            if (typeof block.init === 'function') {
                await block.init(ctx);
                inited.push(name);
            }
        }
        log.info(`已初始化 ${inited.length} 块：${inited.join(' ')}`, 'init-all');
        return inited.slice();
    }

    /** 登记一个工具面 op。 */
    function registerTool(op, entry) {
        if (tools.has(op)) throw new Error(`registry.registerTool(${op}): 重复`);
        tools.set(op, { op, ...entry });
    }

    /** 真分派：壳只做 entry.call(args)，不许在壳里 switch 复制业务。
     *  runtime（signal / session 等）**单独走第二个形参**，绝不混进 args ——
     *  混进去会被 op 的参数白名单当"不认识的参数"拒掉（2026-11-09 首跑真踩，见 L-012）。 */
    async function dispatch(op, args, runtime) {
        const entry = tools.get(op);
        if (!entry) throw new Error(`registry.dispatch(): 没有 op=${op}（可用：${[...tools.keys()].join(',')}）`);
        return entry.call(args ?? {}, runtime);
    }

    function getOp(op) {
        return tools.get(op);
    }

    return {
        register,
        initAll,
        registerTool,
        dispatch,
        getOp,
        get: (n) => blocks.get(n)?.block,
        has: (n) => blocks.has(n),
        list: () => [...blocks.values()].map(({ name, kind, deps }) => ({ name, kind, deps: deps.slice() })),
        toolList: () => [...tools.values()].map(({ op, oneLine }) => ({ op, oneLine })),
        opCount: () => tools.size,
    };
}
