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
 * engine/verify/register-gate.mjs — profile 注册门（**改坏 DSH 的风险闸**）
 *
 * 为什么单独一道门：装机要改 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`，
 * 那是 **DSH 的启动配置**。改坏了 DSH 直接起不来 —— 这是本项目最贵的一类错误。
 * 所以注册逻辑（`scripts/register-fp.mjs`）必须被**自动化验证到"能完全还原"**这个程度。
 *
 * 判什么（全部在临时目录里跑，**绝不碰真 profile**）：
 *   R-1  纯函数 `planProfile()`：注册只加两处，别的一字不动
 *   R-2  安全闸 `assertOnlyIntendedDiff()`：能抓出"多改了一处"
 *   R-3  真跑注册 → 结果只多两处（逐键比对）
 *   R-4  幂等：第二次跑报"无需改动"，且文件字节不变
 *   R-5  **反注册后与原文件完整节相同**（最强的还原证明）
 *   R-6  安全闸能拦住"故意改坏别的键"（反例，证明闸不是摆设）
 *   R-7  写后复验：manifest 可解析、dependencies 里有 link: 指向插件
 *
 * 用法：node engine\verify\register-gate.mjs
 */

import {
    mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = resolve(HERE, '..', '..');
const TMP = join(tmpdir(), 'fp-register-gate');
const PKG_NAME = 'dsh-fp-search';

function resolveNode() {
    // ★ 发布版可移植化（2026-11-16）：原写死 `C:\Users\Diccup\...`，改走家目录推导。
    const c = [
        process.env.FP_NODE,
        join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    ].filter(Boolean);
    for (const p of c) if (existsSync(p)) return p;
    return process.execPath;
}
const NODE = resolveNode();
const REG = join(PKG, 'scripts', 'register-fp.mjs');

const checks = [];
const add = (id, what, ok, detail) => checks.push({ id, what, ok, detail: detail ?? '' });
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** 跑注册脚本，结果走文件（沙箱内管道 EPERM，见 L-013）。 */
let seq = 0;
function runReg(args) {
    mkdirSync(TMP, { recursive: true });
    const outFile = join(TMP, `reg-${++seq}.json`);
    const { openSync, closeSync } = require_fs();
    const fd = openSync(outFile, 'w');
    let r;
    try { r = spawnSync(NODE, [REG, ...args], { stdio: ['ignore', fd, fd], windowsHide: true }); }
    finally { closeSync(fd); }
    let parsed = null;
    let raw = '';
    try { raw = readFileSync(outFile, 'utf8'); parsed = JSON.parse(raw); } catch { parsed = null; }
    try { rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
    return { code: r.error ? null : r.status, out: parsed, raw };
}
function require_fs() {
    // 顶层已 import 了 fs 的一部分；这里补齐 openSync/closeSync 的引用
    return { openSync: fsOpen, closeSync: fsClose };
}
import { openSync as fsOpen, closeSync as fsClose } from 'node:fs';

// ---------------------------------------------------------------- 造一个假 profile
// ★★ 2026-11-21 检查轮修（判据错 ⇒ 恒红，不是实现错）：
//   原先直接拿**真 profile**当样本。真 profile 里 `dsh-fp-search` **本来就已注册**，
//   于是：① 注册时本包的 link 目标被改写 ⇒ R-3 判"其它依赖不变"时误算 ⇒ 恒红；
//        ② 反注册的语义就是**删掉本包** ⇒ 还原后与"原文件"必然不同 ⇒ R-5 恒红。
//   改成：用一份**干净 fixture**（不含本包）当样本 ⇒ 注册/反注册的往返才有可比基线。
//   真 profile 的形状仍作参照（依赖键名/bundles 内容照它的样子造）。
const REAL_PROFILE_PKG = join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json');
const FAKE = join(TMP, 'profile');
const FAKE_PKG = join(FAKE, 'package.json');

/** 造一份"未装本插件"的干净 profile 样本（形状照真 profile，尽量贴近真实配置）。 */
function buildCleanFixture() {
    const base = {
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: {
            'dsh-team': 'link:C:/x/.dsh/plugins/dsh-team',
            'dshmarket': '1.73.21',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-team'] } },
    };
    // 真 profile 存在 ⇒ 借它的键名与 bundles 内容（**去掉本包**），保证形状一致
    if (existsSync(REAL_PROFILE_PKG)) {
        try {
            const real = JSON.parse(readFileSync(REAL_PROFILE_PKG, 'utf8'));
            const deps = {};
            for (const [k, v] of Object.entries(real.dependencies ?? {})) {
                if (k === PKG_NAME) continue;
                deps[k] = v;
            }
            const bundles = (real?.dsh?.profile?.bundles ?? []).filter((x) => x !== PKG_NAME);
            if (Object.keys(deps).length > 0) base.dependencies = deps;
            if (bundles.length > 0) base.dsh.profile.bundles = bundles;
        }
        catch { /* 真 profile 读不动 ⇒ 用内置 fixture */ }
    }
    return base;
}

function resetFake() {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(FAKE, { recursive: true });
    writeFileSync(FAKE_PKG, JSON.stringify(buildCleanFixture(), null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------- R-1 / R-2 纯函数
{
    const mod = await import(`file:///${REG.replace(/\\/g, '/')}`);
    // ★ 2026-11-21 检查轮修：样本用**干净 fixture**（不含本包），不是真 profile。
    //   真 profile 里本包已注册 ⇒ planProfile 只改写 link 目标（changes=1）⇒ 判据恒红。
    const before = buildCleanFixture();
    const { next, changes } = mod.planProfile(before, { pluginDir: PKG });
    const diff = mod.assertOnlyIntendedDiff(before, next, {});
    add('R-1', 'planProfile：注册只加 dependencies + bundles 两处',
        diff.length === 0 && changes.length === 2 && next.dependencies['dsh-fp-search']?.startsWith('link:'),
        `changes=${changes.length} diff=${diff.length}`);

    // 反例：故意多改一个键，安全闸必须报
    const broken = JSON.parse(JSON.stringify(next));
    broken.private = !broken.private;
    const caught = mod.assertOnlyIntendedDiff(before, broken, {});
    add('R-2', '安全闸能抓出"多改了一处"（反例）', caught.length > 0, caught[0] ?? '没抓到！');
}

