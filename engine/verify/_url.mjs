/**
 * engine/verify/_url.mjs — 路径 → file:// URL 的小工具（Windows 安全）
 *
 * 为什么单独一个文件：`new URL('file:///' + path)` 在 Windows 上会把
 * `F:\a\b` 变成 `file:///F:\a\b`（反斜杠没转），部分 node 版本能容忍、
 * 部分不行。这里统一走 `pathToFileURL`，与 `blocks/02-net` 的写法一致。
 */

import { pathToFileURL } from 'node:url';

export function PathToFileUrl(p) {
    return pathToFileURL(p).href;
}
