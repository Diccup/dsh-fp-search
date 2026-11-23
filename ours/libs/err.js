/**
 * libs/err.js — 错误文案表 + 统一错误形状（D4/D5）
 *
 * 干什么：引擎里所有"给模型看的失败"都走这里，保证①文案可操作（说清怎么改）
 *        ②同一个错误在块里块外一个名字（E.X），改文案从不碰业务代码。
 * 为什么这样：1.2.2 的错误文案散在 11 个 handler 里，同一个意思三种说法；
 *            工具面折叠成 ctx_run 之后，模型只能看到这一层文案，必须统一。
 * 边界：只管"用户/模型可见文案"，内部断言错误直接 throw Error 不走这里。
 */

/** 错误码 → { code, fix }。fix 是"怎么改"，永远要有。 */
export const E = {
    ONE_OF_INPUT: {
        code: 'ONE_OF_INPUT',
        // ★ R9（2026-11-04 测试汇总 P1-1）：这条 fix 原来写死了 `op:"index"`，
        //   但 ONE_OF_INPUT 是所有"互斥入参"共用的码（run 的 code+commands 也用它），
        //   于是 op:run 报错时会告诉模型"去改 index 的 path/content/url" —— 指错 op。
        //   调用点传 `reason` 时以调用点为准；不传才退回这条通用文案。
        fix: '这几个输入只能给一个：看清楚是哪个 op 的参数（index 是 path/content/url/dir，run 是 code/commands）',
    },
    NO_INPUT: {
        code: 'NO_INPUT',
        // ★ R9：原来是"至少给一个输入：path/content/url" —— 那是 index 的参数表，
        //   而 NO_INPUT 被 9 个 op 共用（run/memory/purge/pin/retention…），
        //   非 index 的调用看到这句话只会去改错参数（报告里"错误文案指向别的 op"就是这条）。
        //   现在默认文案只说"缺必填"，具体缺什么由调用点的 `reason` 给。
        fix: '缺必填参数：按这个 op 自己的要求补（不带 op 调一次 ctx 会返回 14 个 op 的参数表）',
    },
    // ★ 2026-11-06 S9.36 主人二问（"报错应该直接告诉你参数错误，然后提供正确的格式"）：
    //   `commands` 的**形状**错（嵌套数组 / 元素不是字符串）与"缺参"是两回事，必须分开立码。
    //   缺参 → NO_INPUT；形状错 → BAD_BATCH_SHAPE（说清正确格式，别让模型瞎猜）。
    //   2026-11-06 真机踩坑：嵌套数组 [[...]] 当时能进 runBatch，被 String() 拍成 "a,b"，
    //   行为不明确且不报错 —— 模型只能靠撞墙来发现写错了。
    BAD_BATCH_SHAPE: {
        code: 'BAD_BATCH_SHAPE',
        fix: 'commands 要扁平字符串数组：每条一个字符串，如 ["dir", "echo hi"]；不许嵌套数组（[["a","b"]] 会被拍成 "a,b"），也不许传对象',
    },
    UNKNOWN_OP: {
        code: 'UNKNOWN_OP',
        fix: 'ctx 的 op 只认 list 那张表里的 14 个值；不带 op 会返回该表',
    },
    RETENTION_NEEDS_EXPLICIT: {
        code: 'RETENTION_NEEDS_EXPLICIT',
        fix: 'retention/vacuum/purge(project) 会真删数据：确认要删就显式给 dryRun:false',
    },
    // ★ S9.40（2026-11-06 主人令「删整库必须我同意」）：`purge scope:"project"` 是**整库蒸发**。
    //   原来它复用 RETENTION_NEEDS_EXPLICIT —— 那条的 fix 是「确认要删就显式给 dryRun:false」，
    //   对 project 而言是**错的指路**：照着做（补上 dryRun:false）仍然会被挡，
    //   模型只会反复重试。单独立码，把「整库 + 须主人同意」写进第一行。
    //   另：project 的干跑回执原来也是一句干跑文案，模型看不出自己被挡了 ——
    //   现在改成**报错**（工具层直接抛），挡就是挡，不装作"只是报了个数"。
    PURGE_PROJECT_NEEDS_OWNER: {
        code: 'PURGE_PROJECT_NEEDS_OWNER',
        // ★ 第一行不许出现 `dryRun:false` —— 对 project 那是**错的指路**
        //   （照着做仍然被挡，模型只会反复重试）。局部真删的参数名放第二行的 details 里。
        fix: 'purge scope:"project" 会把整个库蒸发（三张表全清、不可撤销）：这条只能主人手动执行，'
            + '不走 op；要删局部用 scope:"session" 或 scope:"source"',
    },
    MEMORY_TOO_BIG: {
        code: 'MEMORY_TOO_BIG',
        fix: '长久库只存总结不存仓库：把内容压到 64KB 以内，整份原文放临时库',
    },
    MEMORY_CATEGORY_INVALID: {
        code: 'MEMORY_CATEGORY_INVALID',
        fix: 'category 用路径制 <主题>/<部分>[/<类型>]，最多 3 段、段内不许空格；下面是现有路径',
    },
    MEMORY_LABEL_PINNED: {
        code: 'MEMORY_LABEL_PINNED',
        fix: '这个 label 已经在长久库：要换内容先 unpin，或换一个 label',
    },
    DENIED_PATH: {
        code: 'DENIED_PATH',
        fix: '路径不在可写围栏内（工作区 = CONTEXT_MODE_DIR）；换个落点或让主人放行',
    },
    NOT_REGULAR_FILE: {
        code: 'NOT_REGULAR_FILE',
        fix: '这不是普通文件（目录/设备/符号链接目标）；目录请用 dir 形态',
    },
    SHELL_BLOCKED: {
        code: 'SHELL_BLOCKED',
        fix: '命令被危险命令判定拦下（MINGW bash 在受限令牌下必失败）：Windows 改用 language:"shell"（落到本机 PowerShell，兜底 cmd.exe），别用 Git Bash',
    },
    RUNTIME_MISSING: {
        code: 'RUNTIME_MISSING',
        fix: '探测不到这个语言**可用**的运行时：可能是没装，也可能是装了但跑不起来（如 csharp 的 dotnet.exe 在、却缺 SDK / dotnet-script）。换 language，或看回执里 available 列出的能跑语言',
    },
    SQLITE_CORRUPT: {
        code: 'SQLITE_CORRUPT',
        fix: '库文件损坏：已回退重建空库；数据需重新 index',
    },
    USER_VERSION_MISMATCH: {
        code: 'USER_VERSION_MISMATCH',
        fix: '库结构版本不认识（v0 有表 / v>认知）：v0 有表拒迁是护栏，不许静默重建=不许静默删库',
    },
    READ_ONLY_SCHEMA: {
        code: 'READ_ONLY_SCHEMA',
        fix: '这个库的 user_version 比引擎认知新：只读报警，不写入',
    },
    NO_QUERY: {
        code: 'NO_QUERY',
        fix: 'ctx({op:"recall"}) 的 queries 必填：给 2-4 个具体词（路径 / 报错串 / 命令）',
    },
    // ★ 2026-11-04 P3 #20：op:search 在引擎独立跑（web 未装配）时报的是 index 的参数
    //   （`NO_INPUT 至少给一个输入：path/content/url`）—— 文案指向了**另一个 op**，
    //   模型照着改参数只会继续撞墙。网页搜索缺装配时，错误必须说清"这条路本身没装"。
    WEB_NOT_MOUNTED: {
        code: 'WEB_NOT_MOUNTED',
        fix: '网页搜索模块未装配（引擎独立跑时不需要它；DSH 侧由 16-entry 注入）：要搜本地已入库内容用 op:"recall"，不要给 query/url 重试',
    },
    NO_SCHEMA_PIN: {
        code: 'NO_SCHEMA_PIN',
        fix: 'pin 必须同时给 label 与 category',
    },
    // ★ 2026-11-05 Tool Switch（op:"switch"）：三种宿主侧缺件/用法错。
    //   分开立码而不是共用 NO_INPUT，因为三种的"怎么改"完全不同：
    //   没宿主能力 = 这条路在这台宿主上没通；名字错 = 改参数；动作错 = 改 action。
    NO_HOST_CAP: {
        code: 'NO_HOST_CAP',
        fix: '这项能力要宿主配合，当前宿主没提供（引擎独立跑 / 宿主版本不含该服务）：换一条路做，重试同参数不会变好',
    },
    UNKNOWN_ACTION: {
        code: 'UNKNOWN_ACTION',
        fix: 'action 只认表里列出的那几个值：按提示里的清单改，别猜同义词',
    },
    UNKNOWN_TOOL: {
        code: 'UNKNOWN_TOOL',
        fix: '名字不在可开关清单里：先不带 tool 调一次（action 省略=list）看全部可开关名字，再照抄一个',
    },
    // ★ 2026-11-04 沙箱归一（P1）新增：受限执行面的三种真失败。
    // ★ R16（2026-11-05）：原文案「只实测过 node」已被 R11/R14 证伪 —— 文件重定向降级后
    //   shell / csharp / pwsh 在受限会话里都能真跑。文案同步改成实况，别再让模型
    //   以为"只有 javascript 能用"而绕远路。
    // ★ S9.42（2026-11-06 主人问「知道用 SHELL 了，为啥直接去 PYTHON」）：这条 fix 原来写
    //   「本机**没装**这个语言的运行时」。实测证伪：本机 python 装在
    //   `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`
    //   （3.12.14，实测可跑），只是**探测层没看那个目录**；PATH 上那个 `python.exe` 是
    //   WindowsApps 的 0 字节桩（实测 exit 9009）。隔壁冷启动会话就是照着这句假话
    //   白走了 5 步 / 91.4 秒。⇒ 文案只许说"我们的探测没找到可用运行时"，
    //   **不许替用户环境下结论说"没装"**（教训六十五）。
    LANGUAGE_NOT_CONFINABLE: {
        code: 'LANGUAGE_NOT_CONFINABLE',
        fix: '这台机器上探测不到可用的该语言运行时（PATH 里那个可能是 WindowsApps 的 Store 桩，一跑就 9009）：换 allowed 里列出的语言；若确有随包运行时，用 language:"shell" 直接调它的绝对路径',
    },
    CONFINER_UNAVAILABLE: {
        code: 'CONFINER_UNAVAILABLE',
        fix: '宿主沙箱闸门返回了坏形状（既不给出重写 argv 也不给拒因）——宁可拒跑也不原样放行（fail-closed）。这是宿主侧故障，重试同参数不会变好',
    },
    BACKGROUND_DENIED: {
        code: 'BACKGROUND_DENIED',
        fix: '本包没接宿主作业体系（拿不回完成通知，也杀不掉）：长任务给足 timeoutMs 直接跑，不要开后台',
    },
    // ★ R8（2026-11-04 测试汇总）：op:run 的 commands 批量形态**恒走 shell**，
    //   而受限会话的白名单只有 node —— 原来每条命令都死在 LANGUAGE_NOT_CONFINABLE，
    //   失败还被装进 settled[] 当结果返回（表面成功、一条没跑）。
    //   批量这条路在受限宿主下**不是"参数写错了"，是这条路本身没通**，所以文案这么写。
    // ★ S9.42：原文末句「或直接用 pwsh 工具」已删 —— 那个工具被主人按 tool-switch 关着，
    //   且本插件只有一个工具位 `ctx`（教训六十一：文案里不许出现别的工具名）。
    BATCH_NOT_CONFINABLE: {
        code: 'BATCH_NOT_CONFINABLE',
        fix: '受限会话跑不了 commands 批量（批量恒走 shell，受限令牌下起不来）：改成一条 language:"shell" 的 code 把多条命令拼在一起跑；不要把同样的 commands 再发一次',
    },
    CANCELLED: {
        code: 'CANCELLED',
        fix: '调用被取消（signal）；不是代码错误，需要就重发',
    },
    URL_BLOCKED: {
        code: 'URL_BLOCKED',
        fix: '这个 URL 被 SSRF 闸拦下（内网/环回/链路本地/保留名/非 http(s)）：换成公网地址；要抓本地文件直接给 path 参数',
    },
    // ★ R10（2026-11-05 主人质疑）：子进程跑起来了、但**写/建/删工作区外路径被文件系统拒绝**。
    //   原来这条错被 `/EPERM/.test(stderr)` 改判成 HOST_PIPE_DENIED（"引擎装配坏了，去看 confiner"），
    //   把「路径不可写 → 该提权」错报成「引擎故障 → 去查注入」，是本次最误导人的一条。
    // ★ R16（2026-11-05 主人二次要求）：**文案就这一句，不许夹带路径/mode/工作区根**。
    //   理由：①报错会进上下文，冗长文案在反复被拒时最烧 token；②模型只需要知道"路被封了 + 怎么开"，
    //   具体是哪个路径它自己刚才传的，不需要引擎复述。事实一律不进 message。
    WRITE_OUTSIDE_SANDBOX: {
        code: 'WRITE_OUTSIDE_SANDBOX',
        fix: '沙箱模式不允许在工作区外修改，如需修改请使用提权申请',
    },
    // ★ R10：子进程**根本没起来**（spawn 系统调用失败）。与 WRITE_OUTSIDE_SANDBOX 严格区分：
    //   这条是"进程没创建"，那条是"进程跑了但被拒"。原来两者混成一个 HOST_PIPE_DENIED。
    HOST_PIPE_DENIED: {
        code: 'HOST_PIPE_DENIED',
        fix: '子进程起不来（宿主受限令牌）：用 sandbox_permissions + justification 申请提权重试同一次调用，别换参数重发',
    },
};

