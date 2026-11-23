/**
 * engines/bilibili.js — 活卡 · order 8 · 形态=声明式（内联 lambda）
 *
 * 搬迁自 1.0.0 `ws-engines.js:349-356`（ENGINES.bilibili），行为完整不变。
 * · 内联 lambda 一类（bilibili/hackernews/stackoverflow/arxiv/crossref/nvd）：
 *   本卡自带 parse 函数体，由调度器套公共 `load→parse` 调用。
 * · htmlToText 用 stripTags 代替（1.0.0 ws-engines.js:141 `htmlToText = stripTags` 完整等价）；
 *   normalize 走 ctx 注入（公共件 ws-text.js，冻结不许改）。
 * ★ P3① 已做（2026-11-08，本行以下即改动）：旧端点 /search/type 现网有 412 风控，**属间歇可复现、非恒死**
 *   （多轮复跑 12 次 = 2×200/10×412 ~ 5×200/7×412 波动；产品真实 transport 头下 412 响应体 52B，
 *    3,286B 是「无 UA 头 / 仅 UA 头」口径的 412 体，别混用；
 *    **加 Referer 也不保证 200**（A/B 复跑：无 Referer 2×200/2×412、加 Referer 1×200/3×412），
 *    412 与请求头/频次强相关，别当「加了头就通」）。
 *   换 /search/all/v2 后免 cookie 稳定 200（12/12 次 code 0、12 组、video 组 20 条）。
 *   新响应结构 = `data.result[]` 分组数组，每组 {result_type, data[]}（注意字段是 data 不是 results）；
 *   本卡摊平只留 result_type==='video' 组，其余组（tips/brand_ad/esports/activity/web_game/card/
 *   media_bangumi/media_ft/bili_user/user/star）全弃——多数查询下它们本就 0 条，
 *   但 `DeepSeek` 查询实测 activity=1、bili_user=1，弃掉是有意为之。
 *   covers=['video'] 语义不变，输出条目形态（title/url/description）不变。
 *   ★ 与批次 1 前 type 版的关系 = **不是逐条对齐，两版各有各的坏链形态**：
 *   两版结果高度重合但非逐条相同（实测交集 17–20/20）；
 *   旧 type 版会带出 type='ketang' 的**空 bvid 条目**（→ 空链 /video/），
 *   新 all/v2 的 video 组则混入 type='live_room' 的**直播间卡片**（有 roomid、无 bvid）⇒ **同样产出空链**。
 *   ⇒ 「换端点即消除坏链/严格优于」的说法**不成立**（见 L-070）。
 *   ★ **本版已修**：parse 过滤无 bvid 条目 ⇒ **坏链归零**（详见下方 parse 注释）。
 *     甲修法 = **临时治理**（丢直播条目 3/1/1），**非终态**；
 *     终态 = 乙（roomid → live.bilibili.com/<roomid>，零丢失），待批次 2 修判据后回补。
 * · 禁 TLA（钉死项 1）；不 import ws-engines.js（规矩 2）；只 import 叶子件 ../ws-text.js（无环）。
 */
import { stripTags } from '../ws-text.js';

export default {
    id: 'bilibili',
    order: 8,
    kind: 'vertical',
    covers: ['video'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    url: (query) => `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}`,
    parse: (json, limit, ctx) => {
        // all/v2 分组结构：result[] 每项 {result_type, data[]}，摊平 video 组（#76 P3① 口径）
        // ★ P3①-b（b5382e63 票出出入 1 的修复，2026-11-08）：video 组里会混入 type='live_room'
        //   的直播间卡片（有 roomid、无 bvid）——**这是 B 站接口行为，不是本卡的 bug**；
        //   直接拼 url 会产出空链 `https://www.bilibili.com/video/`（坏链），且真会进交付文本。
        //   ⇒ 本版过滤掉无 bvid 的条目（甲修法），保证输出 URL 恒为 /video/BV… 真链。
        //   ⚠ 代价（明写，别当零损失）：丢直播条目（实测丢 3/1/1 条），
        //     **这是「安全且不越界的取舍」，不是「语义正确」**——live_room 是真实在播内容（roomid 真链可达）。
        //   ⚠ 终态目标是**乙修法**（roomid → https://live.bilibili.com/<roomid>，零丢失），
        //     但它要连带修 `web-search.js:156` 的判据（hostname vs eTLD+1 口径不一致 ⇒ 单引擎 20 条塌缩成 1 条），
        //     那是批次 1 冻结面 ⇒ **待批次 2 单独立票后回补**。见 01-开发日志.md L-073~L-075。
        const groups = JSON.parse(json)?.data?.result ?? [];
        const hits = groups
            .filter((g) => g?.result_type === 'video')
            .flatMap((g) => g?.data ?? [])
            // 主过滤 = live_room（现网 29 查询 51 条空 bvid 条目 type 100% = live_room）；
            // 兜底 = 任何无 bvid 的条目都不进（否则拼出空链）。
            // 两个条件都留 ⇒ 日后若 B 站新增「无 bvid 且非 live_room」的卡片形态，
            // 它会被兜底滤掉（**不留坏链**），而 live_room 计数不增长 = 可从形态变化中看出来。
            .filter((v) => v?.type !== 'live_room' && v?.bvid);
        return ctx.normalize(hits.map((v) => ({
            title: stripTags(v.title ?? ''),
            url: `https://www.bilibili.com/video/${v.bvid}`,
            snippet: stripTags(v.description ?? ''),
        })), limit);
    },
    trash: null,
};
