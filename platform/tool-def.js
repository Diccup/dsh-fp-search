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
 * platform/tool-def.js — 工具 → 宿主工具定义的翻译（FP 自己的）
 *
 * ★ 宿主契约（实证来源：CTX 仓 2026-11-06 S9.37 从 app.asar 抽源码核过，
 *   本文件只搬**结论**，不 import CTX 一行）：
 *   宿主有两条注册路，形状要求相反：
 *     ① `ctx.tools.register(defineTool({...}))` —— defineTool 内部把**扁平属性表**
 *        编译成 JSON Schema；
 *     ② `ctx.tools.register(裸对象)` —— **原样保留** definition.parameters，
 *        宿主 schemaOf() 直接投影给模型。
 *   FP 走 ②，所以**必须自己编译**。交扁平表 ⇒ 宿主只读到
 *   `type`/`properties`/`required` 三个假键 ⇒ 工具定义下面显示「（无参数）」，
 *   真参数一个都不露（静默降级，工具照样能调，最难查的那种坏）。
 *
 * 编译规则（照宿主 runSchemaCompiler 的 property-map 分支逐条对齐）：
 *   · 属性的 `required: true` → 收进**根**的 required 数组，节点上不再留这个键；
 *   · `type` 原样保留；`description` / `title` / `default` / `examples` 原样保留；
 *   · `enum` / `const` 原样保留；
 *   · 空表 → `{ type: 'object', properties: {} }`。
 */

/** DSH 工具结果的统一输出 schema。 */
export const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
};

const ANNOTATIONS = ['description', 'title', 'default', 'examples'];

/**
 * 把扁平属性表编译成宿主认的 JSON Schema。
 * @param {Record<string, {type?:string, description?:string, required?:boolean, enum?:unknown[]}>} flat
 */
export function compileParametersToJsonSchema(flat) {
    const properties = {};
    const required = [];
    for (const [key, spec] of Object.entries(flat ?? {})) {
        const node = {};
        for (const k of Object.keys(spec ?? {})) {
            if (k === 'required') continue;
            if (k === 'type' || k === 'enum' || k === 'const' || ANNOTATIONS.includes(k)) node[k] = spec[k];
        }
        if (!node.type) node.type = 'string';
        properties[key] = node;
        if (spec?.required === true) required.push(key);
    }
    const out = { type: 'object', properties };
    if (required.length > 0) out.required = required;
    return out;
}

/**
 * 参数表：**唯一手写处**。参数名的机器可读名单在 `engine/contract.mjs` 的
 * `EXPECTED_PARAMS`，门会把两边逐名对拍（改一处漏一处 ⇒ 门红）。
 *
 * 说明：`op` 一律 required；其余按 op 语义。
 */
export const PARAMS = {
    op: { type: 'string', description: '要调哪个能力：search / fetch / doctor；必填，缺失将如实报错（06 起不再回 op 表）', required: true },
    query: { type: 'string', description: 'search 用：查询词（1~6 个词，优先包名/仓库名/报错码这类标识符），与 url 二选一' },
    url: { type: 'string', description: 'search 的取正文形态，或 fetch 的取原件目标。search 形态与 query 二选一；fetch 必填（除非给了 job 查进度）' },
    engines: { type: 'array', description: 'search 用：只跑这几家引擎（默认全部 22 家活引擎聚合）' },
    limit: { type: 'number', description: 'search 用：交付条数上限' },
    media: { type: 'string', description: 'search 用：image / video，走媒体面' },
    fullSnippet: { type: 'boolean', description: 'search 用：true = 摘要不裁剪（默认裁到 180 字）' },
    noFpFallback: { type: 'boolean', description: 'search 取正文用：true = 关掉五段降级，只跑裸抓' },
    fpLegTimeoutSec: { type: 'number', description: 'search 取正文用：五段里每一腿的超时秒数（默认 5）' },
    outDir: { type: 'string', description: 'fetch 用：落盘目录（默认系统临时目录下的 dsh-fp-download，可用 outDir 覆盖）' },
    maxBytes: { type: 'number', description: 'fetch 用：单个文件字节上限' },
    legs: { type: 'string', description: 'fetch 用：auto（默认，裸抓失败降级反扒腿）/ always（直接走反扒腿）/ off（只用裸抓）' },
    background: { type: 'boolean', description: 'fetch 用：true = 发起后台下载并立即返回 jobId（不阻塞、适合大文件），之后用 job 轮询进度' },
    job: { type: 'string', description: 'fetch 用：给 jobId 查该后台作业的当下进度（字节/百分比/用时/均速/腿）或终态；给了 job 就不需要 url' },
};

/** 只要 PARAMS 里列出的这些键（其余由 describe 决定）。 */
export const PARAM_NAMES = Object.freeze(Object.keys(PARAMS));

/**
 * 翻译成宿主工具定义。
 * @param {{name:string, description:string, params:string[], call:(a:object,signal?:AbortSignal,meta?:object)=>Promise<any>}} tool
 */
export function toDefinition(tool) {
    const flat = {};
    for (const name of tool.params) {
        if (!PARAMS[name]) throw new Error(`toDefinition(${tool.name}): 参数 ${name} 不在 PARAMS 表里`);
        flat[name] = PARAMS[name];
    }
    return {
        name: tool.name,
        description: tool.description,
        parameters: compileParametersToJsonSchema(flat),
        output: {
            schema: OUTPUT_SCHEMA,
            render: (_args, value) => {
                const rec = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
                const text = typeof rec?.text === 'string' ? rec.text : String(value);
                return [{ type: 'text', text }];
            },
        },
        async execute(args, exec) {
            const result = await tool.call(args ?? {}, exec?.signal, exec);
            const text = typeof result === 'string' ? result : String(result?.text ?? '');
            return { text };
        },
        isConcurrencySafe: () => true,
    };
}
