/**
 * blocks/03-fetch/index.js — 取原件块（impl，片 3 核心）
 *
 * 干什么：`fetch {url, outDir?, maxBytes?}` ⇒ 取**原始字节**落盘。
 *
 * ★★ 为什么必须是原始字节（`模块关联表` §一-2，CTX 时代三方全犯过的坑）：
 *   `ws-transport` 返回的 `bytes` 字段**不是字节数**：
 *     · fast 腿 = `text.length`（字符数，:250）
 *     · 桥腿   = 解码→重编码后的长度
 *   拿它当文件大小 ⇒ 中文页面的"字节数"会偏小，PDF/图片会被当成文本截断。
 *   所以本块**不走 text 路径**，直接用 `ArrayBuffer` 收，写 Buffer。
 *
 * ★★ SSRF（`模块关联表` §一-1 / 立项书 R5）：
 *   ① 入口先过 `url-guard.assertSafeUrl`（私网/环回/metadata 直接拒）；
 *   ② 每一跳重定向都要重过闸（`redirect:'manual'` 自己跟），
 *      否则"公网 URL 经 302 跳内网"能绕过 —— 这是 fetch 上线前的必修项。
 *
 * ★ 落点（`模块关联表` 第 17 条 / 主人 2026-11-09 定）：
 *   默认落**系统临时目录**下的 `dsh-fp-download`（`FP_OUT_DIR` 环境变量可覆盖），
 *   `outDir` 参数可覆盖。写死盘符在别的机器上必坏（发布版可移植化，2026-11-16）。
 *   自带清扫：只扫**自家前缀**文件，绝不碰别人的 TEMP。
 */

import { join, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync,
} from 'node:fs';
import { DEFAULT_OUT_DIR } from '../../contract.mjs';
import { ERR, FpError, assemblyState, requireAssembled } from '../01-core/index.js';

export const meta = {
    name: 'fetch',
    kind: 'impl',
    deps: ['core'],
};

/** 我们自己的落盘前缀（清扫只认这个，别的一律不碰）。 */
const OWN_PREFIX = 'fp_';
/** 清扫阈值：超过 1 小时的自家残留。 */
const SWEEP_MS = 3600_000;
/** 最多保留的自家文件数（超出按最旧删）。 */
const MAX_FILES = 50;
/** 重定向上限（防环）。 */
const MAX_REDIRECTS = 5;
/** 默认单文件上限 64 MB。 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/**
 * ★ 11-P0：Node 裸抓单次超时（ms）。
 *   病根：原 `await fetch()` / `await arrayBuffer()` 无中止信号 ⇒ 慢站/挂起连接永不 resolve ⇒ 调用冻结（arxiv 实测）。
 *   修法：每次 fetch 挂 `AbortSignal.timeout`，超时抛明确死因（不再永挂）。
 *   取值 120s：宽松到不误杀正常慢下载，又给挂起连接一个上界；后台作业路（python）另用停滞检测，不受影响。
 */
const NODE_FETCH_TIMEOUT_MS = 120_000;

let _guard = null;

/** 惰性加载 url-guard（双留件的 FP 副本，在 ours/libs/）。 */
async function loadGuard(ctx) {
    if (_guard !== null) return _guard;
    const target = join(ctx.pkgRoot, 'ours', 'libs', 'url-guard.js');
    if (!existsSync(target)) {
        throw new FpError(ERR.NOT_ASSEMBLED, `找不到 SSRF 闸：${target}`, '跑 engine/verify/assemble.mjs 装配素材（libs 要落到 ours/libs/）。');
    }
    _guard = await import(pathToFileURL(target).href);
    return _guard;
}

let _bridge = null;

/**
 * ★ 04 片：惰性加载 fp-bridge（扛P 原始字节腿的 JS 端）。
 * 形状照 `blocks/02-net` 的成例：装配前 import 会 ENOENT ⇒ 诚实报错（红线④"缺件不许静默"）。
 * 只在真要降级时才加载 —— `legs:'off'` 与 Node 路成功都不碰它（关联表 #3/#4：路径解析只此一份）。
 */
