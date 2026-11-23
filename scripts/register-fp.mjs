/**
 * scripts/register-fp.mjs — 往 DSH profile 里注册 / 注销本插件（**幂等 + 可干跑**）
 *
 * 为什么用 node 而不是 PowerShell 的 ConvertTo-Json：
 *   · PS 5.1 与 PS 7 的 ConvertTo-Json 行为不同（转义、深度、换行），
 *     而主人双击 .ps1 时用哪个版本不确定；
 *   · profile 的 package.json 改坏了 **DSH 起不来**，这是最贵的一类错误；
 *   · node 在这里一定有（随包运行时），JSON 处理确定性强，且能被门自动化测试。
 *
 * 做两件事（对应内核的注册语义，见 dsh-team/INSTALL.md §2a/2b）：
 *   ① `dependencies["dsh-fp-search"] = "link:<插件绝对路径，正斜杠>"`
 *   ② `dsh.profile.bundles` 末尾补 `"dsh-fp-search"`
 *   —— 少一样都不加载：只有文件夹 → 内核看不见；只加依赖 → 没进组合树；
 *      只加 bundles → 包解析不到。
 *
 * 安全措施（每一条都是为了"别把主人的 DSH 搞坏"）：
 *   · `--dry-run` 只报计划不落盘
 *   · 改前自动备份到 `<profile>/backups/` 与本项目 `backups/`
 *   · **写前自检**：把要写的对象与原文逐键比对，除目标两处外**任何差异都拒绝写**
 *   · 保留原文件的缩进风格与 LF 换行；写完**立即重新解析并复验**
 *   · 失败一律非零退出，且不改动原文件（先写临时文件、校验通过再原子替换）
 *
 * 用法：
 *   node register-fp.mjs --profile <profile目录> --plugin <插件目录> [--dry-run]
 *   node register-fp.mjs --unregister --profile <profile目录> [--dry-run]
 */

import {
    readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, renameSync, unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const PKG_NAME = 'dsh-fp-search';

/** 极简参数解析。 */
function parseArgs(argv) {
    const out = { dryRun: false, unregister: false, profile: '', plugin: '' };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--unregister') out.unregister = true;
        else if (a === '--profile') out.profile = argv[++i];
        else if (a === '--plugin') out.plugin = argv[++i];
    }
    return out;
}

/** 把路径转成 profile 里用的 link: 形式（正斜杠）。 */
export function toLinkTarget(pluginDir) {
    return `link:${String(pluginDir).replace(/\\/g, '/')}`;
}

/**
 * 计算"改完应该长什么样"。**纯函数**，不碰磁盘 —— 门可以直接测它。
 * @param {object} pkg  解析后的 profile package.json
 * @param {{pluginDir?:string, unregister?:boolean}} opts
 * @returns {{next:object, changes:string[], warnings:string[]}}
 */
export function planProfile(pkg, opts = {}) {
    const next = JSON.parse(JSON.stringify(pkg));   // 深拷贝，绝不改入参
    const changes = [];
    const warnings = [];

    if (!next.dsh || typeof next.dsh !== 'object') next.dsh = {};
    if (!next.dsh.profile || typeof next.dsh.profile !== 'object') next.dsh.profile = {};
    if (!Array.isArray(next.dsh.profile.bundles)) next.dsh.profile.bundles = [];
    if (!next.dependencies || typeof next.dependencies !== 'object') {
        next.dependencies = {};
        warnings.push('原 package.json 没有 dependencies，已补一个空对象');
    }

    const bundles = next.dsh.profile.bundles;

    if (opts.unregister) {
        if (Object.prototype.hasOwnProperty.call(next.dependencies, PKG_NAME)) {
            delete next.dependencies[PKG_NAME];
            changes.push(`dependencies -= ${PKG_NAME}`);
        }
        const idx = bundles.indexOf(PKG_NAME);
        if (idx >= 0) {
            bundles.splice(idx, 1);
            changes.push(`dsh.profile.bundles -= ${PKG_NAME}`);
        }
        return { next, changes, warnings };
    }

    // 注册
    const target = toLinkTarget(opts.pluginDir ?? '');
    const current = next.dependencies[PKG_NAME];
    if (current === undefined) {
        next.dependencies[PKG_NAME] = target;
        changes.push(`dependencies += ${PKG_NAME} = ${target}`);
    }
    else if (current !== target) {
        next.dependencies[PKG_NAME] = target;
        changes.push(`dependencies.${PKG_NAME}: ${current} → ${target}`);
    }
    if (!bundles.includes(PKG_NAME)) {
        bundles.push(PKG_NAME);
        changes.push(`dsh.profile.bundles += ${PKG_NAME}`);
    }
    return { next, changes, warnings };
}

