# fpwebsearch（扛P）

统一入口的反爬网页抓取支持工具：一次调用完成 HTTP → WAF → TLS → render → CDP 五段降级抓取，
返回固定 JSON 契约，并把正文/结果落到 `out\`。

## 快速开始

```bat
cd /d <本包路径>
"%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" fpwebsearch.py https://example.com
```

选项（以 `interface\cli.py` 为准）：

```bat
python fpwebsearch.py <URL> [--probe] [--force-leg http|waf|tls|render|cdp] [--timeout 20] [--out-dir DIR] [--json] [--pretty]
```

## 返回契约

```json
{"ok": true, "site": "example.com", "leg": "http", "title": "Example Domain",
 "text_file": "...\\out\\example.com.txt", "json_file": "...\\out\\example.com.json",
 "chars": 577, "fields": {"probe": false, "legs_tried": ["http"], "elapsed_ms": 1234, "warnings": []},
 "diagnosis": null}
```

- `leg`：最终成功的那条腿；`ok=false` 时 `diagnosis` 是各腿失败原因聚合。
- `--probe`：只报状态/标题/字符数，不落正文。

## 环境要求

| 依赖 | 说明 |
|---|---|
| Python 3.12 | 用 DSH 打包的 python，别用 PATH 上的 `python`（WindowsApps 假桩，退出码 9009） |
| lxml | `parse.selectors` 用；**不需要** `cssselect`（本项目自带纯 Python CSS→XPath 转换） |
| curl_cffi | TLS 指纹腿；项目 `pylibs\` 里有隔离副本，含 certifi |
| Microsoft Edge | render / CDP 两腿用 |

## 重要限制

1. **Chromium 需要命名管道**：DSH 沙箱会拒绝 Mojo 通道（`0x5 拒绝访问`），`render` / `cdp` 两腿
   只能在 `danger-full-access` 下运行；沙箱内会自动降级为 `http` / `waf` / `tls` 三腿，并在
   `diagnosis` 里说明原因。
2. **CF 托管挑战（managed challenge）在 headless 下通常过不去**：属于浏览器指纹限制；
   `challenge\cf.py` 对 Turnstile 复选框（widget）可点，对整页 JS 挑战只能等待+重载。
   可用 `FPWEB_HEADLESS=0` 走有头模式（该模式仍在调，见开发日志）。
3. 抓取请自控频率，`support\pacing.py` 提供退避与令牌桶。

## 目录

```
interface\    cli / mcp / skill 入口
providers\    画像零件（browser/screen/mouse/keyboard/scroll/timing/network/tls/http2/headers/session/noise/font）
drivers\      http / tls / render / cdp / stealth 通道
challenge\    cf / waf / slider 求解器
parse\        selectors / text / adaptive 解析
support\      orchestrator / assembler / coherence / verdict / detect / pacing / sink / store / config
spider\       并发框架
vendor\       外部可复用实现（cdp_client / page_render / waf_fetch）
tests\        各层自测（标准库断言，直接 python tests\test_*.py）
开发日志.md   逐轮进度与问题记录
```

## 自测

```bat
python tests\test_parse.py && python tests\test_providers.py && python tests\test_assembly.py && python tests\test_stealth.py
```
