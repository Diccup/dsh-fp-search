/**
 * blocks/04-doctor/index.js — 运维面块（impl，片 4）
 *
 * 干什么：`doctor` ⇒ **唯一运维面**（主人 2026-11-09 原话 5：可以查询哪些可用、哪些有问题）。
 * 依赖：core / net / fetch。
 *
 * 必须如实报出这六件事，缺件不许静默（立项书 R7 + Readme §五 第 3 道）：
 *   ① 活引擎逐家 OK / EMPTY / FAIL（数量运行时算，标题=行数自洽；07 口径）
 *   ② python 与 curl_cffi 桥是否可达
 *   ③ 五腿能力面：http/waf/tls 沙箱内可用；render/cdp 需 danger-full-access
 *   ④ 默认落点可写 + 盘剩余
 *   ⑤ **包路径是否纯 ASCII**（非 ASCII ⇒ TLS 腿必坏，本仓 2026-11-09 实测，见 L-016）
 *   ⑥ scrapling 缺件如实报（随包 python 没有这个包，CTX 时代就没有，别假装是能力）
 */

import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statfsSync } from 'node:fs';
import { DEFAULT_OUT_DIR, LEGS, LEGS_SANDBOX_OK, LEGS_NEED_DANGER } from '../../contract.mjs';
import { ERR, FpError, assemblyState } from '../01-core/index.js';
import { probeEngines, engineNames } from '../02-net/index.js';

export const meta = {
    name: 'doctor',
    kind: 'impl',
    deps: ['core', 'net'],
};

const PROBE_TIMEOUT_MS = 8000;

/** 检查落点可写 + 盘剩余。 */
function checkOutDir(dir) {
    const out = { dir, writable: false, freeGB: null, error: '' };
    try {
        mkdirSync(dir, { recursive: true });
        const probe = join(dir, `.fp_doctor_${process.pid}.tmp`);
        writeFileSync(probe, 'ok');
        unlinkSync(probe);
        out.writable = true;
    }
    catch (e) {
        out.error = String(e?.message ?? e);
    }
    try {
        // node >=18.15 才有 statfsSync；拿不到就如实报 null，不许编一个数
        if (typeof statfsSync === 'function') {
            const st = statfsSync(dir);
            out.freeGB = Math.round((st.bsize * st.bavail) / (1024 ** 3) * 10) / 10;
        }
    }
    catch { /* 如实留 null */ }
    return out;
}

/** 包路径是否纯 ASCII（非 ASCII ⇒ TLS 腿必坏）。 */
function checkAsciiPath(pkgRoot) {
    const bad = [];
    for (const ch of pkgRoot) {
        if (ch.charCodeAt(0) > 127) bad.push(ch);
    }
    return { ok: bad.length === 0, sample: [...new Set(bad)].slice(0, 5).join('') };
}

