# CTX OP SEARCH 拟升级执行方案（三份合并定稿）

> 合并来源：`deepseek-v4.1-flash-…-v2-实测修正版.md`（实测脊柱）、`qfmodel-….md`（配额根因 N12 + 实验 A/B）、`spark-x2.6-….md`（落地代码骨架 + 文件清单）。
> 冲突处理规矩：**有实测数据的结论压过纯文档推断**；被压掉的结论在 §三 逐条留痕，不悄悄改写。
> 标注：「实测」= 本机真跑过有数字；「代码」= 盘上逐行核对；「未验」= 只是推断。
> 依据：`01-magpie免费通道借鉴与缺口`、`02-六家免费通道连通性实测`、`20-积木化总清单`、`21-合并排序算法`；装机槽 `C:\Users\Diccup\.dsh\plugins\dsh-eco-context`（v1.0.0，与 `overlay\ours\` 13 件哈希全等）。
> 状态：**方案，未动生产代码。**

---

## 〇 结论

本地 `op:search` 的瓶颈**不是"引擎不够多"**，是五条盘上可验证的结构性问题：

1. **没有截止时间** —— 墙钟由最慢一家钉住。实测同参两次 **3271 ms / 1071 ms**（差 3.05 倍，中间未改任何参数）。
2. **没有缓存** —— 同题第二遍全量重打 17 家，而两遍正文**逐字相同**（`AGG_SAME=true`）⇒ 缓存零风险。
3. **失败不收敛** —— 5/17 必失败、4/17 恒 0 条，每轮照打；一次 429 还会**白烧一个 Python 桥子进程**（实测 555 ms，且服务端收到 2 次请求）。
4. **日期已在响应里被我们自己扔了** —— Bing RSS `pubDate` 覆盖 **9/9**，而 `parseBingRss` 只取 title/link/description。
5. **配额制度不吃"引擎实际表现"**（实验 A/B 双证）—— 新引擎按契约插进聚合，limit=10 交付**逐字不变**，接了等于白接。

两道前置硬伤，不修则"接 API 引擎"是空谈：
- **传输层**：`getHtml` 实测只发 GET，`method`/`body` 两个选项**被完全忽略**（服务端看到 GET + 空 body）；而 4 家免费 API **全是 POST JSON**。
- **制度层**：N12 不落地，P1 是空转（§四·N12）。

---

## 一、实测基线

环境：`C:\Users\Diccup\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（v24.21.0）。
⚠️ **本机 PATH 上没有 `node`**，所有门与探针必须用这个绝对路径，否则门以"命令不存在"假失败。

### 1.1 聚合两次耗时（同进程、同参，`DeepSeek V4 发布`，limit:10，全 17 家）

| 次 | 耗时 | 体积 | 条数 |
|---|---|---|---|
| 1 | **3271 ms** | 3764 B | 10 |
| 2 | **1071 ms** | 3764 B | 10 |

⇒ 墙钟无预算约束（治它：P0-1）；⇒ 结果确定、可缓（治它：P0-3）。

### 1.2 逐家耗时（limit:10 / timeoutMs:5000 / allowBridge:false）

| 引擎 | ms | 结果 | | 引擎 | ms | 结果 |
|---|---:|---|---|---|---:|---|
| **pypi** | **5044** | ❌ unavailable | | baidu | 822 | ✅ 7 条 |
| crossref | 2148 | ✅ 10 | | stackoverflow | 746 | ⚠️ 0 条 |
| pubmed | 1519 | ✅ 10（两段式） | | github | 729 | ✅ 5 |
| npm | 1477 | ✅ 10 | | bilibili | 385 | ✅ 10 |
| nvd | 1076 | ⚠️ 0 条 | | **bing** | **334** | ✅ 10（最快主力） |
| hackernews | 924 | ⚠️ 0 条 | | mso | 307 | ❌ blocked |
| arxiv | 1071 | ✅ 10 | | so360 | 281 | ❌ blocked |
| douban | 258 | ⚠️ 0 条 | | sogou | 252 | ❌ 403 |
| sogou_wechat | 191 | ❌ blocked | | 中位 | **746** | |

- 最慢 pypi 与最快 bing 差 **15 倍**，聚合层 `Promise.all` 等全部 ⇒ 交付时间 = 最慢者。
- **5/17 必失败 + 4/17 恒 0 条 = 每轮 17 次请求里 9 次无产出，且不会自愈。**
- ⚠️ **但"恒 0 条"≠"该删"**：`21 §7.1` 有反面实测——P2 垂类被砍后引擎 #1 命中 94→44、覆盖家数 7.29→3.71。P2 的位置价值在**补位**。所以下文一切机制只"暂缓/降权"，不删卡。

### 1.3 传输层真实能力（本机桩服务回放响应，直调 `getHtml`）

| 试验 | 实测 |
|---|---|
| 服务端 429 + `Retry-After: 2`，`allowBridge:true` | 555 ms、`ok:false`、`diagnosis:rate_limit`、`via:'bridge'` ⇒ **一次 429 = 一次 Python 桥子进程**（快腿 429 → `needsBridge` → 桥再打再 429） |
| 紧接着再打同一 429 端点 | 服务端**又收到 2 次请求** ⇒ 零冷却 |
| `getHtml(url,{method:'POST',body:'{...}'})` | 服务端看到 **GET、body 空**（快腿与桥腿都是）⇒ `method`/`body` 被完全忽略 |
| `getHtml(url,{headers:{'x-test':…}})` | 自定义头**送达** ⇒ `headers` 是通的 |

代码侧对照：快腿 `fetchImpl(url,{redirect,signal,headers})` 无 method/body（L220-229）；桥腿 payload 硬编码 `curl_cffi.requests.get(...)`（L288）。

### 1.4 四家免费 API 此刻的形状（Node `fetch`，与插件同运行时，全 200）

