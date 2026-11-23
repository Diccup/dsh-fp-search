/**
 * ws-cool.js — lane D · 引擎冷却表（片 5 · A-1）
 *
 * ⚠️ 2026-11-21 检查轮标注：**本文件当前未接线（全线 0 引用，是死代码）**。
 *   02 片建了它，但聚合层（`web-search.js` / `ws-transport.js`）**从没调用**
 *   `shouldCool`/`recordFailure`/`isCooling` ⇒ 冷却表永远为空、行为零变化。
 *   本体保留它（不删：接线时的判据与边界写得很全，删了要重写），
 *   但**任何"冷却已生效"的说法目前都不成立**。接线属新功能，不在修缺陷范围内。
 *
 * 干什么：某家引擎连续失败（429 / 412 / 5xx / 超时）之后，**在一段时间内不再向它发请求**，
 *   `run()` 直接抛 `cooling`，由聚合层按既有语义 `catch → []` 吃掉。
 *
 * 为什么必须做（三堆 §11.3 A-1 由可选升必需的证据）：
 *   · N-⑤ 实测：baidu 一旦进风控，**每次查询照发一次网络请求**，55–250 ms 白烧，直到自然恢复；
 *   · 合并稿 §1.3 实测：一次 429 = 555 ms 白烧 + 一个 Python 子进程 + 服务端 2 次请求。
 *   现在 22 家并行，一家挂着就是每查一次白烧一次。
 *
 * ★★ 三条边界（三堆 §五【已决·1】原文，不许自己改）：
 *   ① **`page()` 路径不参与**：`web-search.js` 的 engineHint **恒为 `'page'`**，
 *      照原边界会"一次 B 站 412 熔断全站 page() 抓取 30–60 s"。本文件用 `page()` 以外的
 *      命名空间隔离，`page` 这个 key **永不入表**。
 *   ② `ws-media` 的 `'bingimg'` / `'bingvideo'` 同理，**不入表**。
 *   ③ **fp 五段降级不经过这里**：它走 `fp-bridge.js` spawn，`getHtml` 根本不被调用
 *      ⇒ 冷却卡不住五段降级，这是**预期行为**（五段是最后一道，不该被冷却挡）。
 *
 * 为什么不写文件、不进库：
 *   进程内 `Map`，重启清零 = 天然衰减（与 N12 的 `ENGINE_STATS` 同一取舍，
 *   三堆 §11.1-5 三方全签：免掉"统计窗口"这个凭空参数）。
 *
 * 判据（S4）：连续触发 429 后同一家在下一次查询**不再发网络请求**；
 *             `page()` 单发仍走网络。
 *
 * ESM only，零依赖，零绝对路径。
 */

/** 默认退避阶梯（毫秒）：第 1 次 30 s，第 2 次 60 s，第 3 次起封顶 120 s。 */
const BACKOFF_MS = [30_000, 60_000, 120_000];

/** 冷却表：engineId → { until:number, strikes:number, code:string, at:number } */
const TABLE = new Map();

/** 永不入表的 key（边界 ①②）。 */
const EXEMPT = new Set(['page', 'bingimg', 'bingvideo']);

/**
 * 这些状态码算"该冷却"。
 * 412 纳入、与 429 共用退避 —— 三堆 §五【已决·1】（412 判失败 + 触发桥腿 + 白烧，
 * 且 §1.3 实测一次 412 = 555 ms 白烧）。5xx 同理。**不删卡**，只冷却。
 */
const COOL_CODES = new Set([408, 412, 429, 500, 502, 503, 504]);

/**
 * 判一个失败该不该触发冷却。
 * @param {number|string} statusOrCode
 * @returns {boolean}
 */
export function shouldCool(statusOrCode) {
    const n = typeof statusOrCode === 'number' ? statusOrCode : Number(statusOrCode);
    return Number.isFinite(n) && COOL_CODES.has(n);
}

/**
 * 记录一次失败。只有 {@link shouldCool} 认的码才真入表。
 *
 * @param {string} engineId
 * @param {number|string} statusOrCode
 * @param {number} [now]
 * @returns {boolean} 是否真的进了冷却
 */
export function recordFailure(engineId, statusOrCode, now = Date.now()) {
    if (typeof engineId !== 'string' || engineId === '') return false;
    if (EXEMPT.has(engineId)) return false;          // ★ 边界 ①：page() 等永不入表
    if (!shouldCool(statusOrCode)) return false;

    const prev = TABLE.get(engineId);
    const strikes = (prev?.strikes ?? 0) + 1;
    const ms = BACKOFF_MS[Math.min(strikes - 1, BACKOFF_MS.length - 1)];
    TABLE.set(engineId, { until: now + ms, strikes, code: String(statusOrCode), at: now });
    return true;
}

/**
 * 一次成功 ⇒ 清掉该家的冷却与计数（"自然恢复"由成功证明，不靠计时器猜）。
 * @param {string} engineId
 */
export function recordSuccess(engineId) {
    if (typeof engineId !== 'string' || engineId === '') return;
    TABLE.delete(engineId);
}

/**
 * 现在是否处于冷却期。
 * @param {string} engineId
 * @param {number} [now]
 * @returns {{cooling:boolean, remainMs:number, strikes:number, code:string}}
 */
export function coolingState(engineId, now = Date.now()) {
    const rec = TABLE.get(engineId);
    if (!rec) return { cooling: false, remainMs: 0, strikes: 0, code: '' };
    const remainMs = rec.until - now;
    if (remainMs <= 0) {
        // 到期自动出表（但 strikes 保留？——不保留：到期即视为"给它一次机会"，
        // 若再失败 strikes 从 1 重新开始，避免一次风控把人家永久钉在高档退避）
        TABLE.delete(engineId);
        return { cooling: false, remainMs: 0, strikes: 0, code: '' };
    }
    return { cooling: true, remainMs, strikes: rec.strikes, code: rec.code };
}

/** 便捷判定：只需要布尔时用它。 */
export function isCooling(engineId, now = Date.now()) {
    return coolingState(engineId, now).cooling;
}

/** 快照（doctor / 门用；返回纯数据，外部改动不影响内部）。 */
export function coolingSnapshot(now = Date.now()) {
    const out = [];
    for (const [id, rec] of TABLE.entries()) {
        out.push({ engine: id, remainMs: Math.max(0, rec.until - now), strikes: rec.strikes, code: rec.code, at: rec.at });
    }
    return out;
}

/** 测试/回归用：清空（★ N12 同一条红线：回归前必须复位，否则测的是"历史恰好是什么"）。 */
export function resetCooling() {
    TABLE.clear();
}

/** 供门断言：EXEMPT 清单本身也要可验（防止有人偷偷把 page 放进去/拿出去）。 */
export const __exempt = Object.freeze([...EXEMPT]);
