// fp-bridge · PAGE 增强（1.1.0 版本号不变，Updating 工作区）
// 职责：page() 降级时 spawn 扛P 五段递减 CLI（http→waf→tls→render→cdp）。
// 通信走文件（沙箱内 stdout 管道不可靠，同 ws-transport 教训）；spawn 必须异步。
// PYTHONIOENCODING/PYTHONUTF8 双锁（GBK 控制台把 diagnosis 中文变问号的坑，2026-10-31 核对发现）。
// fp 布局：lib\types\fp-bridge.js 的上两级 = 包根\PAGE增强根，fp\ 在其下（工作区与发布形态一致）。
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// ★ R11：python 发现统一走 ours/python-find.js（原来这里的"从 execPath 向上找
// dependencies"在 DSH 进程内加载时永远找不到随包 python —— execPath 是 Electron 宿主）。
import { findPython } from './python-find.js';

const __dirname = dirname(fileURLToPath(import.meta.url)); // ours/
// ★ R10（2026-11-04 测试汇总）：这里是 `join(__dirname,'..','..','fp',...)` —— 多退了一层。
//   本文件在 `<包根>/ours/`，包根下的 `fp/` 只隔**一**级；退两级跑到包根之外，
//   于是 fpStatus().fp 恒 null，op:search 的 url 抓取永远走不到 fp。
//   实测证据：装机槽里 `fp/fpwebsearch.py`（220 B）确实在位，但桥说 fp=null。
//   兜底：极老形态（文件在 lib/types/ 下）保留原来的两级 —— 两种形态都认，取存在的那份。
const FP_PY = [
  join(__dirname, '..', 'fp', 'fpwebsearch.py'),        // ours/ → <包根>/fp
  join(__dirname, '..', '..', 'fp', 'fpwebsearch.py'), // lib/types/ → <包根>/fp（旧形态）
].find((p) => existsSync(p)) ?? join(__dirname, '..', 'fp', 'fpwebsearch.py');

// 清扫 outDir 里 >1h 的 wsb_fp_* 残留（进程被杀在 unlink 前会留尸；同 ws-bridge.js 的 sweepTmp 模式）
function sweepTmp(outDir) {
  try {
    const cutoff = Date.now() - 3600_000;
    for (const f of readdirSync(outDir)) {
      if (!f.startsWith('wsb_fp_')) continue;
      const p = join(outDir, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch {}
    }
  } catch {}
}

let _py = null;

export function fpStatus() {
  if (!_py) _py = findPython();
  return { py: _py, fp: existsSync(FP_PY) ? FP_PY : null };
}

// 异步 spawn（不阻塞事件循环）；stdio 'ignore'——沙箱内管道不可靠，结果全走 --out-file
function spawnPy(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(_py, args, {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        // ★ 2026-11-21 合并轮实测：python 一 import 就在**源码树**写 __pycache__。
        //   后果：① 装机槽每跑一次 raw 腿就多一批 .pyc（跨机器无用，还让件数账说不清）；
        //   ② 槽与仓根的逐件哈希对拍被这批运行时产物搅浑（实测多出 21 件）。
        //   门脚本早就有这条（engine/verify/*.mjs），插件运行路漏了 ⇒ 这里补齐。
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ status: null, signal: 'TIMEOUT' }); }, timeoutMs);
    child.on('error', (e) => finish({ status: null, signal: '-', err: String(e?.code || e?.message || e) }));
    child.on('exit', (code, signal) => finish({ status: code, signal }));
  });
}

/**
 * 扛P 五段递减抓取。编排器在 fp\support（整机自带），本函数只负责拉起+收尸。
 * @param {string} url
 * @param {{fpLegTimeoutSec?:number, outDir?:string}} opts
 * @returns {Promise<{ok:boolean, leg?:string, title?:string, text?:string, chars?:number, diagnosis?:string}>}
 */
