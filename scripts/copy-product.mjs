#!/usr/bin/env node
/**
 * scripts/copy-product.mjs — 装机复制的**唯一实现**（05 片，主人 2026-11-19 令）
 *
 * 病根（关联表 #75 / 04 项目 L-028）：
 *   `install-fp.ps1:68` 是 `Copy-Item (Join-Path $RepoWork '*') $PluginDir -Recurse -Force` —— 整仓根灌槽，
 *   而排除清单（:69-72）只有 `backups / Temp / node_modules` 三项；`engine/verify/install-dryrun.mjs:67`
 *   又**独立写了同一份三项黑名单** ⇒ 两份手写清单必然漂移（关联表 #13 记过的同族事故：
 *   "维护一份本来可以算出来的清单 = 事故根源"）。实测后果：装机槽 3066 件 / 204.1 MB，
 *   其中 `Updating/`(开发日志+BACKUP+work 全树) 58.6MB、`src/`(预放素材) 6.1MB、`Reference/` 0.5MB、
 *   `dsh-eco-context.rar` **114.9MB** ⇒ **约 92% 是账外件**，该装的成品只有 233 件。
 *
 * 本件的做法：**真源 = `package.json` 的 `files` 白名单**（Readme §〇 分工表早就这么定义：
 *   "判断标准就是 package.json 的 files 白名单——白名单外的东西一律不搬"），
 *   运行时从 JSON 读出来算，**代码里不写任何文件清单字面量**（连"排除清单"也不写死：
 *   残渣判定用形态规则，见 JUNK_DIRS / JUNK_FILES，它们不是"该装什么的账"，是"什么不该被当成品"的形态）。
 *   `install-fp.ps1` 与 `install-dryrun.mjs` 都调本件 ⇒ 真装机与预演从此同口径。
 *
 * 三条硬规矩（都来自实测教训）：
 *   ① **缺件即拒**：白名单里声明了、源仓里找不到的 ⇒ 退出码 2 并逐件点名（能力诚实，不许"少装一件还报成功"）；
 *   ② **默认干跑**：不带 `--apply` 只算清单与体积，不动目标目录（照 ctx purge 的成例：不可逆操作要显式开关）；
 *   ③ **不碰目标里的其它件**：本件只写自己算出来的那批路径；清旧槽由调用方决定（脚本 :66 的 Remove-Item 维持原样，
 *      ★ 那是"重写插件目录"不是"清存量"，与 §L-005 的授权边界不冲突）。
 *
 * 用法：
 *   node scripts\copy-product.mjs --from <仓根> --to <目标目录> [--apply] [--json]
 *   退出码：0 成功｜2 缺件（白名单声明但源里没有）｜3 参数/路径错｜4 复制中有 IO 失败
 *           ｜5 files 白名单混进开发内容（语义 lint，见 NEVER_TOP）
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 运行残渣的**形态**规则（不是清单）：这些永远不该被当成品搬。 */
const JUNK_DIRS = new Set(['__pycache__', 'out', '.tmp', 'diag', 'node_modules', '.git', '.vscode']);
const JUNK_FILES = new Set(['.cdp-last-err.log', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
/**
 * ★ 白名单**语义 lint**（05 反例 B 逼出来的，见 05 项目 L-009）：
 *   `files` 是真源没错，但"真源被写脏"时不能跟着脏 —— 开发内容的顶层目录**语义上永远不属于成品**，
 *   哪怕有人把它们塞进 `files` 也要当场拒。05 的病根就是这类件曾占槽 92%，放行 = bug 复发。
 *   这不是第二份"该装什么"的清单（#13/#75 反对的是那个），是"哪些语义类别永不可能该装"的 lint。
 *   ★ 导出给 `install-dryrun.mjs` 的 I-6b **独立复用**：常量只这一份（不会漂移），
 *     但"判白名单脏"这件事复制器与门各判各的 —— 万一有人拆掉复制器的 lint，门仍要能看出白名单被写脏
 *     （否则门就变成"靠被测件报错才红" = 自证，05 L-009 的教训）。
 */
export const NEVER_TOP = new Set(['Updating', 'src', 'Reference', 'backups', 'Temp', 'node_modules']);
/** `files` 白名单之外必带的根件（npm/pnpm 约定：包定义本身）。 */
const ALWAYS_ROOT = new Set(['package.json']);

function die(code, msg, extra) {
    process.stdout.write(JSON.stringify({ ok: false, code, error: msg, ...(extra || {}) }, null, 2) + '\n');
    process.exit(code);
}

/**
 * 把 `files` 白名单 + package.json 展成**该装的路径集合**。
 * ★ 库/CLI 分离：本函数**只抛异常、绝不 process.exit** —— 它会被 `install-dryrun.mjs` 当库 import，
 *   门要的是"拿到错误去判绿/红"，被子进程式的 exit 直接杀掉就变成假失败（关联表 #71 同族：
 *   一处实现的失败方式必须让所有调用方都能消化）。exit 码只由 main() 负责换算。
 * @param {string} from 仓根
 * @returns {{entries:Array<{rel:string,bytes:number}>, missing:string[], whitelist:string[]}}
 */
export function planProduct(from) {
    const pkgPath = join(from, 'package.json');
    if (!existsSync(pkgPath)) throw Object.assign(new Error(`找不到 package.json：${pkgPath}`), { exitCode: 3 });
    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); }
    catch (e) { throw Object.assign(new Error(`package.json 解析失败：${e.message}`), { exitCode: 3 }); }
    const whitelist = Array.isArray(pkg.files) ? pkg.files : null;
    if (!whitelist || whitelist.length === 0) {
        throw Object.assign(new Error('package.json 的 files 白名单缺失或为空 —— 无法算出"该装什么"（拒绝退回整仓复制）'), { exitCode: 2 });
    }
    // ★ 白名单语义 lint：开发内容即使被塞进 files 也当场拒（反例 B 逼出来的，见 NEVER_TOP 顶注）
    const dirty = whitelist.map((x) => String(x).replace(/\\/g, '/').replace(/\/+$/, ''))
        .filter((rel) => NEVER_TOP.has(rel.split('/')[0]));
    if (dirty.length > 0) {
        throw Object.assign(new Error(`files 白名单里混进了开发内容（这些永远不属于成品）：${dirty.join(', ')} —— 拒绝复制，免得账本又灌进插件槽`), { exitCode: 5 });
    }

    const wantedDirs = [];
    const wantedFiles = [];
    const declaredMissing = [];
    for (const f of whitelist) {
        const rel = String(f).replace(/\\/g, '/').replace(/\/+$/, '');
        const abs = join(from, rel);
        if (!existsSync(abs)) { declaredMissing.push(rel); continue; }   // 记进缺件，下面统一拒
        if (statSync(abs).isDirectory()) wantedDirs.push(rel);
        else wantedFiles.push(rel);
    }
    for (const f of ALWAYS_ROOT) {
        if (wantedFiles.includes(f)) continue;
        if (!existsSync(join(from, f))) continue;   // 必带件本来就有，不报缺（防自找麻烦）
        wantedFiles.push(f);
    }

    const entries = [];
    const walk = (rel) => {
        const abs = join(from, rel);
        const st = statSync(abs);
        if (st.isFile()) {
            if (JUNK_FILES.has(rel.split('/').pop())) return;
            entries.push({ rel, bytes: st.size });
            return;
        }
        for (const e of readdirSync(abs, { withFileTypes: true })) {
            if (e.isDirectory() && JUNK_DIRS.has(e.name)) continue;
            const child = `${rel}/${e.name}`;
            if (e.isDirectory()) walk(child);
            else {
                if (JUNK_FILES.has(e.name)) continue;
                entries.push({ rel: child, bytes: statSync(join(from, child)).size });
            }
        }
    };
    for (const d of wantedDirs) walk(d);
    for (const f of wantedFiles) {
        const abs = join(from, f);
        if (!existsSync(abs)) continue;
        entries.push({ rel: f, bytes: statSync(abs).size });
    }
    // 去重 + 稳定序（对拍要靠它可比）
    const seen = new Set();
    const uniq = [];
    for (const it of entries.sort((a, b) => a.rel.localeCompare(b.rel))) {
        if (seen.has(it.rel)) continue;
        seen.add(it.rel);
        uniq.push(it);
    }
    return { entries: uniq, missing: declaredMissing, whitelist };
}