/** 桥可达性：找 python + 试 import curl_cffi（走文件，不用管道 —— 沙箱教训 L-013）。 */
async function checkBridge(ctx) {
    const out = { python: null, curl_cffi: false, detail: '' };
    try {
        const { findPython } = await import(pathUrl(join(ctx.pkgRoot, 'ours', 'python-find.js')));
        out.python = findPython?.() ?? null;
    }
    catch (e) {
        out.detail = `python-find 不可用：${String(e?.message ?? e)}`;
        return out;
    }
    if (!out.python) {
        out.detail = '没找到 python（随包运行时缺失）';
        return out;
    }
    const pylibs = join(ctx.pkgRoot, 'deps', 'pylibs');
    if (!existsSync(join(pylibs, 'curl_cffi'))) {
        out.detail = `deps/pylibs/curl_cffi 不存在：${pylibs}`;
        return out;
    }
    try {
        const { spawnSync } = await import('node:child_process');
        const { openSync, closeSync, readFileSync } = await import('node:fs');
        const tmp = join(ctx.pkgRoot, 'deps', `.fp_bridge_probe_${process.pid}.txt`);
        const fd = openSync(tmp, 'w');
        try {
            spawnSync(out.python, ['-c', 'import curl_cffi;print(curl_cffi.__version__)'], {
                stdio: ['ignore', fd, fd],
                // ★ 黑框修复（2026-11-09，主人报「调 doctor 时 CMD 黑框一闪而逝」）：
                //   DSH 是 **GUI 子系统**进程（PE Subsystem=2，实测），随包 python.exe 是
                //   **Console 子系统**（Subsystem=3）。GUI 进程 spawn 控制台程序时，
                //   Windows 必然给它分配一个新控制台 ⇒ 屏幕上闪一个黑框。
                //   `windowsHide:true` 让 Node 在创建进程时带 STARTF_USESHOWWINDOW|SW_HIDE，
                //   子进程照样跑，但初始窗口不可见。
                //   ★ 为什么不用 CREATE_NO_WINDOW：宿主沙箱 README 明写——
                //     受限令牌下 CREATE_NO_WINDOW/CREATE_NEW_CONSOLE 的子进程会在 DLL
                //     初始化阶段死于 STATUS_DLL_INIT_FAILED(0xC0000142)。Node 的
                //     windowsHide 走的是 SW_HIDE 路线（不新建控制台），是宿主认可的做法
                //     （见 @deepseek-ai/dsh-win32-process 与 dsh-subprocess-local）。
                windowsHide: true,
                // ★ 2026-11-21 合并轮：补 `PYTHONDONTWRITEBYTECODE`。
                //   这条探针 `import curl_cffi` ⇒ python 会把 .pyc 写进**随包 deps/pylibs**，
                //   于是「每次调 doctor 就往装机槽里多一批 __pycache__」（实测 21 件）。
                //   后果：① 槽里多出跨机器无用的 .pyc；② 仓根↔槽逐件哈希对拍被搅浑。
                //   门脚本（engine/verify/*.mjs）早有这条，**插件运行路的三处 spawn 漏了**。
                env: {
                    ...process.env,
                    PYTHONPATH: pylibs,
                    PYTHONIOENCODING: 'utf-8',
                    PYTHONUTF8: '1',
                    PYTHONDONTWRITEBYTECODE: '1',
                },
                timeout: 20000,
            });
        }
        finally { closeSync(fd); }
        const txt = (readFileSync(tmp, 'utf8') ?? '').trim();
        try { unlinkSync(tmp); } catch { /* 忽略 */ }
        const m = txt.match(/(\d+\.\d+\.\d+)/);
        out.curl_cffi = Boolean(m) && !/Traceback|ModuleNotFoundError/.test(txt);
        out.detail = out.curl_cffi ? `curl_cffi ${m[1]}` : txt.split('\n').slice(-2).join(' ').slice(0, 160);
    }
    catch (e) {
        out.detail = String(e?.message ?? e);
    }
    return out;
}