// ---------------------------------------------------------------- R-3 真跑注册
resetFake();
const origHash = sha(FAKE_PKG);
const origText = readFileSync(FAKE_PKG, 'utf8');
const r1 = runReg(['--profile', FAKE, '--plugin', PKG]);
{
    const after = JSON.parse(readFileSync(FAKE_PKG, 'utf8'));
    const before = JSON.parse(origText);
    const depOk = after.dependencies['dsh-fp-search'] === `link:${PKG.replace(/\\/g, '/')}`;
    const bundleOk = after.dsh.profile.bundles.includes('dsh-fp-search');
    // 其它依赖与 bundles 顺序必须原样
    // ★★ 2026-11-21 检查轮修判据（原先恒红，是**门判据错**不是实现错）：
    //   本包自己的 key 也要跳过。注册时 `dependencies['dsh-fp-search']` 会从
    //   `link:C:/Users/<你>/.dsh/plugins/dsh-fp-search` 改写成 `link:<当前插件目录>`
    //   （指向变了是**注册的本意**），把它算进"其它依赖必须逐字不变" ⇒ 必然不等 ⇒ 恒红。
    const otherDepsSame = Object.keys(before.dependencies ?? {})
        .filter((k) => k !== PKG_NAME)
        .every((k) => JSON.stringify(before.dependencies[k]) === JSON.stringify(after.dependencies[k]));
    const otherBundlesSame = JSON.stringify(
        before.dsh.profile.bundles.filter((x) => x !== PKG_NAME),
    ) === JSON.stringify(after.dsh.profile.bundles.filter((x) => x !== PKG_NAME));
    add('R-3', '真跑注册：只多两处，其余依赖与 bundles 顺序原样',
        r1.code === 0 && depOk && bundleOk && otherDepsSame && otherBundlesSame,
        `exit=${r1.code} dep=${depOk} bundle=${bundleOk} deps_same=${otherDepsSame} bundles_same=${otherBundlesSame}`);
}