| 通道 | 耗时 | 体积 | 逐条字段 | 日期 |
|---|---:|---|---|---|
| AnySearch | 1389 ms | 6.7 KB | `title,url,snippet,content`(≤3840字) | ❌ 无 |
| Keenable | **676 ms** | 6.7 KB | `title,url,description,snippet,acquired_at` | ⚠️ 仅抓取时间 |
| Parallel | 2202 ms | **65.8 KB**(SSE) | `url,title,publish_date,excerpts`(1207–2474字) | ✅ 有 |
| TinyFish | 1650 ms | 4.2 KB | `position,site_name,snippet,title,url`+可选`date` | ✅ 部分 |
| Exa（备选） | 1.4 s | — | — | 有 `Published` |

三条必须写进方案的账（前两版漏算）：
- **Parallel 的日期不是每条都有**：三个查询实测 `publish_date` 命中 **3/10、8/10、3/10**。
- **交付层现在裁到 180 字符**（`DELIVER_SNIPPET_CHARS=180`）⇒ **接了 API 引擎却不放开交付层 = 拿 2400 字正文回来裁成 180 字，白接。**
- **Exa 限流是时变的**：本轮 3 并发全 200（与 `02` 文档"第 3 个必 429"不符），但缺 `Accept: application/json, text/event-stream` 立刻 406。⇒ 不能按"恒 429"写死，也不能当"稳"放进聚合。

### 1.5 我们已经在扔日期（零成本收益点）

| 试验 | 结果 |
|---|---|
| Bing RSS 每条有无 `<pubDate>` | **9/9 全有** |
| 日期串长相 | `周日, 08 11月 2026 04:16:00 GMT`（中文星期+中文月份） |
| `new Date(该串)` | **`Invalid Date`** ⇒ 必须自写解析（日/月/年 时:分:秒 → `Date.UTC`，实测 ✅） |
| 加 `tbs=qdr:h/d/w/m` | **10/10 与不加完全重合、日期一模一样** ⇒ `tbs` 对 **RSS 腿无效** |

⇒ "给结果加日期"零新增请求就能拿到（Bing 一家 9/9）；⇒ "最近 N 天过滤"靠 Bing RSS 做不到，唯一通吃做法是**客户端按已解析日期本地筛**。

### 1.6 配额不吃表现（实验 A/B，直调 `computeQuotas`/`interleaveByRank`，不联网）

- **实验 A**：按卡片契约原样插 4 家新引擎，limit=10 交付来源**逐字相同**（`bing,sogou,so360,baidu,mso,github,bing,baidu,bing,baidu`）；只有 limit=30 时新家各分到 1 条。
- **实验 B**：塞 `tinyfish`（10 条全新独货）+ `spam`（10 条全抄 bing URL 的垃圾）⇒ 配额表 `tinyfish:0 spam:0`。

⇒ **制度对优质独货和抄袭垃圾的处理完全相同：都是 0。** 它不是"按表现分配错了"，是**根本没有"表现"这个输入维度**。根因见 §四·N12。

---

## 二、目标（每条可机器判，不用"感觉更快了"）

| # | 目标 | 验收判据 | 档 |
|---|---|---|---|
| G1 | 搜索有**截止时间** | 同参连跑 5 次 `max-min ≤ 800 ms`；pypi 超时不再进墙钟 | P0 |
| G2 | **失败/限流冷却** | 人为让一家返 429，第二次该家 **<50 ms** 且**服务端 0 次请求**；遵守 `retry-after`；**不触发桥腿** | P0 |
| G3 | **结果缓存** | 同参第二次 **<100 ms**；换 query/engines/limit/fullSnippet/allow/blocked 任一**必不命中**；`cacheTTL:0` 可关 | P0 |
| G4 | **日期进交付** | bing 来源条目带 `YYYY-MM-DD`，与 RSS `pubDate` 逐条一致 | P1 |
| G5 | **本地"最近N天"过滤** | 注入已知日期桩，`days:3` 只留 3 天内条目，**不发任何额外请求** | P1 |
| G6 | **一条能发 POST 的通道** | 本地桩收到 `POST`+正确 body+自定义头；SSE 能剥壳 | P1 |
| G7 | **接上 1–2 家 API 引擎** | 至少一家返回 `publish_date`/`content`，**且交付里能看到 >180 字**（否则不许声称"接上了"） | P1 |
| G8 | **配额吃实测表现** | 实验 B 复跑：`spam` novelty=0 ⇒ 两轮窗口后条数 ≤ 独货家；新引擎首见即有探索位 ≥1 条；17 家原状回归逐字一致 | **P1 前置** |
| G9 | **不破现状** | `doctor()` 17 家逐行仍出；`page()`/`media()` 行为不变；`engine/verify/*.mjs` 五门退出码 0；`release-check ⑫` 14 名导出面 + internals 4 键一名不差 | 贯穿 |

---

## 三、被实测推翻的假设（留痕，防下一个人重走）

