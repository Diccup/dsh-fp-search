/**
 * engine/verify/ssrf-gate.mjs — SSRF 门（立项书 R5）
 *
 * 判什么：
 *   S1  私网 / 环回 / 链路本地 / IPv6 环回 / file: 直接拒（入口闸）
 *   S2  **302 跳内网也要拒**：这是 `redirect:'follow'` 时代能绕过去的那条路
 *       （`模块关联表` §一-1，CTX 三堆 §13.3 前置① / §14.6 B-12）
 *   S3  正常公网 URL 仍然能取（闸不能把能力也拦掉）
 *   S4  落盘的是**原始字节**、长度与 Content-Length 相符（`模块关联表` §一-2）
 *   S5  落点清扫只删自家 `fp_` 前缀，别人的文件一个不动
 *  ★ 04 片（2026-11-19，fetch 接反扒原始字节腿）新增：
 *   S6  **JS↔python 判据对账**：同一语料双跑，python 侧绝不许比 JS 侧松
 *       （更严允许、记白名单）——降级路的 SSRF 与主路同强度，无新增绕过（Readme §六-9）
 *   S7a legs:"always" 也必须先过 JS 入口闸（legs 参数管不到闸）
 *   S7b 302 跳内网在 **python 降级路**里同样被拒（每跳过闸），且不留半成品文件
 *
 * 怎么做 302：**本机起一个桩服务**。但本机 127.0.0.1 会被入口闸先拦掉，
 *   所以这里换个办法 —— 用 `fetch` 的 `redirect` 语义直接测"跳转目标过不过闸"：
 *   调用 `blocks/03-fetch` 内部导出的能力不可行（那是私有实现），
 *   于是本门**直接复刻同一条决策链**：桩服务当作"公网起点"不可得，
 *   改为**注入式验证** —— 把 `globalThis.fetch` 换成一个假的，
 *   第 1 跳返回 302 指向内网，看 `fetchToDisk` 会不会拒。
 *   这样测的正是**被测代码**，不是本门自己写的复制品。
 *
 * 用法：node engine\verify\ssrf-gate.mjs
 */

import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PathToFileUrl } from './_url.mjs';

/**
 * ★ 04 片（主人 2026-11-19 指出）：**开发期跑门，绝不在源码树里留 `__pycache__`**。
 * 这类残渣不在 Temp，"清 Temp"碰不到它（实测曾在 `work\fp\support\` 与 `deps\pylibs\*\__pycache__\` 长出）。
 * 写在入口、靠环境变量向所有子进程（含门再 spawn 的 python）传播；生产运行路不受影响
 * （装机槽里由真实调用产生的 pyc 是**性能缓存**，属设计内，不归本条管）。
 */
process.env.PYTHONDONTWRITEBYTECODE = '1';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = resolve(HERE, '..', '..');

const checks = [];
const add = (id, what, ok, detail) => checks.push({ id, what, ok, detail: detail ?? '' });

const { fetchToDisk, sweep } = await import(PathToFileUrl(join(PKG, 'engine', 'blocks', '03-fetch', 'index.js')));
const ctx = { pkgRoot: PKG };

// ★ 发布版可移植化（2026-11-21 检查轮修复）：原先写死 'F:\workspace\LongMem\Temp\fp-ssrf-gate'
//   ⇒ 别人机器上没有 F 盘 ⇒ 这道门直接崩。改走系统临时目录（跨平台，永不写死盘符）。
const TMP = join(tmpdir(), 'fp-ssrf-gate');

// ---------------------------------------------------------------- S1 入口闸
const bad = [
    ['127.0.0.1', 'http://127.0.0.1/x'],
    ['localhost', 'http://localhost:8080/x'],
    ['169.254 metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['10.x 私网', 'http://10.1.2.3/x'],
    ['192.168 私网', 'http://192.168.1.1/x'],
    ['172.16 私网', 'http://172.16.0.1/x'],
    ['IPv6 环回', 'http://[::1]/x'],
    ['file:', 'file:///C:/Windows/win.ini'],
];
const leaks = [];
for (const [label, u] of bad) {
    try { await fetchToDisk(ctx, { url: u, outDir: TMP }); leaks.push(label); }
    catch (e) {
        if (!/URL_BLOCKED/.test(String(e?.code ?? ''))) leaks.push(`${label}(错码:${e?.code})`);
    }
}
add('S-1', '入口闸拦住 8 类私网/环回/metadata/file', leaks.length === 0, leaks.join(',') || '8/8 全拦');

// ---------------------------------------------------------------- S2 302 跳内网
// 注入假 fetch：第 1 跳（公网起点）返回 302，Location 指向内网。
const realFetch = globalThis.fetch;
let hopLog = [];
function installFakeFetch() {
    globalThis.fetch = async (url, opts) => {
        hopLog.push(String(url));
        const s = String(url);
        if (s.startsWith('https://public-stub.example/')) {
            return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } });
        }
        return new Response('should-not-reach', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
}
function restoreFetch() { globalThis.fetch = realFetch; }