export async function fpFetch(url, opts = {}) {
  const st = fpStatus();
  if (!st.py || !st.fp)
    return { ok: false, diagnosis: `fp unavailable: py=${st.py} fp=${st.fp}` };
  const legSec = Math.max(3, Math.round(opts.fpLegTimeoutSec ?? 5));
  const totalMs = legSec * 5000 + 10000; // 每腿 legSec 秒 × 5 腿 + spawn 余量
  const outDir = opts.outDir || tmpdir();
  try { mkdirSync(outDir, { recursive: true }); } catch {}
  sweepTmp(outDir); // 每次调用顺手清 >1h 残留（readdir <1ms，自愈不靠运气）
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outJson = join(outDir, `wsb_fp_${uid}.json`);
  const r = await spawnPy(
    [FP_PY, url, '--json', '--quiet', '--out-dir', outDir, '--out-file', outJson, '--timeout', String(legSec)],
    totalMs,
  );
  let verdict = null;
  try { verdict = JSON.parse(readFileSync(outJson, 'utf8')); } catch {}
  if (!verdict) {
    return { ok: false, diagnosis: `fp verdict missing (exit=${r?.status}, signal=${r?.signal}, err=${r?.err || 'none'})` };
  }
  let text = '';
  const tf = verdict.text_file;
  if (verdict.ok && tf && existsSync(tf)) {
    try { text = readFileSync(tf, 'utf8'); } catch {}
  }
  for (const f of [outJson, tf]) { if (f) { try { unlinkSync(f); } catch {} } }
  if (!verdict.ok)
    return { ok: false, diagnosis: `fp: ${verdict.diagnosis || 'all legs failed'}` };
  return { ok: true, leg: verdict.leg, title: verdict.title, text, chars: verdict.chars };
}

/**
 * ★ 04 片（2026-11-19，主人令「先把FETCH接上腿吧」）：扛P 原始字节下载腿。
 * 与 fpFetch（文本五段）互斥、零干扰：这里只认 http/waf/tls 三腿，**不做任何 decode**，
 * 字节由 python 侧直接写 dest，JS 侧只收 verdict 元数据（管道不可靠老账，同 spawnPy 注释）。
 *
 * 能力边界（不许假装）：render/cdp 两腿是浏览器腿、产出 DOM 文本，对文件无字节语义 ⇒ 不接。
 * pylibs 发现不在这里做：rawdl 走 `from drivers.tls import curl_requests`，
 * 复用 drivers/tls.py 自带的两级回退链（关联表 #4/#6 的账），JS 侧零份数。
 *
 * @param {string} url
 * @param {{dest:string, maxBytes?:number, legs?:string[], fpLegTimeoutSec?:number, outDir?:string}} opts
 * @returns {Promise<{ok:boolean, blocked?:boolean, reason?:string, leg?:string, size?:number,
 *   finalUrl?:string, contentType?:string, status?:number, truncated?:boolean,
 *   errors?:string[], diagnosis?:string}>}
 */
