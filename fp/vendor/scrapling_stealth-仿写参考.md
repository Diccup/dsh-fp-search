# scrapling_stealth.py —— 仿写参考（归档件原理拆解）

> **本文件不是代码，是"如果哪天要按她的原理自己写一个"时的施工参考。**
> 素材：`src/fp/vendor/scrapling_stealth.py`（41KB，归档死代码，无调用方）。
> 出处：复制自 D4Vinci/Scrapling（BSD-3-Clause, © 2024 Karim shoair），**本副本无版权头 = 合规缺口**，仅供内部阅读。按原理**重写**则不受其许可约束。
> 建档：2026-11-21（主人定：留着注明，以后按原理自研）。

---

## 一、它整体是个什么

一句话：**给抓取程序用的「隐身浏览器会话管理器」**——不是给模型当浏览器界面，是让"机器访问"看起来像"真人访问"。

三个类的骨架（原文件结构）：

```
class StealthySession(SyncSession, StealthySessionMixin)         # 同步版
  ├── __init__(**StealthSession)        收配置：headless/代理/CF 求解/持久化目录…
  ├── start()                           起 playwright → 连或launch Chromium → new_context
  ├── _cloudflare_solver(page, _attempts)   CF 挑战识别 + 求解（核心）
  └── fetch(url, **StealthFetchParams)  取页 + 重试 + 代理轮换 + 返回 Response

class AsyncStealthySession(AsyncSession, StealthySessionMixin)   # 异步版（同结构，async）
```

**关键判断**：它的价值 **80% 在 `_cloudflare_solver`**，其余是 Playwright 的常规封装。如果只为"过 CF"，不需要抄整个文件。

---

## 二、核心原理：Cloudflare 求解器逐段拆

这是最值得学的部分。它不是"暴力点验证码"，而是**先分类、再对症**：

### 2.1 先分类（这步最关键）

```python
__CF_PATTERN__ = r"^https?://challenges\.cloudflare\.com/cdn-cgi/challenge-platform/.*"
__CF_MAX_SOLVE_ATTEMPTS__ = 3
```

轮询 51 次（每次间隔 ≤100ms，总窗口 5 秒）去 `_detect_cloudflare(页面内容)`，得出挑战类型：

| 类型 | 特征 | 处理方式 |
|---|---|---|
| `non-interactive` | 纯等待页，无交互 | **什么都不做**，轮询等它自己消失（最多 10 次 × 1s），然后校验是否已过 |
| `embedded` | 挑战 iframe 已嵌入页内 | 找到 iframe → 等 iframe 稳定 → **点 checkbox**（带 100~200ms 随机延迟）→ 等 networkidle |
| `managed` / 其他 | 需交互的完整挑战 | 先等 spinner 解析成 widget iframe（最多 20 次 × 500ms）→ 再按框选点 |

**分类靠的是页面内容特征匹配**（`_detect_cloudflare` 看的是 `ResponseFactory._get_page_content(page)` 拿到的 HTML），不是靠 URL 猜。

### 2.2 三种"等待"的分工（这是精髓）

原实现里有三种不同的等待，各管一段，**混用就会出问题**：

| 方法 | 等什么 | 用在何时 |
|---|---|---|
| `_wait_for_networkidle(page, timeout)` | 网络静默 | 点完 checkbox 后，等 CF 的验证请求发完 |
| `_wait_for_page_stability(page, ...)` | DOM 不再变化 | iframe 加载完 / 挑战动画结束 |
| `page.wait_for_load_state()` | load 事件 | 兜底 |

> **FP 现状对照**：我们的 `cdp.py` 原来是"死等 `readyState=complete`"，ITERATION-006 改成"`interactive` + DOM 大小稳定"。**原理上是同一个东西**——她的 `_wait_for_page_stability` 就是我们的"DOM 稳定"判据，只是她做成独立方法、可复用于 iframe。

### 2.3 防"点了没反应"的细节

```python
iframe.locator('input[type="checkbox"]').click(timeout=10000, delay=randint(100, 200))
```

- `delay=100~200ms` 随机：模拟真人按下-抬起的间隔（真人不可能是 0ms）
- 点之前先 `_wait_for_page_stability(iframe, True, False)`：**等 iframe 稳定再点**，否则点到渲染一半的元素必然失败

---

## 三、其余可仿的部分

### 3.1 启动配置的两条分支（结构清晰，值得照抄形状）

```python
if self._config.cdp_url:                                    # ① 连已有浏览器
    self.browser = playwright.chromium.connect_over_cdp(endpoint_url=self._config.cdp_url)
elif self._config.proxy_rotator:                            # ② 需轮换代理 → 普通 launch
    self.browser = playwright.chromium.launch(**self._browser_options)
    self.context = self.browser.new_context(**self._context_options)
else:                                                       # ③ 持久化上下文（存登录态）
    self.context = playwright.chromium.launch_persistent_context(**persistent_options)
```