async function loadBridge(ctx) {
    if (_bridge !== null) return _bridge;
    const target = join(ctx.pkgRoot, 'ours', 'fp-bridge.js');
    if (!existsSync(target)) {
        throw new FpError(ERR.NOT_ASSEMBLED, `找不到扛P 桥：${target}`, '跑 engine/verify/assemble.mjs 装配素材（ours/fp-bridge.js 要在位）。');
    }
    _bridge = await import(pathToFileURL(target).href);
    if (typeof _bridge.fpFetchRaw !== 'function') {
        throw new FpError(ERR.NOT_ASSEMBLED, 'fp-bridge.js 没有导出 fpFetchRaw', '04 片的桥件未装配到位：检查 ours/fp-bridge.js。');
    }
    return _bridge;
}

/** 清扫落点里过期的自家文件。只删 `fp_` 前缀，别的一概不碰。 */
export function sweep(outDir) {
    const removed = [];
    let names;
    try { names = readdirSync(outDir); } catch { return removed; }
    const cutoff = Date.now() - SWEEP_MS;
    const mine = [];
    for (const n of names) {
        if (!n.startsWith(OWN_PREFIX)) continue;
        const p = join(outDir, n);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoff) {
            try { unlinkSync(p); removed.push(n); } catch { /* 忽略 */ }
        }
        else mine.push({ p, mtime: st.mtimeMs });
    }
    if (mine.length > MAX_FILES) {
        mine.sort((a, b) => a.mtime - b.mtime);
        for (const { p } of mine.slice(0, mine.length - MAX_FILES)) {
            try { unlinkSync(p); removed.push(basename(p)); } catch { /* 忽略 */ }
        }
    }
    // ★ 11：作业台账同属自家残留（关联表 #79：附属文件必须进清扫家族），>1h 的 `.fpjob\*.json` 一并收尸
    const jobDir = join(outDir, '.fpjob');
    try {
        for (const n of readdirSync(jobDir)) {
            const p = join(jobDir, n);
            try {
                const st = statSync(p);
                if (st.isFile() && st.mtimeMs < cutoff) { unlinkSync(p); removed.push(`.fpjob/${n}`); }
            } catch { /* 忽略 */ }
        }
    } catch { /* 无 .fpjob 目录 */ }
    return removed;
}

/** 从 URL 猜一个安全文件名：只留 ASCII 安全字符，防路径穿越。 */
function safeName(url, contentType) {
    let base = 'download';
    try {
        const u = new URL(url);
        const last = basename(decodeURIComponent(u.pathname)) || '';
        if (last) base = last;
    }
    catch { /* 用默认名 */ }
    // 去掉一切可能穿越/非法字符，只保留 ASCII 字母数字与 . - _
    base = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
    if (!base) base = 'download';
    if (extname(base) === '') {
        const ext = guessExt(contentType);
        if (ext) base += ext;
    }
    return base;
}

function guessExt(ct) {
    if (!ct) return '';
    const t = String(ct).toLowerCase();
    if (t.includes('pdf')) return '.pdf';
    if (t.includes('png')) return '.png';
    if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
    if (t.includes('gif')) return '.gif';
    if (t.includes('webp')) return '.webp';
    if (t.includes('svg')) return '.svg';
    if (t.includes('zip')) return '.zip';
    if (t.includes('json')) return '.json';
    if (t.includes('html')) return '.html';
    return '';
}