export async function fpFetchRaw(url, opts = {}) {
  const st = fpStatus();
  if (!st.py || !st.fp)
    return { ok: false, diagnosis: `fp unavailable: py=${st.py} fp=${st.fp}` };
  if (typeof opts.dest !== 'string' || opts.dest.trim() === '')
    return { ok: false, diagnosis: 'fpFetchRaw: dest 必须给（落盘绝对路径，由调用方命名）' };
  const legSec = Math.max(3, Math.round(opts.fpLegTimeoutSec ?? 12));
  // ★ 默认 12 秒/腿（不是文本路的 5 秒）：文件下载比取正文吃字节多，实测 python.org 的 15.7KB PNG
  //   在 8 秒/腿下 waf 腿会截在 7123/15770 字节（04 开发日志 L-019）；12 秒/腿实测能拿全。
  const RAW_LEGS = 3;                       // http/waf/tls 三腿，不是五腿
  const totalMs = legSec * RAW_LEGS * 1000 + 30000;  // 每腿 legSec × 3 + spawn/传输余量
  const outDir = opts.outDir || tmpdir();
  try { mkdirSync(outDir, { recursive: true }); } catch {}
  sweepTmp(outDir);
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // ★ 前缀必须仍是 `wsb_fp_`：这样进程被杀在 unlink 前留下的尸，sweepTmp（认 wsb_fp_ 前缀）能扫掉。
  const outJson = join(outDir, `wsb_fp_raw_${uid}.json`);
  const args = [FP_PY, url, '--raw', '--quiet', '--dest', opts.dest,
    '--out-file', outJson, '--timeout', String(legSec), '--progress'];
  if (Number.isFinite(opts.maxBytes) && opts.maxBytes > 0) args.push('--max-bytes', String(Math.floor(opts.maxBytes)));
  if (Array.isArray(opts.legs) && opts.legs.length > 0) args.push('--legs', opts.legs.join(','));
  const r = await spawnPy(args, totalMs);
  let verdict = null;
  try { verdict = JSON.parse(readFileSync(outJson, 'utf8')); } catch {}
  try { unlinkSync(outJson); } catch {}
  if (!verdict) {
    // 契约缺失：把 dest 可能存在的半成品删掉，绝不交"半个文件"
    try { unlinkSync(opts.dest); } catch {}
    return { ok: false, diagnosis: `fp raw verdict missing (exit=${r?.status}, signal=${r?.signal}, err=${r?.err || 'none'})` };
  }
  if (verdict.blocked) {
    try { unlinkSync(opts.dest); } catch {}
    return { ok: false, blocked: true, reason: verdict.reason || 'SSRF 闸拒', leg: verdict.leg_used || null,
      finalUrl: verdict.final_url || null, errors: verdict.errors || [] };
  }
  if (!verdict.ok) {
    try { unlinkSync(opts.dest); } catch {}
    return { ok: false, diagnosis: `fp raw legs failed: ${(verdict.errors || []).join(' | ') || 'all legs failed'}`,
      errors: verdict.errors || [] };
  }
  return {
    ok: true,
    leg: verdict.leg_used || null,
    size: Number.isFinite(verdict.size) ? verdict.size : 0,
    finalUrl: verdict.final_url || null,
    contentType: verdict.content_type || '',
    status: Number.isFinite(verdict.status) ? verdict.status : null,
    truncated: Boolean(verdict.truncated),
    elapsedS: Number.isFinite(verdict.elapsed_s) ? verdict.elapsed_s : null,   // ★ 06-P1：交付汇总用
    hops: Array.isArray(verdict.hops) ? verdict.hops : [],
    errors: verdict.errors || [],
  };
}

// ============================================================== ★ 11-P1 后台作业
// 病根（本会话实测）：宿主无工具进度推送通道（S1 契约级实锤）+ ctx 独占 ⇒ 阻塞调用期间
//   既无进度可看、慢站还会把调用冻住。后台四路线（fp 参 / ctx background / Start-Process /
//   schtasks）在 ctx 沙箱侧实测全封；**唯一活路 = 插件在宿主进程里 detached spawn**，
//   调用立即返回 jobId，之后随时轮询进度小文件看当下状态。
// 设计要点：
//   · 作业零 python 改动 —— cli.py 的 --out-file 无条件下写 verdict，--progress 无条件写进度小文件；
//     本层只负责"发起时不等待、轮询时读盘"。
//   · 作业台账 `<outDir>/.fpjob/<id>.json`：记录 pid/dest/outJson/progressFile/发起时刻/腿参数。
//   · 进度 = `<dest>.fpdl.json`（06 家族，0.4s 一跳；完成/失败即删 ⇒ 文件消失 + verdict 在 = 终态）。
//   · 清扫并入既有的 outDir 清扫面（11 起由 03-fetch 的 sweep 一并按 mtime 收尸）。

/** 作业台账所在子目录（在 outDir 下，与 `fp_` 家族同域）。 */
export const JOB_SUBDIR = '.fpjob';