| # | 被推翻的说法（出处） | 实测/代码实情 | 修正 |
|---|---|---|---|
| ① | 「冷却表挂在 `load()` 入口查表就够了」（v1） | 429 触发桥腿，单成本 555 ms 且必再撞一次 429 | 冷却**必须挂两处**：`getHtml()` 入口（省网络）+ `needsBridge` 判定前（省子进程）。只挂入口 = 每次仍付一次"快腿失败→起桥" |
| ② | 「缓存键 = `sha256(query+engines+limit+timeParam)`」（v1） | 交付还受 `fullSnippet`/`allow`/`blocked`/`noFilter`/`lang`/引擎表版本影响 | 键必须覆盖全部可变输入（§四·P0-3），否则"改了 allowDomains 却拿到旧结果"的幽灵 bug |
| ③ | 「新 API 引擎 = 只加一个文件、复用 `ctx.load(url,…,opts)`」（v1、spark 3b） | 三处不成立：a) `ctx.load` **实测发不出 POST**；b) `CARDS` 是**静态 import 列表**，新卡要 ①建卡 ②加 import ③加进 `CARDS` ④赋 order，漏挂只 warn 不报错；c) `kind:'api'` **是非法枚举值** | 别发明第三态：要么用 `general`，要么先扩枚举。**当前建议：Parallel 用 `kind:'vertical'`+`covers:['news','zh','ph']`，TinyFish 用 `kind:'general'`+`covers:['*']`**（`engineTier()` 与 `verticalHit` 才都认得） |
| ④ | 「`engines/api/` 子目录放新卡，随整目录拷自动带上」（spark 8.1） | 两道门静默跳过：`assemble-release.mjs` L176-181 只**点名拷** `engines/` 与 `engines-offline/`，其它子目录不在拷贝范围；`install-slot-check.mjs` ③b 用 `readdirSync(cardsDir)` **不递归**（L216）⇒ api 子目录里的卡**永远不会被 import 验证**，坏了运行时才炸 | **新卡一律平铺进 `ours/engines/`**；顶层新模块平铺进 `ours/` 时**必须同步加进 `OVERLAY_OURS`**（13 条白名单），否则产物里没有它而本机测试全绿（假绿） |
| ⑤ | 「`media=image\|video` 可用」（ctx.md 文案） | `14-tools/index.js:416` 把 `media` 传给 `web.search({media})`，而 `search()` **从不读 `media`**（只有独立 `media()` 读）。实测 `search('猫',{limit:3,media:'image'})` 返回普通 17 家文本搜索 | **`media` 是死参数，ctx.md 在骗模型。** P2 处理：真接线，或删文案（删可腾 ~20 B，正好补 ctx.md 只剩 14 B 的缺口）。另 `fullSnippet` 同族：`web-search.js` 有实现但 `14-tools` 不传 ⇒ 模型永远够不到 |
| ⑥ | 「接了 API 卡就算升级」 | 实验 A/B + `DELIVER_SNIPPET_CHARS=180` | P1 有两个硬前置：**POST 通道（P1-3）** + **配额吃表现（N12）** + **交付层放开 180**，三者缺一都不许立"接上了"的功 |
| ⑦ | 「Exa 恒 429，不能接」 | 本轮 3 并发全 200；缺 `Accept` 即 406 | Exa 限流**时变**。结论不变（不进聚合，只作单引擎指定），但理由要改成"时变不可控 + 要伪装 UA"，不是"恒 429" |
| ⑧ | 「`order` 给新卡排 100 就好」（spark） | `07-基线-引擎顺序.txt`（v1.2 钉死）禁止按盘点表 # 或字母序赋 | 新卡 **order 18/19**，只补尾不抬前排 |

---

## 四、执行方案

**总原则**
1. **现有 17 张卡一行不改**（`run(query,limit,ctx)` 签名、返回、顺序全保留）——G9 硬边界。
2. 新能力全加在**壳层与通道层**（`web-search.js` / 新增平铺件 / 新 `ws-api.js`），**不动 `ws-transport.js` 的 GET 语义**（风险大且没必要）。
3. **不改模型可见参数**，除非 §八 主人拍板（ctx.md 只剩 **14 B**）。
4. 所有新文件**平铺进 `overlay/ours/` 并加进 `OVERLAY_OURS`**（§三④）。
5. 施工顺序（每步可单独回滚）：`P0-3 缓存` → `P0-2 冷却` → `P0-1 截止时间` → `P1-1 日期` → `P1-3 POST 通道` → `N12 配额` → `P1-4 API 卡` → `P2 清理`。
   缓存先做（零风险、立刻可量化）；截止时间后做（它改变"哪家能进结果"，要先有对照数据）。

### P0-1 · 截止时间（deadline）—— 治 3271↔1071 抖动

改 `ours/web-search.js` 聚合路径，`ws-engines.js` 不动。
- 入口算 `deadline = started + (options.budgetMs ?? 2500)`；每家 `Promise.race([engine.run(...), sleepUntil(deadline)])`。
- 超时的那家只是"本轮无货"，**不报错**（现状本来就 `catch → []`）；更早返回的结果照常参与合并；`elapsed` 如实带 `(budget hit × N)`。
- 判据 G1。按 §1.2，budget=2500 只切 pypi(5044ms，**本就 0 条**)，crossref/pubmed 仍能进 ⇒ **不会把 10 条削成 5 条**。
- ⚠️ 反例防护（`21 §7.1`）：这里砍的是**"超时等待"，不是"引擎"**——下一轮它照被调用（除非被 P0-2 冷却表记了，那也是"暂缓"不是"删除"）。这条区别要写进日志。

### P0-2 · 失败/限流冷却表 —— 治"每轮重打 5 家必败"

新文件 `overlay/ours/ws-cool.js`（平铺，加 `OVERLAY_OURS`）。纯内存 `Map`，无依赖、不落盘、重启即清。

```js
// 键 = 引擎标识（engineHint），值 = { until, reason, fails }
shouldCool(key, now) -> {cooled, retryIn}
markFail(key, {retryAfter, reason})   // 429 / 403 / blocked / timeout 都记
markOk(key)                            // 成功即清零（自愈）
// parseRetryAfter：秒数 或 HTTP-date 两种都认；缺失/非法 ⇒ 默认 60 s
// 失败退避：30s → 60s → 120s，封顶 5 min；成功一次立刻清零
```

- **挂两处**（§三①）：`getHtml()` 入口省网络 + `needsBridge` 判定前省子进程。
- ⚠️ **键必须按"引擎"不按"域名"**：`eutils.ncbi.nlm.nih.gov` 被 pubmed 两段式用两次，按域名记会让第二段把自己冷却掉。用已存在的 `engineHint` scope 参数最稳。
- ⚠️ **只认 429/超时，不认 412**：B 站 412 是间歇风控（`engines/bilibili.js:9-14` 实测坐实），加了会让垂类结果时有时无。
- 命中时回 `{ok:false, status:429, diagnosis:'cooldown until …', via:'none'}`，**不发网络请求**。
- 判据 G2。**注意与 G3 分票**：同参第二次整体变快是缓存的职责，不许拿冷却表冒领。
- 预期：第二轮起 5 家必败 + 1 家超时共 6 次请求归零；配合 P0-1 稳定在 ~1.1–2.1 s。

### P0-3 · 结果缓存 —— 治"同题全量重打"

