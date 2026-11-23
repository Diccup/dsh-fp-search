/**
 * engine/verify/install-dryrun.mjs — 装机预演门（不动真装机槽）
 *
 * 为什么要有它：Readme §五 的红线 —— "关 DSH 重启之前，必须先核验"。
 *   真装机要主人退出 DSH、双击脚本，白折腾一轮代价很高（CTX 有过真事故）。
 *   本门把整包**复制到一个临时 ASCII 目录**，当成"假装机槽"跑全套，
 *   全绿了才有资格请主人动手。
 *
 * 判什么：
 *   I-1  复制到 ASCII 临时槽不报错，件数对得上
 *   I-2  槽内 `engine\index.mjs --selftest` 绿
 *   I-3  槽内 `verify\tool-surface.mjs --dir <槽>` 绿（**装机形态**的 package.json 也对得上）
 *   I-4  槽内 `verify\plugin-load.mjs` 绿（能真的加载出 fp 工具）
 *   I-5  槽内 `assemble.mjs --verify` 绿（素材与 src 逐字节一致）
 *   I-6  槽里**没有** `backups\`、`Temp\`、`node_modules\` 这些不该装进去的东西
 *   I-7  用槽内路径真调一次 `doctor`（只验不崩；逐家网络探测跳过，见下）
 *
 * ★ 子进程一律走文件收结果（受限态管道 EPERM，见 L-013）。
 * 用法：node engine\verify\install-dryrun.mjs
 */

import {
    mkdirSync, rmSync, existsSync, readdirSync, openSync, closeSync, readFileSync, statSync,
} from 'node:fs';
// ★ 05 片：`cpSync` 已从本门摘掉 —— 造假槽改走 `scripts/copy-product.mjs`（单一真源），
//   留着这个 import 会让人以为本门还在自己整目录复制（关联表 #75 的病根就是"看着像两份都对"）。
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
process.env.PYTHONDONTWRITEBYTECODE = '1';  // 04 片：开发期门不许在源码树留 __pycache__（见 ssrf-gate.mjs 顶注完整版）

import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = resolve(HERE, '..', '..');
// ★ 发布版可移植化（2026-11-21 检查轮修复）：原先写死 'F:\workspace\LongMem\Temp\fp-install-dryrun'
//   ⇒ 别人机器上没有 F 盘 ⇒ 这道门直接崩。改走系统临时目录（跨平台，永不写死盘符）。
const FAKE_SLOT = join(tmpdir(), 'fp-install-dryrun', 'dsh-fp-search');
const TMP = join(tmpdir(), 'fp-install-dryrun');