/**
 * 取原件落盘。
 * ★ 04 片（2026-11-19）：加 `legs` 参数——`auto`（默认：Node 裸抓失败自动降级扛P 原始字节腿）
 *   | `always`（直接走扛P）| `off`（与改动前逐字节同行为）。
 *   降级铁律：① `URL_BLOCKED` 类错误**永不触发降级**（闸拒就是拒，换腿也不许放）；
 *   ② 降级路 `final_url` 缺失 = 拒收；拿到必再过一次 JS 侧 `assertSafeUrl`（关联表 #1/#30）。
 * ★ 11 片（2026-11-23）：加 `background`（发起即返 jobId，不阻塞）与 `job`（轮询作业当下状态）。
 *   三形态互斥优先级：`job` > `background` > 同步。`job`/`background` 都走 python 原始字节腿
 *   （Node 路无法脱离调用存活 ⇒ 后台只有 python 路能兑现）。
 * @returns {Promise<string>} 交付文本（人/模型可读）
 */
export async function fetchToDisk(ctx, { url, outDir, maxBytes, legs, background, job }) {
    const guard = await loadGuard(ctx);
    const assertSafeUrl = guard.assertSafeUrl ?? guard.default;
    if (typeof assertSafeUrl !== 'function') {
        throw new FpError(ERR.NOT_ASSEMBLED, 'url-guard 没有导出 assertSafeUrl', '检查 ours/libs/url-guard.js 是否装配正确。');
    }

    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
    const targetDir = typeof outDir === 'string' && outDir.trim() !== '' ? outDir : DEFAULT_OUT_DIR;
    mkdirSync(targetDir, { recursive: true });
    const swept = sweep(targetDir);

    // ★ 11-P1-②：作业轮询（最高优先级：给了 job 就是查状态，**不需要 url、也不该过 URL 闸**）
    //   ★ 11 实测踩坑：入口闸若在分派前无条件调用，轮询（无 url）会崩 `url 无法解析：undefined`。
    if (typeof job === 'string' && job.trim() !== '') {
        return pollJobText(ctx, targetDir, job.trim(), swept);
    }

    // ① 入口闸（仅同步/后台发起这两种需要 url 的形态）
    assertSafeUrl(url);

    const mode = (typeof legs === 'string' && legs.trim() !== '') ? legs.trim().toLowerCase() : 'auto';
    if (!['auto', 'always', 'off'].includes(mode)) {
        throw new FpError(ERR.BAD_ARGS, `fetch：legs 只认 auto / always / off，收到「${String(legs).slice(0, 30)}」`, '去掉这个参数（默认 auto）或按三个值之一传。');
    }

    // ★ 11-P1-①：后台发起（不阻塞，立即返回 jobId）
    if (background === true) {
        return startJobText(ctx, url, targetDir, limit, swept, assertSafeUrl);
    }

    // ② Node 裸抓。legs:'off' = 原行为直道：错误**原样传播**（FpError 形状与改动前逐字一致，
    //    回归零，关联表 #2/#30 的账不破）。auto = 失败记死因再降级；always = 跳过 Node 路。
    let nodeFail = null;
    let nodeResult = null;
    if (mode === 'off') {
        nodeResult = await nodeFetch(url, assertSafeUrl, limit, targetDir);   // 不 catch = 原行为
        return deliver(nodeResult, swept);
    }
    if (mode !== 'always') {
        nodeResult = await nodeFetch(url, assertSafeUrl, limit, targetDir).catch((e) => {
            if (String(e?.code ?? '') === 'URL_BLOCKED') throw e;   // ★ 闸拒不降级（铁律①）
            nodeFail = String(e?.message || e).slice(0, 160);
            return null;
        });
    }
    if (nodeResult) {
        return deliver(nodeResult, swept);
    }

    // ③ 扛P 原始字节降级路（http→waf→tls）
    const bridge = await loadBridge(ctx);
    const rawName = `${OWN_PREFIX}${Date.now()}_${safeName(url, '')}`;
    const rawDest = join(targetDir, rawName);
    let rr = await bridge.fpFetchRaw(url, { dest: rawDest, maxBytes: limit });
    if (!rr.ok && rr.blocked) {
        // ★ 铁律①（04）：闸拒 = 直球内网，换腿换镜像都不放（不进任何回退）。
        throw new FpError(ERR.BAD_ARGS, `fp raw 腿被 SSRF 闸拒：${rr.reason}`, '这条 URL 过不了闸，换腿也不放（设计内）。');
    }
    // ★ 07-P3 镜像回退：GitHub 系域名且**直连+三腿全死**才进这里（L-003 实测：本机直连是通的，
    //   默认改域名 = 绕远路 + 信任面扩大，绝不允许）。镜像序 = 实测时延序；每个镜像 URL
    //   先过 JS 闸，成功路的 final_url 照样复核（铁律②对镜像同样成立）。全灭 ⇒ 死因逐条如实报。
    let viaMirror = '';
    const mirrorErrs = [];
    if (!rr.ok) {
        for (const mu of mirrorCandidates(url)) {
            const mHost = safeHost(mu);
            try { assertSafeUrl(mu); } catch { mirrorErrs.push(`${mHost}: 镜像 URL 被闸拒（跳过）`); continue; }
            const mr = await bridge.fpFetchRaw(mu, { dest: rawDest, maxBytes: limit });
            if (mr.ok) { rr = mr; viaMirror = mHost; break; }
            if (mr.blocked) { mirrorErrs.push(`${mHost}: 闸拒(${mr.reason})`); continue; }
            mirrorErrs.push(`${mHost}: ${(mr.diagnosis || 'legs failed').slice(0, 90)}`);
        }
    }
    if (!rr.ok) {
        const tail = nodeFail ? `（Node 裸抓先失败：${nodeFail}）` : '';
        const mt = mirrorErrs.length > 0 ? `；镜像回退也全败：${mirrorErrs.join(' | ').slice(0, 240)}` : '';
        throw new FpError(ERR.BAD_ARGS, `fetch 失败：${rr.diagnosis}${tail}${mt}`,
            mirrorErrs.length > 0
                ? '直连、反扒腿、GitHub 镜像全部失败；核对 URL 是否存在，或改走 search{url} 取文本。'
                : '反扒腿（http/waf/tls）全部失败；看 errors 逐腿死因，或改走 search{url} 取文本。');
    }
    // ★ 铁律②：final_url 必须存在且再过一次 JS 闸；缺失 = 拒收
    if (typeof rr.finalUrl !== 'string' || rr.finalUrl === '') {
        try { unlinkSync(rawDest); } catch { /* 无文件可删 */ }
        throw new FpError(ERR.BAD_ARGS, 'fp raw 腿未回传 final_url，按设计拒收（SSRF 复核前提）', '升级 fp 上游件后重试。');
    }
    try {
        assertSafeUrl(rr.finalUrl);
    } catch (e) {
        try { unlinkSync(rawDest); } catch { /* 无文件可删 */ }
        throw new FpError(String(e?.code ?? 'URL_BLOCKED') === 'URL_BLOCKED' ? ERR.BAD_ARGS : (e?.code ?? ERR.BAD_ARGS),
            `fp raw 腿最终 URL 被 JS 闸复核拒绝：${rr.finalUrl}`, '跳转目标落在内网/保留域，拒收（设计内）。');
    }
    // 复核过 ⇒ 正式落名（若最终 URL 与入口不同，用最终 URL 猜文件名更准）
    let dest = rawDest;
    if (normalizeEq(rr.finalUrl, url) === false) {
        const nicer = `${OWN_PREFIX}${Date.now()}_${safeName(rr.finalUrl, rr.contentType)}`;
        const npath = join(targetDir, nicer);
        try { renameSync(rawDest, npath); dest = npath; } catch { /* 保持原名 */ }
    }
    let size = rr.size;
    try { size = statSync(dest).size; } catch { /* 用 verdict.size */ }
    const hopsN = Math.max(0, (rr.hops?.length ?? 1) - 1);
    const lines = [
        `fetch · ${size} bytes · ${rr.status ?? 200} · ${rr.finalUrl}`,
        `    saved: ${dest}`,
    ];
    if (rr.truncated) lines.push(`    ⚠ 已截断：超过 maxBytes=${limit}（原大小更大，落盘的是前 ${limit} 字节）`);
    if (rr.contentType) lines.push(`    content-type: ${rr.contentType}`);
    // ★ 06-P1：耗时/均速汇总（下载期间外部可看 `<dest>.fpdl.json` 进度小文件；宿主无推送通道，S1 定案）
    const speed = (rr.elapsedS && rr.elapsedS > 0) ? ` · ${rr.elapsedS}s · ${Math.round(rr.size / rr.elapsedS / 1024)} KB/s` : '';
    lines.push(`    via: fp-raw · leg=${rr.leg}${speed}${nodeFail ? `（Node 裸抓先失败：${nodeFail.slice(0, 80)}）` : ''}`);
    if (viaMirror) lines.push(`    mirror: ${viaMirror}（直连+三腿全死后的实测镜像回退，07-P3；最终 URL 已复核过闸）`);
    const deadLegs = (rr.errors ?? []).filter(Boolean);
    if (deadLegs.length > 0) lines.push(`    legs_tried_failed: ${deadLegs.join(' | ').slice(0, 240)}`);
    if (hopsN > 0) lines.push(`    redirects: ${hopsN}（python 每跳过闸 + JS 终 URL 复核）`);
    if (swept.length > 0) lines.push(`    swept: ${swept.length} 个过期自家文件`);
    return lines.join('\n');
}