新文件 `overlay/ours/ws-cache.js`（平铺，加 `OVERLAY_OURS`）。LRU 64 条 / 每条 ≤64 KB，TTL 600 s。

- 缓的是 **`renderAggregate` 的最终交付文本**，不是各家原始 HTML（一家 1.9 MB，缓 10 家 = 20 MB，无意义）。
- 键按 §三②：`sha256(规范化query | 排序后engines | limit | fullSnippet | allow | blocked | noFilter | lang | 引擎表指纹)`，其中"引擎表指纹"= `Object.keys(ENGINES).join(',')` 现场算（零维护，加卡后旧缓存自动失效）。
- **只缓聚合路径**；单引擎 / `page()` / `media()` 不缓（正文时效性强，且会造"明明改了还是旧文"的误判）。
- 逃生口 `cacheTTL:0`；`{debug:true}` **旁路缓存**，否则 debug 看不到真抓取。
- 命中时**重写头行毫秒并加 `· cache:hit`** ——实测两遍正文已相同，不标注会让模型以为"没执行"。别骗模型。
- 判据 G3；预期 1071 ms → **<10 ms**。

### P1-1 · 日期进交付（零新增网络）—— 治"没有发布时间"

三处内部字段，不动交付格式以外的东西：
1. `ours/ws-engines.js` `parseBingRss()`：`<pubDate>` → `published`，**自写解析器**（中文星期+中文月份 → `Date.UTC`；`new Date()` 实测 NaN）。
2. `ours/ws-text.js` `normalize()`：**透传** `item.published` → `_published`，缺省 `undefined`，**绝不写空串**。
   ⚠️ 这动的是**公共件**，`parseBing`（S55 冻结）也路过它 ⇒ **先跑 `release-check ⑫` + `t55` 对拍**，确认 14 名导出面与 S55 三条断言不受影响，再合。
3. `ours/web-search.js` `renderAggregate()`：条目行末追加 ` · 2026-11-08`，**只在有日期时**。老 17 卡无该字段 ⇒ 输出逐字不变。
- 判据 G4。收益：Bing 一家 9/9 覆盖，**最便宜的一家，零新增请求零新增参数**。

### P1-2 · 本地"最近 N 天"（紧跟 P1-1）

拿到 `_published` 后**客户端筛**，不碰任何引擎的时间参数。触发方式两条，需主人挑（§八·②）：
- **A（不新增参数）**：只把日期交给模型，由模型判断新旧。零门改造成本，**推荐先做这个**。
- **B（新增 `days`）**：`resolveOpts` 增 `days`，`renderAggregate` 前按 `_published` 过滤。代价：`ctx.md` 只剩 14 B + `tool-surface ⑪-b` 的 `EXPECTED_PARAMS` 是**逐字有序 13 项清单** ⇒ 同时改文案+改门+重算 token 账，**必须主人批**。

**为什么不用引擎侧时间参数**（三版方案此处口径已统一）：实测 `tbs=qdr:*` 对 Bing RSS **完全无效**（10/10 重合）；Bing HTML 腿有效但要多一跳；四家 API 里只有 Parallel/Exa 有日期字段（TinyFish 部分带、AnySearch/Keenable 无）；拼老引擎的 URL 时间参数是**抓 HTML 的脆弱面，拼错即全线 0 结果**。⇒ **客户端筛是唯一"各家通吃"的做法。**
若仍要做引擎侧透传，近似档 `≤2天→day`、`≤14天→week`、`≤90天→month`、其余 `year`；不支持时间的卡**静默忽略**，不报错也不谎称已筛（写"本引擎不支持时间过滤"反而更坏——模型会以为筛过了）。

### P1-3 · 一条能发 POST 的通道（API 引擎真正前置）

新文件 `overlay/ours/ws-api.js`（平铺，加 `OVERLAY_OURS`）。**不碰 `ws-transport.js`**，避免动到 `page()` 既有链路：

```js
postJson(url, {headers, body, timeoutMs}) -> {ok, status, text, json}
postJsonSse(url, {...}) -> {ok, status, text}   // 剥 "data: " 前缀取最后一条
```
- **SSE 双层剥壳**（实测）：Parallel 回 `event: message\ndata: {...}`，先切 `data:` 再 `JSON.parse`；**内层还有一层 `result.content[0].text` 是"字符串里的 JSON"，要二次 `JSON.parse`**。
- **SSE 解析不是单卡私事** ⇒ 独立叶子件 `ours/ws-sse.js`（与 `ws-text.js` 同级、无环），别在两张卡各写一遍正则。卡片只准 import 叶子件、禁 import `ws-engines.js`（规矩 2）。
- 默认 UA 用浏览器 UA（实测 Exa 无 UA→403、Keenable→400、TinyFish→401，三家都踩过）。
- 429/403 与 `ws-cool` 联动；`Content-Type: application/json` **由卡片在 headers 里声明**，transport 不猜（保持 lane B 无业务逻辑）。
- **不接桥腿**：POST 走 fast leg；实测若某家日后要浏览器 TLS 指纹，再给 `ws-api.js` 加 POST 桥腿（单点扩展）。现桥 payload 硬编码 GET，**别让 POST 悄悄走成 GET**。
- 判据 G6。

### N12 · 配额改为"样板 × 实测表现系数"（**P1 前置**，G8）

**根因**：主人 N1 原话（`ws-engines.js:571-575` 逐字在案）「不是绝对值，要你们计算一下**可用比例**来定这个比例」。当时落地把"可用比例"实现成【样板当权重 + 当场挂掉才重分】，**"按引擎实际表现算比例"这一半从未兑现**。主人的批评不是新需求，是旧承诺欠账。

现有制度信号面（说它"全静态"也不公平）：

| 机制 | 代码位 | 吃的信号 | 不吃的信号 |
|---|---|---|---|
| bing 3 / 百度 3 钉死 | `:639-657` | 手写样板常量 | 这两家当下结果好坏 |
| 其他各 1 轮流 | `:662-688` | 家数 | 质量、独家性、历史命中 |
| 百度不通 bing 补 5 | `:659` | **当场可用性** | 可用但很烂的照吃满配额 |
| 垂类 rarity | `:625-629` | covers × 查询类 | 单家实际出货质量 |
| deficit 余额回收 | `:698-729` | **当场条数** | 条数之外的任何东西 |

