# 装载 dsh-fp-search（维护方双击）

## ⚠ v1 方案是错的，这里记清楚为什么

v1 以为"把文件夹复制进 `%USERPROFILE%\.dsh\plugins\` 就完事"。
**事实：DSH 不扫这个目录。** 光放文件夹、重启多少次都不会加载。

出处（两条，都在本机核过）：
1. 本插件 `INSTALL.md` / `README` 的注册章节 ——
   原话：「**光把文件夹放进 `plugins\` 再重启是没用的**——DSH 不扫这个目录。」
2. 本机 profile 实读 `%USERPROFILE%\.dsh\profiles\<profile名>\package.json` ——
   每个在跑的插件都在 `dependencies` 里有 `link:` 指到 `plugins\<名>`，
   且 `dsh.profile.bundles` 里有它的名字。

## 正确的注册路：三件套，缺一不加载

| # | 在哪 | 内容 |
|---|---|---|
| ① | `%USERPROFILE%\.dsh\plugins\dsh-fp-search\` | 插件实体（本脚本负责复制） |
| ② | profile `package.json` → `dependencies` | `"dsh-fp-search": "link:C:/Users/<你>/.dsh/plugins/dsh-fp-search"` |
| ③ | profile `package.json` → `dsh.profile.bundles` | 数组末尾加 `"dsh-fp-search"` |
| ＋ | profile 目录里跑 `pnpm install` | 让 pnpm 建好 `node_modules` 链接 |

**少任何一样都不加载**：
只有文件夹 → 内核看不见；
只加 dependencies 不加 bundles → 包能 resolve 但没进组合树，没人 `apply()`；
只加 bundles 不加 dependencies → patch 读得到、包解析不到。

## 要不要关 DSH / 能不能热加载

**代码更新（`index.js` / `src/*` / `engine/*`）不用重启** —— 宿主有 HMR，文件换入后当场检出。
`dsh-team` 那边更狠，还有 `POST /api/dsh-team/reload` 自热重载。

**本次是"新装"，要点在 pnpm install 那一步**：它会改 `node_modules`，
DSH 开着时文件可能被占用。所以：

1. 建议**先完全退出 DSH**（托盘右键退出，不是关窗口）再双击本脚本；
2. 装完**先别急着重启** —— 新建一个会话，直接调 `fp({op:"doctor"})`；
3. 出结果 = 宿主 HMR 已经把 profile 树重组好了，**不用重启**；
4. 没反应再完全退出重开（兜底，不是必然步骤）。

> 内核里唯一躲不掉的重启是**包的物理位置变了**（`restartReason: "package-moved"`）。
> 本次是首次安装，位置从"没有"变成"有"，属新增注册，通常 HMR 就能接上。

## 怎么用

双击 `install-fp.ps1`。它会：
1. 检查 DSH 是否在跑（在跑会让你确认）
2. 备份旧插件目录 + profile 的 `package.json` 到 `work\backups\pre-install-<时间戳>\`
3. 复制插件实体到 `plugins\dsh-fp-search\`
4. 改 profile `package.json` 的两处（已有就跳过，指向不对就改对）
5. 在 profile 目录跑 `pnpm install`
6. 核对 `node_modules` 链接 + 跑 `tool-surface --dir` 与 `--selftest`，把结果打给你看

卸载/回滚：双击 `uninstall-fp.ps1`（同样撤三处：dependencies、bundles、实体目录，再 pnpm install）。
