"""爬虫框架：标准库线程池并发跑 orchestrator.fetch，顺序保持输入一致。"""
from __future__ import annotations
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional


def _fetch_one(url: str, probe: bool, force_leg: Optional[str],
               timeout: Optional[int], out_dir) -> Dict[str, Any]:
    """单 URL 抓取；任何异常都折叠成 ok=False 的契约，不向外抛。"""
    # 延迟 import，避免 interface/spider 与 support 的循环依赖
    from support.orchestrator import fetch
    from support.verdict import make_verdict
    try:
        verdict = fetch(url, probe=probe, force_leg=force_leg,
                        timeout=timeout, out_dir=out_dir, emit=False)
        return dict(verdict)
    except Exception as exc:
        return make_verdict(False, url, force_leg or "http",
                            diagnosis=f"{type(exc).__name__}: {exc}",
                            fields={"probe": probe})


def run(urls, workers: int = 2, delay: float = 0.0, probe: bool = True,
        force_leg: Optional[str] = None, timeout: Optional[int] = None,
        out_dir=None, on_result: Optional[Callable[[Dict[str, Any]], None]] = None) -> List[Dict[str, Any]]:
    """并发抓一批 URL，返回顺序与输入一致。

    - workers 并发上限（≤0 时钳到 1）；delay 为相邻提交间隔秒数。
    - 单 URL 失败不影响其他：异常折叠为 ok=False 的契约项。
    - probe 默认 True：批量场景默认只探测不落正文。
    """
    url_list = list(urls)
    results: List[Optional[Dict[str, Any]]] = [None] * len(url_list)
    n_workers = max(1, int(workers))
    if not url_list:
        return []

    def work(index: int) -> None:
        verdict = _fetch_one(url_list[index], probe, force_leg, timeout, out_dir)
        results[index] = verdict
        if on_result is not None:
            try:
                on_result(verdict)
            except Exception:
                pass

    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futures = []
        for i, _ in enumerate(url_list):
            futures.append(pool.submit(work, i))
            if delay and i < len(url_list) - 1:
                time.sleep(delay)
        for fut in futures:
            fut.result()
    return [r for r in results if r is not None]


def stream(urls, workers: int = 2, delay: float = 0.0, probe: bool = True,
           force_leg: Optional[str] = None, timeout: Optional[int] = None,
           out_dir=None) -> Any:
    """生成器版：完成一个产出一个（带 index/url 键，不保证输入顺序）。"""
    from concurrent.futures import as_completed
    url_list = list(urls)
    n_workers = max(1, int(workers))
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futures = {pool.submit(_fetch_one, u, probe, force_leg, timeout, out_dir): (i, u)
                   for i, u in enumerate(url_list)}
        for fut in as_completed(futures):
            i, u = futures[fut]
            try:
                verdict = fut.result()
            except Exception as exc:
                from support.verdict import make_verdict
                verdict = make_verdict(False, u, force_leg or "http",
                                        diagnosis=f"{type(exc).__name__}: {exc}")
            verdict = dict(verdict)
            verdict["index"] = i
            verdict["url"] = u
            yield verdict
            if delay:
                time.sleep(delay)


def crawl(urls, **fetch_kwargs) -> List[Dict[str, Any]]:
    """批量入口：直通 orchestrator.fetch，结果顺序与输入对齐，单条失败隔离。

    fetch 的关键字参数（probe/force_leg/timeout/out_dir/emit 等）通过 **fetch_kwargs 透传；
    任一 URL 异常折叠为 ok=False 的契约项，不影响其他 URL。
    """
    from support.orchestrator import fetch as _fetch
    from support.verdict import make_verdict
    url_list = list(urls)
    results: List[Dict[str, Any]] = []
    kwargs = dict(fetch_kwargs)
    kwargs.setdefault("emit", False)
    for u in url_list:
        try:
            verdict = _fetch(u, **kwargs)
            results.append(dict(verdict) if isinstance(verdict, dict) else verdict)
        except Exception as exc:
            results.append(make_verdict(
                False, str(u), kwargs.get("force_leg") or "http",
                diagnosis=f"{type(exc).__name__}: {exc}",
                fields={"probe": kwargs.get("probe", False)},
            ))
    return results