⇒ **骨架是固定样板；"表现"只在当场救济时参与，跨查询、跨质量的表现代码里不存在。**

**拟修**（不推翻样板，在样板上叠可计算系数）：
```
最终配额 = clamp( 样板权重 × f(yield, novelty, latencyOk), 保底 .. 上限 )
```

| 指标 | 定义 | 治什么 |
|---|---|---|
| `yield` | 该家 items>0 的比例 | 常挂的家降权（现制度只有当场救济，没有记忆） |
| `novelty` | 进入交付的 URL 归一后本家独家占比 | **spam 型抄袭引擎现形**（实验 B 靶子） |
| `latencyOk` | 未在超时线内失败 | 拖全表的家自动降权（Exa"能不能进聚合"以后由数据答） |

**不做** clickworthy/质量分——没有点击信号，编出来的是假数据。
**冷启动（不修就鸡生蛋）**：新引擎无档案 ⇒ f 只吃历史则 tinyfish 永远 0 条、永远没历史。⇒ 中性起步 `f=1.0` + **ε-探索配额**：limit≥10 固定给 1–2 条探索位，计入档案，跑够窗口（建议 50 次查询）后按 f 收敛。这一条同时解掉实验 A 的"接而不变"。
**红线**：bing/baidu 主力位受 f 影响但**不清零**（保底 ≥1，保样板形状与头行语义）；垂类 rarity（P1 v3 两票定稿）**不并入 f**，两套各管各层；改交付分布 = **两票面**。
**落点**：`ours/ws-engines.js`（新增 `ENGINE_STATS` 记账 + `computeQuotas` 权重×f，reserve/others 两段都乘）、`ours/web-search.js`（聚合收尾调一次 `recordDelivery`）、档案持久化位置拍板后再定（存内存 vs 进 11-memory，跨进程才有"表现"可言，但多一处常态写面）。
**判据**：见 G8 + 四条回归——① 实验 B 复跑 spam novelty=0 让位；② 17 家原状回归（全部 yield=1、novelty 相当时 f≈1 ⇒ limit=10 交付来源与现基线**逐字一致**）；③ items=0 连续 N 次 ⇒ 配额自动让位，**并保留** `:659` 作首查即时兜底（第一查没历史，靠它）；④ 交付总条数恒 = min(limit, 总货量)（deficit 段不许被 f 破坏）。

### P1-4 · 接 API 引擎（顺序按实测重排）

> ⚠️ **本表在主人拍板前不视为结论**（见 §10.1）：表中 Exa / Firecrawl 两行的"✗"判语已作废、降为待议；"首批砍到两家"同批待议。事实素材与全部选项代价见 `待决断清单-20261108.md` §B1–B4、§A2。

| 顺序 | 引擎 | 理由（实测） | 卡形态（按 §三③ 修正） |
|---|---|---|---|
| **1** | **Parallel** | 唯一有结构化日期（30–80% 命中）+ `excerpts` 1207–2474 字；2.2 s / 65.8 KB **必须截断** | `engines/parallel.js`（平铺），`kind:'vertical'`，`covers:['news','zh','ph']`，order 18 |
| **2** | **TinyFish** | 中文最准（1.65 s / 4.2 KB），有 `site_name` + 部分 `date`，体积最小 | `engines/tinyfish.js`（平铺），`kind:'general'`，`covers:['*']`，order 19 |
| 3 | AnySearch | `content` 最长 3840 字但**无日期**，且与 Parallel 高度重叠；直进 snippet 会撞 `output-containment` 40 KB（StackOverflow 36733 字符前例） | 视交付层是否放开 180 字再定 |
| 4 | Keenable | 最快 676 ms 但字段最薄（`description` 多数为空），与 bing/baidu 完全重叠；N12 未落地前进聚合也是 0 配额 | 备选 |
| ✗ | Exa | 限流时变（本轮 3 并发全 200、缺 `Accept` 即 406）、要伪装 UA | **不进聚合**，只作单引擎指定 |
| ✗ | Firecrawl | search 结果仅 737 B 太薄；价值在 `/v1/scrape` | 归 P2 的 `page()` 兜底腿 |

**首批砍到两家**（01 建议三家）：AnySearch 的 `content` 与 Parallel 的 `excerpts` 功能重叠，少一张卡 = 少一路并发成本和一个坏链来源。
**每张卡真实改动量**（替代"只加一个文件"）：
```
① 新建 overlay/ours/engines/<id>.js          （平铺，不进子目录）
② ws-engines.js 加一行 import
③ ws-engines.js 的 CARDS 数组加一项
④ 卡里给 order（18/19，按 07-基线-引擎顺序.txt 追加，禁按 # 或字母序）
⑤ ENGINE_PROFILE 由卡片生成，不许另存手抄表（v1.3：covers 单一出处）
⑥ 卡内 run() 调 ws-api.js（不是 ctx.load）
```
**必须联动交付层**：Parallel `excerpts` 拼起来 2400 字、AnySearch `content` 3840 字，交付层若仍 180 字上限，接上等于只拿到一句话。`excerpts`/`content` 走 **`_snippet_raw`**（卡片留全量、交付才裁，S9.54 已定纪律），**不拼进 `snippet`**。⇒ G7 判据含"交付里能看到 >180 字"，否则不许宣称接上。
**SSRF 口径**：`14-tools/index.js:414-416` 只有 `url` 形态过 `assertSafeUrl`，`query` 形态不过（引擎 URL 由卡片自拼）⇒ 接 API 卡要**显式声明端点白名单口径**，别以为闸自动管住新卡。
**装配副作用（两票面明写）**：交付头行 `engines:` 多出两个名字（`renderAggregate` 用 `names.join`）。
**回滚**：`CARDS` 撤两条 import（秒回 17 家）+ 卡文件撤出目录（留目录 = S4 warn，或挪进 `engines-offline/`）。

