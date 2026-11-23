/**
 * engine/verify/gate-selfcheck.mjs — **门的门**：反例验证
 *
 * 为什么要有它：Readme §五 的红线 ——"门全绿 ≠ 门是好的"。
 *   一个永远报绿的判据等于没有判据（而且更坏：它让人以为验过了）。
 *   2026-11-09 本仓首跑就踩到一次**门的误报**（G-4 把路径名当参数名），
 *   所以才要有这一道：**主动造反例，看门必不必须红**。
 *
 * 做法：把被测门当子进程跑，喂它一份**故意改坏**的副本，断言它 EXIT≠0。
 *   改坏的方式只落在临时目录里的副本上，**原件一个字节都不动**。
 *
 * 用法：node engine\verify\gate-selfcheck.mjs
 */

import { mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
process.env.PYTHONDONTWRITEBYTECODE = '1';  // 04 片：开发期门不许在源码树留 __pycache__（见 ssrf-gate.mjs 顶注完整版）


const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = resolve(HERE, '..', '..');
// ★ 发布版可移植化（2026-11-21 检查轮修复）：原先写死 'F:\workspace\LongMem\Temp\fp-gate-selfcheck'
//   ⇒ 别人机器上没有 F 盘 ⇒ 这道门直接崩。改走系统临时目录（跨平台，永不写死盘符）。
const TEMP_ROOT = join(tmpdir(), 'fp-gate-selfcheck');

/**
 * ★ 找 node 可执行文件 —— **不许用裸 `process.execPath`**。
 *   2026-11-09 本仓首跑实测：本文件在 DSH 进程内被跑时，`process.execPath` 是
 *   `F:\Ds harness\DeepSeek Harness.exe`（Electron 宿主），拿它 spawn 子门 ⇒
 *   `spawnSync` 直接失败、`status=null`、**五条反例全部"通过"** —— 门在骗人。
 *   这正是 `模块关联表` §一-4 记的 R11（`python-find.js` 踩过的同一个坑）的
 *   同族变体：**Electron 进程里 process.execPath 不是 node**。
 *
 *   解析顺序：① 环境变量 `FP_NODE`（装机/CI 显式指定）→ ② 随包 python 同树的
 *   node（本机写死可复现）→ ③ `process.execPath`（只在真·node 进程里才对）。
 */
function resolveNode() {
    const candidates = [
        process.env.FP_NODE,
        // ★ 发布版可移植化（2026-11-21 检查轮修复）：原写死 'C:\Users\Diccup\...'，
        //   别人机器上没有这个路径 ⇒ 落到 process.execPath（可能是 Electron 宿主）⇒ 门在骗人。
        //   改走家目录推导（与 all.mjs / register-gate.mjs 同一口径）。
        join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    ].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return c;
    return process.execPath;
}
const NODE = resolveNode();

const checks = [];
const add = (id, what, ok, detail) => checks.push({ id, what, ok, detail: detail ?? '' });

/**
 * ★ 子进程必须用**文件**收结果，不许用管道。
 *   2026-11-09 本仓首跑实测（同窗两次）：受限 token 下
 *   `spawnSync(node, [...], {encoding:'utf8'})` 直接
 *   `EPERM ... stdout undefined`，`status=null`；
 *   改成 `stdio:['ignore', fd, fd]` 指向文件后同一命令 `status=0`。
 *   这正是 `ours/fp-bridge.js:3` 头注早就记下的 "沙箱内 stdout 管道不可靠，
 *   通信走文件" —— 本文件是同一个坑的第二次复现（登记进 2-开发日志 L-013）。
 */
let runSeq = 0;
function runNode(script, args = []) {
    mkdirSync(TEMP_ROOT, { recursive: true });
    const outFile = join(TEMP_ROOT, `child-${++runSeq}.log`);
    let fd;
    try {
        fd = openSync(outFile, 'w');
    }
    catch (e) {
        return { code: null, out: `openSync failed: ${e.message}` };
    }
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
    if (r.error) return { code: null, out: `spawn error: ${r.error.message}` };
    return { code: r.status, out };
}

/** 复制一份包到临时目录（只复制验证需要的部分，快）。
 *  ★ 04 片：加 extra 参数——ssrf-gate 需要 `ours/`（url-guard/fp-bridge/python-find）与
 *    `fp/`（rawdl 判据）两棵树，默认清单里没有 ⇒ 沙箱内必缺件；
 *    缺件的门如果"照样绿"就是假绿，所以复制清单必须随被测门扩展。
 *  ★★ 05 片（实测推翻 04 的做法，见 05 项目 L-011）：05 让 `install-dryrun` 硬依赖
 *    `scripts/copy-product.mjs` ⇒ 只拷 engine/platform 的默认清单会把 I-1 打成"缺件红"，
 *    连带假槽不建、I-13 变"main 读不到" ⇒ **反例靠事故命中，真反例与假红再也分不开**
 *    （实验：未改坏的沙箱跑 install-dryrun 也 EXIT=1）。
 *    现在默认清单 = **照 `package.json` 的 files 复制完整成品**（与真装机同一口径、同一实现），
 *    沙箱从此是"完整可跑的包"，反例的红只能来自被故意改坏的那一处。
 *    extra 保留：给需要**成品之外**树（如 `src`）的用例。 */
const PRODUCT = await import(pathToFileURL(join(PKG, 'scripts', 'copy-product.mjs')).href);
function makeSandbox(tag, extra = []) {
    const dst = join(TEMP_ROOT, tag);
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dst, { recursive: true });
    const plan = PRODUCT.planProduct(PKG);
    if (plan.missing.length > 0) throw new Error(`沙箱基座缺件（files 声明但源里没有）：${plan.missing.join(', ')}`);
    const res = PRODUCT.copyProduct(plan, { from: PKG, to: dst, apply: true });
    if (res.failed.length > 0) throw new Error(`沙箱基座复制失败：${res.failed.slice(0, 3).join(' | ')}`);
    for (const rel of extra) {
        const src = join(PKG, rel);
        if (existsSync(src)) cpSync(src, join(dst, rel), { recursive: true });
    }
    return dst;
}

