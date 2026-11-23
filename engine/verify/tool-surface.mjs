/**
 * engine/verify/tool-surface.mjs — 工具面一致性门（R1）
 *
 * 判什么（全部 FP 自算，**一个数都没抄 CTX**）：
 *   G-1  op 三处同源：engine/contract.mjs OPS / WANT_OPS / 运行时注册面
 *   G-2  platform/catalog.js 的 KNOWN_OPS 与 contract 逐名一致（兜底视图不许漂）
 *   G-3  platform/tool-def.js PARAMS ⊇ contract.EXPECTED_PARAMS（每个 op 的参数都翻得出来）
 *   G-4  描述文本里提到的每个参数名都真实存在于 PARAMS（防"教模型传不存在的键"）
 *   G-5  交付格式常量存在且可调用（"先用老格式"，主人 2026-11-09 定）
 *   G-6  装机目录（若给 --dir）里的 package.json / cordis.patch.yml / platform 入口在位
 *
 * 用法：
 *   node engine\verify\tool-surface.mjs                 # 单跑本包
 *   node engine\verify\tool-surface.mjs --dir <包根>     # 对拍装机槽/成品
 * 退出码 0 = 全绿。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createEngine, PKG_ROOT } from '../index.mjs';
import { OPS, WANT_OPS, EXPECTED_PARAMS, DELIVER_FORMAT, TOOL_NAME, PACKAGE_NAME } from '../contract.mjs';
import { PARAMS } from '../../platform/tool-def.js';
import { KNOWN_OPS, FULL_CATALOG } from '../../platform/catalog.js';
import { toolDescription } from '../../platform/plugin.js';

const argv = process.argv.slice(2);
const dirArg = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : undefined;
const targetRoot = dirArg ? resolve(dirArg) : PKG_ROOT;

const checks = [];
const add = (id, what, ok, detail) => checks.push({ id, what, ok, detail: detail ?? '' });

// ---------------------------------------------------------------- G-1 三处同源
const engine = await createEngine({ level: 'warn', pkgRoot: PKG_ROOT });
const runtimeOps = engine.opCatalog.map((o) => o.op);
add('G-1a', 'contract.OPS 与 WANT_OPS 同源', OPS.map((o) => o.op).join(',') === WANT_OPS.join(','), `OPS=[${OPS.map((o) => o.op)}] WANT=[${WANT_OPS}]`);
add('G-1b', '运行时注册面与 contract 同源', runtimeOps.join(',') === WANT_OPS.join(','), `runtime=[${runtimeOps}]`);
add('G-1c', 'op 数 = 3（FP 自己的基准，非抄 CTX 的 14）', runtimeOps.length === 3, `实测 ${runtimeOps.length}`);

// ---------------------------------------------------------------- G-2 兜底视图不漂
add('G-2', 'platform/catalog.js KNOWN_OPS 与 contract 一致', KNOWN_OPS.join(',') === WANT_OPS.join(','), `catalog=[${KNOWN_OPS}]`);
add('G-2b', '工具位只有 1 个 = fp', FULL_CATALOG.length === 1 && FULL_CATALOG[0] === TOOL_NAME, `FULL_CATALOG=[${FULL_CATALOG}]`);

// ---------------------------------------------------------------- G-3 参数可翻译
const missingParams = [];
for (const [op, names] of Object.entries(EXPECTED_PARAMS)) {
    for (const n of names) if (!PARAMS[n]) missingParams.push(`${op}:${n}`);
}
add('G-3', 'EXPECTED_PARAMS 每个参数都在 tool-def.PARAMS 里', missingParams.length === 0, missingParams.join(',') || 'ok');

// ---------------------------------------------------------------- G-4 描述不提不存在的参数
const desc = toolDescription(runtimeOps);
const allParamNames = new Set(Object.values(EXPECTED_PARAMS).flat());
/**
 * 判据（v1，2026-11-09 首跑抓出误报后改准）：
 *   参数名 = **小驼峰**（首字母小写、内部有大写），且**不在路径里**
 *   （路径片段如 LongMem / FPdownload 是首字母大写的目录名，不是参数名）。
 *   首版判据只查"含大写"，把 `F:\…\LongMem\Temp\FPdownload` 两个目录名报成参数，
 *   属门自己误报 —— 误报的门比没有门更坏（会训练人忽略红字），故当场修判据。
 */