/**
 * 按计划件复制。
 * @param {{entries:Array<{rel:string}>}} plan
 * @param {{from:string,to:string,apply:boolean}} opts
 */
export function copyProduct(plan, { from, to, apply }) {
    const written = [];
    const failed = [];
    for (const it of plan.entries) {
        if (!apply) continue;
        const dst = join(to, it.rel);
        try {
            mkdirSync(dst.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
            copyFileSync(join(from, it.rel), dst);
            written.push(it.rel);
        }
        catch (e) { failed.push(`${it.rel}: ${e.code || e.message}`); }
    }
    return { written, failed };
}

function main(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--apply' || a === '--json') { args[a.slice(2)] = true; continue; }
        if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i += 1; continue; }
        die(3, `不认识的参数：${a}`);
    }
    if (!args.from || !args.to) die(3, '用法：--from <仓根> --to <目标目录> [--apply] [--json]');
    const from = resolve(args.from);
    const to = resolve(args.to);
    if (!existsSync(from)) die(3, `源不存在：${from}`);

    const plan = planProduct(from);
    const bytes = plan.entries.reduce((s, x) => s + x.bytes, 0);

    // ① 缺件即拒（先于复制：宁可不装，也不"少装一件还报成功"）
    if (plan.missing.length > 0) {
        die(2, `白名单声明的件在源里找不到（拒绝继续，免得装出个缺件的槽）`, { missing: plan.missing });
    }

    const { written, failed } = copyProduct(plan, { from, to, apply: Boolean(args.apply) });
    if (failed.length > 0) {
        die(4, '复制中有 IO 失败', { failed: failed.slice(0, 20), failedCount: failed.length });
    }

    const out = {
        ok: true,
        mode: args.apply ? 'apply' : 'dryrun',
        from,
        to,
        whitelistCount: plan.whitelist.length,
        whitelist: plan.whitelist,
        files: plan.entries.length,
        productMB: Number((bytes / 1048576).toFixed(2)),
        copied: written.length,
    };
    // ★ 清单**绝不写进目标槽**（写进去 = 本件自己造出第二个账外件，与 05 的目标正相反）。
    //   门/人要清单时用 --list-out 显式指到 Temp 之类的外部位，或直接读 --json 的 stdout。
    if (args['list-out']) {
        try {
            mkdirSync(resolve(args['list-out']).replace(/[\\/][^\\/]+$/, ''), { recursive: true });
            writeFileSync(resolve(args['list-out']), plan.entries.map((x) => x.rel).join('\n') + '\n', 'utf8');
            out.listFile = resolve(args['list-out']);
        }
        catch (e) { die(4, `清单写出失败：${e.code || e.message}`, { listOut: args['list-out'] }); }
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
}

// 标准"直接运行"判定：比较绝对路径，不靠 endsWith（文件名重名会误判）。
const selfPath = resolve(fileURLToPath(import.meta.url));
const argPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (selfPath === argPath) {
    // CLI 层负责把 library 抛出的异常换算成约定退出码（2 缺件 / 3 参数路径 / 4 IO）；
    // 门当库用时拿到的还是异常本身，不会被 process.exit 打断（见 planProduct 顶注）。
    try { main(process.argv.slice(2)); }
    catch (e) { die(e?.exitCode ?? 4, String(e?.message ?? e)); }
}
