# FP · 网页搜索 / 取正文 / 取原件

> 插件名 `dsh-fp-search`，工具位 `fp`，三个 op：`search` / `fetch` / `doctor`。
> 本插件是**独立插件**（主人 2026-11-09 定）：不依赖、不修改 CTX 的任何文件或服务。

## 什么时候用

| 想做 | 用 |
|---|---|
| 查资料、找网页 | `fp({op:"search", query:"…"})` |
| 把一个网页的正文取下来 | `fp({op:"search", url:"…"})` |
| 下载文件（PDF/图片/压缩包等） | `fp({op:"fetch", url:"…"})` |
| 不知道哪家引擎能用、环境有没有问题 | `fp({op:"doctor"})` |

## op:search —— 两形态

```
fp({op:"search", query:"DeepSeek", engines:["bing"], limit:5})
fp({op:"search", query:"DeepSeek", fullSnippet:true})      // 摘要不裁到 180 字
fp({op:"search", query:"猫", media:"image"})               // 图片
fp({op:"search", url:"https://example.com/article"})        // 取正文
```

- 不给 `engines` = **22 家活引擎全量聚合**；给一家就是单家模式。
- 交付格式 = CTX 1.0.0 冻结面（`引擎 · N hit(s) · 毫秒 · query`，条目 `[n] (引擎) 标题`）。
- 取正文时会自动降级：裸抓 → `http → waf → tls → render → cdp` 五段。
  两级死因都会报出来（`— fp: …`），不会只给一个"失败"。
- **只跑裸抓、不降级**：`fp({op:"search", url:"…", noFpFallback:true})`。
- **每腿超时秒数**（默认 5）：`fp({op:"search", url:"…", fpLegTimeoutSec:10})`。

## op:fetch —— 取原件

```
fp({op:"fetch", url:"https://example.com/a.pdf"})
fp({op:"fetch", url:"…", outDir:"D:\\downloads", maxBytes:10485760})
fp({op:"fetch", url:"反扒站上的文件", legs:"always"})
fp({op:"fetch", url:"大文件.tgz", background:true})     → 立即返回 jobId，不阻塞
fp({op:"fetch", job:"<jobId>"})                        → 查当下进度
```

- 落的是**原始字节**（不是文本、不是字符数），PDF/图片能直接打开。
- 默认落点：系统临时目录下的 `dsh-fp-download`（可用环境变量 `FP_OUT_DIR` 覆盖），也可用 `outDir` 覆盖。
- `legs`：`auto`（默认，裸抓失败降级反扒腿）/ `always`（直接走反扒腿）/ `off`（只用裸抓）。
- **★ 后台下载 + 实时进度（11 片，大文件首选）**：
  - `background:true` ⇒ **本次调用立即返回 jobId**（实测约 14ms），下载在宿主 python 子进程继续跑，会话不被占住；
  - `fetch({job:"<id>"})` ⇒ 随时查**当下**：`fetch · job <id> · working · 22.5% · 1310720/5825770 bytes · 4s · 316 KB/s` + 相位/腿；
    终态 `done` 带 `saved:` 与 `via:`；另有 `failed/blocked/timeout/lost` 五种如实状态；
  - **形态边界（如实）**：进度是**主动轮询的当下快照**，不是自动蹦的进度条——宿主无推送通道（06 S1 契约级实锤）。
    要"下了多少/多久/百分比"，调一次 `fetch({job})` 就有；
  - 作业只在 `background` 下产生；同步 `fetch` 仍是原行为（阻塞到落盘）。
  - 作业台账 `<outDir>\.fpjob\<id>.json`，>1h 自动清扫；SSRF 闸对 `background` 同样生效。
- **卡死修复（11 片 P0）**：Node 裸抓加 120s 超时，挂起连接不再让调用永冻（原行为会让会话半天不动）。
- **实时进度（06 片）**：反扒腿下载期间在 `<落盘名>.fpdl.json` 写进度小文件
  （已收字节/总长/均速/当前腿，≥0.4 秒一跳；`http` 腿逐块真进度，`waf/tls` 腿只有相位——
  curl 全量入内存，拦不住，如实限定）。**完成/失败即删除**（消失=终态）；它是 `fp_` 前缀家族，
  清扫自动覆盖。交付文本的 via 行汇总总用时与均速（`· Ns · N KB/s`）。Node 裸抓路（无 via 行）不受影响。
- **缺 op 一律如实报错（06 A 案，主人 2026-11-19 定）**：不再返回 op 帮助表（旧行为把调用故障
  洗白成成功）；要能力面自述 ⇒ `op:"doctor"`。

## 非文本文件：SEARCH 短路，请改用 FETCH

`op:"search"` 的 `url` 形态只对**文本页面**有意义。命中非文本内容（图片/视频/音频/PDF/压缩包/
可执行/二进制流等）时，SEARCH **不取正文**，直接报：

```
<url> · file · 图片 · image/png · 15770 bytes
    非文本文件，SEARCH 取正文无意义（只会得到乱码）；下载原始文件请用 fp({op:"fetch", url:"…"})。
```

- 识别双信号：`content-type`（主）+ URL 后缀（辅，裸抓被反爬拦时只能靠后缀识别）。
- 五段降级扛过反爬后拿到的若仍是文件，同样不交乱码。

## op:doctor —— 唯一运维面

一条命令看清六件事：
1. 素材装配（`ours` / `fp` / `pylibs`）齐不齐
2. **包路径是否纯 ASCII**（非 ASCII ⇒ TLS 腿必坏，报错是 `curl: (77)`）
3. 桥：python 在不在 + `curl_cffi` 能不能导入
4. 五腿能力面：`http/waf/tls` 沙箱内可用；**`render/cdp` 可用，但需本次调用授权 `danger-full-access`**
5. 落点可写 + 盘剩余
6. 活引擎逐家 `OK / EMPTY / FAIL`（标题数 = 实际点名行数，07 起自洽对账）

## 能力边界（别当成 bug）

- **`render` / `cdp` 两腿能用，但需本次调用授权 `danger-full-access`**：默认沙箱下 Chromium
  多进程模型要建 Mojo 命名管道，受限 token 必被拒（`0x5`）。**这不是能力缺失**——
  本次工具调用带 `sandbox_permissions=danger-full-access`（宿主会请主人审批）即可正常运行；
  默认沙箱下失败会自动降级到 http/waf/tls。需要渲染时**主动申请授权**，别当它不存在。
- **`scrapling` 腿一直缺件**（随包 python 没这个包），doctor 会如实报，不假装是能力。
- 抓取只读公开页：**不绕验证码、不碰付费墙**。
- 某些引擎会因风控返回 `EMPTY` 或 `FAIL`（如 sogou 出验证码），属正常，doctor 会逐家点名。