// ---------------------------------------------------------------- 基线：原件必须绿
const base = runNode(join(PKG, 'engine', 'verify', 'tool-surface.mjs'));
add('S-0', '基线：未改的原件跑 tool-surface 必须绿', base.code === 0, `EXIT=${base.code}`);

// ★ 04 片基线：未改的原件跑 ssrf-gate 也必须绿（联网 + python 各一发）。
//   没有这条基线，下面的 S-7/S-8 反例"红了"可能只是沙箱缺件，证明不了门尽责。
const baseRaw = runNode(join(PKG, 'engine', 'verify', 'ssrf-gate.mjs'));
add('S-0b', '基线：未改的原件跑 ssrf-gate 必须绿（含 S-6/S-7a/S-7b）', baseRaw.code === 0, `EXIT=${baseRaw.code}`);

// ★ 05 片基线（同 S-0b 的道理，且这条是 05 施工中真抓出来的洞，见 05 项目 L-011）：
//   install-dryrun 自 05 起硬依赖 `scripts/copy-product.mjs` ⇒ 沙箱基座若不完整，
//   I-1 会因"缺件"红、连带假槽不建、I-13 变"main 读不到" ⇒ 反例全靠事故命中，
//   真反例与假红**再也分不开**。这条基线绿，才说明后面 S-6 的红是"故意改坏"造成的。
{
    const box = makeSandbox('case0c');
    const r = runNode(join(box, 'engine', 'verify', 'install-dryrun.mjs'));
    add('S-0c', '基线：未改坏的完整沙箱跑 install-dryrun 必须绿（沙箱基座可证伪）', r.code === 0,
        `EXIT=${r.code}${r.code !== 0 ? ` | ${(r.out || '').split('\n').filter((l) => /FAIL/.test(l)).slice(0, 2).join(' ; ').slice(0, 220)}` : ''}`);
}

mkdirSync(TEMP_ROOT, { recursive: true });

