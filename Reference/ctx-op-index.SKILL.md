---
name: ctx-op-index
description: |
  ctx 的写入面：index 入 14 天临时库，remember / pin / unpin / memory 管长久库。
  含四选一互斥、dir 不能 pin、pin 前置判据、64KB 闸、14 天删线等硬边界。
  触发：/ctx-op-index
user-invocable: true
---

# 写入面：index / remember / pin / unpin / memory

## 两库分工

| 库 | 怎么进 | 寿命 | 上限 |
|---|---|---|---|
| 临时库 | `index` / `run` 大输出 | **14 天**删线（命中会续命） | 单块 4096 B |
| 长久库 | `remember` / `pin` | 不掉 | 单行 **64KB** |

长久库 ≤2 席在 recall 里优先占位。

## index

```js
ctx({ op:"index", path:"src/app.js", source:"project:x" })
ctx({ op:"index", dir:"src/", source:"project:x" })          // 每文件 <dir>:<相对路径>
ctx({ op:"index", content:"…文本…", source:"note:xxx" })
ctx({ op:"index", url:"https://…", source:"doc:xxx" })
ctx({ op:"index", path:"a.md", pin:true, category:"决策" })   // 写完就钉
```

- `path` / `content` / `url` / `dir` **四选一**，给两个就报 `ONE_OF_INPUT`。
- 用 `path` 而不是大段 `content`：字节留在本地，不进对话。
- `dir` **不能**配 `pin`：裸目录没有源行，且违反 64KB 闸。
  → 先 `index{dir}` 拿文件 label，再 pin 单个文件，或用 `remember` 写总结。
- `pin` 必须能定位 label：`content` 形态要带 `source`，否则拒绝（写入前就判，不半成功）。
- `pin` 必须带 `category`（`long` / `decision` / `insight` / `runbook` / …）。
- `category` 不给 pin 也能单独用 = 给源打分类（影响 recall 加权）。

## remember

```js
ctx({ op:"remember", title:"标题", content:"正文", category:"经验教训/复盘" })
```

手录长久经验，单行 ≤64KB。适合写"结论"，不适合抄原文。

## pin / unpin

```js
ctx({ op:"pin",   label:"run:shell:2026…", category:"决策" })    // 多块合一进长久库（run:<语言>:…）
ctx({ op:"unpin", label:"项目:xxx" })                               // 反钉，写回临时库重受 14 天删线
```

## memory

```js
ctx({ op:"memory", action:"list", limit:50 })
ctx({ op:"memory", action:"get", id:3 })        // 或 label:"…"
ctx({ op:"memory", action:"setCategory", id:3, category:"决策" })
ctx({ op:"memory", action:"delete", id:3 })     // 唯一允许删长久记忆的入口
ctx({ op:"memory", action:"stats" })
```

`get` 认 `id` **和** `label` 两种键。

## 纪律

- 不要 `index` 依赖目录、构建产物、密钥、生成物。
- 已经在对话里的内容不要再 `index` 一遍。
- 临时库会过期：**要留住的结论必须 `remember` 或 `pin`**，否则 14 天后没了。
