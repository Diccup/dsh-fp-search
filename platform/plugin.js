/*
 * ============================================================================
 * 本文件由 AI 辅助生成（AI-generated / AI-assisted）。
 *
 * 免责声明：
 *   本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
 *   使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
 *   请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。
 *   完整声明见仓库根目录的 DISCLAIMER.md。
 * ============================================================================
 */
/**
 * platform/plugin.js — FP 平台匹配层入口（唯一入口，零业务逻辑）
 *
 * 职责只有四件：读配置 → 起引擎 → 注册工具 → 记日志。
 * 业务在 engine/blocks/ 里；这一层不认识搜索，也不认识网络。
 *
 * ★ 独立性（维护方 2026-11-09 定）：
 *   FP 是**新插件**，本文件不 import CTX 任何文件、不向 CTX 要任何服务、
 *   不改 CTX 装机槽。以后要接 CTX 是以后的事。
 *
 * ★ 装饰层失败不许拖垮工具面（CTX 2026-11-02 真事故的教训，跨插件有效）：
 *   工具注册是主业务；提示词段/技能装载全是锦上添花 —— 坏了顶多少点便利，
 *   绝不允许它决定"工具有没有"。
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../engine/index.mjs';
import { PARAM_NAMES, toDefinition } from './tool-def.js';
import { FULL_CATALOG, KNOWN_OPS, deployNote } from './catalog.js';
import { installBundledSkills } from './skill-set.js';

export const name = 'dsh-fp-search';

const PLATFORM_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));

export { FULL_CATALOG, KNOWN_OPS, deployNote, mountedTools } from './catalog.js';

/**
 * 配置。
 *
 * ★ 2026-11-09 修正（原版是致命 bug，整个插件加载失败）：
 *
 *   原代码 `export const Config = {};`，理由写的是"零外部依赖、宿主解析不到会走默认处理"。
 *   **宿主不兜底**。cordis 4.1 `resolveConfig`（cordis/lib/index.js:244）：
 *
 *       if (!runtime.Config) return config;                            // 只有 falsy 才放行
 *       const result = runtime.Config['~standard'].validate(config);   // 否则必取 ~standard
 *
 *   `{}` 是 truthy ⇒ 不走第一行 ⇒ `{}['~standard']` 是 undefined ⇒ 再取 `.validate`
 *   ⇒ TypeError: Cannot read properties of undefined (reading 'validate')
 *   ⇒ 插件在 apply() 之前就崩，工具面永远不出现（apply 里的探针也就永远不落盘）。
 *
 * ★ 本插件**故意不导出 Config**（走 falsy 分支，config 原样透传）。
 *   为什么不用 schemastery 写 schema：本包零 dependencies，`@deepseek-ai/schemastery`
 *   只存在于 profile 的 node_modules 里；从活槽目录 `~\.dsh\plugins\dsh-fp-search\`
 *   解析不到它（实测 ERR_MODULE_NOT_FOUND）。今天能跑是因为 pnpm 把包装进了 profile
 *   的 node_modules，那是**偶然**，不是保证。不导出 Config 就没有这个依赖点。
 *
 *   开关照旧从 `config.enabled !== false` 判（见 apply），行为不变。
 */

/** 描述文本（工具的对外说明；词法门会查它提到的参数是否真存在）。 */
export function toolDescription(ops = KNOWN_OPS) {
    return [
        'FP：独立网页能力插件。',
        `op：${ops.join(' / ')}。`,
        'search 给 query = 聚合搜索（22 家活引擎）；给 url = 取正文（裸抓失败自动 http→waf→tls→render→cdp 五段降级）。',
        'fetch 给 url = 取原始字节落盘（默认落系统临时目录 dsh-fp-download，可用 outDir 覆盖）；裸抓失败自动降级反扒原始字节腿（http→waf→tls，legs 参数可控）。',
        'doctor = 唯一运维面：逐家引擎、桥可达性、五腿能力面、落点可写、盘剩余。',
    ].join('');
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 插件 apply：宿主调用一次。
 * @param {object} ctx 宿主上下文（含 ctx.get / ctx.logger / ctx.effect）
 * @param {{enabled?:boolean}} config
 */
export async function apply(ctx, config = {}) {
    const enabled = config?.enabled !== false;
    if (!enabled) {
        ctx.logger.info('dsh-fp-search: disabled by config');
        return;
    }
    const tools = ctx.get('tools', false);
    if (tools === undefined) {
        ctx.logger.warn('dsh-fp-search: tools service is unavailable; plugin is inactive');
        return;
    }

    const disposers = [];
    let disposed = false;
    ctx.effect(() => () => {
        disposed = true;
        for (const d of disposers.splice(0)) {
            try { d(); } catch { /* 卸载期不抛 */ }
        }
    }, 'dsh-fp-search platform plugin');

    let engine;
    try {
        engine = await createEngine({ level: 'warn', pkgRoot: PKG_ROOT });
    }
    catch (error) {
        // 引擎起不来 = 一个工具都不注册，但**不静默**：宿主日志要能看见原因。
        ctx.logger.warn(`dsh-fp-search: engine unavailable; plugin is inactive (${errorMessage(error)})`);
        return;
    }

    // op 清单以运行时为准（拿不到才回兜底常量）。
    const ops = engine.opCatalog.map((o) => o.op);
    const params = PARAM_NAMES.slice();

    let registered = 0;
    for (const toolName of FULL_CATALOG) {
        if (disposed) return;
        try {
            const def = toDefinition({
                name: toolName,
                description: toolDescription(ops),
                params,
                // ★ runtime 走第二形参，**不许混进 args**（L-012：混进去会被参数白名单拒掉）
                call: (args, signal, meta) => engine.call(args, { signal, meta }),
            });
            disposers.push(tools.register(def));
            registered += 1;
        }
        catch (error) {
            ctx.logger.warn(`dsh-fp-search: skipped tool ${toolName}: ${errorMessage(error)}`);
        }
    }

    // ---- 装饰层：拿不到 systemPrompt 只 warn，绝不影响上面已注册的工具 ----
    const systemPrompt = ctx.get('systemPrompt', false);
    if (systemPrompt !== undefined && registered > 0) {
        try {
            const section = deployNote(ops);
            if (typeof systemPrompt.section === 'function') {
                const dispose = systemPrompt.section({ id: 'fp-tools', order: 60, text: section });
                if (typeof dispose === 'function') disposers.push(dispose);
            }
        }
        catch (error) {
            ctx.logger.warn(`dsh-fp-search: prompt section unavailable, tools stay active (${errorMessage(error)})`);
        }
    }

    // ---- 装饰层：捆绑技能（同样失败只 warn）----
    let skillCount = 0;
    try {
        const ds = installBundledSkills({
            ctx,
            skillsDir: join(PKG_ROOT, 'skills'),
            logger: ctx.logger,
        });
        for (const d of ds) disposers.push(d);
        skillCount = ds.length;
    }
    catch (error) {
        ctx.logger.warn(`dsh-fp-search: bundled skills unavailable, tools stay active (${errorMessage(error)})`);
    }

    ctx.logger.info(`dsh-fp-search: registered ${registered} tool surface (fp) with ${ops.length} op: ${ops.join(',')}`
        + ` · skills=${skillCount} · root=${PKG_ROOT}`);
}
