> [!IMPORTANT]
> **本项目由 AI 辅助生成（AI-generated / AI-assisted）。**
> 代码与文档均经人工审阅与本机验证，但**可能**存在缺陷或不准确之处，使用前请自行复核。
>
> **免责声明：本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
> 使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
> 请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。**
> 完整声明见 [DISCLAIMER.md](./DISCLAIMER.md)。

# dsh-fp-search（FP）

独立的网页能力插件：**搜索 / 取正文 / 取原件 / 自检**，一个工具位 `fp`，三个 op。

> 本插件是**独立插件**：不依赖、不修改、不 import `dsh-eco-context`（CTX）的任何文件或服务。

## 工具面

```
fp({op:"search", query, engines?, limit?, media?, fullSnippet?})   聚合搜索（22 家活引擎）
fp({op:"search", url})                                             取正文（裸抓 → http→waf→tls→render→cdp 五段降级）
fp({op:"fetch",  url, outDir?, maxBytes?})                         取原件落盘（原始字节）
fp({op:"doctor"})                                                  唯一运维面（六段体检）
```

## 装

默认受限沙箱下模型写不了 `%USERPROFILE%\.dsh\plugins\`，所以装载必须由人来做：

1. **完全退出 DSH**（主窗口 + 托盘）
2. 双击 `scripts\install-fp.ps1`
   （自动探测 DSH 根与 profile 目录 → 铺文件 → 注册 profile `package.json` 的两条
   → `pnpm install` 建链接。找不到 DSH 会提示退出，不会乱写。）
3. 重开 DSH，让模型真调一次 `fp({op:"doctor"})`

卸载：双击 `scripts\uninstall-fp.ps1`。

也可以**手改**（照 sdel/eco 那套：拷文件夹 → 在 profile `package.json` 加
`dependencies` 与 `dsh.profile.bundles` 两条 → 跑 `pnpm install`）。
DSH 不扫 `plugins\` 目录 —— 光放文件夹不注册，永远不会加载。

## 结构与门

```
platform\   平台匹配层（plugin / catalog / tool-def / skill-set），零业务
engine\     契约 contract.mjs（唯一真源）+ registry + 6 块 + 8 道门
  blocks\   01-core / 02-net / 03-fetch / 04-doctor / 05-outgate / 14-tools
  verify\   all（一键七门）/ tool-surface / plugin-load / gate-selfcheck /
            ssrf-gate / assemble / outgate / install-dryrun / e2e-live
（后两个在 `engine\verify\` 下）
ours\       网络面素材（自有实现）
fp\         五腿反爬本体
deps\pylibs curl_cffi（TLS 指纹腿用）
```

**一键验**（用随包 node 的绝对路径，本机 PATH 上没有 node）：

```powershell
# node 路径按下面顺序探测：PATH 里的 node → %USERPROFILE%\.dsh\dsh-runtimes\...\node\bin\node.exe
& 'C:\Users\<你的用户名>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' `
  '.\engine\verify\all.mjs'
```

期望 `== 全门绿 ==` / `EXIT=0`。另有 `engine\verify\install-dryrun.mjs`（装机预演 8 项）
与 `engine\verify\e2e-live.mjs`（端到端真调用 7 项，联网）。

## 能力边界（不是 bug）

- `render` / `cdp` 两腿**能用，但需本次调用授权 `danger-full-access`**：Chromium 多进程模型
  要建 Mojo 命名管道，受限 token 下必被拒（`0x5`）。这是**沙箱边界，不是能力缺失**——
  本次工具调用带 `sandbox_permissions=danger-full-access`（宿主会请主人审批）即可正常运行，
  默认沙箱下失败会自动降级到 http/waf/tls 三腿。换落点没用，要的是授权。
- `scrapling` 腿一直缺件（随包 python 没有这个包），doctor 如实报，不假装是能力。
- 某些引擎会因风控返回 `EMPTY` / `FAIL`（如 sogou 出验证码），doctor 逐家点名。
- **包路径必须纯 ASCII**：非 ASCII 会让 libcurl 打不开 `cacert.pem`（curl 77），TLS 腿必坏。
  doctor 的 `[2]` 段会报这条。
- 抓取只读公开页：**不绕验证码、不碰付费墙**。

## 许可

MIT，见 `LICENSE`。