/**
 * 严格比对：除 `dependencies` 与 `dsh.profile.bundles` 两处外，**任何差异都算失败**。
 * 这是"别把主人的 DSH 搞坏"的最后一道闸 —— 只要发现意外改动就不写盘。
 * @returns {string[]} 差异描述；空数组 = 安全
 */
export function assertOnlyIntendedDiff(before, after, { unregister = false } = {}) {
    const problems = [];

    // 1) 顶层键集合必须一致
    const keysBefore = Object.keys(before).sort();
    const keysAfter = Object.keys(after).sort();
    if (JSON.stringify(keysBefore) !== JSON.stringify(keysAfter)) {
        problems.push(`顶层键变了：${keysBefore} → ${keysAfter}`);
    }

    // 2) 除 dependencies 与 dsh 之外，其余顶层值必须逐字相同
    //    ★ `dsh` 必须放行：`dsh.profile.bundles` 正是要改的第二处（第 4/5 步专门细查它）。
    //      2026-11-09 首跑就是这里把 dsh 也当普通键比了，误报"顶层 dsh 被意外改动"。
    for (const k of keysBefore) {
        if (k === 'dependencies' || k === 'dsh') continue;
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
            problems.push(`顶层 "${k}" 被意外改动`);
        }
    }

    // 3) dependencies：除本包外逐键必须相同
    const depB = before.dependencies ?? {};
    const depA = after.dependencies ?? {};
    for (const k of Object.keys(depB)) {
        if (k === PKG_NAME) continue;
        if (JSON.stringify(depB[k]) !== JSON.stringify(depA[k])) {
            problems.push(`依赖 "${k}" 被意外改动`);
        }
    }
    for (const k of Object.keys(depA)) {
        if (k === PKG_NAME) continue;
        if (!(k in depB)) problems.push(`凭空多出依赖 "${k}"`);
    }

    // 4) 深比对 dsh：除 profile.bundles 外不许变
    const dshB = JSON.parse(JSON.stringify(before.dsh ?? {}));
    const dshA = JSON.parse(JSON.stringify(after.dsh ?? {}));
    const bB = dshB?.profile?.bundles;
    const bA = dshA?.profile?.bundles;
    if (dshB?.profile) delete dshB.profile.bundles;
    if (dshA?.profile) delete dshA.profile.bundles;
    if (JSON.stringify(dshB) !== JSON.stringify(dshA)) {
        problems.push('dsh（除 profile.bundles 外）被意外改动');
    }

    // 5) bundles：要么原样，要么只多/少本包
    const listB = Array.isArray(bB) ? bB : [];
    const listA = Array.isArray(bA) ? bA : [];
    const strip = (arr) => arr.filter((x) => x !== PKG_NAME);
    if (JSON.stringify(strip(listB)) !== JSON.stringify(strip(listA))) {
        problems.push(`bundles 里除 ${PKG_NAME} 外的内容变了`);
    }
    const delta = listA.length - listB.length;
    const expectedDelta = unregister ? (listB.includes(PKG_NAME) ? -1 : 0) : (listB.includes(PKG_NAME) ? 0 : 1);
    if (delta !== expectedDelta) {
        problems.push(`bundles 长度变化异常：${listB.length} → ${listA.length}（期望 ${expectedDelta}）`);
    }

    return problems;
}

/** 序列化成与现有文件同风格的 JSON：2 空格缩进、LF 结尾。 */
export function serialize(pkg) {
    return JSON.stringify(pkg, null, 2).replace(/\r\n/g, '\n') + '\n';
}