function resolveNode() {
    // ★ 发布版可移植化（2026-11-21 检查轮修复）：原写死 'C:\Users\Diccup\...' ⇒ 改走家目录推导。
    const c = [process.env.FP_NODE, join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')].filter(Boolean);
    for (const p of c) if (existsSync(p)) return p;
    return process.execPath;
}
const NODE = resolveNode();

const checks = [];
const add = (id, what, ok, detail) => checks.push({ id, what, ok, detail: detail ?? '' });

let seq = 0;
function runInSlot(scriptRel, args = []) {
    mkdirSync(TMP, { recursive: true });
    const outFile = join(TMP, `out-${++seq}.log`);
    const fd = openSync(outFile, 'w');
    let r;
    try {
        r = spawnSync(NODE, [join(FAKE_SLOT, scriptRel), ...args], { stdio: ['ignore', fd, fd], cwd: FAKE_SLOT, windowsHide: true });
    }
    finally { closeSync(fd); }
    let out = '';
    try { out = readFileSync(outFile, 'utf8'); } catch { /* 忽略 */ }
    try { rmSync(outFile, { force: true }); } catch { /* 忽略 */ }
    return { code: r.error ? null : r.status, err: r.error?.message, out };
}

// ---------------------------------------------------------------- 造假槽
// ★ 05 片（主人令「改脚本，只装需要的内容，开发内容装进去干嘛0- 0！」）：
//   原来这里**自己又写了一份黑名单**（backups/Temp/node_modules），与 `install-fp.ps1` 那份各管各的
//   ⇒ 预演绿了不代表真装机干净（关联表 #75 / #13 同族事故："维护一份本来可以算出来的清单"）。
//   现在真装机与预演**共用 `scripts/copy-product.mjs`**（真源 = package.json 的 files），
//   本门不再持有任何文件清单字面量。
let slotPlan = null;
let slotModule = null;   // ★ 05：给 I-6b 交叉核对用；取不到时保持 null，**绝不抛**（抛了整道门崩 = 假失败）
try {
    rmSync(TMP, { recursive: true, force: true });
    const cp = await import(pathToFileURL(join(PKG, 'scripts', 'copy-product.mjs')).href);
    slotModule = cp;
    slotPlan = cp.planProduct(PKG);
    const res = cp.copyProduct(slotPlan, { from: PKG, to: FAKE_SLOT, apply: true });
    if (slotPlan.missing.length > 0) throw new Error(`白名单声明的件在源里缺失：${slotPlan.missing.join(', ')}`);
    if (res.failed.length > 0) throw new Error(`复制 IO 失败：${res.failed.slice(0, 5).join(' | ')}`);
    add('I-1', '用 copy-product 按 files 白名单造 ASCII 假槽成功', existsSync(FAKE_SLOT),
        `${FAKE_SLOT}（计划 ${slotPlan.entries.length} 件 / ${(slotPlan.entries.reduce((s, x) => s + x.bytes, 0) / 1048576).toFixed(2)} MB）`);
}
catch (e) {
    add('I-1', '用 copy-product 按 files 白名单造 ASCII 假槽成功', false, String(e?.message ?? e));
}

// ---------------------------------------------------------------- I-6b 假槽必须是纯成品（05 新增）
// ★ 反假绿设计（本门首跑就抓到过一次假绿，见 05 L-008）：
//   校验口径**不取复制器自己的 plan**，而是**外部重算** —— 直接读 `package.json` 的 files 原文，
//   逐条判"假槽里每个文件是否被白名单允许 / 白名单里每个顶层项是否真有文件进槽"。
//   否则就成了"用被测件算出的计划给被测件打分"（I-1 红了它还能绿 = #65/#73 同族的自证假绿）。
{
    // 前置：I-1 不成，I-6b 没有判"绿"的资格（按 id 查，不靠数组位置——位置会被后续插项打断）
    const i1 = checks.find((c) => c.id === 'I-1');
    const i1ok = Boolean(i1 && i1.ok);
    let slotFiles = [];
    try {
        (function rec(d) {
            for (const e of readdirSync(d, { withFileTypes: true })) {
                const f = join(d, e.name);
                if (e.isDirectory()) rec(f);
                else slotFiles.push(f.slice(FAKE_SLOT.length + 1).replace(/\\/g, '/'));
            }
        })(FAKE_SLOT);
    }
    catch { slotFiles = []; }

    let wl = [];
    try { wl = (JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).files || []).map((x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '')); }
    catch { wl = []; }
    const allowed = (rel) => rel === 'package.json' || wl.some((w) => rel === w || rel.startsWith(w + '/'));

    const notAllowed = slotFiles.filter((r) => !allowed(r));
    // ★ 第二道**独立**判据：门**自带**一份"开发内容类别"字面量，不向复制器借常量。
    //   为什么不用复制器导出的那份：拆掉复制器 lint 时，整个模块可能都 import 不到 ⇒ 门跟着失明（自证）。
    //   代价 = 类别字面量两处各有一份（漂移风险）⇒ 用下面两个锚点把它变成**可证伪**的：
    //     锚点1（交叉核对）：复制器模块能拿到的话，两份类别集合必须完全相等，不等 ⇒ 红（漂移当场抓）。
    //     锚点2（**可证伪自测**）：门当场拿一条已知该判脏的假白名单（含 'Updating'）喂给自己这套判据，
    //           判不出脏 ⇒ 说明这份字面量/判据被人改坏了 ⇒ 红。★ 第一版锚点写成"每一项都得在仓里真存在"，
    //           在 work 施工位必假红（work 只补成品件，没有 Updating/src）⇒ 存在性不是判据有效性的凭据，
    //           "已知脏样本必须被判脏"才是（05 L-010 自查）。
    const GATE_NEVER = new Set(['Updating', 'src', 'Reference', 'backups', 'Temp', 'node_modules']);
    const dirtyOf = (list) => list.filter((w) => GATE_NEVER.has(w.split('/')[0]));
    const dirtyWl = dirtyOf(wl);
    const gateDrift = slotModule && slotModule.NEVER_TOP
        ? [...GATE_NEVER].sort().join(',') !== [...slotModule.NEVER_TOP].sort().join(',')
        : false;
    const selfTestOk = dirtyOf(['engine', 'Updating', 'deps/pylibs']).join(',') === 'Updating';
    // 形态负面断言（"绝对不许进槽"的东西，不是"该装什么"的清单）：
    const junkInSlot = slotFiles.filter((r) => r.split('/').includes('__pycache__') || r.split('/').includes('out') || r.endsWith('.rar'));
    // 白名单每个顶层项必须在槽里有实物（防止"少装一整目录"还绿）
    const emptyTops = wl.filter((w) => existsSync(join(PKG, w)) && statSync(join(PKG, w)).isDirectory()
        && !slotFiles.some((r) => r.startsWith(w + '/')));
    const missingRootFiles = wl.filter((w) => existsSync(join(PKG, w)) && !statSync(join(PKG, w)).isDirectory() && !slotFiles.includes(w));

    const ok = i1ok && wl.length > 0 && dirtyWl.length === 0 && !gateDrift && selfTestOk
        && notAllowed.length === 0 && junkInSlot.length === 0 && emptyTops.length === 0 && missingRootFiles.length === 0;
    add('I-6b', '假槽 = 纯成品（门独立按 files 原文重算，双道判据）', ok,
        wl.length === 0 ? '拿不到 files 白名单'
            : dirtyWl.length ? `白名单混进开发内容(${dirtyWl.join(',')})`
                : gateDrift ? '门与复制器的开发内容类别集合不一致（漂移）'
                    : !selfTestOk ? '门判据自测失效（已知脏样本没被判脏）'
                : !i1ok ? 'I-1 已红，本项不给绿资格'
                    : `槽 ${slotFiles.length} 件；白名单外 ${notAllowed.length}${notAllowed.length ? `(${notAllowed.slice(0, 3).join(',')})` : ''}；残渣 ${junkInSlot.length}${junkInSlot.length ? `(${junkInSlot.slice(0, 2).join(',')})` : ''}；空目录项 ${emptyTops.length}${emptyTops.length ? `(${emptyTops.join(',')})` : ''}；缺根件 ${missingRootFiles.length}`);
}

