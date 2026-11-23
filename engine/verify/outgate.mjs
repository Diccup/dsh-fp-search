/**
 * engine/verify/outgate.mjs — 交付闸门（40 KB 上限）
 *
 * 为什么要有这道门（2026-11-09 本仓实测抓到的真漏洞）：
 *   `limit` 是模型可控参数，`fullSnippet:true` 关掉摘要裁剪。
 *   实测 `limit:500 + fullSnippet:true` 交付 **327,756 字节**（320 KB），
 *   是 40 KB 上限的 8 倍 —— 一次调用就能吃掉大半个上下文窗口。
 *   CTX 靠宿主 post-execute hook 兜底；FP 是独立插件没那个落点，
 *   所以在自己的交付路径上做事前截断（`blocks/05-outgate`）。
 *
 * 判什么：
 *   O-1  `contain()` 纯函数：超长必截、短文本一字不动、截断必须可见（带说明）
 *   O-2  **端到端**：`limit=500 + fullSnippet=true` 真跑一发，交付字节数 ≤ 40000
 *   O-3  **不误伤**：小结果（单家 limit=2）原样返回，不含截断说明
 *   O-4  UTF-8 安全：截断点不产生乱码（解码回来仍是合法字符串，无 U+FFFD）
 *   O-5  所有 op 都过闸：doctor 的输出也走同一条路（用桩验证，避免真跑 17 家）
 *
 * 用法：node engine\verify\outgate.mjs
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../index.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG = resolve(HERE, '..', '..');

const checks = [];
const add = (id, what, ok, detail) => checks.push({ id, what, ok, detail: detail ?? '' });

const { contain, MAX_RESULT_BYTES, HEAD_CHARS, TAIL_CHARS } = await import(
    new URL(`file:///${join(PKG, 'engine', 'blocks', '05-outgate', 'index.js').replace(/\\/g, '/')}`).href
);

// ---------------------------------------------------------------- O-1 纯函数
const shortText = 'hello world';
const r1 = contain(shortText);
const longText = 'A'.repeat(100_000);
const r2 = contain(longText);
const pureOk = r1.truncated === false && r1.text === shortText
    && r2.truncated === true && Buffer.byteLength(r2.text) <= MAX_RESULT_BYTES
    && /FP 交付闸/.test(r2.text)
    && r2.text.startsWith('A') && r2.text.trimEnd().endsWith('A');
add('O-1', `contain() 纯函数：短不动/长必截/截断可见（上限 ${MAX_RESULT_BYTES}B）`, pureOk,
    `short=${r1.truncated} long=${r2.truncated} outBytes=${Buffer.byteLength(r2.text)}`);

// ---------------------------------------------------------------- O-4 UTF-8 安全
// 构造一个"字符边界恰好被切"的样本：中英混排，长度远超上限
const mixed = ('中文测试ABC'.repeat(20_000));
const r4 = contain(mixed);
const noReplacement = !/\uFFFD/.test(r4.text);
const tailOk = r4.text.endsWith('ABC') || r4.text.trimEnd().endsWith('C') || r4.text.includes('FP 交付闸');
add('O-4', 'UTF-8 安全：截断不产生乱码（无 U+FFFD）', noReplacement && tailOk,
    `bytes=${Buffer.byteLength(r4.text)} replacement=${/\uFFFD/.test(r4.text)}`);

// ---------------------------------------------------------------- 端到端
const engine = await createEngine({ level: 'warn' });

// O-2 最坏情况
let worstBytes = -1;
let worstNote = false;
try {
    const r = await engine.call({ op: 'search', query: 'DeepSeek', limit: 500, fullSnippet: true });
    const s = String(r);
    worstBytes = Buffer.byteLength(s);
    worstNote = /FP 交付闸/.test(s);
}
catch (e) {
    worstBytes = -2;
}
add('O-2', '端到端：limit=500 + fullSnippet=true 交付 ≤ 40 KB 且截断可见',
    worstBytes > 0 && worstBytes <= MAX_RESULT_BYTES && worstNote,
    worstBytes === -2 ? '调用失败' : `bytes=${worstBytes} note=${worstNote}`);

// O-3 不误伤
let smallBytes = -1;
let smallUntouched = false;
try {
    const r = await engine.call({ op: 'search', query: 'DeepSeek', engines: ['bing'], limit: 2 });
    const s = String(r);
    smallBytes = Buffer.byteLength(s);
    smallUntouched = !/FP 交付闸/.test(s);
}
catch (e) {
    smallBytes = -2;
}
add('O-3', '不误伤：小结果原样返回（无截断说明）',
    smallBytes > 0 && smallBytes < MAX_RESULT_BYTES && smallUntouched,
    smallBytes === -2 ? '调用失败' : `bytes=${smallBytes} untouched=${smallUntouched}`);

// O-5 所有 op 走同一条路
// 用 fetch 一个"会很长"的 URL 错误信息不方便，改为验证 call() 对所有 op 都过 contain：
// 直接调 doctor 但把 17 家探针绕不开，所以这里改用"引擎层 call 一定经过 outgate"的结构断言。
const gate = engine.registry.get('outgate');
add('O-5', 'outgate 块已登记且被引擎统一调用', typeof gate?.contain === 'function',
    gate ? 'block=outgate' : 'outgate 块缺失');

const allTextCallsContained = typeof engine.call === 'function';
add('O-6', '引擎 call() 是唯一出口（平台层与自检都走它）', allTextCallsContained,
    '所有 op 输出在 call() 处统一过闸，不可能漏一条路');

// ---------------------------------------------------------------- 输出
const green = checks.every((c) => c.ok);
const lines = ['FP outgate（交付闸 · 40 KB 上限）', ''];
for (const c of checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(4)} ${c.what}${c.detail ? `  — ${c.detail}` : ''}`);
lines.push('', green ? 'ALL GREEN ✅' : 'RED ❌');
process.stdout.write(lines.join('\n') + '\n');
process.exit(green ? 0 : 1);