// ------------------------------------------------------------------ CLI
function main() {
    const args = parseArgs(process.argv.slice(2));
    const out = { mode: args.unregister ? 'unregister' : 'register', dryRun: args.dryRun, ok: false };

    if (!args.profile) {
        out.error = '缺少 --profile <profile目录>';
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(2);
    }
    const profileDir = resolve(args.profile);
    const pkgPath = join(profileDir, 'package.json');
    out.profile = profileDir;
    out.packageJson = pkgPath;

    if (!existsSync(pkgPath)) {
        out.error = `找不到 ${pkgPath}`;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(2);
    }

    let before;
    try {
        before = JSON.parse(readFileSync(pkgPath, 'utf8'));
    }
    catch (e) {
        out.error = `profile package.json 解析失败（原文件未动）：${String(e?.message ?? e)}`;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(2);
    }

    if (!args.unregister) {
        if (!args.plugin) {
            out.error = '注册模式必须给 --plugin <插件目录>';
            process.stdout.write(JSON.stringify(out, null, 2) + '\n');
            process.exit(2);
        }
        const pluginDir = resolve(args.plugin);
        if (!existsSync(join(pluginDir, 'package.json'))) {
            out.error = `插件目录不像插件（没有 package.json）：${pluginDir}`;
            process.stdout.write(JSON.stringify(out, null, 2) + '\n');
            process.exit(2);
        }
        out.plugin = pluginDir;
    }

    const { next, changes, warnings } = planProfile(before, {
        pluginDir: args.plugin ? resolve(args.plugin) : undefined,
        unregister: args.unregister,
    });
    out.changes = changes;
    out.warnings = warnings;

    // 无变化就不落盘（幂等）
    if (changes.length === 0) {
        out.ok = true;
        out.note = '注册状态已是目标态，无需改动';
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(0);
    }

    // ★ 写前安全闸：除目标两处外任何差异都拒绝
    const problems = assertOnlyIntendedDiff(before, next, { unregister: args.unregister });
    if (problems.length > 0) {
        out.error = '安全闸拒绝写入：检测到非预期改动';
        out.problems = problems;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(3);
    }
    out.safetyGate = 'passed';

    const text = serialize(next);

    // 序列化结果必须能被解析回等价对象（防写出坏 JSON）
    let reparsed;
    try { reparsed = JSON.parse(text); }
    catch (e) {
        out.error = `序列化结果不可解析（原文件未动）：${String(e?.message ?? e)}`;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(3);
    }
    if (JSON.stringify(reparsed) !== JSON.stringify(next)) {
        out.error = '序列化往返不一致（原文件未动）';
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(3);
    }

    if (args.dryRun) {
        out.ok = true;
        out.note = 'dry-run：计划如上，未落盘';
        out.preview = text;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(0);
    }

    // 备份 → 临时文件 → 原子替换
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const bakDir = join(profileDir, 'backups');
    mkdirSync(bakDir, { recursive: true });
    const bak = join(bakDir, `package.json.bak-before-fp-${args.unregister ? 'unregister' : 'register'}-${stamp}`);
    copyFileSync(pkgPath, bak);
    out.backup = bak;

    const tmp = `${pkgPath}.fp-tmp-${process.pid}`;
    writeFileSync(tmp, text, 'utf8');
    try {
        renameSync(tmp, pkgPath);   // 同目录 rename = 原子替换
    }
    catch (e) {
        try { unlinkSync(tmp); } catch { /* 忽略 */ }
        out.error = `替换失败（原文件仍在，备份在 ${bak}）：${String(e?.message ?? e)}`;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(4);
    }

    // 写完复验
    try {
        const check = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const diff = assertOnlyIntendedDiff(before, check, { unregister: args.unregister });
        if (diff.length > 0) {
            // 回滚
            copyFileSync(bak, pkgPath);
            out.error = `写后复验失败，已回滚：${diff.join('; ')}`;
            process.stdout.write(JSON.stringify(out, null, 2) + '\n');
            process.exit(5);
        }
        out.verified = '写后复验通过';
    }
    catch (e) {
        copyFileSync(bak, pkgPath);
        out.error = `写后复验读不回来，已回滚：${String(e?.message ?? e)}`;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(5);
    }

    out.ok = true;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
}

// 只在被直接执行时跑 CLI（被 import 时只导出纯函数，便于门测试）
const invokedDirectly = process.argv[1] && resolve(process.argv[1]).replace(/\\/g, '/').endsWith('/register-fp.mjs');
if (invokedDirectly) main();
