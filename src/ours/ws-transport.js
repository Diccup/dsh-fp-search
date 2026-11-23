import { readFileSync, existsSync, readdirSync, statSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { classifyBody, decodeHtml } from './ws-detect.js';
import { failure } from './ws-text.js';
// ★ R11：python 发现统一走 ours/python-find.js（原来的"从 execPath 向上找 dependencies"
// 在 DSH 进程内加载时永远找不到随包 python —— 那时 execPath 是 Electron 宿主）。
import { findPython } from './python-find.js';

export let spawnImpl = spawnSync;

const DEFAULT_TIMEOUT_MS = 15000;
const _PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));   // lib/types → 包根（随包 pylibs 用）
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _discovery = null;
let _probeCache = new Map();
let _bridgeDisabled = false;

function _statMtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

function _pythonXy(py) {
  // ★ 2026-11-21 检查轮补：这两条版本探测也会 spawn python。`-c 'import sys;...'`
  //   本身不写 .pyc，但为一致性统一带上 PYTHONDONTWRITEBYTECODE（免得将来改 payload 时又漏）。
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
  try {
    const r = spawnSync(py, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true, env });
    // version goes to stderr for python; use pipe to capture
  } catch {}
  try {
    const r2 = spawnSync(py, ['-c', 'import sys;print(sys.version_info.major,sys.version_info.minor,sep="")'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env });
    const out = String(r2.stdout || '').trim();
    if (/^\d+\d+$/.test(out) && out.length === 2) return out;
    if (/^\d+ \d+$/.test(out)) { const [a,b] = out.split(' '); return `${a}${b}`; }
  } catch {}
  return null;
}

function _cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function _findPylibs(bases, xy) {
  const hits = [];
  let visited = 0;
  const start = Date.now();
  function walk(root, depth) {
    if (depth > 4) return;
    if (visited > 20000) return;
    if (Date.now() - start > 2000) return;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
    visited++;
    const hasCurl = entries.some((e) => e.isDirectory() && e.name === 'curl_cffi');
    const pyd = entries.find((e) => e.isFile() && /^_cffi_backend\.cp\d+.*\.pyd$/.test(e.name));
    if (hasCurl && pyd) {
      const tag = (pyd.name.match(/_cffi_backend\.cp(\d+)/) || [])[1];
      if (!xy || !tag || tag === xy) {
        const dist = entries.find((e) => e.isDirectory() && /^curl_cffi-.*\.dist-info$/.test(e.name));
        const ver = dist ? dist.name.replace(/^curl_cffi-/, '').replace(/\.dist-info$/, '') : '0';
        let mtime = 0;
        try { mtime = statSync(root).mtimeMs; } catch {}
        hits.push({ path: root, version: ver, mtime });
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        try { walk(join(root, e.name), depth + 1); } catch {}
      }
    }
  }
  for (const b of bases) {
    if (!b) continue;
    try { walk(realpathSync(b), 0); } catch {}
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => _cmpVersion(b.version, a.version) || (b.mtime - a.mtime));
  return hits[0].path;
}

function _discover() {
  if (_discovery) return _discovery;
  // ★ R11：统一走 ours/python-find.js。原来这里自己实现了一遍"从 execPath 向上找
  //   dependencies\python\python.exe"，在 DSH 进程内加载时 execPath 是 Electron 宿主，
  //   向上走永远走不到 ~\.dsh\dsh-runtimes\ —— 结果 py=null，抓取全线降级失败。
  const py = findPython();
  let pylibs = process.env.DSH_FP_PYLIBS || null;
  let parent = null;
  if (py && !pylibs) {
    const xy = _pythonXy(py);
    // 随包 pylibs 最优先：1.2.1 起随包 pylibs 上提到包根 deps\pylibs（中文开发目录名不再进发布物）；
    // 旧发布形态 重建搜索项目\deps\pylibs 保留为兼容次选，让新模块配得上 1.2.0 及更早的装载位。
    // 摆脱对 cwd walk 的运气依赖（2026-10-31 外测修复）。fp\drivers\tls.py 的第一回退分支就是 BASE.parent\deps\pylibs，故 Python 侧零改动。
    const bases = [join(_PKG_ROOT, 'deps', 'pylibs'), join(_PKG_ROOT, '重建搜索项目', 'deps', 'pylibs'), process.env.DSH_FP_ROOT, process.cwd(), homedir()].filter(Boolean);
    pylibs = _findPylibs(bases, xy);
  }
  if (pylibs) parent = dirname(pylibs);
  _discovery = { py, pylibs, parent };
  return _discovery;
}