/**
 * ★ 11-P1-①：后台发起。立即返回 jobId + 落点 + 进度文件路径 + 轮询方法。
 * 为什么必须在 python 路上：Node bare-fetch 跑在本调用的事件循环里，调用返回即无从存活；
 *   python 子进程 detached 出去才能脱离本次调用继续下载（宿主进程的子进程，非 ctx 沙箱树）。
 */
async function startJobText(ctx, url, targetDir, limit, swept, assertSafeUrl) {
    const bridge = await loadBridge(ctx);
    if (typeof bridge.fpFetchRawJob !== 'function') {
        throw new FpError(ERR.NOT_ASSEMBLED, 'fp-bridge.js 没有导出 fpFetchRawJob', '本片（11）的桥件未装配到位：检查 ours/fp-bridge.js。');
    }
    const name = `${OWN_PREFIX}${Date.now()}_${safeName(url, '')}`;
    const dest = join(targetDir, name);
    const r = bridge.fpFetchRawJob(url, { dest, outDir: targetDir, maxBytes: limit });
    if (!r.ok) {
        throw new FpError(ERR.BAD_ARGS, `后台下载发起失败：${r.diagnosis}`, '看 doctor 的桥可达性一段；或改用同步 fetch（不给 background）。');
    }
    const j = r.job;
    const lines = [
        `fetch · background · job ${j.id} · ${url}`,
        `    dest: ${dest}`,
        `    progress: ${j.progressFile}（0.4s 一跳，完成即删）`,
        `    进度查询：fetch{job:"${j.id}"} —— 随时调，返回当下字节/百分比/用时/均速/腿（本调用已返回，下载在后台继续）`,
        `    pid: ${j.pid ?? '未知'}`,
    ];
    if (swept.length > 0) lines.push(`    swept: ${swept.length} 个过期自家文件`);
    return lines.join('\n');
}