// ---------------------------------------------------------------- I-2..I-5
const st = runInSlot(join('engine', 'index.mjs'), ['--selftest']);
add('I-2', '槽内 index --selftest 绿', st.code === 0, `EXIT=${st.code}`);

const ts = runInSlot(join('engine', 'verify', 'tool-surface.mjs'), ['--dir', FAKE_SLOT]);
const tsGreen = ts.code === 0 && /ALL GREEN/.test(ts.out);
const hasDirChecks = /G-6a/.test(ts.out) && /G-6b/.test(ts.out);
add('I-3', '槽内 tool-surface --dir 绿（含装机形态检查）', tsGreen && hasDirChecks,
    `EXIT=${ts.code} dirChecks=${hasDirChecks}`);

const pl = runInSlot(join('engine', 'verify', 'plugin-load.mjs'));
add('I-4', '槽内 plugin-load 绿（真能注册出 fp）', pl.code === 0, `EXIT=${pl.code}`);

// ---------------------------------------------------------------- I-5 素材完整性（槽内自查）
// ★ 为什么不用 `assemble.mjs --verify`：那个门要读 `..\src\` 与 `BACKUP\_清单-src.txt`，
//   装机槽里这两样**故意不存在**（装机形态不该带源码仓）。第一次预演就踩到这里
//   （I-5 红），当场换判据：改为在槽内直接核对**关键素材文件的存在与大小**。
const mustHave = [
    ['ours/web-search.js', 5000],
    ['ours/ws-engines.js', 20000],
    ['ours/ws-transport.js', 8000],
    ['ours/fp-bridge.js', 3000],
    ['ours/python-find.js', 3000],
    ['ours/output-containment.js', 3000],
    ['ours/libs/url-guard.js', 1000],
    ['ours/libs/err.js', 200],
    ['fp/fpwebsearch.py', 100],
    ['fp/support/rawdl.py', 3000],     // ★ 04 片：原始字节下载腿（fetch 反扒降级用）
    ['scripts/copy-product.mjs', 3000], // ★ 05 片：白名单复制器（装机与预演共用的唯一实现；缺它 = 下次没人能装机）
    ['deps/pylibs/curl_cffi/__init__.py', 1],
    ['deps/pylibs/certifi/cacert.pem', 100000],
];
const missing = [];
const tooSmall = [];
for (const [rel, minBytes] of mustHave) {
    const p = join(FAKE_SLOT, rel);
    if (!existsSync(p)) { missing.push(rel); continue; }
    if (statSync(p).size < minBytes) tooSmall.push(`${rel}(${statSync(p).size}B<${minBytes})`);
}
add('I-5', '槽内关键素材齐全且大小合理', missing.length === 0 && tooSmall.length === 0,
    [missing.length ? `缺:${missing.join(',')}` : '', tooSmall.length ? `异常:${tooSmall.join(',')}` : ''].filter(Boolean).join(' ')
    || `${mustHave.length}/${mustHave.length} 齐全`);

