// fp-bridge · PAGE 增强（1.1.0 版本号不变，Updating 工作区）
// 职责：page() 降级时 spawn 扛P 五段递减 CLI（http→waf→tls→render→cdp）。
// 通信走文件（沙箱内 stdout 管道不可靠，同 ws-transport 教训）；spawn 必须异步。
// PYTHONIOENCODING/PYTHONUTF8 双锁（GBK 控制台把 diagnosis 中文变问号的坑，2026-10-31 核对发现）。
// fp 布局：lib\types\fp-bridge.js 的上两级 = 包根\PAGE增强根，fp\ 在其下（工作区与发布形态一致）。
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
