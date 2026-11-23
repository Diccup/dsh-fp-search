/**
 * blocks/05-outgate/index.js — 交付闸块（crosscut，40 KB 上限）
 *
 * 为什么必须存在（2026-11-09 本仓实测抓到的真漏洞）：
 *   `limit` 是模型可控参数，`fullSnippet:true` 关掉摘要裁剪 ⇒
 *   实测 `limit:500 + fullSnippet:true` 交付文本达 **320,174 字符 / 327,756 字节**（320 KB），
 *   是 40 KB 上限的 8 倍。一次调用就能把上下文窗口吃掉一大截。
 *
 *   CTX 那套是 `ours/output-containment.js` 挂在宿主的 **post-execute hook** 上，
 *   是"事后缩小"；FP 没有那个 hook 的落点（独立插件，平台层拿不到）。
 *   所以这里做**事前截断**：在自己的交付路径上就压到上限内，不让超长文本离开插件。
 *
 * 判据（照 `output-containment.js` 的成例）：
 *   · 上限 `MAX_RESULT_BYTES = 40_000`（模型可见文本的字节数，UTF-8）
 *   · 超了：保留头 `HEAD_CHARS = 6_000` + 尾 `TAIL_CHARS = 2_000`
 *   · 中间插一行说明：截了多少、怎么看全量
 *   · **截断必须可见**（不许静默），且要告诉模型怎么拿全量（缩小 limit）
 *
 * 依赖：core
 */

export const meta = {
    name: 'outgate',
    kind: 'crosscut',
    deps: ['core'],
};

/** 交付文本上限（模型可见字节数）。与 CTX `output-containment.js` 同值。 */
export const MAX_RESULT_BYTES = 40_000;
/** 保留的头/尾字符数。 */
export const HEAD_CHARS = 6_000;
export const TAIL_CHARS = 2_000;

/**
 * 把交付文本压到上限内。
 * @param {string} text 原始交付文本
 * @param {{maxBytes?:number, hint?:string}} [opts]
 * @returns {{text:string, truncated:boolean, originalBytes:number}}
 */
export function contain(text, opts = {}) {
    const s = String(text ?? '');
    const maxBytes = opts.maxBytes ?? MAX_RESULT_BYTES;
    const originalBytes = Buffer.byteLength(s, 'utf8');
    if (originalBytes <= maxBytes) {
        return { text: s, truncated: false, originalBytes };
    }

    // 按 UTF-8 安全切：head 与 tail 都取字符，中间截断点不拆代理对
    const head = s.slice(0, HEAD_CHARS);
    const tail = s.slice(Math.max(HEAD_CHARS, s.length - TAIL_CHARS));
    const dropped = s.length - head.length - tail.length;
    const note = [
        '',
        `… [FP 交付闸] 输出过长已截断：原文 ${originalBytes} 字节 / ${s.length} 字符，`
        + `此处保留头 ${HEAD_CHARS} 字符 + 尾 ${TAIL_CHARS} 字符，省略中间 ${dropped} 字符。`,
        opts.hint ?? '要更少内容：把 limit 调小；要全量：分批看（例如 limit:20 多次取）。',
        '',
    ].join('\n');

    let out = head + note + tail;
    // 极端情况：头尾+说明仍超（说明本身很长不会发生，但兜一层）
    if (Buffer.byteLength(out, 'utf8') > maxBytes) {
        out = out.slice(0, Math.floor(maxBytes / 4));
    }
    return { text: out, truncated: true, originalBytes };
}

export function init() { /* 纯函数，无状态 */ }
