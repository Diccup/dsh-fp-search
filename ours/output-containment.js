/**
 * Post-execute output containment for DSH.
 *
 * The Bash routing guard stops most context-flooding commands before they run,
 * but a model can still reach one through a path the guard allows, or through
 * another tool entirely. This listener is the second line of defense: when a
 * result is oversized it keeps the head and tail, writes the full text to a
 * spill file, and tells the model how to read it back.
 *
 * The listener is cooperative: it never throws, accepts every result it does
 * not need to change, and only shrinks content larger than the configured cap.
 *
 * ★ 2026-11-03：**删掉 text-guard 这条耦合。**
 *   原先这里还会改写 "vendored server 推荐了未挂载工具" 的提示串
 *   （ctx_batch_execute / ctx_fetch_and_index）。1.0.0 里：
 *     · vendor/ 只剩 LICENSE（server.bundle 已删，没有东西再发这些串）；
 *     · 那三个工具名在 1.0.0 的工具面里**一个都不存在**，
 *       GUARDED_TOOLS.has(exec.name) 永远为 false；
 *     · 守卫的四条源字符串在整包代码里 grep 全无匹配。
 *   也就是它守的是一个已经不存在的宿主行为 —— 空转。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Default cap before a result is spilled: ~40 KB of model-facing text. */
const DEFAULT_MAX_RESULT_BYTES = 40_000;
/** Characters kept from the head of an oversized result. */
const HEAD_CHARS = 6_000;
/** Characters kept from the tail of an oversized result. */
const TAIL_CHARS = 2_000;
/** Per-listener spill budget; the oldest files are pruned past this count. */
const MAX_SPILL_FILES = 20;
const spilled = [];
/**
 * Install the post-execute containment listener.
 *
 * @param ctx - the plugin context whose event bus carries tool dispatch.
 * @param options - optional byte cap and spill directory.
 * @returns the exact disposer that removes the listener.
 */
export function installOutputContainment(ctx, options = {}) {
    const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    const spillDir = options.spillDir ?? join(tmpdir(), 'dsh-eco-context-spill');
    return ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next();
        if (decision.kind !== 'accept')
            return decision;
        const source = 'content' in decision && decision.content !== undefined
            ? decision.content
            : result.content;
        const original = textFromBlocks(source);
        const text = original;
        if (text === undefined || Buffer.byteLength(text, 'utf8') <= maxResultBytes)
            return decision;
        const record = spill(text, spillDir, exec);
        const replacement = [{ type: 'text', text: summarize(text, record, maxResultBytes) }];
        return { kind: 'accept', content: replacement, additionalContexts: decision.additionalContexts };
    });
}
/** Concatenate text blocks, or return undefined when the result is not plain text. */
function textFromBlocks(content) {
    const parts = [];
    for (const block of content) {
        if (block.type !== 'text' || typeof block.text !== 'string')
            return undefined;
        parts.push(block.text);
    }
    return parts.length === 0 ? undefined : parts.join('\n');
}
/** Persist one oversized payload and return its locator. */
function spill(text, spillDir, exec) {
    const path = join(spillDir, `${sanitize(exec.name)}-${Date.now().toString(36)}.txt`);
    const bytes = Buffer.byteLength(text, 'utf8');
    try {
        mkdirSync(spillDir, { recursive: true });
        writeFileSync(path, text, 'utf8');
        spilled.push({ path, bytes });
        while (spilled.length > MAX_SPILL_FILES)
            spilled.shift();
        return { path, bytes };
    }
    catch {
        // A missing spill directory must not fail the tool call; the caller gets a
        // truncated result without a locator.
        return { path: '', bytes };
    }
}
/** Build the model-facing replacement: head, tail, and a read-back instruction. */
function summarize(text, record, maxResultBytes) {
    const head = text.slice(0, HEAD_CHARS);
    const tail = text.slice(-TAIL_CHARS);
    const omitted = text.length - head.length - tail.length;
    const lines = [
        `[dsh-eco-context] Output was ${record.bytes} bytes (limit ${maxResultBytes}); ${omitted} characters omitted from the middle.`,
    ];
    if (record.path.length > 0) {
        lines.push(`Full output saved to ${record.path}.`);
        // 2026-11-04：旧文案引导模型调 ctx_execute_file / ctx_index / ctx_search ——
        //   这三个名字在 1.0.0 工具面上都不存在，照做只会每次白报错。换成 op 形状。
        lines.push('Analyze it with ctx({op:"run", language:"javascript", code:…}) reading that path, or ctx({op:"index", path:"…"}) then ctx({op:"recall", queries:[…]}) — do not cat it back into the conversation.');
    }
    else {
        lines.push('Use ctx({op:"run"}) next time so the raw output never enters the conversation.');
    }
    lines.push('', '--- head ---', head, '', '--- tail ---', tail);
    return lines.join('\n');
}
/** Keep a tool name safe for a filename. */
function sanitize(name) {
    return name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'tool';
}
/** Test-only: expose recorded spills for assertions. */
export function __spillRecordsForTests() {
    return spilled;
}