// 注意：public-stub.example 是公网形态（不在私网名单里），所以入口闸会放行，
// 真正的考验是**第 2 跳的 127.0.0.1** 会不会被拦。
installFakeFetch();
let redirectVerdict = '';
try {
    await fetchToDisk(ctx, { url: 'https://public-stub.example/start', outDir: TMP });
    redirectVerdict = 'LEAK（跳内网竟然成功）';
}
catch (e) {
    redirectVerdict = `${e?.code ?? '?'}`;
}
finally { restoreFetch(); }
add('S-2', '302 跳内网被拒（每跳重过闸）', /URL_BLOCKED/.test(redirectVerdict),
    `verdict=${redirectVerdict} hops=${hopLog.length}${hopLog.length > 1 ? '（确实跟了一跳）' : ''}`);

// ---------------------------------------------------------------- S3 正常公网仍可取（用真网络，选中性站点）
mkdirSync(TMP, { recursive: true });
let okText = '';
try {
    okText = await fetchToDisk(ctx, { url: 'https://example.com', outDir: TMP });
}
catch (e) {
    okText = `ERR ${e?.code} ${e?.message}`;
}
add('S-3', '正常公网 URL 仍可取（闸不误伤能力）', /^fetch · \d+ bytes · 200/.test(okText), okText.split('\n')[0]?.slice(0, 90));

// ---------------------------------------------------------------- S4 原始字节
const m = okText.match(/fetch · (\d+) bytes/);
const savedPath = (okText.match(/saved: (.+)/) ?? [])[1]?.trim();
let byteOk = false;
let byteDetail = '';
if (m && savedPath && existsSync(savedPath)) {
    const size = statSync(savedPath).size;
    byteOk = Number(m[1]) === size;
    byteDetail = `报告=${m[1]}B 实际=${size}B`;
}
add('S-4', '落盘字节数与报告一致（不是字符数）', byteOk, byteDetail || '拿不到落盘文件');

// ---------------------------------------------------------------- S5 清扫只删自家
mkdirSync(TMP, { recursive: true });
writeFileSync(join(TMP, 'someone-else-important.txt'), 'do not delete me');
writeFileSync(join(TMP, 'fp_old_should_stay.txt'), 'recent fp file');
const before = readdirSync(TMP).length;
sweep(TMP);
const after = readdirSync(TMP);
const keptForeign = after.includes('someone-else-important.txt');
add('S-5', '清扫只动自家 fp_ 前缀，别人的文件不动', keptForeign, `before=${before} after=${after.length} foreign_kept=${keptForeign}`);

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