### P2 · 收尾清理（低风险）

1. **`media` 死参数**：要么在 `search()` 里真接 `ws-media`，要么删 `ctx.md` 里的 `media=image|video`（删省 ~20 B，正好补 §五 的 14 B 缺口；先确认 `media` 不在 `MOVED_PARAMS` 里——已确认不在，安全）。
2. **`fullSnippet` 通上去**：已实现未接线，`14-tools` 多传一个 boolean 即可，但撞 `EXPECTED_PARAMS` 门，需主人批。
3. **Firecrawl 作 `page()` 兜底腿**：仅当裸抓 + fp 五段全败时用 `postJson('/v1/scrape')` 取 `data.content`，标注 `via:firecrawl`；不进搜索聚合，fp 成功时老行为不变。
4. **`normalizeQuery`**（低风险可随手带上）：折叠空白 + trim + 长度夹 1..200（Parallel 官方限制，本地现只判非空不夹）。超长要抛可读错（`err()` 第一行写"怎么改"），**不静默截断**。判据：`search('  a   b ')` 与 `search('a b')` 文本全等。

---

## 五、会被"门"挡住的地方（先算清，别改到一半才发现）

| 门 / 约束 | 具体数字 | 对本方案的约束 |
|---|---|---|
| `ctx.md` 体积红线 | `DESC_MAX_BYTES=1563`，现 **1549 B** ⇒ **余量 14 B** | 新增参数说明（`days`/`fullSnippet`/`cacheTTL`）**全都写不进去**。要么删 `media`（省 ~20 B），要么主人抬红线 |
| `tool-surface ⑪-b` | `EXPECTED_PARAMS` **恰好 13 个且顺序固定**（`op,language,code,file,commands,timeoutMs,intent,sandbox_permissions,justification,queries,source,dryRun,fix`） | 新增模型可见参数 = 改这条期望清单 + 重算 token 账，属主人级决定 |
| `tool-surface ⑪-c` | `MOVED_PARAMS` 20 个每个都必须在 `ctx.md` 出现 | 删 `media` 文案前已确认它不在 `MOVED_PARAMS`，安全 |
| `release-check ⑫` | `web-search.js` 导出**恰好 14 名** + `__webSearchInternals` **恰好 4 键**（`ENGINES,clip,getHtml,render`） | 新函数**不许**从 `web-search.js` 导出；要么放新文件，要么加进 internals（但那会破 4 键门） |
| `assemble-release` `OVERLAY_OURS` | 13 条平铺白名单，逐条点名 | 每个新平铺件必须加进去，否则产物里没有而本机全绿（**假绿**） |
| `assemble-release` D1 门 | 两处 `ours` 逐件哈希全等，现基准 **37 件** | 新增件让件数变（37 → 40/41/45，取决于做了几件）；门自动校验，**日志必须记件数变化** |
| `install-slot-check ③b` | `readdirSync(engines)` **不递归** | 新卡**只能平铺**在 `ours/engines/` |
| `install-slot-check ③` | `STARTUP_MODULES` 12 条硬清单 | `ws-cool/ws-cache/ws-api/ws-sse` 若被 `web-search.js` **静态 import** 就要入列（动态 import 则不必须） |
| `web-search.js:42` S4 对账 | `reconcileEngineCards()` 漏挂**只 warn 不报错** | 加卡后必须人工核对头行与 `doctor()`，别信"绿了" |
| `tool-surface ⑩` | `platform/` 禁 `child_process`；`ours/` 允许 | 新通道放 `ours/` 合法；**不许**为发 POST 去 `platform/` 加东西 |
| 交付文本冻结 | `render`/`renderAggregate` 头注「契约 §5 frozen」；`parseBing` 被 S55 逐字锁 | P1-1 的日期行、N12/P1-4 的交付分布变化 = **两票面**，票照走 |
| `output-containment` 40 KB | `web-search.js:64-69`（StackOverflow 36733 字符前例） | API 长正文必须走 `_snippet_raw`，不许直进 `snippet` |

---

## 六、文件变更清单

**新建（全部平铺进 `overlay/ours/`，逐个加进 `OVERLAY_OURS`）**
1. `ws-cool.js` 429/失败冷却表 2. `ws-cache.js` 结果缓存 LRU 3. `ws-api.js` POST/SSE 通道 4. `ws-sse.js` SSE 剥壳叶子件
5. `engines/parallel.js` 6. `engines/tinyfish.js`（P1-4，N12 之后）

**修改**
7. `ours/ws-transport.js` —— 冷却查表挂两处（入口 + bridge 判定前）；**不改 GET 语义**
8. `ours/ws-engines.js` —— `parseBingRss` 解 `pubDate`、`CARDS`+import 加卡、`resolveOpts`（仅走 B 档时加 `days`）、N12 的 `ENGINE_STATS` + `computeQuotas` 叠 f
9. `ours/ws-text.js` —— `normalize()` 透传 `published` → `_published`（缺省不写；先过 S55 对拍）
10. `ours/web-search.js` —— 聚合层缓存短路、deadline、`renderAggregate` 日期行、`recordDelivery`
11. `engine/blocks/14-tools/index.js` —— 仅 B 档/`fullSnippet` 接线时改
12. `engine/blocks/14-tools/descriptions/ctx.md` + `overlay/skills/ctx-op-search/SKILL.md` —— 缓存新语义一句、`media` 死参数处置
13. 门：`assemble-release.mjs`（`OVERLAY_OURS`+D1 件数）、`install-slot-check.mjs`（`STARTUP_MODULES`）、`tool-surface.mjs`、`release-check.mjs`

**不动**：老 17 张活卡、`engines-offline/` 6 张、`fp-bridge.js`、`ws-media.js`、`ws-detect.js`、`page()` 的 fp 五段递减链路。

---

## 七、风险与明确不做