// ---------------------------------------------------------------- I-5b 引擎卡数
let engineCards = 0;
let offlineCards = 0;
try { engineCards = readdirSync(join(FAKE_SLOT, 'ours', 'engines')).filter((f) => f.endsWith('.js')).length; } catch { /* 忽略 */ }
try { offlineCards = readdirSync(join(FAKE_SLOT, 'ours', 'engines-offline')).filter((f) => f.endsWith('.js')).length; } catch { /* 忽略 */ }
// ★ 2026-11-21 合并轮：不再写死张数。
//   原判据 `engineCards === 23 && offlineCards === 7` 是 ITERATION-012 之前的旧口径
//   （当时活引擎 17 家、offline 7 家），后来 5 张新卡接入 + 4 张 API 卡下线，
//   实测口径变成 **活引擎 22 张 / offline 11 张**，写死的数字必然假红。
//   改法（同 ITERATION-012 的结构性断言思路）：判**区间与自洽**，不判具体张数 ——
//   ① 活引擎 ≥ 17（低于此说明接线被拆了）；② offline ≥ 1（存在且不启用）；
//   ③ 两目录都在位。真正"逐家点名对账"由 doctor 的 E-5 承担（标题数 = 报的行数）。
add('I-5b', '引擎卡数合理（活目录 ≥17 张，offline 目录存在且不启用）',
    engineCards >= 17 && offlineCards >= 1,
    `engines=${engineCards} offline=${offlineCards}`);

// ---------------------------------------------------------------- I-6 垃圾不该进槽
const junk = ['backups', 'Temp', 'node_modules'].filter((n) => existsSync(join(FAKE_SLOT, n)));
add('I-6', '装机槽里没有 backups / Temp / node_modules', junk.length === 0, junk.join(',') || '干净');