// ---------------------------------------------------------------- S6 判据对账（04 片）
// 同一语料双跑：JS assertSafeUrl ↔ python rawdl.assert_safe_url。
// 判据：JS=BLOCK 且 py=PASS 必须 = 0 条（更松 = 降级路绕过 SSRF，红线⑨直接红）；
// py 更严允许，但必须落白名单点名 —— 白名单外的新增"更严"也红（防判据悄悄漂移）。
{
    // [URL, JS侧期望是否应拦]
    const CORPUS = [
        ['http://127.0.0.1/x', true], ['http://localhost:8080/x', true],
        ['http://169.254.169.254/latest/meta-data/', true], ['http://10.1.2.3/x', true],
        ['http://192.168.1.1/x', true], ['http://172.16.0.1/x', true], ['http://[::1]/x', true],
        ['file:///C:/Windows/win.ini', true], ['http://0.0.0.0/', true],
        ['http://100.64.0.1/', true], ['http://198.18.0.1/', true],
        ['http://foo.internal/', true], ['http://wpad/', true], ['http://x.home.arpa/', true],
        ['ftp://example.com/f', true], ['http://user:[email protected]/', true],
        ['http://127.1/', true], ['http://2130706433/', true], ['http://0x7f.0.0.1/', true],
        ['http://169.254.1/', true],
        // 172.27777 展开 = 172.0.108.161（第二段 0 ⇒ 公网）：两边同向放，期望 false。
        // 首跑我把它写成 true，被"JS判据漂移"当场抓出 —— 这条漂移检查正是为这种自以为是留的。
        ['http://172.27777/', false],
        ['http://[fd00::1]/', true], ['http://[fe80::1]/', true],
        ['https://example.com/x', false], ['http://8.8.8.8/', false], ['http://172.15.0.1/', false],
        ['http://100.128.0.1/', false], ['https://EXAMPLE.COM/a', false],
        ['http://example.com:80/p', false], ['http://EXAMPLE.COM/A', false], ['http://[2001:db8::1]/', false],
        ['x', true], ['http://256.1.1.1/', true],
        // ★ 07-P2：hex 映射族入语料（04 时代的洞：WHATWG 把点分映射形规范成 hex，旧点分正则看不见）。
        // 旧白名单把 `::ffff:127.0.0.1` 记成 "py 更严 OK" —— **门的白名单当时就把洞登记在案却无人当洞**（L-008 教训）。
        ['http://[::ffff:127.0.0.1]/', true], ['http://[::ffff:7f00:1]/', true],
        ['http://[::ffff:169.254.169.254]/', true], ['http://[::ffff:a9fe:a9fe]/', true],
        ['http://[0:0:0:0:0:ffff:7f00:1]/', true], ['http://[::7f00:1]/', true],
        ['http://[::ffff:c0a8:1]/', true], ['http://[::ffff:8.8.8.8]/', false],
    ];
    // py 更严白名单（实测账 04 开发日志 L-006：JS 放、py 拒 = 方向安全，逐条点名留底）
    // ★ 07-P2：`::ffff:127.0.0.1` 从白名单**移除**——JS 修成字节级后两侧同拒，"更严"账目归零；
    //   留着它 = 允许 JS 哪天悄悄退回放行（洞复活而门绿）。
    const STRICTER_OK = new Set(['http://[ff00::1]/']);
    mkdirSync(TMP, { recursive: true });
    const urls = CORPUS.map(([u]) => u);
    writeFileSync(join(TMP, 's6-corpus.json'), JSON.stringify(urls), 'utf8');
    writeFileSync(join(TMP, 's6_probe.py'), [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(join(PKG, 'fp'))})`,
        'from support import rawdl',
        'corpus = json.load(open(sys.argv[1], encoding="utf-8"))',
        'res = []',
        'for u in corpus:',
        '    try:',
        '        rawdl.assert_safe_url(u); res.append([u, "PASS"])',
        '    except rawdl.UrlBlocked:',
        '        res.append([u, "BLOCK"])',
        '    except Exception as e:',
        '        res.append([u, "ERR", type(e).__name__])',
        'json.dump(res, open(sys.argv[2], "w", encoding="utf-8"))',  // ★ 全走文件（L-013：受限态管道不可靠）
    ].join('\n'), 'utf8');
    const pyFind = await import(pathToFileURL(join(PKG, 'ours', 'python-find.js')).href);
    const py = pyFind.findPython();
    const rawdlPath = join(PKG, 'fp', 'support', 'rawdl.py');
    const s6Result = join(TMP, 's6-py-out.json');
    let pyOut = null;
    let s6detail = '';
    if (py && existsSync(rawdlPath)) {
        try { unlinkSync(s6Result); } catch { /* 首次没有 */ }
        // ★ PYTHONDONTWRITEBYTECODE：本探针 import support.rawdl ⇒ 默认会在**源码树**里写
        //   `fp/support/__pycache__/rawdl.cpython-312.pyc`（主人 2026-11-19 指出的那类垃圾：
        //   跑门/探针造的残渣不在 Temp，散在工作树，"清 Temp"根本碰不到它）。
        //   门只读判据不读缓存 ⇒ 关掉写字节码零副作用，源码树保持干净（04 开发日志 L-029）。
        const r = spawnSync(py, [join(TMP, 's6_probe.py'), join(TMP, 's6-corpus.json'), s6Result],
            { stdio: 'ignore', windowsHide: true, timeout: 30000,
              env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
        try { pyOut = JSON.parse(readFileSync(s6Result, 'utf8')); }
        catch { s6detail = `py 结果文件不可读 exit=${r.status} signal=${r.signal ?? 'none'}`; }
    } else {
        s6detail = `前提缺件：py=${py} rawdl=${existsSync(rawdlPath)}`;
    }
    if (Array.isArray(pyOut) && pyOut.length === urls.length) {
        const guard = await import(pathToFileURL(join(PKG, 'ours', 'libs', 'url-guard.js')).href);
        const looser = [];
        const drift = [];
        const stricterNew = [];
        for (let i = 0; i < urls.length; i += 1) {
            const u = urls[i];
            let jsVerdict = 'BLOCK';
            try { guard.assertSafeUrl(u); jsVerdict = 'PASS'; } catch { /* BLOCK */ }
            const pyVerdict = pyOut[i][1] === 'PASS' ? 'PASS' : 'BLOCK';
            if (jsVerdict === 'BLOCK' && pyVerdict === 'PASS') looser.push(u);
            if (jsVerdict === 'PASS' && pyVerdict === 'BLOCK' && !STRICTER_OK.has(u)) stricterNew.push(u);
            if ((jsVerdict === 'BLOCK') !== CORPUS[i][1]) drift.push(`${u}(JS判据漂移)`);
        }
        add('S-6', 'JS↔python 判据对账（py更松=0 / JS漂移=0 / 新增更严=0）',
            looser.length === 0 && drift.length === 0 && stricterNew.length === 0,
            [...looser.map((x) => `py更松:${x}`), ...drift, ...stricterNew.map((x) => `新增更严:${x}`)].join(', ') || `${urls.length} 条全对账`);
    } else {
        add('S-6', 'JS↔python 判据对账（py更松=0 / JS漂移=0 / 新增更严=0）', false, s6detail || 'python 对账无结果');
    }
}

// ---------------------------------------------------------------- S7 降级路的闸（04 片）
// 用假 fp-bridge 断言两条铁律：入口闸先于桥、桥回包的内网终 URL 必须被 JS 复核拒。
{
    const fpbPath = join(PKG, 'ours', 'fp-bridge.js');
    mkdirSync(TMP, { recursive: true });
    const fpbBackup = join(TMP, 'fp-bridge.orig');
    if (existsSync(fpbPath)) {
        writeFileSync(fpbBackup, readFileSync(fpbPath));
        // 假桥：trap-302 ⇒ "成功"但 finalUrl 指内网；其它 URL 被叫到 ⇒ 记 FAKE-CALLED
        writeFileSync(fpbPath, [
            'export async function fpFetchRaw(url) {',
            '  if (String(url).includes(\'trap-302\')) {',
            '    return { ok: true, leg: \'http\', size: 5, finalUrl: \'http://127.0.0.1:9/secret\', contentType: \'text/plain\', status: 200, hops: [String(url), \'http://127.0.0.1:9/secret\'] };',
            '  }',
            '  return { ok: false, blocked: true, reason: \'FAKE-CALLED\' };',
            '}',
            'export function fpStatus() { return { py: \'fake\', fp: \'fake\' }; }',
        ].join('\n'), 'utf8');
        let s7a = '';
        let s7b = '';
        try {
            // S7a：legs:'always' 不许绕过入口闸 —— 私网直链必须在**叫桥之前**被拒
            try {
                await fetchToDisk(ctx, { url: 'http://127.0.0.1/x', outDir: TMP, legs: 'always' });
                s7a = 'LEAK（竟然成功）';
            } catch (e) {
                const called = /FAKE-CALLED/.test(String(e?.message || ''));
                s7a = /URL_BLOCKED/.test(String(e?.code ?? ''))
                    ? (called ? 'LEAK-ORDER（闸拒但桥先被叫）' : 'REFUSED-BEFORE-BRIDGE')
                    : `错码:${e?.code}`;
            }
            add('S-7a', 'legs:"always" 入口闸先于桥（桥没被叫）', s7a === 'REFUSED-BEFORE-BRIDGE', s7a);

            // S7b：桥"成功"回包但 final_url 指内网 ⇒ JS 复核必须拒；落点不许新增残留
            const before = new Set(readdirSync(TMP));
            try {
                await fetchToDisk(ctx, { url: 'https://public-stub.example/trap-302', outDir: TMP, legs: 'always' });
                s7b = 'LEAK（内网终 URL 竟然交付）';
            } catch (e) {
                s7b = /复核拒绝|拒收/.test(String(e?.message || '')) ? 'REFUSED-FINAL' : `错码:${e?.code} ${String(e?.message || '').slice(0, 50)}`;
            }
            const added = readdirSync(TMP).filter((n) => n.startsWith('fp_') && !before.has(n));
            add('S-7b', '降级路 final_url 指内网被 JS 复核拒 + 无残留', s7b === 'REFUSED-FINAL' && added.length === 0,
                `${s7b} 新增残留=${added.length ? added.join(',') : '0'}`);
        } finally {
            writeFileSync(fpbPath, readFileSync(fpbBackup));
            unlinkSync(fpbBackup);
        }
    } else {
        add('S-7a', 'legs:"always" 入口闸先于桥', false, 'fp-bridge.js 不在位');
        add('S-7b', '降级路 final_url 复核', false, 'fp-bridge.js 不在位');
    }
}

// ---------------------------------------------------------------- 输出
const green = checks.every((c) => c.ok);
const lines = ['FP ssrf-gate（SSRF 闸 + 原始字节 + 清扫）', ''];
for (const c of checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(4)} ${c.what}${c.detail ? `  — ${c.detail}` : ''}`);
lines.push('', green ? 'ALL GREEN ✅' : 'RED ❌');
process.stdout.write(lines.join('\n') + '\n');
process.exit(green ? 0 : 1);