**要点**：三种场景分开走，不硬塞一个分支。特别是 `launch_persistent_context` —— 持久化 `user_data_dir` 才能保住 cookie/登录态，这是"抓登录墙后的内容"的前提。

### 3.2 代理轮换 + 坏代理剔除

```python
for attempt in range(self._config.retries):
    proxy = self._config.proxy_rotator.get_proxy()          # 每次重试换一个
    ...
    if is_proxy_error(e):                                    # 识别"是代理坏了"而非"目标站坏了"
        log(f"Proxy '{proxy}' failed (attempt {attempt+1}), retry in {retry_delay}s")
        time_sleep(self._config.retry_delay)
```

**可仿点**：`is_proxy_error()` 这个判据——**区分"代理不可用"和"目标站拒绝"**，前者换代理重试，后者换代理也没用。FP 的 `providers/network.py` 里 `proxy_pool: None` 还是占位（基线 08 记着），这块可直接借思路。

### 3.3 防泄漏与记录

- `block_webrtc`：代理模式下强制 WebRTC 走代理，**防真实 IP 泄漏**（不用代理的人感知不到，用了代理不开这个等于白用）
- `record_requests` / `max_recorded_requests`：录请求（调试/审计用），有上限防内存爆

---

## 四、不可仿 / 慎仿的部分（诚实清单）

| 项 | 为什么不建议照抄 |
|---|---|
| **`patchright` 依赖** | 它是 Playwright 的反检测魔改分支，版本跟进慢、和上游 Playwright 会分叉。**我们的 cdp 腿用原生 CDP 协议，已证明能拿到 12,927 字符正文，没必要换** |
| **Scrapling 全家桶** | `scrapling.core._types` / `engines.toolbelt.proxy_rotation` / `engines._browsers._base` 等 import 把整个框架耦合进来，几十 MB。与"FP 独立插件不引 scrapling"约束冲突 |
| **`ResponseFactory` / `Response`** | 这是 Scrapling 的响应封装，和我们自己的 verdict 结构不兼容，照抄等于引入两套数据结构 |
| **`StealthySessionMixin` 继承链** | 依赖 Scrapling 的基类，脱离框架无法复用 |
| **CF 求解的"点 checkbox"** | ⚠️ **注意边界**：我们的基线 12 红线是「只读公开页、不绕验证码」。**点 Turnstile 复选框属于灰色地带**——FP 现有 `challenge/cf.py` 也是这么做的（历史遗留），但**新写的东西不该扩大这块**，要按主人对红线的界定来 |

---

## 五、如果真要自研，建议的路线

**目标**：不引 scrapling/patchright，用零/少依赖实现"链式浏览器外观 + CF 分类处理"。

### 阶段一：先做"分类器"（零依赖，最安全）
- 写一个 `detect_challenge(html) -> type`：识别 `non-interactive` / `embedded` / `managed` / 无挑战
- **只用正则/结构特征判 HTML，不碰浏览器**
- 价值：现有 `cdp.py` 的 `cf_detect_state` 已有雏形（`interstitial`/`managed`/`widget`/`turnstile-iframe`），**优先在它上面扩展，而不是新写一套**

### 阶段二：把"三种等待"提炼成独立工具（复用价值高）
- `wait_network_idle(session, timeout)` / `wait_dom_stable(session, ...)`
- 用 CDP 的 `Page.lifecycleEvent`（`networkIdle`）比轮询 `readyState` 更准
- 落点建议：`fp/drivers/cdp.py` 内部，先内部复用，不要急着公开

### 阶段三：代理池 + 坏代理剔除（独立于浏览器，先做这个）
- `is_proxy_error(e) -> bool` 的判据（连接拒绝/超时/407 → 代理问题；403/429 → 目标站问题）
- 接 `fp/support/config.py` 的 `FPWEB_PROXY` 兼容（单代理 = 池长 1）
- 落点：`fp/providers/network.py` 把 `proxy_pool: None` 占位补实

### 阶段四（最后做，且需主人明确授权）
- 隐身外观增强：这是在"对抗检测"上走得更远，**必须先把红线谈清楚**再动手
- 可选替代：与其追 patchright，不如加固 `providers/` 现有 13 件画像（基线 05 那套）

---

## 六、一句话结论

**值得学的是"分类后对症下药"这个思路和三种等待的分工；不值得抄的是它对 Scrapling/patchright 的强耦合。**
真要自研，从**阶段二（等待工具）和阶段三（代理剔除）**起步——它们零风险、可独立验证、且 FP 现在确实缺。
