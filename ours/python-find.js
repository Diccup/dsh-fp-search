// python-find · 随包 python 的发现（ours/fp-bridge.js 与 ours/ws-transport.js 共用）
//
// ★ 为什么要有这一件（R11，2026-11-04 测试汇总）：
//   原来两个文件各自实现了一遍 `findPython()`，判据是"从 process.execPath 向上找
//   名为 dependencies 的目录"。这个判据在**托管 node 单独跑**时成立，但在 DSH 里
//   **进程内加载**时不成立 —— 那时 `process.execPath` 是 Electron 宿主的 exe
//   （`F:\Ds harness\...`），从它向上走一辈子也走不到 `~\.dsh\dsh-runtimes\`。
//   实测后果：`fpStatus()` 回 `py=null`，op:search 的 url 抓取全线退化成
//   `fp unavailable: py=null fp=null`，而随包 python 明明就在
//   `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`
//   好好地装着（v3.12.14，实测可跑）。
//
//   修法 = 保留原探针（托管 node 直跑仍走它），再补三条真实存在的落点：
//     ① execPath 向上找 `dependencies`（原判据，保留）
//     ② execPath 向上找 `dependencies/node/bin` 再回退到同级 `../python`（node 在 bin 子目录里）
//     ③ `%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\python\python.exe`（DSH 运行时目录，真机主路径）
//     ④ PATH 上的 python（最后的兜底）
//   边界：只做**发现**，不验版本、不探依赖 —— 能不能用由调用方的 _probe 决定。

import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

/** 一个候选路径能不能当真 python 用（文件存在即可）。 */
function ok(p) {
  return typeof p === 'string' && p.length > 0 && existsSync(p);
}

/** python.exe 在当前平台的候选文件名（POSIX 只认 python3/python）。 */
function pythonNames() {
  return process.platform === 'win32' ? ['python.exe'] : ['python3', 'python'];
}

/** 从 start 逐级向上，最多 depth 层，找满足 pick(dir) 的候选。 */
function walkUp(start, depth, pick) {
  let cur = start;
  for (let i = 0; i < depth; i++) {
    const hit = pick(cur);
    if (hit) return hit;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** ① + ②：从 execPath 向上找 dependencies（含 node 在 bin 子目录里的形态）。 */
function fromExecPath() {
  const base = dirname(process.execPath); // 托管 node: …\dependencies\node\bin
  return walkUp(base, 12, (dir) => {
    // ① dir 本身就是 dependencies
    if (basename(dir) === 'dependencies') {
      for (const n of pythonNames()) {
        const cand = join(dir, 'python', n);
        if (ok(cand)) return cand;
      }
    }
    // ② dir 是 dependencies\node\bin —— 回退两级到 dependencies
    const twoUp = dirname(dirname(dir));
    if (basename(twoUp) === 'dependencies') {
      for (const n of pythonNames()) {
        const cand = join(twoUp, 'python', n);
        if (ok(cand)) return cand;
      }
    }
    return null;
  });
}

/** ③ DSH 运行时目录：%USERPROFILE%\.dsh\dsh-runtimes\<任意>\dependencies\python\python.exe */
function fromDshRuntimes() {
  const root = join(homedir(), '.dsh', 'dsh-runtimes');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null; // 没有这个目录 = 不是 DSH 环境，正常
  }
  // primary 优先，其余按名字排（保证同一台机器上结果稳定、可复现）
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => (a.includes('primary') === b.includes('primary') ? a.localeCompare(b) : (a.includes('primary') ? -1 : 1)));
  for (const name of dirs) {
    for (const n of pythonNames()) {
      const cand = join(root, name, 'dependencies', 'python', n);
      if (ok(cand)) return cand;
    }
  }
  return null;
}

/** ④ PATH 上的 python（最后兜底；不 spawn，只看 PATH 里的目录有没有这个文件）。 */
function fromPath() {
  const dirs = String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    for (const n of pythonNames()) {
      const cand = join(dir, n);
      if (ok(cand)) return cand;
    }
  }
  return null;
}

let _cached;
let _cachedKey = null;

/**
 * 找随包/本机的 python。结果按"环境指纹"缓存：PATH 或 execPath 变了就重找。
 * @returns {string|null} python 可执行文件绝对路径
 */
export function findPython() {
  const env = process.env.DSH_FP_PYTHON;
  if (ok(env)) return env; // 显式指路优先，且不缓存（维护方可能中途改）
  const key = String(process.env.PATH ?? '') + '|' + process.execPath;
  if (_cached && _cachedKey === key) return _cached;
  _cached = fromExecPath() ?? fromDshRuntimes() ?? fromPath() ?? null;
  _cachedKey = key;
  return _cached;
}

/** 清缓存（selftest / 改过 DSH_FP_PYTHON 之后用）。 */
export function resetPythonCache() {
  _cached = undefined;
  _cachedKey = null;
}