// ---------------------------------------------------------------- I-7 槽内块齐全（含 doctor/outgate）
// ★ 判据不许硬编码块数：从槽内 engine\index.mjs 的 BLOCK_MANIFEST 读真值再比
//   （2026-11-09 就是这里硬编码 5，加了 outgate 第 6 块后必红 —— 门自己会过期）
const selftestOut = st.out ?? '';
// ★ 04 片修判据（首跑抓到既有红，复算方式见 04 开发日志 L-017）：
//   `runNode` 把 stdout+stderr 合进同一个文件（受限态管道老账 L-013），而引擎 import 链上
//   `web-search.js` 的 `[web-search] engines/ 目录与表不对账…` warn（02 遗留、只 warn 不阻断）
//   会混在 JSON **前面** ⇒ 整块 JSON.parse 必失败 ⇒ blockCount=null ⇒ I-7 从 02 之后恒红。
//   修法是**稳健提取 JSON**（取首个 '{' 到末尾），判据强度一分不降（仍要 blockCount 与 manifest 相等）。
let blockCount = null;
try {
    const from = selftestOut.indexOf('{');
    if (from >= 0) blockCount = JSON.parse(selftestOut.slice(from)).blockCount;
} catch { blockCount = null; }
let expectedBlocks = null;
try {
    const src = readFileSync(join(FAKE_SLOT, 'engine', 'index.mjs'), 'utf8');
    expectedBlocks = (src.match(/^\s*\{ name: '/gm) ?? []).length;
} catch { expectedBlocks = null; }
add('I-7', '槽内块数与 manifest 一致（core/net/fetch/doctor/outgate/tools）',
    blockCount !== null && expectedBlocks !== null && blockCount === expectedBlocks,
    `blockCount=${blockCount} manifest=${expectedBlocks}`);

// ---------------------------------------------------------------- I-8 装机形状（三件套，缺一不加载）
// ★★ 2026-11-09 主人一句话揭出的真错误：v1 装机脚本以为"复制进 plugins\ 就行"。
//    事实（dsh-team/INSTALL.md:47 + 本机 profile 实读）：
//      **DSH 不扫 plugins\ 目录**。插件要被加载，三样缺一不可：
//        ① 实体在 %USERPROFILE%\.dsh\plugins\<pkg>\
//        ② profile 的 package.json  dependencies 里有 `link:` 指向它
//        ③ profile 的 dsh.profile.bundles 数组里有 <pkg>
//    本项只验"我们自己的包**具备**被注册的条件"（②③ 由装机脚本写入，这里验脚本里写了）：
//    package.json 名对、main 指向真实文件、cordis.patch.yml 存在且 insert 的 id 对。
{
    const pkgJsonPath = join(FAKE_SLOT, 'package.json');
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')); } catch { pkg = null; }
    const mainOk = pkg !== null && pkg.name === 'dsh-fp-search' && pkg.main === 'platform/plugin.js'
        && existsSync(join(FAKE_SLOT, pkg.main));
    add('I-8', 'package.json：name/main 对且 main 文件真实存在', mainOk,
        pkg ? `name=${pkg.name} main=${pkg.main}` : 'package.json 读不到');
}

{
    const patchPath = join(FAKE_SLOT, 'cordis.patch.yml');
    let patchOk = false;
    let detail = 'missing';
    if (existsSync(patchPath)) {
        const body = readFileSync(patchPath, 'utf8');
        const hasInsert = /^-\s*insert:/m.test(body);
        const hasId = /id:\s*dsh-fp-search/.test(body);
        patchOk = hasInsert && hasId;
        detail = `insert=${hasInsert} id=${hasId}`;
    }
    // ★ 2026-11-09 纠正：原来还断言 `inject: [...tools]` 必须出现。那是 L-030 的误判残留。
    //   实读本机四个在跑的插件：dsh-eco-context 与 dsh-purge **都带 inject 且运行正常**
    //   （dsh-team / our-free-model / session-delete 不带，也都正常）。
    //   ⇒ inject 是**可选**的"等服务就绪再 apply"，写不写都能跑；真正会炸的是 `Config = {}`（见 I-13）。
    //   这里只断言"能挂上"的两件必需要素，不再管 inject 有无。
    add('I-9', 'cordis.patch.yml：insert + id=dsh-fp-search（inject 可选）', patchOk, detail);
}

{
    // 装机脚本必须写对注册路（v1 的教训不能重演）
    // ★ 2026-11-09 纠正：v3 起注册这件事**不在 ps1 里做**，而是交给 `scripts\register-fp.mjs`
    //   （确定性 JSON + 安全闸 + 原子替换 + 写后复验 + 回滚）。
    //   所以判据不能再去 ps1 里找 "bundles"/"profiles\desktop" 这些字面量 —— ps1 只管调用注册器。
    //   正确判据 = 三件套各自有归属：
    //     ① ps1 调到注册器（register-fp.mjs 存在且被引用）
    //     ② 注册器里真的写 dependencies + bundles 两处
    //     ③ ps1 里有 pnpm install
    const instPath = join(FAKE_SLOT, 'scripts', 'install-fp.ps1');
    const regPath = join(FAKE_SLOT, 'scripts', 'register-fp.mjs');
    let scriptOk = false;
    let detail = 'missing';
    if (existsSync(instPath)) {
        const body = readFileSync(instPath, 'utf8');
        const callsReg = /register-fp\.mjs/.test(body) && existsSync(regPath);
        const hasPnpm = /pnpm/i.test(body) && /install/i.test(body);
        let regOk = false;
        if (existsSync(regPath)) {
            const r = readFileSync(regPath, 'utf8');
            regOk = /dependencies/.test(r) && /bundles/.test(r) && /link:/.test(r);
        }
        scriptOk = callsReg && hasPnpm && regOk;
        detail = `ps1→注册器=${callsReg} 注册器写两处=${regOk} pnpm=${hasPnpm}`;
    }
    add('I-10', '装机路三件套：ps1 调注册器 + 注册器写 dependencies/bundles + pnpm install', scriptOk, detail);
}

// ---------------------------------------------------------------- I-11 / I-12 / I-13：加载条件
// ★ 2026-11-09 **两次真机教训的最终结论**（L-030 → L-032 纠正）：
//
//   L-030 当时以为元凶是 `inject` 和 `peerDependencies`，理由是"对照组都没有"。
//   那是**只看了三个插件就下结论**。实读本机全部在跑的插件后：
//     · dsh-eco-context：patch **有** inject:[tools,systemPrompt]，package **有** 4 条 peerDependencies
//       （含 @deepseek-ai/cordis，而 profile 的 node_modules 里根本没有这个包）→ **运行正常**
//     · dsh-purge：patch 有 inject:[systemPrompt,tools] → **运行正常**
//     · dsh-team / dsh-our-free-model / dsh-session-delete：都没有 inject → 也正常
//   ⇒ **inject 与 peerDependencies 都只是可选项，写不写都不影响加载。**
//
//   真正的元凶是 `platform/plugin.js` 里的 `export const Config = {};`：
//   cordis 4.1 `resolveConfig`（cordis/lib/index.js:244）只在 `!runtime.Config` 时放行，
//   `{}` 是 truthy ⇒ 去取 `Config['~standard'].validate` ⇒ undefined.validate ⇒ TypeError
//   ⇒ 插件在 apply() 之前就崩。这就是主人看到的那句 "Cannot read properties of undefined (reading 'validate')"。
//
//   所以 I-11 改成"不禁止 inject，只要求 inject 里不出现**根工具服务之外**的怪名"这类无效断言 ——
//   直接**撤掉**，换成 I-13 的 Config 断言（那才是真会炸的地方）。
//   I-12 同理撤掉：peerDependencies 不是问题。
{
    const mainPath = (() => {
        const pkgPath = join(FAKE_SLOT, 'package.json');
        if (!existsSync(pkgPath)) return null;
        try {
            const j = JSON.parse(readFileSync(pkgPath, 'utf8'));
            return j.main ? join(FAKE_SLOT, j.main) : null;
        }
        catch { return null; }
    })();

    let ok = false;
    let detail = 'main 读不到';
    if (mainPath && existsSync(mainPath)) {
        const src = readFileSync(mainPath, 'utf8');
        // 抓 `export const Config = <表达式>;` 的右值（到行尾分号）
        const m = src.match(/^\s*export\s+const\s+Config\s*=\s*([^;]*);/m);
        if (!m) {
            ok = true;
            detail = '未导出 Config（走 falsy 分支，config 原样透传）✅';
        }
        else {
            const rhs = m[1].trim();
            // 只有"真 schema"才允许：必须能拿出 ~standard。字面量 {} / [] / null / undefined 一律拒。
            const bare = /^(\{\s*\}|\[\s*\]|null|undefined|void\s+0)$/.test(rhs);
            ok = !bare;
            detail = bare
                ? `Config = ${rhs} ← 会让宿主抛 "Cannot read properties of undefined (reading 'validate')"`
                : `Config = ${rhs.slice(0, 40)}（真 schema）✅`;
        }
    }
    add('I-13', 'platform 入口不导出假 Config（{}/[]/null 会让宿主在 apply 前崩）', ok, detail);
}

// ---------------------------------------------------------------- 收尾
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

const green = checks.every((c) => c.ok);
const lines = ['FP install-dryrun（装机预演 · 不动真槽）', `假槽：${FAKE_SLOT}`, ''];
for (const c of checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(4)} ${c.what}${c.detail ? `  — ${c.detail}` : ''}`);
lines.push('', green ? 'ALL GREEN ✅（可以去请主人装机了）' : 'RED ❌（先修，别让主人白退一次 DSH）');
process.stdout.write(lines.join('\n') + '\n');
process.exit(green ? 0 : 1);