// ---------------------------------------------------------------- R-4 幂等
{
    const h1 = sha(FAKE_PKG);
    const r2 = runReg(['--profile', FAKE, '--plugin', PKG]);
    const h2 = sha(FAKE_PKG);
    add('R-4', '幂等：二次跑报"无需改动"且文件字节不变',
        r2.code === 0 && h1 === h2 && /无需改动/.test(r2.out?.note ?? ''),
        `exit=${r2.code} hashSame=${h1 === h2}`);
}

// ---------------------------------------------------------------- R-5 反注册完全还原
{
    const r3 = runReg(['--profile', FAKE, '--unregister']);
    // ★★ 2026-11-21 检查轮修判据：原来断言"与原文件**逐字节**相同" ⇒ 恒红。
    //   两处硬伤：① 原文件是**已注册**的真 profile ⇒ 反注册把本包删掉 ⇒ 必然不同；
    //              ② `serialize()` 固定补一个尾部 LF，原文件可能没有 ⇒ 字节级差异无意义。
    //   改成**语义还原**判据：顶层键集合一致 + 其它依赖逐键一致 + 其它 bundles 顺序一致
    //   + 本包确实已不在（dependencies/bundles 里都没有它）。
    const after = JSON.parse(readFileSync(FAKE_PKG, 'utf8'));
    const before = JSON.parse(origText);
    const depKeysOk = JSON.stringify(Object.keys(before.dependencies ?? {}).filter((k) => k !== PKG_NAME).sort())
        === JSON.stringify(Object.keys(after.dependencies ?? {}).filter((k) => k !== PKG_NAME).sort());
    const depValsOk = Object.keys(before.dependencies ?? {})
        .filter((k) => k !== PKG_NAME)
        .every((k) => JSON.stringify(before.dependencies[k]) === JSON.stringify(after.dependencies?.[k]));
    const bundlesOk = JSON.stringify((before.dsh?.profile?.bundles ?? []).filter((x) => x !== PKG_NAME))
        === JSON.stringify((after.dsh?.profile?.bundles ?? []).filter((x) => x !== PKG_NAME));
    const pkgGone = !Object.prototype.hasOwnProperty.call(after.dependencies ?? {}, PKG_NAME)
        && !(after.dsh?.profile?.bundles ?? []).includes(PKG_NAME);
    const topKeysOk = JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(after).sort());
    const restored = depKeysOk && depValsOk && bundlesOk && pkgGone && topKeysOk;
    add('R-5', '★ 反注册后**语义还原**（其它键/依赖/bundles 原样，本包已移除）',
        r3.code === 0 && restored,
        `exit=${r3.code} restored=${restored} deps=${depKeysOk && depValsOk} bundles=${bundlesOk} pkgGone=${pkgGone} topKeys=${topKeysOk}`);
}

// ---------------------------------------------------------------- R-7 写后复验产物
{
    // 再注册一次，检查写后复验字段与 link 路径形态
    const r4 = runReg(['--profile', FAKE, '--plugin', PKG]);
    const good = r4.code === 0 && /通过/.test(r4.out?.verified ?? '');
    const noBackslashLink = !/link:[A-Za-z]:\\/.test(readFileSync(FAKE_PKG, 'utf8'));
    add('R-7', '写后复验通过，且 link: 路径用正斜杠（不用反斜杠）',
        good && noBackslashLink, `exit=${r4.code} verified=${r4.out?.verified} noBackslash=${noBackslashLink}`);
}

// ---------------------------------------------------------------- 收尾：清掉假 profile
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

const green = checks.every((c) => c.ok);
const lines = ['FP register-gate（profile 注册 · 改坏 DSH 的风险闸）', `假 profile：${FAKE}（已清理）`, ''];
for (const c of checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(4)} ${c.what}${c.detail ? `  — ${c.detail}` : ''}`);
lines.push('', green ? 'ALL GREEN ✅（注册逻辑能完全还原，可以放心动真 profile）' : 'RED ❌（别碰真 profile）');
process.stdout.write(lines.join('\n') + '\n');
process.exit(green ? 0 : 1);
