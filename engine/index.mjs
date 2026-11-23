/**
 * engine/index.mjs — FP 引擎唯一入口
 *
 * 三种形态共用同一份 blocks：
 *   ① createEngine({ ctx })         进程内（DSH 平台层用）
 *   ② node engine/index.mjs --selftest   独立跑（无宿主、无 ctx）← R1 门的主角
 *
 * 边界：入口只做"装配 + 生命周期 + 缺 op 如实报错"，不含业务；业务在 blocks 里。
 *       **--selftest 期不写任何真实数据、不联网**（片 0 起就守这条）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRegistry } from './registry.mjs';
import { createLogger } from './libs/log.js';
import { OPS, WANT_OPS, TOOL_NAME, PACKAGE_NAME } from './contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(HERE, '..');

/** 块登记表：名字、目录、kind、deps。**加一块 = 这里加一行**。 */
export const BLOCK_MANIFEST = [
    { name: 'core', dir: '01-core', kind: 'contract', deps: [] },
    { name: 'net', dir: '02-net', kind: 'impl', deps: ['core'] },
    { name: 'fetch', dir: '03-fetch', kind: 'impl', deps: ['core'] },
    { name: 'doctor', dir: '04-doctor', kind: 'impl', deps: ['core', 'net'] },
    { name: 'outgate', dir: '05-outgate', kind: 'crosscut', deps: ['core'] },
    { name: 'tools', dir: '14-tools', kind: 'tool', deps: ['core', 'net', 'fetch', 'doctor', 'outgate'] },
];

/** 登记前先拓扑排序：manifest 顺序错了也不许逃过 deps 校验。 */
export function topoSortManifest(manifest) {
    const byName = new Map(manifest.map((m) => [m.name, m]));
    const visited = new Set();
    const out = [];
    const visit = (m, stack) => {
        if (visited.has(m.name)) return;
        if (stack.has(m.name)) throw new Error(`BLOCK_MANIFEST 有环：${[...stack, m.name].join(' → ')}`);
        stack.add(m.name);
        for (const d of m.deps ?? []) {
            const dep = byName.get(d);
            if (!dep) throw new Error(`BLOCK_MANIFEST：${m.name} 依赖未知块 ${d}`);
            visit(dep, stack);
        }
        stack.delete(m.name);
        visited.add(m.name);
        out.push(m);
    };
    for (const m of manifest) visit(m, new Set());
    return out;
}

/**
 * 起一个引擎实例。
 * @param {{level?:string, pkgRoot?:string}} opts
 */
export async function createEngine(opts = {}) {
    const log = createLogger({ level: opts.level ?? 'info' }).forScope('engine');
    const registry = createRegistry({ level: opts.level ?? 'info' });
    const pkgRoot = opts.pkgRoot ?? PKG_ROOT;

    const ordered = topoSortManifest(BLOCK_MANIFEST);
    for (const entry of ordered) {
        const mod = await import(new URL(`./blocks/${entry.dir}/index.js`, import.meta.url).href);
        registry.register({ name: entry.name, kind: entry.kind, deps: entry.deps }, mod, entry.dir);
    }

    const engineCtx = { registry, log, pkgRoot, existsSync };
    await registry.initAll(engineCtx);

    const opCatalog = registry.toolList();
    const api = {
        registry,
        log,
        pkgRoot,
        blocks: registry.list(),
        opCatalog,
        toolName: TOOL_NAME,
        packageName: PACKAGE_NAME,
        /** 统一的调用口；平台层与自检都走这里。
         *  ★ runtime 与 args 严格分开（见 L-012）：args 只放模型真给的操作参数。
         *  ★ 交付闸（05-outgate）在这里**统一兜底**：任何 op 的输出都过一遍 40 KB 上限。
         *    为什么放这一层而不是各 op 自己压：漏一处就有一条路能把 320 KB 灌进上下文
         *    （L-026 实测：limit=500 + fullSnippet=true 就是 327,756 字节）。
         *    一处兜底 = 不可能漏。 */
        async call(args, runtime) {
            const op = args?.op;
            if (typeof op !== 'string' || op === '') {
                // ★ 06-P2（按主人倾向的 A 案起草；B 案后门待拍板再补）：
                //   缺 op = 调用故障，不许伪装成成功。旧行为回 op 帮助表 ⇒ 上游畸形编码
                //   （参数名丢失）时故障被洗白成一次正常调用（06 立项书背景 2·隔壁窗实锤）。
                //   如实报错并列出收到的键，让"掉字符"当场现形。
                const keys = args && typeof args === 'object' ? Object.keys(args) : [];
                throw new Error(
                    `fp：本次调用未收到有效 op 参数（收到的键：${keys.length ? keys.join(', ') : '无'}）。`
                    + `op 必填，取值 ${opCatalog.map((o) => o.op).join(' / ')}；要能力面自述就调 op:"doctor"。`);
            }
            const raw = await registry.dispatch(op, args, runtime);
            const gate = registry.get('outgate');
            if (!gate || typeof gate.contain !== 'function') return raw;
            if (typeof raw !== 'string') return raw;
            const contained = gate.contain(raw);
            return contained.text;
        },
    };
    log.info(`引擎就绪：${api.blocks.length} 块 / ${opCatalog.length} op / 包根 ${pkgRoot}`, 'ready');
    return api;
}

