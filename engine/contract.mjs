/*
 * ============================================================================
 * 本文件由 AI 辅助生成（AI-generated / AI-assisted）。
 *
 * 免责声明：
 *   本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
 *   使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
 *   请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。
 *   完整声明见仓库根目录的 DISCLAIMER.md。
 * ============================================================================
 */
/**
 * engine/contract.mjs — FP 的能力契约（**唯一真源**）
 *
 * 为什么单独一个文件：
 *   CTX 净身那轮的真事故 = "op 清单散在 5 个地方，删一个 op 要改 5 处，漏一处就
 *   教模型去调一个不存在的 op"。FP 从第一天起只准有**一份**硬编码清单，
 *   其余全部由它派生或与它对拍（立项书 §2.5）。
 *
 * 三个使用方，同源同批改（改这里一处，另外两处自动跟上）：
 *   ① `engine/blocks/14-tools` 按 OPS 逐个注册 op；
 *   ② `engine/index.mjs --selftest` 用 OPS.length 作 opCount 断言；
 *   ③ `engine/verify/tool-surface.mjs` 拿 OPS 对拍运行时注册面。
 *
 * ★ 红线（立项书 §2.5 / Readme §五）：**不许抄 CTX 的 37 件 / 12 块 / 14 op**。
 *   下面每个数字都是 FP 自己的，改它必须有实测依据并落开发日志。
 */

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** 工具位名（宿主工具面里出现的那一个名字）。 */
export const TOOL_NAME = 'fp';

/** 插件包名（package.json 名，装机核对用）。 */
export const PACKAGE_NAME = 'dsh-fp-search';

/**
 * v0 的 op 面 = 三名（维护方 2026-11-09 定：SEARCH + FETCH 并列 v0，DOCTOR 是唯一运维面）。
 * 数组顺序 = 交付文本里 op 表的顺序，也是 docs 里出现的顺序。
 */
export const OPS = Object.freeze([
    Object.freeze({
        op: 'search',
        oneLine: '网页搜索（query）或取正文（url）；22 家活引擎聚合，裸抓失败自动五段降级',
        requires: Object.freeze(['query|url']),
    }),
    Object.freeze({
        op: 'fetch',
        oneLine: '取原件落盘（url → 原始字节；裸抓失败自动降级反扒原始字节腿 http→waf→tls），默认落系统临时目录 dsh-fp-download（outDir 可覆盖）',
        requires: Object.freeze(['url']),
    }),
    Object.freeze({
        op: 'doctor',
        oneLine: '唯一运维面：22 家逐家 OK/EMPTY/FAIL、桥可不可达、五腿能力面、落点可写、盘剩余',
        requires: Object.freeze([]),
    }),
]);

/** op 名单（派生，不许手写第二份）。 */
export const WANT_OPS = Object.freeze(OPS.map((o) => o.op));

/**
 * 每个 op 的**公开参数名**。
 * 门拿它做两件事：① 与平台层 `toDefinition` 编译出的 JSON Schema 逐名对拍；
 * ② 词法门查"描述里提到的参数名是否都真实存在"（防教模型传不存在的键）。
 */
export const EXPECTED_PARAMS = Object.freeze({
    search: Object.freeze(['op', 'query', 'url', 'engines', 'limit', 'media', 'fullSnippet', 'noFpFallback', 'fpLegTimeoutSec']),
    fetch: Object.freeze(['op', 'url', 'outDir', 'maxBytes', 'legs']),
    doctor: Object.freeze(['op']),
});

/** v0 交付文本 = CTX 1.0.0 冻结面完整照搬（维护方 2026-11-09：「先用老格式」）。 */
export const DELIVER_FORMAT = Object.freeze({
    source: 'CTX 1.0.0 frozen surface',
    headSearchSingle: (engine, n, ms, q) => `${engine} · ${n} hit(s) · ${ms}ms · ${q}`,
    headSearchAggregate: (n, ms, q, engines) => `search · ${n} hit(s) · ${ms}ms · ${q} · engines: ${engines}`,
    itemTitle: (i, engine, title) => `[${i}] (${engine}) ${title}`,
    itemUrl: (url) => `    ${url}`,
    itemSnippet: (s) => `    ${s}`,
});

/**
 * 默认落点（`outDir` 可覆盖）。
 *
 * ★ 发布版可移植化（2026-11-16）：原先写死 `F:\workspace\LongMem\Temp\FPdownload`。
 *   别人机器上根本没有 F 盘 → 落盘直接失败。现在按优先级解析：
 *     1) 环境变量 `FP_OUT_DIR`（显式指定，最高优先）
 *     2) `os.tmpdir()` 下的 `dsh-fp-download`（系统临时目录，跨平台，永不写死盘符）
 *   两者都拿不到时退回当前工作目录。
 */
export const DEFAULT_OUT_DIR = (() => {
    const fromEnv = String(process.env.FP_OUT_DIR ?? '').trim();
    if (fromEnv !== '') return fromEnv;
    try {
        return join(tmpdir(), 'dsh-fp-download');
    }
    catch {
        return resolve(process.cwd(), 'dsh-fp-download');
    }
})();

/** 五腿，顺序即降级顺序（与 `fp/support/orchestrator.py:28` 的 LEGS 一致）。 */
export const LEGS = Object.freeze(['http', 'waf', 'tls', 'render', 'cdp']);

/** 沙箱内可用的腿 / 需要 danger-full-access 的腿（2026-11-09 两窗实测，见 2-开发日志 L-004 / L-008）。 */
export const LEGS_SANDBOX_OK = Object.freeze(['http', 'waf', 'tls']);
export const LEGS_NEED_DANGER = Object.freeze(['render', 'cdp']);
