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
 * engine/verify/assemble.mjs — 素材装配（`..\src\` → 包内），**完整节照搬**
 *
 * 规矩（Readme §四「本仓第一刀特殊」）：
 *   `src\` 是**预放素材、不是成品**。装配 = 把素材搬进包内落点，
 *   **能不改原件就不改**；未列入本片的件必须与预放**完整节一致**（R8 的门要能验）。
 *
 * 落点映射（src 组 → 包内）：
 *   src\ours\*         → <包根>\ours\*          （网络面，平铺 + engines + engines-offline）
 *   src\libs\*.js      → <包根>\ours\libs\*.js  （双留件的 FP 副本；url-guard 引 ./err.js 必须在同层）
 *   src\fp\*           → <包根>\fp\*
 *   src\deps\pylibs\*  → <包根>\deps\pylibs\*
 *   src\deps\pylibs_probe.py → <包根>\deps\pylibs_probe.py
 *
 * ★ 两条硬规矩（都来自实测，见 2-开发日志 L-008 / L-016）：
 *   1. **跳过运行残渣**：`fp\out\` 下的东西（`.tmp`、`.cdp-last-err.log`）不进包；
 *      `__pycache__` 不进包（源码在就行，pyc 跨机器无用且会让件数账说不清）。
 *   2. **`src\` 一个字节都不许动**：装配后重算 `src\` 全量哈希，与
 *      `BACKUP\_清单-src.txt` 逐件对拍，drift 必须 = 0。
 *
 * 用法：
 *   node engine\verify\assemble.mjs              # 真装配
 *   node engine\verify\assemble.mjs --dry-run    # 只报计划，不落盘
 *   node engine\verify\assemble.mjs --verify     # 只核对"已装配的与 src 一致"
 */

import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = resolve(HERE, '..', '..');          // 包根：可能是 work\，也可能是仓根（成品位）

/**
 * 找"仓根"= 含 `src\` 的那个祖先目录。
 *
 * ★ 2026-11-09 修：原来写死 `resolve(PKG,'..','..','..')`，只在"包在
 *   `Updating\<项目>\work\` 下"时成立。成品位搬到仓根之后（`package.json` /
 *   `platform\` / `engine\` 直接在 `dsh-fp-search\`）同一行就指到 `F:\workspace\` 去了，
 *   于是 G6 找 `F:\workspace\src` 找不到 ⇒ 假红。
 *   改成**向上探测 `src\`**：从 work 跑找到本项目仓根，从仓根跑立刻命中，两边都对。
 */
function findRepoRoot(from) {
    let d = from;
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(d, 'src'))) return d;
        const up = resolve(d, '..');
        if (up === d) break;
        d = up;
    }
    return resolve(PKG, '..', '..', '..');      // 兜底：保持旧行为
}

/** 找基线清单 `_清单-src.txt`（在 `Updating\<项目>\BACKUP\` 里）。 */
function findBaseline(repo) {
    const direct = join(repo, 'Updating', 'BACKUP', '_清单-src.txt');
    if (existsSync(direct)) return direct;
    const upd = join(repo, 'Updating');
    if (existsSync(upd)) {
        for (const name of readdirSync(upd)) {
            const p = join(upd, name, 'BACKUP', '_清单-src.txt');
            if (existsSync(p)) return p;
        }
    }
    return join(PKG, '..', 'BACKUP', '_清单-src.txt');   // 兜底：work 形态
}

const REPO = findRepoRoot(PKG);
const SRC = join(REPO, 'src');
const BASELINE = findBaseline(REPO);
const MANIFEST_OUT = join(PKG, 'ASSEMBLY.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERIFY_ONLY = argv.includes('--verify');

/** 不进包的路径片段（运行残渣 / 缓存 / 会随机器变的东西）。 */
const SKIP_SEGMENTS = new Set(['__pycache__', '.tmp', 'out', 'diag']);
const SKIP_FILES = new Set(['.cdp-last-err.log', '.DS_Store', 'Thumbs.db']);

function shouldSkip(rel) {
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => SKIP_SEGMENTS.has(p))) return true;
    const base = parts[parts.length - 1];
    return SKIP_FILES.has(base);
}

/** 递归列文件（相对路径）。 */
function walk(root, base = root, acc = []) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); }
    catch { return acc; }
    for (const e of entries) {
        const abs = join(root, e.name);
        if (e.isDirectory()) walk(abs, base, acc);
        else if (e.isFile()) acc.push(relative(base, abs));
    }
    return acc;
}

function sha8(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8).toUpperCase();
}

/** 落点映射：返回 [{ from(相对 src), to(相对包根) }] */
function buildPlan() {
    const plan = [];
    const pushGroup = (srcGroup, toGroup) => {
        const srcRoot = join(SRC, srcGroup);
        if (!existsSync(srcRoot)) return;
        for (const rel of walk(srcRoot)) {
            if (shouldSkip(rel)) continue;
            plan.push({ from: join(srcGroup, rel), to: join(toGroup, rel) });
        }
    };
    pushGroup('ours', 'ours');
    pushGroup('fp', 'fp');
    pushGroup('deps\\pylibs', 'deps\\pylibs');

    // libs 两件 → ours\libs\（url-guard.js:15 引 ./err.js，必须同层）
    for (const f of existsSync(join(SRC, 'libs')) ? readdirSync(join(SRC, 'libs')) : []) {
        if (!f.endsWith('.js')) continue;
        plan.push({ from: join('libs', f), to: join('ours', 'libs', f) });
    }
    // pylibs_probe.py → deps\
    const probe = join(SRC, 'deps', 'pylibs_probe.py');
    if (existsSync(probe)) plan.push({ from: join('deps', 'pylibs_probe.py'), to: join('deps', 'pylibs_probe.py') });

    return plan;
}

// ---------------------------------------------------------------- 基线核对（src 零改动）
function checkSrcBaseline() {
    if (!existsSync(BASELINE)) return { ok: false, detail: `基线清单缺失：${BASELINE}` };
    const lines = readFileSync(BASELINE, 'utf8').split(/\r?\n/).filter((l) => l.includes('\t'));
    const map = new Map();
    for (const l of lines) {
        const [h, , p] = l.split('\t');
        if (p) map.set(p, h);
    }
    const drift = [];
    for (const rel of walk(SRC)) {
        // ★ ITERATION-006（G6 门缺陷修复）：**必须先跳过运行残渣**，与 buildPlan 用同一套规则。
        //   否则跑过一次 cdp/render 之后，`fp/out/.cdp-*/**`、`fp/diag/*.txt`、
        //   `.cdp-last-err.log` 这些运行时产物会被当成"源码件"，基线里当然没有 ⇒ G6 假红。
        //   而它们本来就被 SKIP_SEGMENTS/SKIP_FILES 排除在装配之外，不该参与对拍。
        if (shouldSkip(rel)) continue;
        const expect = map.get(rel);
        const got = sha8(join(SRC, rel));
        if (expect !== got) drift.push(`${rel} 基线=${expect ?? '(无)'} 现=${got}`);
    }
    return { ok: drift.length === 0, detail: drift.slice(0, 5).join(' | '), count: map.size, drift };
}

// ---------------------------------------------------------------- 装配
function assemble(plan) {
    let copied = 0;
    const mismatched = [];
    for (const { from, to } of plan) {
        const srcAbs = join(SRC, from);
        const dstAbs = join(PKG, to);
        if (!DRY) {
            mkdirSync(dirname(dstAbs), { recursive: true });
            copyFileSync(srcAbs, dstAbs);
            if (sha8(srcAbs) !== sha8(dstAbs)) mismatched.push(to);
        }
        copied += 1;
    }
    return { copied, mismatched };
}

// ---------------------------------------------------------------- 主流程
const out = { at: new Date().toISOString(), mode: DRY ? 'dry-run' : VERIFY_ONLY ? 'verify' : 'assemble' };
let exitCode = 0;

/*
 * ★ 发布版可移植化（2026-11-16）：这道门是**开发期门** ——
 *   它比对「开发仓的 src/ 素材」与「包内已装配件」是否完整节一致。
 *   发布包（/ 装机槽）里没有 src/，素材**就是**包本身，没有"另一份可比对的东西"。
 *   原先在成品位跑它必然红（实测装机槽同样红），这是**假红**，不是门尽责。
 *   现在：src/ 不存在 ⇒ 如实报「发布包·此门不适用」并 EXIT=0；
 *   src/ 存在（开发仓）⇒ 照旧完整节比对，门照样抓漂移。
 */