| 风险 | 对策 |
|---|---|
| 截止时间砍掉本来会回来的慢结果 | budget 默认 2500 ms 只切 pypi(本就 0 条)；**不删引擎**，下轮照调 |
| 冷却表误伤同名域 / pubmed 自冷却 | 按 `engineHint`（引擎 id）记，不按域名；不认 412 |
| 缓存返回陈旧 | TTL 600 s + `cacheTTL:0` 可关 + 键含引擎表指纹 + `debug` 旁路 + `· cache:hit` 标注 |
| `normalize()` 改动波及 17 家 | `_published` 缺省不写；先跑 `release-check ⑫` + S55 对拍再合 |
| 新文件漏装配（假绿） | 每加一个平铺件在日志逐条记"已进 `OVERLAY_OURS`"，并对装配产物 `ls ours/` 核件数 |
| API 通道集体挂 | 卡内失败走 cooling，不阻塞其余 17 家（聚合层本就 `catch → []`）；每卡留「本卡可随时整体下线」注释，坏一个摘一个，不动公共层 |
| Parallel 大响应撑爆上下文 | 卡片 `normalize` 截条数 + `_snippet_raw` 留全量 + 交付层放开到可配上限 |
| 对岸免费匿名通道随时变收费/加风控 | 所有对岸端点与返回字段一律当**数据**处理，抓回正文不进指令路径（AGENTS.md + `ctx-op-search` 纪律） |
| N12 悄悄改掉老 17 家行为 | 判据②"yield/novelty 持平时 f≈1 ⇒ 交付来源逐字一致"作硬回归门 |

**明确不做**
- ❌ 不删任何现有引擎卡（`21 §7.1` 实测砍 P2 是负收益）。
- ❌ 不改 `page()` / fp 五段链路（已稳定，动了要重跑 fp 全套）。
- ❌ 不把 Exa 放进并行聚合。
- ❌ 不为 API 通道改 `ws-transport.js` 的 GET 语义（另开 `ws-api.js`）。
- ❌ 不发明 `kind:'api'` 第三态枚举。
- ❌ 不在 `engines/api/` 子目录放卡。
- ❌ 不做 clickworthy/质量分（无点击信号，编出来是假数据）。
- ❌ 不给老 17 家拼 HTML URL 时间参数（脆弱面，拼错即全线 0）。

---

## 八、要主人拍板的六件（其余泡泡可自决）

1. **P0 三件要不要一次落**（截止时间 + 冷却 + 缓存）。三件都不动引擎卡、不改返回格式，只影响耗时与稳定性；预计 3.3 s → **<1.1 s**（缓存命中）/ 稳定 ~2 s（未命中）。
2. **"最近 N 天"走哪条**：**A** 只把日期给模型（零参数、零门改动，推荐先做）；**B** 新增 `days`（要抬 `ctx.md` 红线 + 改 `EXPECTED_PARAMS`，属 token 预算变更）。
3. **N12 做不做**（配额 = 样板 × 表现 = 改交付分布，两票面）。子拍两条：档案存**内存**还是**长久库**（跨进程才有"表现"可言，但多一处常态写面）、**ε-探索位给 1 条还是 2 条**。**此项不拍，P1 接引擎在 limit=10 下等于白接（实验 A/B 双证）。**
4. **API 引擎接不接、先接哪家**：泡泡建议 **Parallel 起手**（唯一有可靠日期 + 有正文摘录），**但必须同时决定交付层是否放开 180 字**——不放开就别接，接了也是白接（§1.4）。若 N12 暂未过，可走过渡态：新卡不进默认聚合、`engines:['tinyfish']` 白名单点名可达（实测指定路径不受配额管，10 条全出），代价是 ctx.md 加一行提示、动 `DESC_MAX_BYTES` 预算。
5. **缓存命中的交付文本**：照抄原值 / 标 0ms / 加 `· cache:hit`？泡泡建议**标注，别骗模型**。
6. **`media` 死参数怎么收**：真接线（图片腿进 `search()`）还是删 ctx.md 文案（省 ~20 B 补 14 B 缺口）。

---

## 九、落地流程（照 `Updating\Readme.md`，不许跳）

1. **立项**：新建 `Updating\NN-CTX OP SEARCH升级（Updating）\`，写 `1-立项书.md`（四段）+ `2-开发日志.md` + 空 `BACKUP\`。本轮改动的每个文件**改前先拷进 `BACKUP\`** 并记 SHA256 前 8 位。
2. **施工顺序**：§四 总原则第 5 条。每步都能单独回滚。
3. **第 1 道门（本仓内）**，每阶段完跑：
   ```
   <node> engine\index.mjs --selftest
   <node> engine\verify\all-blocks.mjs
   <node> engine\verify\t-cases.mjs
   <node> engine\verify\bridge-contract.mjs
   <node> engine\verify\release-check.mjs      ← ⑫ 14 名导出面 + parseBing fixture 三项不许变红
   <node> engine\verify\tool-surface.mjs --dir <成品根>
   <node> engine\verify\assemble-release.mjs   ← 先跑装配，D1 哈希门在末尾
   ```
4. **第 2 道门（装 DSH 后）**：完全退出 DSH → `scripts\reinstall-from-repo.ps1` → 重开 → 真调 `ctx({op:"search"})` 各形态 → `install-slot-check.mjs` + `tool-surface.mjs --dir <槽B>`。
5. **收尾**：去 `（Updating）` → `总开发日志.md` 记一行 → 更新 `CTX工具结构图.md` → 同步主仓 → 装载。

> ⚠️ 上面所有 `<node>` 一律用 `C:\Users\Diccup\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（本机 PATH 无 node，实测）。

---

## 附 · 复现要点（本轮全部实测，原样可跑）

