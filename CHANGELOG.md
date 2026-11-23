# Changelog

本文件记录 dsh-fp-search 的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-11-21

修复轮：本体检查（2026-11-21）发现的问题已全部处理。

### 修复

- **捆绑技能在宿主里加载必失败（P0）**：`platform/skill-set.js` 注册宿主技能时漏了
  宿主契约的必填字段 `source`（另补 `path` 与显式 `invocation`）。
  宿主 `dsh-skill` 的 `register()` 阶段不查 `source`（注册照样成功、插件日志仍记
  `skills=1`），但 `get()` 阶段会抛 `loaded skill "fp" source must be a string`
  ⇒ 模型永远读不到 SKILL.md 正文。
- **门假绿（P0）**：`e2e-live` 的桩宿主 `skills.register` 原本只记技能名、不跑宿主校验
  ⇒ E-7 恒绿。现改为复刻宿主 `SkillRegistration` 的必填校验，
  E-7 改为断言"注册对象满足宿主加载期契约"。
- **非文本文件短路缺失（P1）**：`SKILL.md` 承诺"图片/PDF/压缩包等不取正文、直接提示改用
  `op:"fetch"`"，但代码里没有该实现（`search{url:png}` 实测返回 34,932 字符二进制乱码）。
  现已并回 03 片的文件识别（`ours/web-search.js` 的 `fileNotice` +
  `ours/ws-transport.js` 的 `content-type`/真实字节数透传），并同步回 `src\` 与基线清单。
- **三道门写死开发机路径（P1，可移植性回归）**：`gate-selfcheck` / `install-dryrun` /
  `ssrf-gate` 的临时目录与 node 路径写死 `F:\workspace\...` 与 `C:\Users\Diccup\...`
  ⇒ 别人机器上没有 F 盘 ⇒ 门直接崩。现改走 `tmpdir()` / `homedir()`（与发布口径一致）。
- **`register-gate` 恒红（P1，判据错不是实现错）**：
  ① R-3 把本包自己的依赖键算进"其它依赖必须不变" ⇒ 恒红；
  ② R-5 断言"反注册后与原文件逐字节相同"，但反注册语义就是删除本包、
     且 `serialize()` 会补一个尾部 LF ⇒ 恒红；
  ③ 样本直接取"真 profile"（里面本包本来就已注册）⇒ 往返没有可比基线。
  现改为：干净 fixture 作样本、R-3 跳过本包键、R-5 改判**语义还原**。
  该门此前**不在一键全门里**，现加入 `all.mjs` 作为 **G8**。

### 变更

- `skills/fp/SKILL.md` 重写：去掉重复小节（`op:fetch`/`op:doctor` 各有两份）、
  补 `noFpFallback` / `fpLegTimeoutSec` 两个真实参数、单列"非文本文件短路"一节。
- `README.md` 与 `skills/fp/SKILL.md` 的 `render` / `cdp` 表述改为
  「**可用，但需本次调用授权 `danger-full-access`**」（此前写"不可用"，与 `doctor` 口径矛盾）。
- `ours/ws-cool.js`：头注标注**当前未接线**（全线 0 引用），避免"冷却已生效"的误解。
- `fp/README.md`：删掉指向不存在的 `tests\` 与 `开发日志.md` 的段落，指明正式验收入口在宿主侧门。
- 三个 PowerShell 脚本（`install-fp.ps1` / `deploy-fp.ps1` / `uninstall-fp.ps1`）补 UTF-8 BOM
  （本机 ANSI 代码页 936，缺 BOM 时 PowerShell 5.1 按 GBK 解析，中文提示必乱码）。
- `package.json` 版本号 `0.0.1` → `0.1.1`，与本文件对齐。

## [0.1.0] - 2026-11-16

首个公开发布版。

### 新增

- 独立网页能力插件：工具位 `fp`，三个 op。
  - `search`：22 家引擎聚合搜索（17 原生 + 5 新增）；传 `url` 时改为取正文。
  - `fetch`：取原件落盘（原始字节，不是文本、不是字符数）。
  - `doctor`：唯一运维面 —— 22 家逐家 OK/EMPTY/FAIL、桥可不可达、五腿能力面、落点可写、盘剩余。
- 五段降级抓取：裸抓 → http → waf → tls → render → cdp。
- SSRF 闸：私网 / 环回 / metadata / `file:` 一律拒；**302 跳内网也拒**（每一跳重过闸）。
- 自带清扫：只删自家 `fp_` 前缀且超过 1 小时的文件，绝不动别人的文件。

### 变更

- **发布版可移植化**：
  - 取原件默认落点由写死的 `F:\...` 改为系统临时目录下的 `dsh-fp-download`
    （环境变量 `FP_OUT_DIR` 可覆盖）。
  - Python 侧的落点目录、curl_cffi 依赖探测路径全部改为探测式。
  - `waf_fetch.py` 的 node 路径改为 `DSH_NODE` 环境变量 → DSH 打包 runtime → PATH 三级探测。
  - 装载 / 卸载 / 部署三个 PowerShell 脚本的 node、pnpm、profile 目录全部改为探测式
    （原先写死用户名与 profile 名 `desktop`）。
  - 五道验收门的临时目录改走系统临时目录，node 路径改走 `homedir()`。

### 已知边界

- `render` / `cdp` 两腿**可用，但需本次调用授权 `danger-full-access`**
  （Chromium 多进程要建 Mojo 命名管道，默认受限 token 必被拒；这是沙箱边界，不是能力缺失）。
- 某些引擎会因风控返回 `EMPTY` / `FAIL`，`doctor` 逐家点名，不假装是能力。
- 包路径必须纯 ASCII，否则 libcurl 打不开 `cacert.pem`（curl 77），TLS 腿必坏。
- 抓取只读公开页：**不绕验证码、不碰付费墙**。
