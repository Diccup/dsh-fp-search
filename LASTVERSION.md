# LASTVERSION

> 本文件由 `comupdate\tools\publish.ps1` 从实测数据自动生成，**不要手改**（手填必漂）。

| 项 | 值 |
|---|---|
| 插件名 | dsh-fp-search |
| 版本 | 0.2.0 |
| 来源仓 | F:\workspace\LongMem\Work\dsh-fp-search |
| 来源提交 | （Work 仓非 git 仓；以同步时间为准） |
| 同步时间 | 2026-11-24 00:09:54 |
| 成品件数 | 249 |
| 清单根哈希 | 7D2F1702AF058EE7CBBE390D67FC1C5C677AF5E92DB32750EE2064DA75C70FFB |
| 门结论 | EXIT=0；EXIT=0 ✅  G1  index --selftest（引擎自检） | EXIT=0 ✅  G2  tool-surface（工具面一致性） | EXIT=0 ✅  G3  plugin-load（平台层装载·桩宿主） | EXIT=0 ✅  G4  gate-selfcheck（门的门·反例验证） | EXIT=0 ✅  G5  ssrf-gate（SSRF 闸 + 原始字节 + 清扫） | EXIT=0 ✅  G6  assemble --verify（素材与 src 完整节一致） | EXIT=0 ✅  G7  outgate（交付闸 · 40 KB 上限） | EXIT=0 ✅  G8  register-gate（profile 注册·改坏 DSH 的风险闸） |
| GitHub commit | da272be8e029c21b1561b7b6909691aa5224d2c4 |

## 本次更新内容（来自 `RELEASE-NOTES.md` 待发条目区，共 3 条）

- **[P1] fetch**：fetch | **后台下载 + 实时进度**：`fetch{background:true}` 立即返回 jobId 不阻塞，`fetch{job:"<id>"}` 随时查当下字节/百分比/用时/均速/腿/相位（大文件不再卡死会话）
  - 证据：真机三次轮询 0→1.31MB→5.83MB 到 `done · 100% · 902 KB/s`；落盘 size 精确一致 + gzip 魔数正确
  - 日期：2026-11-23
- **[P0] fetch**：fetch | **修 Node 裸抓卡死**：加 120s 超时 + 超时明确死因（原无中止信号，挂起连接会让调用永冻）
  - 证据：当初冻结的 arxiv PDF 现正常下载 2215244B
  - 日期：2026-11-23
- **[---] 技能文档**：技能文档 | `skills/fp/SKILL.md` 补上 background/job 用法与形态边界（原来文档里一个字没提，模型看不到新能力等于没用） | 仓根=槽 `EF90140F`，background 命中 4 处
  - 证据：P2
  - 日期：2026-11-24

## 成品清单（由 package.json files 白名单算出，非手写）

- `platform`
- `engine`
- `ours`
- `fp`
- `deps/pylibs`
- `deps/pylibs_probe.py`
- `skills`
- `scripts`
- `cordis.patch.yml`
- `README.md`
- `LICENSE`
- `ASSEMBLY.json`
- `CHANGELOG.md`
- `RELEASE-NOTES.md`
- `NOTICE`
- `CONTRIBUTING.md`
- `DISCLAIMER.md`
- `.gitignore`
- `.gitattributes`
- `.github/workflows/ci.yml`
