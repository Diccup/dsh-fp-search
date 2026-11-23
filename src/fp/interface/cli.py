"""CLI 入口：fpwebsearch.py <URL> [options]，默认输出一行 JSON 契约。"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from support.verdict import dumps as verdict_dumps

LEGS = ("http", "waf", "tls", "render", "cdp")
VERSION = "0.1.0"


def _leg_help() -> str:
    return (
        "legs order: http -> waf -> tls -> render -> cdp\n"
        "  http   : stdlib urllib, fastest, fails on TLS fingerprint checks\n"
        "  waf    : curl_cffi with browser TLS fingerprint, handles most WAFs\n"
        "  tls    : curl_cffi impersonate (chrome136), strongest fingerprint layer\n"
        "  render : headless render (text fallback) for JS-required pages\n"
        "  cdp    : real-browser CDP leg, slowest, last resort"
    )


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(
        prog="fpwebsearch.py",
        description="unified web fetch: five-leg fallback, one-line JSON verdict",
    )
    parser.add_argument("url", nargs="*", help="target URL(s)")
    parser.add_argument("--probe", action="store_true", help="status/title/chars only, no body file")
    parser.add_argument("--force-leg", choices=list(LEGS), default=None,
                        help="run only this leg (argparse rejects invalid values)")
    parser.add_argument("--timeout", type=int, default=20, help="per-request timeout seconds (default 20)")
    parser.add_argument("--out-dir", default=None, help="output directory (default project out/)")
    parser.add_argument("--out-file", default=None,
                        help="write verdict JSON to this exact path (bridge mode; written even on failure)")
    parser.add_argument("--json", action="store_true", help="print JSON only (no human-readable lines)")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON with indent")
    parser.add_argument("--quiet", action="store_true", help="suppress stderr diagnosis on failure")
    parser.add_argument("--version", action="version", version=f"fpwebsearch {VERSION}")
    parser.add_argument("--list-legs", action="store_true", help="print leg order explanation and exit")
    parser.add_argument("--batch", action="store_true", help="treat positional urls as a batch")
    # ★ 04 片（2026-11-19）：原始字节下载模式（反扒文件腿）。与文本路互斥、零干扰。
    parser.add_argument("--raw", action="store_true",
                        help="raw-bytes download mode (http->waf->tls legs only; no decode)")
    parser.add_argument("--dest", default=None, help="--raw: exact destination file path (caller names it)")
    parser.add_argument("--pylibs", default=None, help="--raw: deps/pylibs dir for curl_cffi")
    parser.add_argument("--max-bytes", type=int, default=None, help="--raw: byte cap, default 64 MiB")
    parser.add_argument("--legs", default=None, help="--raw: comma subset, e.g. waf,tls")
    # ★ 06-P1（2026-11-19）：--raw 进度小文件开关（宿主无工具进度通道 ⇒ 文件面外显）
    parser.add_argument("--progress", action="store_true",
                        help="--raw: write <dest>.fpdl.json progress sidecar while downloading")
    parser.add_argument("--urls-file", default=None, help="file with one URL per line")
    args = parser.parse_args(argv)

    if args.raw:
        _raw_main(args)
        return

    if args.list_legs:
        print(_leg_help())
        return

    urls = list(args.url or [])
    if args.urls_file:
        try:
            with open(args.urls_file, encoding="utf-8") as f:
                urls.extend([ln.strip() for ln in f if ln.strip()])
        except Exception as exc:
            parser.error(f"cannot read urls file: {exc}")
    if not urls:
        parser.error("URL required (or use --list-legs)")

    from support.orchestrator import fetch
    kwargs = dict(probe=args.probe, force_leg=args.force_leg,
                  timeout=args.timeout, out_dir=args.out_dir)
    if len(urls) == 1 and not args.batch and not args.urls_file:
        try:
            verdict = fetch(urls[0], **kwargs, emit=False)
        except Exception as exc:
            if args.out_file:
                # 桥模式：异常也要落一份失败契约，让调用方拿到死因（管道不可靠，全走文件）
                try:
                    Path(args.out_file).write_text(
                        json.dumps({"ok": False, "site": urls[0], "leg": None, "chars": 0,
                                    "diagnosis": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False),
                        encoding="utf-8")
                except Exception:
                    pass
            if not args.quiet:
                print(f"fetch failed: {type(exc).__name__}: {exc}", file=sys.stderr)
            sys.exit(1)
        text = verdict_dumps(verdict)
        if args.pretty:
            text = json.dumps(verdict, ensure_ascii=False, indent=2)
        print(text)
        if args.out_file:
            try:
                Path(args.out_file).write_text(text, encoding="utf-8")
            except Exception:
                pass
        if not verdict.get("ok") and not args.quiet:
            reason = verdict.get("diagnosis") or "all legs failed"
            site = verdict.get("site") or urls[0]
            print(f"failed: {site}: {reason}", file=sys.stderr)
            sys.exit(1)
        return

    from spider.framework import crawl
    try:
        results = crawl(urls, **kwargs)
    except Exception as exc:
        if not args.quiet:
            print(f"batch failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
    text = json.dumps(results, ensure_ascii=False)
    if args.pretty:
        text = json.dumps(results, ensure_ascii=False, indent=2)
    print(text)
    if any(not (r or {}).get("ok") for r in results) and not args.quiet:
        sys.exit(1)


def _raw_main(args) -> None:
    """--raw 模式：跑 support.rawdl 三腿，结果 JSON 写 --out-file（桥契约同例：失败也落盘）。"""
    import os
    if args.pylibs:
        p = os.path.abspath(args.pylibs)
        if p not in sys.path:
            sys.path.insert(0, p)
    from support import rawdl
    if not args.url:
        print("raw mode: URL required", file=sys.stderr)
        sys.exit(2)
    legs = [x.strip() for x in args.legs.split(",") if x.strip()] if args.legs else None
    dest = Path(args.dest) if args.dest else None
    if dest is None:
        print("raw mode: --dest required", file=sys.stderr)
        sys.exit(2)
    verdict = rawdl.safe_download(
        args.url[0], dest,
        timeout=args.timeout or 8,
        max_bytes=args.max_bytes or rawdl.DEFAULT_MAX_BYTES,
        legs=legs,
        progress=bool(getattr(args, "progress", False)),
    )
    text = json.dumps(verdict, ensure_ascii=False)
    if args.out_file:
        try:
            Path(args.out_file).write_text(text, encoding="utf-8")
        except Exception as exc:
            print(f"raw: cannot write out-file: {exc}", file=sys.stderr)
    if not args.quiet:
        print(text)
    if verdict.get("blocked"):
        sys.exit(2)
    if not verdict.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
