/**
 * engine/verify/e2e-live.mjs — 端到端真实调用门（模拟宿主，真联网）
 *
 * 与 plugin-load 的区别：plugin-load 只验**形状**（注册得对不对），
 * 本门验**能力**（真调用能不能出东西）。Readme §五 的教训：
 * "门全绿 ≠ 装上去能用，必须真调用一次才知道它是不是空的。"
 *
 * 判什么：
 *   E-1  桩宿主装载后，工具位 `fp` 在位
 *   E-2  `fp({op:"search", query})` 真出条，头行符合老格式（`引擎 · N hit(s) · xms · query`）
 *   E-3  `fp({op:"search", url})` 对**有正文的真页面**能取到正文（不是空壳）
 *   E-4  `fp({op:"fetch", url})` 真落盘，文件存在且字节数对得上
 *   E-5  `fp({op:"doctor"})` 六段齐全，且**标题家数 = 实际点名行数**（07 自洽对账，不硬写数）
 *   E-6  三次真调用之后，卸载干净（桩宿主里工具位归零）
 *
 * 用法：node engine\verify\e2e-live.mjs
 * 注意：本门**要联网**，慢（约 10–20 秒）。门全绿要跑它。
 */

import { existsSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { apply } from '../../platform/plugin.js';
process.env.PYTHONDONTWRITEBYTECODE = '1';  // 04 片：开发期门不许在源码树留 __pycache__（见 ssrf-gate.mjs 顶注完整版）


const checks = [];
const add = (id, what, ok, detail) => checks.push({ id, what, ok, detail: detail ?? '' });

function makeHost() {
    const registered = new Map();
    const disposers = [];
    const logs = [];
    const skills = [];
    const skillEntries = [];
    const ctx = {
        logger: {
            info: (m) => logs.push(`info ${m}`),
            warn: (m) => logs.push(`warn ${m}`),
            debug: () => {},
            error: (m) => logs.push(`error ${m}`),
        },
        get(service, strict) {
            if (service === 'tools') {
                return {
                    register(def) {
                        registered.set(def.name, def);
                        return () => registered.delete(def.name);
                    },
                };
            }
            if (service === 'systemPrompt') return { section: () => () => {} };
            if (service === 'skills') {
                return {
                    register(entry) {
                        // ★★ 2026-11-21（P0）：桩宿主**复刻宿主校验**，不再只 push 名字。
                        //   宿主 `@deepseek-ai/dsh-skill` 的 `register()` 阶段
                        //   `validateRuntimeSkill()` 只查 name/description/invocation，
                        //   **不查 source** ⇒ 少 `source` 的注册对象照样"注册成功"，
                        //   但 `get()` 阶段 `validateDefinition()` 会抛
                        //   `loaded skill "fp" source must be a string` ⇒ 模型读不到正文。
                        //   旧桩宿主（只 push(name)）让这条路径**恒绿（假绿）**。
                        //   这里按宿主 `SkillRegistration` 的真实要求校验必填字段。
                        if (typeof entry?.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) {
                            throw new Error(`invalid skill name "${entry?.name}"`);
                        }
                        if (typeof entry?.description !== 'string' || entry.description.length === 0) {
                            throw new Error(`skill "${entry?.name}" requires a description`);
                        }
                        if (typeof entry?.content !== 'string') {
                            throw new Error(`loaded skill "${entry?.name}" content must be a string`);
                        }
                        if (typeof entry?.source !== 'string') {
                            throw new TypeError(`loaded skill "${entry?.name}" source must be a string`);
                        }
                        if (typeof entry?.provider !== 'string') {
                            throw new TypeError(`loaded skill "${entry?.name}" provider must be a string`);
                        }
                        if (entry?.path !== undefined && typeof entry.path !== 'string') {
                            throw new TypeError(`loaded skill "${entry?.name}" path must be a string`);
                        }
                        skills.push(entry.name);
                        skillEntries.push(entry);
                        return () => {};
                    },
                };
            }
            if (strict) throw new Error(`桩宿主没有服务 ${service}`);
            return undefined;
        },
        effect(fn) {
            const d = fn();
            if (typeof d === 'function') disposers.push(d);
        },
    };
    return { ctx, registered, disposers, logs, skills, skillEntries };
}

const host = makeHost();
await apply(host.ctx, { enabled: true });
const def = host.registered.get('fp');
add('E-1', '桩宿主装载后 fp 工具在位', Boolean(def));

if (!def) {
    finish();
}

const call = async (args) => {
    const r = await def.execute(args, {});
    return String(r?.text ?? r);
};

// ---------------------------------------------------------------- E-2 搜索
let searchText = '';
try { searchText = await call({ op: 'search', query: 'DeepSeek', engines: ['bing'], limit: 3 }); }
catch (e) { searchText = `ERR ${e?.code} ${e?.message}`; }
const headOk = /^bing · \d+ hit\(s\) · \d+ms · DeepSeek/.test(searchText);
add('E-2', 'search{query} 真出条且头行 = 老格式', headOk && /\n\[1\]/.test(searchText), searchText.split('\n')[0]?.slice(0, 80));

// ---------------------------------------------------------------- E-3 取正文
let pageText = '';
try { pageText = await call({ op: 'search', url: 'https://www.python.org/about/' }); }
catch (e) { pageText = `ERR ${e?.code} ${String(e?.message).slice(0, 120)}`; }
const pageOk = /chars of text/.test(pageText) && pageText.length > 500;
add('E-3', 'search{url} 对有正文的页面能取到正文', pageOk,
    pageOk ? pageText.split('\n')[0]?.slice(0, 90) : pageText.split('\n')[0]?.slice(0, 90));

// ---------------------------------------------------------------- E-4 取原件
let fetchText = '';
try { fetchText = await call({ op: 'fetch', url: 'https://www.python.org/static/img/python-logo.png' }); }
catch (e) { fetchText = `ERR ${e?.code} ${String(e?.message).slice(0, 120)}`; }
const savedPath = (fetchText.match(/saved: (.+)/) ?? [])[1]?.trim();
const declared = Number((fetchText.match(/fetch · (\d+) bytes/) ?? [])[1] ?? -1);
let fetchOk = false;
let fetchDetail = fetchText.split('\n')[0]?.slice(0, 90);
if (savedPath && existsSync(savedPath)) {
    const real = statSync(savedPath).size;
    fetchOk = real === declared && real > 1000;
    fetchDetail = `${real}B 落盘，报告=${declared}B`;
}
add('E-4', 'fetch 真落盘且字节数一致（PNG）', fetchOk, `${fetchDetail}${savedPath ? ` → ${savedPath}` : ''}`);

// ---------------------------------------------------------------- E-5 doctor
let docText = '';
try { docText = await call({ op: 'doctor' }); }
catch (e) { docText = `ERR ${e?.code} ${e?.message}`; }
// ★ 07-P1：E-5 判据从"硬写 23"改为**自洽对账**——[6] 段标题数量 = 实际点名行数。
//   比原判据更强：口径漂一个就红（原 23 恒红是把真话写死成假话；纯 17 写死也只是换个数，
//   对账才让"承诺数 = 兑现数"永远成立）。段名匹配同步改动态（doctor 标题已改运行时数）。
const segs = ['[1] 装配', '[2] 路径编码', '[3] 桥', '[4] 五腿', '[5] 落点', /\[6\] \d+ 家/];
const segOk = segs.every((s) => (s instanceof RegExp ? s.test(docText) : docText.includes(s)));
const engineRows = (docText.match(/^\s+(OK|EMPTY|FAIL)\s+\w+/gm) ?? []).length;
const claimedRows = Number((docText.match(/引擎数 (\d+)/) ?? [])[1] ?? -1);
add('E-5', 'doctor 六段齐全且逐家点名（标题数=行数对账）', segOk && engineRows === claimedRows && engineRows > 0,
    `段=${segOk} 标题=${claimedRows} 行=${engineRows}`);

// ---------------------------------------------------------------- E-8 fetch 反扒原始字节腿真调用（04 片）
// legs:"always" 强制走扛P raw 路：交付必须有 via: fp-raw + 字节是真 PNG 魔数
//（证明没被 decode 过——文本路会把二进制解码成乱码，03 项目实测的根因账）。
let rawText = '';
try { rawText = await call({ op: 'fetch', url: 'https://www.python.org/static/img/python-logo.png', legs: 'always' }); }
catch (e) { rawText = `ERR ${e?.code} ${String(e?.message).slice(0, 160)}`; }
{
    const rawSaved = (rawText.match(/saved: (.+)/) ?? [])[1]?.trim();
    const rawDeclared = Number((rawText.match(/fetch · (\d+) bytes/) ?? [])[1] ?? -1);
    let rawOk = false;
    let rawDetail = rawText.split('\n')[0]?.slice(0, 90);
    if (rawSaved && existsSync(rawSaved)) {
        const real = statSync(rawSaved).size;
        const head = readFileSync(rawSaved).subarray(0, 8).toString('hex');
        rawOk = real === rawDeclared && real > 1000 && head.startsWith('89504e47') && /via: fp-raw/.test(rawText);
        rawDetail = `${real}B 魔数=${head.slice(0, 8)} declared=${rawDeclared} viaRaw=${/via: fp-raw/.test(rawText)}`;
        try { unlinkSync(rawSaved); } catch { /* 留给清扫 */ }
    }
    add('E-8', 'fetch legs:"always" 走反扒原始字节腿且字节未解码', rawOk, `${rawDetail}${/ERR/.test(rawText) ? ` | ${rawText.slice(0, 120)}` : ''}`);
    // ------------------------------------------------ E-9（06-P1）：交付汇总带用时/均速 + 进度小文件零残留
    //   递增采样实录在 06 开发日志 L-005（37 采样/10 变化点）；本断言只锁**可重跑的持久形状**：
    //   ① via 行必含 `· Ns · N KB/s`；② 完成即删 ⇒ `<dest>.fpdl.json` 不许残留。
    const speedOk = /· \d+(?:\.\d+)?s · \d+ KB\/s/.test(rawText);
    let residue = '';
    try {
        const m = rawText.match(/saved: (.+)/);
        if (m && existsSync(m[1] + '.fpdl.json')) residue = m[1] + '.fpdl.json';
    } catch { /* 无 saved 行 ⇒ 下面 speedOk 也悬 */ }
    add('E-9', 'fetch(raw) 交付带用时/均速且进度小文件无残留', speedOk && residue === '', `speed=${speedOk} residue=${residue || '无'}`);
}

// ---------------------------------------------------------------- E-6 卸载干净
for (const d of host.disposers) { try { d(); } catch { /* 卸载期不抛 */ } }
add('E-6', '卸载后工具位归零', host.registered.size === 0, `remaining=${host.registered.size}`);
// ★ 2026-11-21（P0）：E-7 不只看"名字在不在"，还要看**注册对象能不能过宿主加载期校验**
//   （`source`/`provider`/`content`/`path` 必填）。桩宿主 register 已按宿主契约校验，
//   少字段会在这里直接抛 ⇒ 本项不再可能假绿。
const fpSkill = host.skillEntries.find((e) => e.name === 'fp');
const skillShapeOk = Boolean(fpSkill)
    && typeof fpSkill.source === 'string' && fpSkill.source.length > 0
    && typeof fpSkill.provider === 'string' && fpSkill.provider.length > 0
    && typeof fpSkill.content === 'string' && fpSkill.content.length > 0
    && typeof fpSkill.path === 'string' && fpSkill.path.length > 0
    && fpSkill.invocation?.modelInvocable === true
    && fpSkill.invocation?.userInvocable === true;
add('E-7', '捆绑技能已装载且注册对象满足宿主加载期契约', host.skills.includes('fp') && skillShapeOk,
    `skills=[${host.skills.join(',')}] shape=${skillShapeOk} source=${fpSkill?.source ?? '(无)'} path=${fpSkill?.path ? '有' : '(无)'}`);

finish();

function finish() {
    const green = checks.every((c) => c.ok);
    const lines = ['FP e2e-live（端到端真调用 · 联网）', ''];
    for (const c of checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(4)} ${c.what}${c.detail ? `  — ${c.detail}` : ''}`);
    const warns = host.logs.filter((l) => l.startsWith('warn'));
    if (warns.length) {
        lines.push('', '宿主 warn 日志：');
        for (const w of warns) lines.push(`  ${w}`);
    }
    lines.push('', green ? 'ALL GREEN ✅' : 'RED ❌');
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(green ? 0 : 1);
}