// ---------------------------------------------------------------- 反例 1：op 清单被改坏
{
    const box = makeSandbox('case1');
    const f = join(box, 'platform', 'catalog.js');
    const src = readFileSync(f, 'utf8').replace(
        "export const KNOWN_OPS = Object.freeze(['search', 'fetch', 'doctor']);",
        "export const KNOWN_OPS = Object.freeze(['search', 'fetch']);",
    );
    writeFileSync(f, src, 'utf8');
    const r = runNode(join(box, 'engine', 'verify', 'tool-surface.mjs'));
    add('S-1', '反例：catalog 少一个 op ⇒ 门必须红', r.code !== 0, `EXIT=${r.code} ${/FAIL\s+G-2/.test(r.out) ? '(G-2 命中)' : '(未命中 G-2)'}`);
}

// ---------------------------------------------------------------- 反例 2：参数表漏一个
{
    const box = makeSandbox('case2');
    const f = join(box, 'platform', 'tool-def.js');
    const src = readFileSync(f, 'utf8').replace(
        "    maxBytes: { type: 'number', description: 'fetch 用：单个文件字节上限' },",
        '',
    );
    writeFileSync(f, src, 'utf8');
    const r = runNode(join(box, 'engine', 'verify', 'tool-surface.mjs'));
    add('S-2', '反例：tool-def 漏一个参数 ⇒ 门必须红', r.code !== 0, `EXIT=${r.code} ${/FAIL\s+G-3/.test(r.out) ? '(G-3 命中)' : '(未命中 G-3)'}`);
}

// ---------------------------------------------------------------- 反例 3：交付格式被改
{
    const box = makeSandbox('case3');
    const f = join(box, 'engine', 'contract.mjs');
    const src = readFileSync(f, 'utf8').replace(
        'itemTitle: (i, engine, title) => `[${i}] (${engine}) ${title}`',
        'itemTitle: (i, engine, title) => `${i}. ${title}`',
    );
    writeFileSync(f, src, 'utf8');
    const r = runNode(join(box, 'engine', 'verify', 'tool-surface.mjs'));
    add('S-3', '反例：交付格式被改 ⇒ 门必须红', r.code !== 0, `EXIT=${r.code} ${/FAIL\s+G-5/.test(r.out) ? '(G-5 命中)' : '(未命中 G-5)'}`);
}

// ---------------------------------------------------------------- 反例 4：参数混进 runtime 键（复现 L-012）
{
    const box = makeSandbox('case4');
    const f = join(box, 'platform', 'plugin.js');
    const src = readFileSync(f, 'utf8').replace(
        'call: (args, signal, meta) => engine.call(args, { signal, meta }),',
        'call: (args, signal, meta) => engine.call({ ...args, __signal: signal }, { meta }),',
    );
    writeFileSync(f, src, 'utf8');
    const r = runNode(join(box, 'engine', 'verify', 'plugin-load.mjs'));
    // 期望：真调那一发因为多了 __signal 被白名单拒 ⇒ P-5 拿到的是 FP_BAD_ARGS 而不是结果。
    add('S-4', '反例：runtime 键混进 args ⇒ plugin-load 必须红', r.code !== 0, `EXIT=${r.code} ${/FAIL\s+P-5/.test(r.out) ? '(P-5 命中)' : '(未命中 P-5)'}`);
}

// ---------------------------------------------------------------- 反例 5：op 数被改成 4
{
    const box = makeSandbox('case5');
    const f = join(box, 'engine', 'contract.mjs');
    const src = readFileSync(f, 'utf8').replace(
        "        op: 'doctor',",
        "        op: 'doctor',\n    }),\n    Object.freeze({\n        op: 'extra',\n        oneLine: '故意多出来的 op（反例）',\n        requires: Object.freeze([]),",
    );
    writeFileSync(f, src, 'utf8');
    const r = runNode(join(box, 'engine', 'index.mjs'), ['--selftest']);
    // 多一个 op 但没有实现 ⇒ 引擎启动期就炸（blocks/14-tools 的反向自检），这就是要的效果
    add('S-5', '反例：私自加第 4 个 op ⇒ 启动期必须炸/自检必须红', r.code !== 0, `EXIT=${r.code}`);
}

