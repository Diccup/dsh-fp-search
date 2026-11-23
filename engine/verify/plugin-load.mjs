/**
 * engine/verify/plugin-load.mjs — 平台层装载门（用桩宿主，不需要真 DSH）
 *
 * 判什么：
 *   P-1  `apply()` 能在桩宿主上跑完，不抛
 *   P-2  恰好注册 1 个工具，名字 = fp
 *   P-3  工具定义的 parameters 是**真 JSON Schema**，`op` 在 required 里
 *        （★ 这道专门防 CTX 踩过的坑：交扁平表 ⇒ 宿主只看到 3 个假键 ⇒ 参数全不露）
 *   P-4  参数的 properties 里，contract.EXPECTED_PARAMS 的并集**一个不少**
 *   P-5  真调一发 `{op:"search", query:"x"}` ⇒ 得到可读的"尚未接线"错误（片 0 的诚实态）
 *   P-6  真调 `{}` ⇒ 如实报"未收到 op"错（06 改：旧行为回 op 表 = 伪装成功，废除）
 *   P-7  卸载（disposer）能把工具撤干净
 *
 * 为什么要有这道：Readme §五 的教训"门全绿 ≠ 装上去能用"。
 *   自检绿只证明引擎自洽；**宿主注册面的形状**必须单独验，否则装到 DSH 里
 *   可能是"工具在、参数全空"的静默降级。
 *
 * 用法：node engine\verify\plugin-load.mjs
 */

import { apply, toolDescription } from '../../platform/plugin.js';
import { EXPECTED_PARAMS } from '../contract.mjs';

const checks = [];
const add = (id, what, ok, detail) => checks.push({ id, what, ok, detail: detail ?? '' });

/** 搭一个最小桩宿主：只有 tools / systemPrompt / logger / effect。 */
function makeHost() {
    const registered = new Map();
    const disposers = [];
    const logs = [];
    const ctx = {
        logger: {
            info: (m) => logs.push(`info ${m}`),
            warn: (m) => logs.push(`warn ${m}`),
            debug: (m) => logs.push(`debug ${m}`),
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
            if (service === 'systemPrompt') {
                return { section: () => () => {} };
            }
            if (strict) throw new Error(`桩宿主没有服务 ${service}`);
            return undefined;
        },
        effect(fn) {
            const d = fn();
            if (typeof d === 'function') disposers.push(d);
        },
    };
    return { ctx, registered, disposers, logs };
}

// ---------------------------------------------------------------- 跑装载
const host = makeHost();
let applyError = null;
try {
    await apply(host.ctx, { enabled: true });
}
catch (e) {
    applyError = String(e?.message ?? e);
}
add('P-1', 'apply() 在桩宿主上不抛', applyError === null, applyError ?? 'ok');

// ---------------------------------------------------------------- P-2 一个工具位
add('P-2', '注册 1 个工具且名为 fp', host.registered.size === 1 && host.registered.has('fp'), `registered=[${[...host.registered.keys()]}]`);

const def = host.registered.get('fp');

// ---------------------------------------------------------------- P-3 参数是真 JSON Schema
const params = def?.parameters;
const schemaOk = params && params.type === 'object' && params.properties && typeof params.properties === 'object'
    && Array.isArray(params.required) && params.required.includes('op')
    && Object.keys(params.properties).length > 3;   // 3 个假键（type/properties/required）是扁平表误传的特征
add('P-3', 'parameters 是真 JSON Schema 且 op 在 required', Boolean(schemaOk),
    params ? `keys=[${Object.keys(params)}] props=${Object.keys(params.properties ?? {}).length} required=[${params.required}]` : 'missing');

// ---------------------------------------------------------------- P-4 参数一个不少
const want = new Set(Object.values(EXPECTED_PARAMS).flat());
const got = new Set(Object.keys(params?.properties ?? {}));
const missing = [...want].filter((n) => !got.has(n));
add('P-4', 'EXPECTED_PARAMS 并集全部出现在 properties 里', missing.length === 0, missing.length ? `缺 ${missing}` : `共 ${got.size} 个参数`);

// ---------------------------------------------------------------- P-5 真调一发（能力诚实）
// 片 0 期：此断言查"尚未接线"（IMPL_STATE=stub）。
// 片 1–4 接线后：改为查**真的能出结果**；失败可以，但**不许是参数白名单拒**——
//   因为从平台层进来的调用不该带多余键，带了就是运行时上下文混进 args（L-012 那个真 bug）。
//   —— 同批改动见 模块关联表 §五-24 与 2-开发日志 L-018。
let callOutcome = '';
let callOk = false;
try {
    const r = await def.execute({ op: 'search', query: 'deepseek', engines: ['bing'], limit: 1 }, {});
    const text = String(r?.text ?? r);
    callOk = /hit\(s\)|search ·/.test(text);
    callOutcome = `成功：${text.split('\n')[0]?.slice(0, 70)}`;
}
catch (e) {
    const code = e?.code ?? '';
    const msg = String(e?.message ?? e);
    // 关键区分：组装期/装配态错误可接受（如实报），**参数白名单拒不可接受**（那是调用链自己带脏键）
    const whitelistReject = code === 'FP_BAD_ARGS' && /不认识的参数/.test(msg);
    callOk = !whitelistReject && Boolean(code);
    callOutcome = whitelistReject ? `参数白名单拒：${msg.slice(0, 80)}` : `失败但可接受：${code}`;
}
add('P-5', '真调 search 能出结果，且不被参数白名单误拒', callOk, callOutcome);

// ---------------------------------------------------------------- P-6 缺 op 如实报错（06-P2：旧判据"回 op 表"= 伪装成功，废除）
let noOpOutcome = '';
try {
    const r = await def.execute({}, {});
    noOpOutcome = `LEAK-TEXT ${String(r?.text ?? r).slice(0, 60)}`; // 返回了文本 = 老毛病未除，判红
}
catch (e) {
    noOpOutcome = String(e?.message ?? e);
}
add('P-6', '缺 op 如实报错且带收到的键（不再回 op 表）', /未收到有效 op/.test(noOpOutcome), noOpOutcome.slice(0, 100));
// P-6b 反例：给了别的键（模拟上游掉字符）⇒ 错误里必须点名那些键
let leakKeyOutcome = '';
try { await def.execute({ url: 'https://example.invalid/x' }, {}); }
catch (e) { leakKeyOutcome = String(e?.message ?? e); }
add('P-6b', '缺 op 报错回显收到的键（掉字符可诊断）', /url/.test(leakKeyOutcome) && /未收到有效 op/.test(leakKeyOutcome), leakKeyOutcome.slice(0, 100));

// ---------------------------------------------------------------- P-7 卸载干净
for (const d of host.disposers) {
    try { d(); } catch { /* 卸载期不抛 */ }
}
add('P-7', '卸载后工具位撤干净', host.registered.size === 0, `remaining=[${[...host.registered.keys()]}]`);

// ---------------------------------------------------------------- 输出
const green = checks.every((c) => c.ok);
const lines = ['FP plugin-load（桩宿主）', ''];
for (const c of checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(4)} ${c.what}${c.detail ? `  — ${c.detail}` : ''}`);
if (host.logs.some((l) => /warn/.test(l))) {
    lines.push('', '宿主日志（warn 级）：');
    for (const l of host.logs.filter((x) => /warn/.test(x))) lines.push(`  ${l}`);
}
lines.push('', green ? 'ALL GREEN ✅' : 'RED ❌');
process.stdout.write(lines.join('\n') + '\n');
process.exit(green ? 0 : 1);