```powershell
$NODE = 'C:\Users\Diccup\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 1) 聚合两次耗时 + 正文是否相同（§1.1）：同进程连跑两次 search(q,{limit:10}) 比 body 与 ms
# 2) 逐家耗时（§1.2）：对 Object.keys(ENGINES) 逐个 run(q,10,{getHtml,timeoutMs:5000,allowBridge:false}) 计时
# 3) 429 真实行为 + POST 是否通（§1.3）：本机 http 服务回 429/Retry-After 连打两次数服务端请求数；
#    再发 {method:'POST',body} 看服务端看到的是 GET 还是 POST
# 4) 四家 API 连通与形状（§1.4）：
#    POST https://mcp.parallel.ai/mcp        Accept: application/json, text/event-stream
#    POST https://agent.tinyfish.ai/mcp      X-TinyFish-Access-Mode: keyless
#    POST https://api.anysearch.com/v1/search
#    POST https://api.keenable.ai/v1/search/public  X-Keenable-Title: dsh-eco
#    Parallel 的 arguments 必须 objective + search_queries(数组) 两个都给，缺一被判 isError（实测踩过）
# 5) Bing RSS 有无日期、tbs 有无效（§1.5）：
#    https://www.bing.com/search?q=…&format=rss&count=10&setlang=zh-CN[&tbs=qdr:d]
#    比两组 link 集合重合度（实测 10/10）与 pubDate 集合（实测完全相同）
# 6) 配额实验 A/B（§1.6）：动态 import overlay/ours/ws-engines.js，直调 computeQuotas/interleaveByRank
#    喂合成分组，不需联网
```

---

## 十、主人的追加要求与判定（2026-11-08 19:1x 轮，编号顺延，不回改前文）

> **主人原话（要点）**：新 6 个引擎按 CTX 插件搜索引擎的形态做 6 个新引擎文件，把**适合我们的规则**并入 OP SEARCH。
> 并问：并入后 limit=10 拿不到名额所以不出现，是不是证明我们的筛选规则有问题。

### 10.1 6 家做几张搜索卡 → **已开放为待决断项，本稿不判**

> 19:2x 轮主人指出：「拆成单卡不就是为了解决 UA 这类情况」——成立。盘上证据：卡片契约的 `ua`/`headers` 每卡自带（现役 baidu 卡即 `ua: MOBILE_UA` + 自定义 headers），单卡声明 UA **零公共层改动**。⇒ 本稿 §四·P1-4 表里"Exa ✗ / Firecrawl ✗"两条判语**作废，降为待议**。
> 各家事实（字段、体积、限流两组并存实测、scrape 未验）已集中列在 **`待决断清单-20261108.md` §B1–B3**，选项与代价齐全，**判断由三窗口讨论共同产出**，产出后回写本稿 §四·P1-4。
> §四·P1-4 表在拍板前只视为**素材与代价清单**，不视为结论。

### 10.2 「只建文件就加进来了」在盘上不成立 —— 4 处硬前置 + 2 处联动

| # | 坑 | 实情 | 出处 |
|---|---|---|---|
| 1 | `ctx.load` **发不出 POST** | 实测 `{method:'POST',body}` 服务端看到 **GET + 空 body**（快腿/桥腿都是）；4 家 API **全 POST JSON** ⇒ **不先造 POST 通道，这 4 张卡一行都写不出来**。这是唯一真正的前置 | §1.3 |
| 2 | **不只加一个文件** | 建卡 ①文件 ②import ③卡数组 ④order 四处齐改；漏挂**只 warn 不报错** ⇒ 测试全绿而卡没上（假绿） | §三③ |
| 3 | **不能放子目录** | 装配门只点名拷 `engines/` 与 `engines-offline/`；装机门扫卡 `readdirSync` **不递归** ⇒ 子目录里的卡永不 import 验证，运行时才炸。**顶层新模块必须逐个进白名单** | §三④ |
| 4 | **`kind:'api'` 非法枚举** | 分层只认 `general`/`vertical`；第三态进不了 P0 也不进垂类统计。⇒ TinyFish/AnySearch/Keenable 用 `general`+`covers:['*']`，Parallel 用 `vertical`+`covers:['news','zh','ph']` | §三③ |
| 联动A | **交付层裁 180 字** | Parallel `excerpts` 1207–2474 字 / AnySearch `content` ≤3840 字 ⇒ 不放开交付层就是"拿 2400 字回来交 180 字"，**白接**。走 `_snippet_raw`（卡片留全量、交付才裁） | §1.4 |
| 联动B | **Parallel 双层壳** | 外层剥 `data:`，内层还有一段"字符串里的 JSON"要二次 `JSON.parse`；`objective` + `search_queries`（数组）必须都给，缺一判 `isError`。SSE 解析放公共叶子件，**4 张卡不许各写一遍正则** | §四·P1-3 |

### 10.3 「适合我们的规则并入」必须分两堆（机制可并，制度不可顺手并）

**能直接并入**（零风险、不动老 17 卡、不改交付文本，泡泡可自决）：
429/失败冷却表 · 结果缓存 · 截止时间 budgetMs · Bing `pubDate` 解析 · 查询归一夹 1..200 · POST 通道 + SSE 剥壳。

**不能自动并入**（动冻结面 / 参数面 / 制度面 —— 属"改规则"，要走两票或主人拍板）：

| 想并的规则 | 撞在哪道面 |
|---|---|
| 交付里露发布时间 | 交付格式是**冻结契约**（§5 frozen），两票面 |
| 新增 `days` / `fullSnippet` | ctx.md **只剩 14 B** + 期望参数清单是**逐字有序 13 项** ⇒ 同改文案 + 改门 + 重算 token 账 |
| API 卡进默认聚合 | 头行 `engines:` 多出名字 = 文本变化，两票面 |
| 配额按实际表现分 | 改交付分布，制度性改动，两票面 |

### 10.4 limit=10 不出现 ⇒ 确实指向筛选规则的问题（定性先记，展开待 §八·3 拍板）

一句话判定：**不是"新引擎不够好"，是配额制度里根本没有"表现"这个输入维度** —— 实验 A/B 双证（§1.6）：优质独货与抄袭垃圾待遇完全相同，都是 0。
⇒ 所以「新引擎按契约插进聚合、limit=10 交付逐字不变」不是接法错了，是**配额面欠账**（主人 N1「要计算可用比例来定比例」这一半从未落地）。
**结论：不修 N12 就接引擎 = 白接；接了却不出货 = 反过来证明 N12 该修。两条互为证据。**
修法、红线、四条回归判据见 §四·N12；拍板项见 §八·3。