// ---------------------------------------------------------------- 反例 6：导出假 Config（复现真机崩溃）
// ★ 这是 2026-11-09 真机不加载的**真元凶**（L-032）：`export const Config = {};`
//   cordis 4.1 resolveConfig 只在 `!runtime.Config` 时放行；`{}` truthy ⇒ 取 `['~standard'].validate`
//   ⇒ undefined.validate ⇒ TypeError，插件在 apply() 之前就崩。
//   本反例把这一行塞回沙箱，**I-13 必须红**。若这条不红，说明 I-13 是假门。
{
    const box = makeSandbox('case6');
    const f = join(box, 'platform', 'plugin.js');
    const src = readFileSync(f, 'utf8').replace(
        "export const name = 'dsh-fp-search';",
        "export const name = 'dsh-fp-search';\nexport const Config = {};",
    );
    writeFileSync(f, src, 'utf8');
    const r = runNode(join(box, 'engine', 'verify', 'install-dryrun.mjs'));
    add('S-6', '反例：导出 Config = {} ⇒ install-dryrun 的 I-13 必须红', r.code !== 0, `EXIT=${r.code} ${/FAIL\s+I-13/.test(r.out) ? '(I-13 命中)' : '(未命中 I-13)'}`);
}

// ---------------------------------------------------------------- 反例 7（04 片）：拆掉降级路的终 URL 复核
// 把 03-fetch 里"final_url 再过一次 JS 闸"的复核改成直接放行 ⇒ S-7b 必须红。
{
    const box = makeSandbox('case7', ['ours', 'fp']);
    const f = join(box, 'engine', 'blocks', '03-fetch', 'index.js');
    const src = readFileSync(f, 'utf8').replace(
        `    try {
        assertSafeUrl(rr.finalUrl);
    } catch (e) {`,
        `    try {
        void 0;   // 故意拆掉复核（反例）
    } catch (e) {`,
    );
    if (src === readFileSync(f, 'utf8')) {
        add('S-7', '反例：拆掉 final_url 复核 ⇒ ssrf-gate S-7b 必须红', false, '改坏锚点没落上（沙箱内代码形状与预期不符）');
    } else {
        writeFileSync(f, src, 'utf8');
        const r = runNode(join(box, 'engine', 'verify', 'ssrf-gate.mjs'));
        add('S-7', '反例：拆掉 final_url 复核 ⇒ ssrf-gate S-7b 必须红', r.code !== 0 && /FAIL\s+S-7b/.test(r.out), `EXIT=${r.code}${/FAIL\s+S-7b/.test(r.out) ? ' (S-7b 命中)' : ' (未命中 S-7b)'}`);
    }
}

// ---------------------------------------------------------------- 反例 8（04 片）：把 python 判据改松
// 删掉 rawdl.py 的 169.254 链路本地判定 ⇒ S-6 对账必须抓到"py 更松"并红。
{
    const box = makeSandbox('case8', ['ours', 'fp']);
    const f = join(box, 'fp', 'support', 'rawdl.py');
    const src = readFileSync(f, 'utf8').replace(
        '    if a == 169 and b == 254:\n        return True',
        '    # 故意拆掉链路本地/metadata 判定（反例）',
    );
    if (src === readFileSync(f, 'utf8')) {
        add('S-8', '反例：python 判据改松 ⇒ ssrf-gate S-6 必须红', false, '改坏锚点没落上（rawdl 判据形状与预期不符）');
    } else {
        writeFileSync(f, src, 'utf8');
        const r = runNode(join(box, 'engine', 'verify', 'ssrf-gate.mjs'));
        add('S-8', '反例：python 判据改松 ⇒ ssrf-gate S-6 必须红', r.code !== 0 && /FAIL\s+S-6/.test(r.out), `EXIT=${r.code}${/FAIL\s+S-6/.test(r.out) ? ' (S-6 命中)' : ' (未命中 S-6)'}`);
    }
}

rmSync(TEMP_ROOT, { recursive: true, force: true });
// ---------------------------------------------------------------- 输出
const green = checks.every((c) => c.ok);
const lines = ['FP gate-selfcheck（门的门 · 反例验证）', ''];
for (const c of checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(4)} ${c.what}${c.detail ? `  — ${c.detail}` : ''}`);
lines.push('', green ? 'ALL GREEN ✅（每道门都能被对应的改动打红）' : 'RED ❌（有门对改坏不敏感 = 假绿风险）');
process.stdout.write(lines.join('\n') + '\n');
process.exit(green ? 0 : 1);
