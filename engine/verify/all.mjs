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
 * engine/verify/all.mjs — **一键全门**（片 0 的完整验收口）
 *
 * 跑四道门，任何一道红就整体 EXIT=1。冷启动接手时只需要记这一条命令：
 *   node engine\verify\all.mjs
 *
 * 为什么要有"一键"：Readme §五 第 1 道核验要求"全部门 EXIT=0"，
 *   但逐个手敲容易漏跑一道而自己不知道（漏跑的那道往往正是不绿的那道）。
 *   一个入口、一张总表、一个退出码 = 漏不掉。
 *
 * ★ 子进程用文件收结果（同 gate-selfcheck 的理由：受限态管道 EPERM，见 L-013）。
 */

import { mkdirSync, rmSync, readFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = resolve(HERE, '..', '..');
const TEMP_ROOT = join(tmpdir(), 'fp-gates');

function resolveNode() {
    const candidates = [
        process.env.FP_NODE,
        join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    ].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return c;
    return process.execPath;
}
const NODE = resolveNode();

let seq = 0;
function run(script, args = []) {
    mkdirSync(TEMP_ROOT, { recursive: true });
    const outFile = join(TEMP_ROOT, `gate-${++seq}.log`);
    const fd = openSync(outFile, 'w');
    let r;
    try {
        r = spawnSync(NODE, [script, ...args], { stdio: ['ignore', fd, fd], windowsHide: true });
    }
    finally {
        closeSync(fd);
    }
    let out = '';
    try { out = readFileSync(outFile, 'utf8'); } catch { /* 忽略 */ }
    try { rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
    return { code: r.error ? null : r.status, err: r.error?.message, out };
}

const GATES = [
    { id: 'G1', name: 'index --selftest（引擎自检）', script: join(PKG, 'engine', 'index.mjs'), args: ['--selftest'] },
    { id: 'G2', name: 'tool-surface（工具面一致性）', script: join(PKG, 'engine', 'verify', 'tool-surface.mjs'), args: [] },
    { id: 'G3', name: 'plugin-load（平台层装载·桩宿主）', script: join(PKG, 'engine', 'verify', 'plugin-load.mjs'), args: [] },
    { id: 'G4', name: 'gate-selfcheck（门的门·反例验证）', script: join(PKG, 'engine', 'verify', 'gate-selfcheck.mjs'), args: [] },
    { id: 'G5', name: 'ssrf-gate（SSRF 闸 + 原始字节 + 清扫）', script: join(PKG, 'engine', 'verify', 'ssrf-gate.mjs'), args: [] },
    { id: 'G6', name: 'assemble --verify（素材与 src 完整节一致）', script: join(PKG, 'engine', 'verify', 'assemble.mjs'), args: ['--verify'] },
    { id: 'G7', name: 'outgate（交付闸 · 40 KB 上限）', script: join(PKG, 'engine', 'verify', 'outgate.mjs'), args: [] },
    // ★ 2026-11-21 检查轮：把 **register-gate** 纳入全门。
    //   这道门是"改坏 DSH 启动配置"的风险闸（注册逻辑必须能完全还原），
    //   此前**不在 all.mjs 里** ⇒ 长期无人跑 ⇒ 它的判据恒红也没人知道（真问题：判据错）。
    //   注：它在假 profile 上跑，**绝不碰真 profile**。
    { id: 'G8', name: 'register-gate（profile 注册·改坏 DSH 的风险闸）', script: join(PKG, 'engine', 'verify', 'register-gate.mjs'), args: [] },
];

const results = [];
for (const g of GATES) {
    const r = run(g.script, g.args);
    results.push({ ...g, ...r });
}

const green = results.every((r) => r.code === 0);
const lines = [];
lines.push('══ FP 片 0 全门 ══');
lines.push(`包根：${PKG}`);
lines.push(`node：${NODE}`);
lines.push('');
for (const r of results) {
    lines.push(`${r.code === 0 ? 'EXIT=0 ✅' : `EXIT=${r.code ?? 'null'} ❌`}  ${r.id}  ${r.name}`);
    if (r.code !== 0) {
        const tail = (r.out || r.err || '').split('\n').filter(Boolean).slice(-12).join('\n    ');
        lines.push(`    ${tail}`);
    }
}
lines.push('');
lines.push(green ? '== 全门绿：片 0 可验收 ==' : '== 有门不绿：不接受，先修再走 ==');

try { rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.stdout.write(lines.join('\n') + '\n');
process.exit(green ? 0 : 1);