function pathUrl(p) {
    return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

/** 主入口：产出一份人/模型都能读的体检报告。 */
export async function run(ctx) {
    const lines = [];
    lines.push('doctor · FP 体检');

    // ① 装配态
    const state = assemblyState(ctx.pkgRoot, existsSync, join);
    lines.push('');
    lines.push('[1] 装配');
    lines.push(`    ours      ${state.ours ? 'OK' : 'MISSING'}`);
    lines.push(`    fp        ${state.fp ? 'OK' : 'MISSING'}`);
    lines.push(`    pylibs    ${state.pylibs ? 'OK' : 'MISSING'}`);
    lines.push(`    包根      ${ctx.pkgRoot}`);

    // ② 路径 ASCII（TLS 腿的前提）
    const ascii = checkAsciiPath(ctx.pkgRoot);
    lines.push('');
    lines.push('[2] 路径编码（TLS 腿前提）');
    lines.push(ascii.ok
        ? '    路径纯 ASCII ✅（TLS 腿可用）'
        : `    ⚠ 路径含非 ASCII 字符「${ascii.sample}」⇒ **TLS 腿会坏**（libcurl 打不开非 ASCII 路径上的 cacert.pem，curl 77）；http/waf 腿不受影响`);

    // ③ 桥
    const bridge = await checkBridge(ctx);
    lines.push('');
    lines.push('[3] 桥（python + curl_cffi）');
    lines.push(`    python    ${bridge.python ?? 'NOT FOUND'}`);
    lines.push(`    curl_cffi ${bridge.curl_cffi ? 'OK' : 'FAIL'}  ${bridge.detail ? `— ${bridge.detail}` : ''}`.trimEnd());

    // ④ 五腿能力面
    lines.push('');
    lines.push('[4] 五腿能力面');
    for (const leg of LEGS) {
        if (LEGS_SANDBOX_OK.includes(leg)) lines.push(`    ${leg.padEnd(7)} 沙箱内可用`);
        else if (LEGS_NEED_DANGER.includes(leg)) lines.push(`    ${leg.padEnd(7)} 可用，但需本次调用授权 danger-full-access`);
    }
    // ★ ITERATION-005：原来这里只写"需 danger-full-access（…被沙箱拒，0x5）"，
    //   读起来像"这腿是坏的/不存在"。**它不是不可用，是默认沙箱不放行。**
    //   实测（2026-11-21）：给 danger-full-access 后 render 腿在 python.org/about
    //   上 ok:true、正文 43,265 字符；cdp 腿能启动并取到真正文。
    //   能力自述必须说清"怎么才能用"，否则接手的新模型会把"要申请"误读成"没有"。
    lines.push('    说明      以上 render/cdp 两条腿**能正常工作**，唯一前提是本次工具调用带');
    lines.push('              sandbox_permissions=danger-full-access（宿主要求主人审批，插件子进程');
    lines.push('              无法自我升权）。默认沙箱下它们会失败并降级到 http/waf/tls，');
    lines.push('              这是沙箱边界，不是能力缺失——需要渲染时申请授权即可，别当它不存在。');
    lines.push('    scrapling  缺件（随包 python 无此包，如实报，不假装是能力）');

    // ⑤ 落点 + 盘余
    const out = checkOutDir(DEFAULT_OUT_DIR);
    lines.push('');
    lines.push('[5] 落点');
    lines.push(`    ${out.dir}`);
    lines.push(`    可写      ${out.writable ? 'OK' : `FAIL — ${out.error}`}`);
    lines.push(`    盘剩余    ${out.freeGB === null ? '（拿不到，如实留空）' : `${out.freeGB} GB`}`);

    // ⑥ 活引擎逐家（07-P1：口径改诚实——标题数量 = 运行时真数，不再硬写 23；6 张未接线卡在册不计数）
    lines.push('');
    try {
        const names = await engineNames(ctx);
        lines.push(`[6] ${names.length} 家引擎逐家探测（各发一次固定 query）`);
        lines.push(`    引擎数 ${names.length}：${names.join(' ')}`);
        const t0 = Date.now();
        const report = await probeEngines(ctx, { timeoutMs: PROBE_TIMEOUT_MS });
        const ms = Date.now() - t0;
        for (const row of String(report).split('\n')) lines.push(`    ${row}`);
        lines.push(`    合计 ${ms}ms`);
    }
    catch (e) {
        if (e instanceof FpError && e.code === ERR.NOT_ASSEMBLED) {
            lines.push(`    跳过：${e.message}`);
            lines.push(`    修复：${e.hint ?? '跑 assemble.mjs'}`);
        }
        else {
            lines.push(`    FAIL — ${String(e?.message ?? e)}`);
        }
    }

    return lines.join('\n');
}

export function init() { /* 无状态 */ }