/**
 * ★ 11-P1-②：作业轮询。返回当下进度快照（字节/百分比/用时/均速/腿/相位）或终态。
 * 数据源 = `<dest>.fpdl.json`（实时写）+ `<outJson>`（终态 verdict）——都是磁盘事实，不编。
 */
async function pollJobText(ctx, targetDir, jobId, swept) {
    const bridge = await loadBridge(ctx);
    if (typeof bridge.fpJobStatus !== 'function') {
        throw new FpError(ERR.NOT_ASSEMBLED, 'fp-bridge.js 没有导出 fpJobStatus', '本片（11）的桥件未装配到位：检查 ours/fp-bridge.js。');
    }
    const s = bridge.fpJobStatus(targetDir, jobId);
    if (!s.ok) {
        throw new FpError(ERR.BAD_ARGS, `作业查询失败：${s.diagnosis}`, '核对 jobId；作业台账只保留 1 小时（>1h 自动清扫）。');
    }
    const done = Number(s.bytesDone ?? 0);
    const total = Number.isFinite(s.bytesTotal) ? s.bytesTotal : null;
    const pct = (total && total > 0) ? Math.min(100, Math.round(done / total * 1000) / 10) : null;
    const speed = Number.isFinite(s.avgBps) && s.avgBps > 0 ? `${Math.round(s.avgBps / 1024)} KB/s` : null;
    const head = `fetch · job ${jobId} · ${s.status}${pct !== null ? ` · ${pct}%` : ''} · ${done}${total !== null ? `/${total}` : ''} bytes · ${s.elapsedS}s${speed ? ` · ${speed}` : ''}`;
    const lines = [head];

    if (s.status === 'working') {
        lines.push(`    相位: ${s.phase || 'downloading'}${s.leg ? ` · 腿: ${s.leg}` : ''}`);
        if (s.stallS !== null && s.stallS !== undefined) lines.push(`    最后进度更新: ${s.stallS}s 前`);
        lines.push('    下载仍在后台进行；再调 fetch{job} 可看最新状态。');
    } else if (s.status === 'done') {
        lines.push(`    saved: ${s.dest}`);
        if (s.leg) lines.push(`    via: fp-raw · leg=${s.leg}`);
        if (s.contentType) lines.push(`    content-type: ${s.contentType}`);
        if (s.truncated) lines.push('    ⚠ 已截断：超过 maxBytes（落盘的是前 maxBytes 字节）');
        if (s.finalUrl) lines.push(`    final_url: ${s.finalUrl}`);
    } else if (s.status === 'blocked') {
        lines.push(`    ⚠ SSRF 闸拒：${s.reason}`);
        lines.push('    这条 URL 过不了闸，换腿也不放（设计内）。');
    } else if (s.status === 'failed') {
        lines.push(`    ✘ 下载失败：${s.diagnosis}`);
        if (s.errors?.length) lines.push(`    errors: ${s.errors.join(' | ').slice(0, 240)}`);
    } else if (s.status === 'timeout') {
        lines.push(`    ✘ ${s.diagnosis}`);
        lines.push('    作业已按 TIMEOUT 处理；可重发 fetch{background:true} 或改走 search{url} 取文本。');
    } else if (s.status === 'lost') {
        lines.push(`    ✘ ${s.diagnosis}`);
        lines.push('    可能原因：作业被宿主回收 / python 启动即失败 / jobId 拼错。看 doctor 的桥段。');
    }
    if (swept.length > 0) lines.push(`    swept: ${swept.length} 个过期自家文件`);
    return lines.join('\n');
}