if (!existsSync(SRC)) {
    out.skipped = `发布包形态：找不到开发仓素材目录 ${SRC}；此门是开发期门（素材与 src 完整节比对），在发布包/装机槽不适用。`;
    out.ok = true;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
}

// ① 先验 src 零改动（装配前后都要能验）
const base = checkSrcBaseline();
out.srcBaseline = { ok: base.ok, entries: base.count, detail: base.detail || '' };
if (!base.ok) exitCode = 1;

const plan = buildPlan();
out.plan = { files: plan.length };

if (VERIFY_ONLY) {
    /**
     * 只核对：包内已装配件与 src 逐件哈希一致。
     *
     * ★ 片 5（2026-11-09）新增 `LOCAL_EDITS`：R8「没碰的没变」的**正确表述**是
     *   "**没有列进本次改动清单的**预放件完整节不变"，不是"全部都不许动"。
     *   片 5 明确要改 `ours/web-search.js`（A-5/A-9/N12 记账）与 `ours/ws-engines.js`
     *   （6 张卡 + N12 重写）——若 G6 仍要求这两件与 src 一致，**那不是门尽责，是门判据错了**
     *   （同 01 项目 L-032 的教训：出现矛盾先怀疑判据）。
     *
     *   纪律：这份豁免清单**只许加、且每加一件必须在 02 项目 2-开发日志里点名**；
     *   不在清单里的件仍完整节比对 ⇒ 真事故（装配把别的件写脏）照样红。
     */
    const LOCAL_EDITS = new Set([
        'ours\\web-search.js',      // 片 5：A-5 归一 / A-9 截止 / N12 记账 / A-1 接线 / C-2 page 走 MD
        'ours\\ws-engines.js',      // 片 5：6 张卡 import+CARDS / N12 重写 / ENGINE_STATS
        'ours\\ws-text.js',         // 片 5 · C-1 clip 不劈代理对 + C-2 新增 htmlToMarkdown
        // ★ 黑框修复（2026-11-09，维护方报「调 doctor 时 CMD 黑框一闪而逝」）的
        //   `ours\ws-transport.js` 与 `fp\vendor\waf_fetch.py` **已不在本清单里**：
        //   本片已把修复同步进 `src\` 侧两件并重算基线清单 ⇒ 包内与 src 完整节一致，
        //   不再需要豁免（豁免只用于"改了但不同步"的情形）。
        //   背景：DSH 是 GUI 子系统进程，spawn Console 子系统的 python/node 必弹控制台窗口。
    ]);
    const diff = [];
    const editedFound = [];
    for (const { from, to } of plan) {
        const dstAbs = join(PKG, to);
        if (!existsSync(dstAbs)) { diff.push(`缺 ${to}`); continue; }
        const same = sha8(join(SRC, from)) === sha8(dstAbs);
        if (LOCAL_EDITS.has(to)) {
            editedFound.push(`${to}=${same ? '与src相同(未改)' : '已改(豁免)'}`);
            continue;
        }
        if (!same) diff.push(`差异 ${to}`);
    }
    // 反向检查：清单里点名的件必须真的存在（防"豁免了一个不存在的件"= 假绿）
    const missingEdit = [...LOCAL_EDITS].filter((t) => !existsSync(join(PKG, t)));
    out.verify = {
        ok: diff.length === 0 && missingEdit.length === 0,
        mismatched: diff.slice(0, 10),
        total: diff.length,
        localEdits: editedFound,
        localEditsMissing: missingEdit,
    };
    if (diff.length > 0 || missingEdit.length > 0) exitCode = 1;
}
else {
    const r = assemble(plan);
    out.assemble = { copied: r.copied, mismatched: r.mismatched.slice(0, 10), mismatchCount: r.mismatched.length };
    if (r.mismatched.length > 0) exitCode = 1;

    // ② 装配后再验一次 src 零改动（防装配过程反向写脏源）
    const after = checkSrcBaseline();
    out.srcAfter = { ok: after.ok, detail: after.detail || '' };
    if (!after.ok) exitCode = 1;

    if (!DRY) {
        // ③ 写 ASSEMBLY.json（装机自检的锚点）
        const pkgJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
        const manifest = {
            name: pkgJson.name,
            version: pkgJson.version,
            assembledAt: out.at,
            assembledFrom: { src: 'Work/dsh-fp-search/src', groups: ['ours', 'fp', 'deps/pylibs', 'libs→ours/libs', 'deps/pylibs_probe.py'] },
            counts: { files: r.copied, mismatched: r.mismatched.length, srcBaseline: base.count },
            skipped: { segments: [...SKIP_SEGMENTS], files: [...SKIP_FILES] },
            rules: [
                'src 只读：装配前后各验一次哈希，drift 必须 = 0',
                '运行残渣不进包：fp/out/**、__pycache__/**、.cdp-last-err.log',
                'libs 两件落到 ours/libs/（url-guard.js 引 ./err.js 必须同层）',
            ],
        };
        writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        out.manifest = 'ASSEMBLY.json 已写';
    }
}

out.ok = exitCode === 0;
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
process.exit(exitCode);