function looksLikeParamName(token, source, tokenIndex) {
    if (token.length < 4) return false;
    if (!/^[a-z][A-Za-z0-9]*$/.test(token)) return false;   // 小驼峰
    if (!/[A-Z]/.test(token.slice(1))) return false;
    const before = source.slice(Math.max(0, tokenIndex - 1), tokenIndex);
    if (before === '\\' || before === '/') return false;     // 路径片段
    return true;
}
const badParams = [];
for (const m of desc.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
    const token = m[0];
    if (!looksLikeParamName(token, desc, m.index ?? 0)) continue;
    if (allParamNames.has(token)) continue;
    badParams.push(token);
}
add('G-4', '描述里没有指向不存在参数的名字', badParams.length === 0, badParams.join(',') || 'ok');

// ---------------------------------------------------------------- G-5 交付格式（老格式）
const fmt = DELIVER_FORMAT;
const headOk = fmt.headSearchSingle('bing', 3, 120, 'q') === 'bing · 3 hit(s) · 120ms · q';
const aggOk = fmt.headSearchAggregate(3, 120, 'q', 'bing,douban') === 'search · 3 hit(s) · 120ms · q · engines: bing,douban';
const itemOk = fmt.itemTitle(1, 'bing', 'T') === '[1] (bing) T';
add('G-5', '交付文本头行/条目 = CTX 1.0.0 冻结面形状', headOk && aggOk && itemOk, `single=${headOk} agg=${aggOk} item=${itemOk}`);

// ---------------------------------------------------------------- G-6 装机目录形状
if (dirArg) {
    const pkgJson = join(targetRoot, 'package.json');
    const patch = join(targetRoot, 'cordis.patch.yml');
    const entry = join(targetRoot, 'platform', 'plugin.js');
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgJson, 'utf8')); } catch { pkg = null; }
    add('G-6a', `${targetRoot} 有可解析的 package.json`, pkg !== null, pkg ? `name=${pkg.name}` : 'missing/unparsable');
    add('G-6b', `package.json.name = ${PACKAGE_NAME}`, pkg?.name === PACKAGE_NAME, `实测 ${pkg?.name}`);
    add('G-6c', 'cordis.patch.yml 在位', existsSync(patch));
    add('G-6d', 'platform/plugin.js 在位', existsSync(entry));
}

// ---------------------------------------------------------------- G-7 package.json files 不许指向不存在的路径
// ★ 2026-11-09 实测抓出：`files` 里列了 `README.md` / `LICENSE` 但包里没有这两件，
//   同时漏了 `scripts`（装机脚本，恰恰是最该随包走的东西）。
//   `files` 是发布白名单，指向不存在 = 装机版少件而开发版看不出来。
{
    const pkgJsonPath = join(targetRoot, 'package.json');
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')); } catch { pkg = null; }
    const declared = Array.isArray(pkg?.files) ? pkg.files : [];
    const dangling = declared.filter((rel) => !existsSync(join(targetRoot, rel)));
    add('G-7', 'package.json files 不指向不存在的路径', pkg !== null && dangling.length === 0,
        pkg === null ? 'package.json 读不到' : (dangling.join(',') || `${declared.length} 条全在位`));
}

// ---------------------------------------------------------------- 输出
const green = checks.every((c) => c.ok);
const lines = [
    `FP tool-surface · ${targetRoot}`,
    `op: ${runtimeOps.join(',')} (${runtimeOps.length})  ·  tool: ${TOOL_NAME}  ·  pkg: ${PACKAGE_NAME}`,
    '',
];
for (const c of checks) {
    lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(5)} ${c.what}${c.detail ? `  — ${c.detail}` : ''}`);
}
lines.push('', green ? 'ALL GREEN ✅' : 'RED ❌');
process.stdout.write(lines.join('\n') + '\n');
process.exit(green ? 0 : 1);