/** Node 裸抓成功路径的交付——**形状与 04 之前逐字节一致**（回归零：G4 S-3 的账）。 */
function deliver(r, swept) {
    const lines = [
        `fetch · ${r.buf.length} bytes · ${r.status} · ${r.current}`,
        `    saved: ${r.dest}`,
    ];
    if (r.truncated) lines.push(`    ⚠ 已截断：超过 maxBytes=${r.limit}（原大小更大，落盘的是前 ${r.limit} 字节）`);
    if (r.ct) lines.push(`    content-type: ${r.ct}`);
    if (r.hops > 0) lines.push(`    redirects: ${r.hops}（每一跳都过了 SSRF 闸）`);
    if (swept.length > 0) lines.push(`    swept: ${swept.length} 个过期自家文件`);
    return lines.join('\n');
}

/**
 * ★ 11-P0：Node 裸抓超时诊断。把 AbortSignal.timeout 触发的中止/超时，
 *   转成带死因的 FpError（不再让挂起连接永挂、也不让 TimeoutError 裸冒到调用方）。
 */
function nodeTimeoutDiag(e, url) {
    const name = String(e?.name ?? '');
    const msg = String(e?.message ?? e ?? '');
    const isTimeout = name === 'TimeoutError' || e?.code === 'ABORT_ERR' || /timeout|abort|timed out/i.test(msg);
    return new FpError(
        ERR.BAD_ARGS,
        `Node 裸抓超时${isTimeout ? `（${NODE_FETCH_TIMEOUT_MS / 1000}s 内未完成）` : ''}：${url}`,
        '目标站连接挂起或过慢；可加 legs:"always" 走反扒原始字节腿，或稍后重试（后台作业路不受此限）。'
    );
}

