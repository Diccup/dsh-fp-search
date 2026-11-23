# LASTVERSION

> 本文件由 `comupdate\tools\publish.ps1` 从实测数据自动生成，**不要手改**（手填必漂）。

| 项 | 值 |
|---|---|
| 插件名 | dsh-fp-search |
| 版本 | 0.1.1 |
| 来源仓 | F:\workspace\LongMem\Work\dsh-fp-search |
| 来源提交 | （Work 仓非 git 仓；以同步时间为准） |
| 同步时间 | 2026-11-23 19:04:19 |
| 成品件数 | 249 |
| 清单根哈希 | AA5549A691E51087B608102AADD6E2CC5E316FAA8F428272B757DBB9C5D3F58F |
| 门结论 | EXIT=0；EXIT=0 ✅  G1  index --selftest（引擎自检） | EXIT=0 ✅  G2  tool-surface（工具面一致性） | EXIT=0 ✅  G3  plugin-load（平台层装载·桩宿主） | EXIT=0 ✅  G4  gate-selfcheck（门的门·反例验证） | EXIT=0 ✅  G5  ssrf-gate（SSRF 闸 + 原始字节 + 清扫） | EXIT=0 ✅  G6  assemble --verify（素材与 src 完整节一致） | EXIT=0 ✅  G7  outgate（交付闸 · 40 KB 上限） | EXIT=0 ✅  G8  register-gate（profile 注册·改坏 DSH 的风险闸） |
| GitHub commit | 52280b28f79b77c0b9ccfe698539d08b2a46bfb1 |

## 本次更新内容（来自 `RELEASE-NOTES.md` 待发条目区，共 1 条）

- **[P0] 发布链路**：发布链路 | 打通"改完→发 GitHub"整条链：新增 `comupdate\tools\publish.ps1` 等 5 件工具；修 Public 仓 216 件开发内容混入、git 历史分叉、CRLF 致 CI 假红、备份仓与公共仓共用 remote 四断点
  - 证据：CI run 45160167255 = success；Public 对拍 0；备份仓对拍 0
  - 日期：2026-11-23

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