function jobDirOf(outDir) {
  const d = join(outDir, JOB_SUBDIR);
  try { mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function jobFileOf(outDir, id) {
  return join(jobDirOf(outDir), `${id}.json`);
}

/** 读作业台账；不存在/坏了 ⇒ null（如实返回，不编）。 */
export function readJob(outDir, id) {
  try { return JSON.parse(readFileSync(jobFileOf(outDir, safeJobId(id)), 'utf8')); }
  catch { return null; }
}

/** jobId 只留安全字符（防路径穿越：这是外部可传的参数）。 */
export function safeJobId(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

/**
 * ★ 发起后台下载作业：立即返回，不等待下载完成。
 * @param {string} url
 * @param {{dest:string, outDir:string, maxBytes?:number, legs?:string[], fpLegTimeoutSec?:number}} opts
 * @returns {{ok:boolean, job?:object, diagnosis?:string}}
 */
export function fpFetchRawJob(url, opts = {}) {
  const st = fpStatus();
  if (!st.py || !st.fp) return { ok: false, diagnosis: `fp unavailable: py=${st.py} fp=${st.fp}` };
  if (typeof opts.dest !== 'string' || opts.dest.trim() === '')
    return { ok: false, diagnosis: 'fpFetchRawJob: dest 必须给（落盘绝对路径，由调用方命名）' };
  const outDir = opts.outDir || tmpdir();
  try { mkdirSync(outDir, { recursive: true }); } catch {}
  sweepTmp(outDir);
  const legSec = Math.max(3, Math.round(opts.fpLegTimeoutSec ?? 12));
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outJson = join(outDir, `wsb_fp_raw_${id}.json`);   // wsb_fp_ 前缀 ⇒ sweepTmp 能收尸
  const args = [FP_PY, url, '--raw', '--quiet', '--dest', opts.dest,
    '--out-file', outJson, '--timeout', String(legSec), '--progress'];
  if (Number.isFinite(opts.maxBytes) && opts.maxBytes > 0) args.push('--max-bytes', String(Math.floor(opts.maxBytes)));
  if (Array.isArray(opts.legs) && opts.legs.length > 0) args.push('--legs', opts.legs.join(','));
  let child;
  try {
    // ★ detached + unref：作业不占调用方的等待，进程独立于本次工具调用存活。
    child = spawn(_py, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    child.unref();
  } catch (e) {
    return { ok: false, diagnosis: `作业发起失败：${String(e?.code || e?.message || e)}` };
  }
  const rec = {
    id, url, dest: opts.dest, outJson, outDir,
    progressFile: `${opts.dest}.fpdl.json`,
    legSec, maxBytes: Number.isFinite(opts.maxBytes) ? Math.floor(opts.maxBytes) : null,
    legs: Array.isArray(opts.legs) ? opts.legs : null,
    pid: child?.pid ?? null,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
  };
  try { writeFileSync(jobFileOf(outDir, id), JSON.stringify(rec, null, 2), 'utf8'); }
  catch (e) { return { ok: false, diagnosis: `作业台账写入失败：${String(e?.code || e?.message || e)}` }; }
  return { ok: true, job: rec };
}

/**
 * ★ 轮询作业当下状态：读进度小文件 + verdict（有则终态）。
 * 返回 status：working（有进度、无 verdict）/ done / failed / blocked / timeout / lost（台账在但既无进度也无 verdict）。
 */
export function fpJobStatus(outDir, id, opts = {}) {
  const rec = readJob(outDir, id);
  if (!rec) return { ok: false, diagnosis: `找不到作业 ${id}（台账不在 ${join(outDir, JOB_SUBDIR)}）` };
  const now = Date.now();
  const stallSec = Math.max(30, Number(opts.stallSec ?? 180));

  // ① 进度小文件（下载中/刚结束两种都有价值）
  let prog = null;
  try { prog = JSON.parse(readFileSync(rec.progressFile, 'utf8')); } catch {}

  // ② 终态 verdict（cli --out-file 无条件写；作业结束才有）
  let verdict = null;
  try { verdict = JSON.parse(readFileSync(rec.outJson, 'utf8')); } catch {}

  const elapsed = Math.round((now - rec.startedMs) / 1000);
  if (verdict) {
    // 台账保留（便于再次查询终态），verdict 读到即终态
    if (verdict.blocked) {
      return { ok: true, status: 'blocked', job: rec, elapsedS: elapsed,
        bytesDone: prog?.bytes_done ?? 0, bytesTotal: prog?.bytes_total ?? null,
        reason: verdict.reason || 'SSRF 闸拒', leg: verdict.leg_used || null,
        dest: rec.dest, finalUrl: verdict.final_url || null };
    }
    if (!verdict.ok) {
      return { ok: true, status: 'failed', job: rec, elapsedS: elapsed,
        bytesDone: prog?.bytes_done ?? 0, bytesTotal: prog?.bytes_total ?? null,
        dest: rec.dest, errors: verdict.errors || [],
        diagnosis: `fp raw legs failed: ${(verdict.errors || []).join(' | ') || 'all legs failed'}` };
    }
    let size = Number.isFinite(verdict.size) ? verdict.size : 0;
    try { size = statSync(rec.dest).size; } catch {}
    return { ok: true, status: 'done', job: rec, elapsedS: elapsed,
      bytesDone: size, bytesTotal: prog?.bytes_total ?? size, size,
      leg: verdict.leg_used || null, dest: rec.dest, finalUrl: verdict.final_url || null,
      contentType: verdict.content_type || '', truncated: Boolean(verdict.truncated),
      avgBps: (verdict.elapsed_s && verdict.elapsed_s > 0) ? Math.round(verdict.size / verdict.elapsed_s) : null,
      hops: Array.isArray(verdict.hops) ? verdict.hops : [],
      errors: verdict.errors || [] };
  }

  // ③ 无 verdict ⇒ 还在跑，或挂死
  if (prog) {
    // 进度文件里的 updated 是 monotonic 秒，不能跨进程比；用 mtime 判停滞。
    let mtime = 0;
    try { mtime = statSync(rec.progressFile).mtimeMs; } catch {}
    const stallS = mtime ? Math.round((now - mtime) / 1000) : null;
    const pidAlive = rec.pid ? isPidAlive(rec.pid) : null;
    const status = (stallS !== null && stallS > stallSec && pidAlive === false) ? 'timeout' : 'working';
    return { ok: true, status, job: rec, elapsedS: elapsed,
      bytesDone: prog.bytes_done ?? 0, bytesTotal: prog.bytes_total ?? null,
      leg: prog.leg || null, phase: prog.status || null, avgBps: prog.avg_Bps ?? null,
      stallS, pidAlive, dest: rec.dest,
      ...(status === 'timeout' ? { diagnosis: `作业停滞 ${stallS}s 无进度且进程已退出（按 TIMEOUT 处理）` } : {}) };
  }

  // ④ 既无进度也无 verdict：刚发起（python 还没写第一跳进度）或已死
  const pidAlive = rec.pid ? isPidAlive(rec.pid) : null;
  if (elapsed <= 10 || pidAlive) {
    return { ok: true, status: 'working', job: rec, elapsedS: elapsed,
      bytesDone: 0, bytesTotal: null, leg: null, phase: 'starting', pidAlive, dest: rec.dest };
  }
  return { ok: true, status: 'lost', job: rec, elapsedS: elapsed,
    bytesDone: 0, bytesTotal: null, pidAlive, dest: rec.dest,
    diagnosis: '作业进程已退出且无 verdict/进度（可能被宿主回收或启动即失败）' };
}

/** 进程是否还活着（Windows 上用 tasklist，失败则返回 null = 未知，不编）。 */
function isPidAlive(pid) {
  try {
    return String(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true })).includes(String(pid));
  } catch { return null; }
}

/** 清扫过期作业台账（>1h），与 fp_ 家族同口径，只碰自家 .fpjob 目录。 */
export function sweepJobs(outDir) {
  const removed = [];
  const d = jobDirOf(outDir);
  let names = [];
  try { names = readdirSync(d); } catch { return removed; }
  const cutoff = Date.now() - 3600_000;
  for (const n of names) {
    const p = join(d, n);
    try { if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed.push(n); } } catch {}
  }
  return removed;
}