function _probe(py, pylibs, impl) {
  const key = `${py}|${_statMtime(py)}`;
  if (_probeCache.has(key)) return _probeCache.get(key);
  const metaFile = join(tmpdir(), `ctxweb_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  const payload = `import json,sys
sys.path.insert(0, sys.argv[1])
try:
    import curl_cffi
    meta={'ok':True}
except Exception as e:
    meta={'ok':False,'err':str(e)[:300]}
f=open(sys.argv[2],'w',encoding='utf-8')
json.dump(meta,f)
f.close()
`;
  try { rmSync(metaFile, { force: true }); } catch {}
  try {
    // ★ 2026-11-21 检查轮补：这条探针会 `import curl_cffi`（pylibs 在 sys.path 上）
    //   ⇒ python 默认把 .pyc 写进**随包 deps/pylibs**（跨机器无用，还让件数账说不清）。
    //   本门脚本与另两处 spawn 早就有 PYTHONDONTWRITEBYTECODE，**这一处漏了**。
    impl(py, ['-c', payload, pylibs, metaFile], {
      stdio: 'ignore', timeout: 20000, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
  } catch {}
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { meta = null; }
  try { rmSync(metaFile, { force: true }); } catch {}
  const res = meta && meta.ok ? 'ok' : (meta && meta.err ? meta.err : 'missing');
  _probeCache.set(key, res);
  if (res !== 'ok') _bridgeDisabled = true;
  return res;
}

export function bridgeStatus() {
  const d = _discovery;
  if (!d) return { py: null, pylibs: null, curl_cffi: 'untested' };
  const key = d.py ? `${d.py}|${_statMtime(d.py)}` : null;
  const r = key ? _probeCache.get(key) : null;
  return {
    py: d.py || null,
    pylibs: d.pylibs || null,
    curl_cffi: r ? (r === 'ok' ? 'ok' : 'missing') : 'untested',
    reason: r && r !== 'ok' ? r : undefined,
  };
}

function _validateOutDir(outDir) {
  const d = _discover();
  let resolved;
  try { resolved = realpathSync(resolve(outDir)); } catch { resolved = resolve(outDir); }
  const tmp = realpathSync(tmpdir());
  const cwd = realpathSync(process.cwd());
  const dshWebOut = process.env.DSH_WEB_OUT;
  let allowed = false;
  const under = (base, p) => p === base || p.startsWith(base + sep);
  if (under(tmp, resolved)) allowed = true;
  else if (under(cwd, resolved)) allowed = true;
  else if (dshWebOut) {
    try {
      const base = realpathSync(resolve(dshWebOut));
      if (under(base, resolved)) allowed = true;
    } catch {}
  }
  if (d.parent && under(realpathSyncSafe(d.parent), resolved)) allowed = false;
  // hard reject pylibs parent
  if (d.parent) {
    try {
      const pp = realpathSync(d.parent);
      if (resolved === pp || resolved.startsWith(pp + sep)) allowed = false;
    } catch {}
  }
  if (!allowed) return tmp;
  return resolved;
}

function realpathSyncSafe(p) { try { return realpathSync(p); } catch { return resolve(p); } }

function _extractTitle(html) {
  const m = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : '';
}

function _uid() { return `${Date.now()}_${Math.random().toString(36).slice(2)}`; }

/** 异步桥 spawn：spawnSync 会阻塞事件循环，并行 doctor/聚合下桥腿被迫排队串行（自测 2026-10-31：50.9s 且每 +8.5s 线性）；默认 impl 时走这里，外部注入的同步 impl 保持原语义 */
function _spawnPyAsync(py, args, timeoutMs) {
  return new Promise((resolve) => {
    // ★ 2026-11-21 合并轮：与 fp-bridge.js 同因 —— python 一 import 就写源码树 __pycache__，
    //   装机槽每跑一次就多一批 .pyc（跨机器无用、件数账说不清）。门脚本早有这条，运行路补齐。
    const child = spawn(py, args, {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ status: null, signal: 'TIMEOUT' }); }, timeoutMs);
    child.on('error', (e) => finish({ status: null, signal: '-', err: String(e?.code || e?.message || e) }));
    child.on('exit', (code, signal) => finish({ status: code, signal }));
  });
}

export async function getHtml(url, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = 2_000_000,
    allowBridge = true,
    headers = {},
    fetchImpl = fetch,
    spawnImpl: spawnOverride,
    outDir,
    metaDir,
  } = opts;
  const impl = spawnOverride || spawnImpl;

  // Fast leg
  let status = 0;
  let text = '';
  let enc = '';
  let ct = '';   // ★ 03 片：提到函数级——fast 腿返回体要透传 content-type，const 在 try 块内会出块即死
  let byteLen = 0; // ★ 03 片：同上，真实字节数（Uint8Array 长度），失败路径保持 0
  let fastDiagnosis = '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': DEFAULT_UA,
        'accept-language': 'en-US,en;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });
    status = res.status;
    ct = (typeof res.headers?.get === 'function') ? (res.headers.get('content-type') || '') : '';
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    byteLen = bytes.length;
    const sliced = bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
    const dec = decodeHtml(sliced, ct);
    text = dec.text;
    enc = dec.enc;
  } catch (e) {
    if (e?.name === 'AbortError') fastDiagnosis = `timeout: no response within ${timeoutMs}ms`;
    else fastDiagnosis = String(e?.message || e);
  } finally {
    clearTimeout(timer);
  }

  const title = _extractTitle(text);
  const blocked = text ? classifyBody(text, title) : null;
  const fastOk = status >= 200 && status < 300 && !blocked && !fastDiagnosis;

  if (fastOk) {
    // ★ 03 片：透传 content-type 与真实字节数（byteLen=Uint8Array 长度）。
    //   注意 `bytes` 仍是 text.length（字符数，关联表 #2 的坑），文件大小用途只认 byteLen。
    return { ok: true, status, text, bytes: text.length, via: 'fast', enc, contentType: ct, byteLen, body_file: undefined, blocked: undefined, diagnosis: undefined };
  }

  // Bridge decision
  const needsBridge = !fastOk;
  if (!allowBridge || !needsBridge) {
    // return failure-ish
    if (blocked) return { ok: false, status, text, bytes: text.length, via: 'none', enc, contentType: ct, body_file: undefined, blocked, diagnosis: blocked };
    if (fastDiagnosis) return { ok: false, status, text, bytes: text.length, via: 'none', enc, contentType: ct, body_file: undefined, blocked: undefined, diagnosis: fastDiagnosis };
    if (status && (status < 200 || status >= 300)) return { ok: false, status, text, bytes: text.length, via: 'none', enc, contentType: ct, body_file: undefined, blocked: undefined, diagnosis: `http ${status}` };
    return { ok: true, status, text, bytes: text.length, via: 'none', enc, contentType: ct, body_file: undefined, blocked: undefined, diagnosis: undefined };
  }

  const d = _discover();
  if (!d.py || !d.pylibs) {
    return { ok: false, status, text, bytes: text.length, via: 'none', enc, contentType: ct, body_file: undefined, blocked: blocked || undefined, diagnosis: blocked || fastDiagnosis || `http ${status}` || 'bridge unavailable' };
  }
  if (_bridgeDisabled) {
    return { ok: false, status, text, bytes: text.length, via: 'none', enc, contentType: ct, body_file: undefined, blocked: blocked || undefined, diagnosis: blocked || fastDiagnosis || 'bridge disabled' };
  }
  const probeRes = _probe(d.py, d.pylibs, impl);
  if (probeRes !== 'ok') {
    _bridgeDisabled = true;
    return { ok: false, status, text, bytes: text.length, via: 'none', enc, contentType: ct, body_file: undefined, blocked: blocked || undefined, diagnosis: blocked || fastDiagnosis || probeRes };
  }

  const baseDir = metaDir || outDir || tmpdir();
  const validated = _validateOutDir(baseDir === tmpdir() ? tmpdir() : baseDir);
  // if outDir provided, validate; if not, tmpdir
  const finalDir = outDir ? _validateOutDir(outDir) : (metaDir ? _validateOutDir(metaDir) : tmpdir());
  const uid = _uid();
  const bodyFile = join(finalDir, `ctxweb_${uid}.html`);
  const metaFile = join(finalDir, `ctxweb_${uid}.meta.json`);

  const payload = `import json,sys
sys.path.insert(0, sys.argv[1])
try:
    import curl_cffi.requests as r
    resp = r.get(sys.argv[2], impersonate='chrome136', timeout=int(sys.argv[5]))
    body = resp.text
    ct = resp.headers.get('content-type','')
    f=open(sys.argv[3],'w',encoding='utf-8'); f.write(body); f.close()
    meta={'ok': 200 <= resp.status_code < 300, 'status': resp.status_code, 'bytes': len(body.encode('utf-8')), 'content_type': ct, 'body_file': sys.argv[3], 'err': ''}
    f=open(sys.argv[4],'w',encoding='utf-8'); json.dump(meta,f); f.close()
except Exception as e:
    meta={'ok': False, 'status': 0, 'bytes': 0, 'content_type': '', 'body_file': sys.argv[3], 'err': str(e)[:300]}
    f=open(sys.argv[4],'w',encoding='utf-8'); json.dump(meta,f); f.close()
`;
  let spawnRes = null;
  try {
    // python 超时 = 调用方 timeoutMs（秒，下限 5），spawn 余量 +5s——旧版 20s==20s 零余量，慢站被杀在写 meta 前且真死因被"meta missing"掩盖（2026-10-31 外测修复）
    const timeoutSec = Math.max(5, Math.round(timeoutMs / 1000));
    if (impl === spawnSync) {
      // 默认同步 impl → 异步 spawn：spawnSync 阻塞事件循环，并行下桥腿排队串行（自测 2026-10-31 抓到：doctor 50.9s 且每家 +8.5s 线性）
      spawnRes = await _spawnPyAsync(d.py, ['-c', payload, d.pylibs, url, bodyFile, metaFile, String(timeoutSec)], timeoutMs + 5000);
    } else {
      // 外部注入的同步 impl：同样补 PYTHONDONTWRITEBYTECODE（否则照样往 deps/pylibs 写 .pyc）
      spawnRes = impl(d.py, ['-c', payload, d.pylibs, url, bodyFile, metaFile, String(timeoutSec)], {
        stdio: 'ignore',
        timeout: timeoutMs + 5000,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
      });
    }
  } catch (e) {
    // ignore
  }

  let meta = null;
  try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { meta = null; }

  if (!meta) {
    return { ok: false, status, text, bytes: text.length, via: 'bridge', leg: 'tls', enc, contentType: '', body_file: bodyFile, blocked: undefined, diagnosis: 'bridge meta missing or invalid' };
  }

  let bodyText = '';
  const bf = meta.body_file || bodyFile;
  try { bodyText = readFileSync(bf, 'utf8'); } catch { bodyText = ''; }

  const blk2 = bodyText ? classifyBody(bodyText, _extractTitle(bodyText)) : null;
  if (meta.ok && !blk2) {
    return { ok: true, status: meta.status || 200, text: bodyText, bytes: meta.bytes || bodyText.length, via: 'bridge', leg: 'tls', enc: 'utf-8', contentType: meta.content_type || '', byteLen: meta.bytes || bodyText.length, body_file: bf, blocked: undefined, diagnosis: undefined };
  }
  const diagnosis = meta.err ? meta.err.slice(0, 300) : (blk2 || `http ${meta.status}`);
  return {
    ok: false,
    status: meta.status || status,
    text: bodyText || text,
    bytes: meta.bytes || bodyText.length || text.length,
    via: 'bridge',
    leg: 'tls',
    enc: 'utf-8',
    contentType: meta.content_type || '',
    body_file: bf,
    blocked: blk2 || undefined,
    diagnosis,
  };
}