/** Node 路主体（原 ②③ 段原样搬来，不改语义；reject ⇒ 网络错/HTTP 错，resolve ⇒ 已落盘）。 */
async function nodeFetch(url, assertSafeUrl, limit, targetDir) {
    let current = url;
    let response = null;
    let hops = 0;
    for (; hops <= MAX_REDIRECTS; hops += 1) {
        const signal = AbortSignal.timeout(NODE_FETCH_TIMEOUT_MS);   // ★ 11-P0
        let res;
        try {
            res = await fetch(current, { redirect: 'manual', signal });
        } catch (e) {
            throw nodeTimeoutDiag(e, current);   // ★ 11-P0：挂起连接不再永挂
        }
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) { response = res; break; }
            const next = new URL(loc, current).toString();
            assertSafeUrl(next);        // ★ 关键：跳转目标也要过闸
            current = next;
            continue;
        }
        response = res;
        break;
    }
    if (response === null) {
        throw new FpError(ERR.BAD_ARGS, `重定向超过 ${MAX_REDIRECTS} 跳，已放弃：${url}`, '目标站可能在做跳转环。');
    }
    if (!response.ok) {
        throw new FpError(ERR.BAD_ARGS, `HTTP ${response.status}：${url}`, '检查 URL 是否有效。');
    }
    let ab;
    try {
        ab = await response.arrayBuffer();   // body 读受该请求 signal 约束
    } catch (e) {
        throw nodeTimeoutDiag(e, current);   // ★ 11-P0
    }
    let buf = Buffer.from(ab);
    let truncated = false;
    if (buf.length > limit) {
        buf = buf.subarray(0, limit);
        truncated = true;
    }
    const ct = response.headers.get('content-type') ?? '';
    const name = `${OWN_PREFIX}${Date.now()}_${safeName(current, ct)}`;
    const dest = join(targetDir, name);
    writeFileSync(dest, buf);
    return { buf, status: response.status, current, dest, truncated, ct, hops, limit };
}

/**
 * ★ 07-P3 镜像候选：只认 GitHub 系直链资源（archive/codeload/raw），前缀式拼 URL。
 * 表与序 = 07 开发日志 L-003 实测时延（三家当时全 200）；不照抄网传表，死表由主人一句话改。
 * 返回 [] = 不适用（非 GitHub 资源原样报错，绝不瞎撞镜像）。
 */
export function mirrorCandidates(url) {
    let u; try { u = new URL(url); } catch { return []; }
    const h = u.hostname.toLowerCase();
    const isGh = h === 'github.com' || h === 'codeload.github.com' || h === 'raw.githubusercontent.com';
    if (!isGh) return [];
    if (u.protocol !== 'https:') return [];           // 只代理 https 原链，不放大明文面
    // 镜像 = 通用转发代理：前缀 + 原始完整 URL（隔壁窗实测用法；不改写路径，
    // codeload/raw/archive 三种形态都原样交给镜像自己去转发）。
    return ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/'].map((m) => m + url);
}

function safeHost(u) { try { return new URL(u).hostname; } catch { return u.slice(0, 30); } }

/** 简单同源比较（协议/主机/路径一致即视为未跳转；只影响是否换名，不影响闸）。 */
function normalizeEq(a, b) {
    try {
        const ua = new URL(a); const ub = new URL(b);
        return ua.protocol === ub.protocol && ua.hostname === ub.hostname && ua.pathname === ub.pathname;
    } catch { return false; }
}

export function init() { /* 无状态 */ }