/**
 * 造一个可读错误。message 第一行永远是「怎么改」，details 跟在后面。
 *
 * ★ R9（2026-11-04 测试汇总 P1-1）：`details.reason` 现在会**顶到第一行**。
 *   原来 reason 只是排第二行的一条事实，第一行永远是那张全局表的通用文案 ——
 *   于是 NO_INPUT 被 9 个 op 共用时，行级的具体指路被压在下面，而第一行还在说
 *   "给 path/content/url"（那是 index 的参数）。工具面看的是第一行。
 *
 * @param {keyof E} key
 * @param {Record<string, unknown>} [details] 附加事实（现有路径、体积、条数…）
 */
export function err(key, details) {
    const spec = E[key];
    if (!spec) throw new Error(`err(): 未登记的错误码 ${key}`);
    // reason 是"怎么改"的调用点版本：有它就顶第一行，原来的通用 fix 降为参考
    const hasReason = details && typeof details.reason === 'string' && details.reason.trim().length > 0;
    const first = hasReason ? details.reason.trim() : spec.fix;
    const e = new Error(first);
    e.code = spec.code;
    if (details && Object.keys(details).length > 0) {
        const rest = Object.entries(details).filter(([k]) => !(hasReason && k === 'reason'));
        e.details = details;
        // 第二行起给事实，模型照着改参数
        const lines = rest.map(([k, v]) => {
            const val = Array.isArray(v) ? v.join(' | ') : String(v);
            return `  ${k}: ${val}`;
        });
        // ★ 2026-11-06 S9.36：通用规则只在**没有被第一行覆盖**时才追加。
        //   判据用"包含"而不是"全等"：调用点的 reason 常常是「该错误码的 fix + 细节前缀」
        //   （例：BAD_BATCH_SHAPE 的「commands 第 N 条不是字符串 —— 」+ 原 fix），
        //   两行一模一样 = 白烧 token，且让人以为出了两条信息。
        const fixText = typeof spec.fix === 'string' ? spec.fix.trim() : '';
        if (hasReason && fixText && !first.includes(fixText))
            lines.push(`  （通用规则）${fixText}`);
        e.message = lines.length > 0 ? `${first}\n${lines.join('\n')}` : first;
    }
    return e;
}

/** 把任意抛出物压成 {code,message}，供工具层回文本。 */
export function describe(thrown) {
    if (thrown && typeof thrown === 'object') {
        return {
            code: thrown.code ?? thrown.name ?? 'ERROR',
            message: thrown.message ?? String(thrown),
            details: thrown.details,
        };
    }
    return { code: 'ERROR', message: String(thrown) };
}
