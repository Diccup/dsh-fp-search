/**
 * platform/skill-set.js — 捆绑技能装载（FP 自己的）
 *
 * 干什么：把 `skills/<name>/SKILL.md` 装进宿主的技能服务。
 * 依赖：宿主 `ctx.get('skills')`（拿不到就返回空数组，只 warn 不抛）。
 *
 * ★ 纪律：技能目录名必须与 op / 工具面的说法一致 —— 目录指向不存在的东西 = 撒谎。
 *   门 G-2 会验 `KNOWN_OPS`，本文件不另维护名单。
 *
 * ★★ 2026-11-21 修（P0 · 宿主加载必失败）：
 *   宿主 `@deepseek-ai/dsh-skill` 的 `SkillRegistration` = `SkillDefinition` 去
 *   `invocation`/`provider`，**`source` 是必填字段**。而 `register()` 阶段的
 *   `validateRuntimeSkill()` **不查 source**（只查 name/description/invocation）
 *   ⇒ 只少 `source` 时**注册照样成功**（插件日志会记 `skills=1`），
 *   但 `get()` 阶段的 `validateDefinition()` 会抛：
 *       TypeError: loaded skill "fp" source must be a string
 *   ⇒ **模型永远读不到 SKILL.md 正文**。
 *   门为什么没抓到：`e2e-live` 的桩宿主 `skills.register` 只 `push(entry.name)`，
 *   **不跑宿主校验** ⇒ E-7 恒绿（假绿）。
 *
 *   修法（形状照同机 `dsh-eco-context/platform/skill-set.js`）：
 *   注册对象必须带齐 `source` / `path` / `invocation` 三个字段。
 *   —— `source: 'bundled'`（与文件系统 provider 的语义一致：本技能随包捆绑）。
 *   —— `path`：技能的指令文件绝对路径（宿主用它做资源基址与展示）。
 *   —— `invocation`：显式给 `{ modelInvocable: true, userInvocable: true }`，
 *      不靠宿主默认值（默认值的语义以后可能变，显式更稳）。
 *
 *   ★ 另注：`provider` 用插件名 `'dsh-fp-search'`（runtime 技能不走 provider 归属
 *     校验，那道校验只作用于 `registerProvider` 提供的候选）。同机 CTX 插件同款写法。
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 每个捆绑技能的目录描述（宿主用它做路由说明）。
 *
 * ★ 为什么手写而不用"从 SKILL.md 里抓第一行"：抓第一行的做法在 FP 的
 *   SKILL.md 上会抓到引用块（`> 插件名 …`），换个排版就变，属于脆口径。
 *   手写 + 抓取兜底，两头都不吃亏。
 */
const DESCRIPTIONS = Object.freeze({
    fp: 'FP 网页能力插件：网页搜索 / 取正文 / 取原件 / 自检。工具位 fp，三个 op：search / fetch / doctor。'
        + '查资料用 search；把一个网页的正文取下来用 search 的 url 形态；下载文件（PDF/图片/压缩包）用 fetch；'
        + '不知道哪家引擎能用、环境有没有问题用 doctor。',
});

/**
 * @param {{ctx:object, skillsDir:string, logger:object, provider?:string}} p
 * @returns {Array<() => void>} disposers
 */
export function installBundledSkills({ ctx, skillsDir, logger, provider = 'dsh-fp-search' }) {
    const skills = ctx.get('skills', false);
    if (skills === undefined) {
        logger?.warn?.('dsh-fp-search: skills service unavailable; bundled skills not installed');
        return [];
    }
    if (!existsSync(skillsDir)) return [];

    const disposers = [];
    for (const entry of readdirSync(skillsDir)) {
        const dir = join(skillsDir, entry);
        let st;
        try { st = statSync(dir); } catch { continue; }
        if (!st.isDirectory()) continue;
        const file = join(dir, 'SKILL.md');
        if (!existsSync(file)) continue;
        try {
            const body = readFileSync(file, 'utf8');
            const title = (body.match(/^#\s+(.+)$/m) ?? [])[1]?.trim() ?? entry;
            const description = DESCRIPTIONS[entry]
                ?? body.split('\n').find((l) => l.trim() !== '' && !l.startsWith('#'))?.trim()
                ?? '';
            const dispose = skills.register({
                name: entry,
                title,
                description,
                content: body,
                // ★★★ 宿主契约必填三件（缺任一 ⇒ 注册过、加载炸）：
                source: 'bundled',
                path: file,
                invocation: { modelInvocable: true, userInvocable: true },
                provider,
            });
            if (typeof dispose === 'function') disposers.push(dispose);
        }
        catch (e) {
            logger?.warn?.(`dsh-fp-search: skill "${entry}" skipped (${String(e?.message ?? e)})`);
        }
    }
    return disposers;
}