// ★ 06-P2（主人 2026-11-19 拍板 A 案）：op 帮助表**全删**——`toolTableText` 已摘除。
//   能力面自述唯一入口 = op:"doctor"；缺 op 一律如实报错（伪装成功的路彻底焊死）。

// ------------------------------------------------------------------ 自检（G1 同形）

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
    const out = {};
    try {
        const engine = await createEngine({ level: process.env.ENGINE_LOG ?? 'warn' });
        out.blockCount = engine.blocks.length;
        out.opCount = engine.opCatalog.length;
        out.ops = engine.opCatalog.map((o) => o.op);
        out.toolName = engine.toolName;

        const checks = [];
        // ① block 数 = manifest 实数（自己数，不抄 CTX）
        checks.push(['blockCount', out.blockCount === BLOCK_MANIFEST.length]);
        // ② op 面三处同源：contract.OPS / WANT_OPS / 运行时注册面
        checks.push(['opsMatchContract', out.ops.join(',') === WANT_OPS.join(',')]);
        checks.push(['opsCountIs3', out.opCount === 3]);
        // ③ 缺 op 必须如实报错（06-P2：不再回帮助表；反例=报错文本必须含收到的键名）
        let noOpErr = '';
        try { await engine.call({ url: 'x' }); } catch (e) { noOpErr = String(e?.message ?? e); }
        checks.push(['missingOpHonest', /未收到有效 op/.test(noOpErr) && noOpErr.includes('url')]);
        // ③b 空对象调用同样如实报错（旧断言 toolTableRenders 废除——那是"伪装成功"本体）
        let emptyErr = '';
        try { await engine.call({}); } catch (e) { emptyErr = String(e?.message ?? e); }
        checks.push(['emptyArgsHonest', /未收到有效 op/.test(emptyErr) && emptyErr.includes('无')]);
        // ④ 坏 op 必须可读报错，不许静默
        let badOpErr = '';
        try { await engine.call({ op: 'nope' }); } catch (e) { badOpErr = String(e?.message ?? e); }
        checks.push(['badOpRejected', /没有 op=nope/.test(badOpErr)]);
        // ⑤ 未装配素材时**不许假装能用**：应得到 FP_NOT_ASSEMBLED 且带"怎么修"
        //    （片 1–4 接线后，能力诚实从"stub 报未接线"变成"装配缺失报怎么修"，见 L-018）
        let honesty = '';
        try {
            await engine.call({ op: 'search', query: 'x' });
            honesty = 'NO_ERROR';   // 素材齐全且真搜成功也算正常
        } catch (e) {
            honesty = `${e?.code ?? ''} ${e?.message ?? e}`;
        }
        checks.push(['capabilityHonest', honesty === 'NO_ERROR' || /FP_NOT_ASSEMBLED/.test(honesty) || /FP_BAD_ARGS|FP_NO_TARGET/.test(honesty)]);
        // ⑥ 缺参必须可读报错
        let noTarget = '';
        try { await engine.call({ op: 'search' }); } catch (e) { noTarget = String(e?.message ?? e); }
        checks.push(['missingTargetRejected', /要么给 query/.test(noTarget)]);

        out.checks = checks.map(([name, ok]) => ({ name, ok }));
        out.allGreen = checks.every(([, ok]) => ok);
        out.error = null;
    }
    catch (e) {
        out.allGreen = false;
        out.error = String(e?.message ?? e);
    }
    // stdout 只放 JSON（日志走 stderr）
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(out.allGreen ? 0 : 1);
}
