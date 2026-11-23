/**
 * engines-offline/netdisk.js — 离线占位卡（永不 import）· 抛错桩
 *
 * 来源：1.0.0 `ws-engines.js:515-517`（ENGINES.netdisk）。
 *
 * ★ 02 规矩 7（C-4 定稿）：netdisk **不进活目录**（否则 renderAggregate 头行
 *   `engines:` 多一个 netdisk = 对外返回文本变），**也不整表消失**
 *   （single-engine 路 `engine:'netdisk'` 现抛
 *   `failure('netdisk','unavailable','netdisk channel reserved, not implemented')`，
 *   消失后变成 `unknown engine` = 行为变）。
 *   ⇒ **公共层留桩 + 单引擎路由表含桩，码与文案完整不变**；本文件是占位卡
 *   （清单 A3 要求 offline 目录先放 netdisk.js），调度器**永不 import**。
 *
 * 恢复/启用方式：本卡是"留口"（维护方裁决：先不做，留 opt-in 接口），
 * 真正启用时要在公共层实现 run，并决定是否进活目录。
 * · 禁 TLA（钉死项 7）。
 */

export default {
    id: 'netdisk',
    order: null,          // offline 卡不参与活表键序
    kind: 'general',
    covers: ['*'],
    nativeRank: 'relevance',
    quota: null,
    ua: null,
    headers: null,
    // 与 1.0.0 公共层桩**完整一致**的失败码与文案（钉死项 7）。
    run: async () => {
        const error = new Error('[netdisk] unavailable: netdisk channel reserved, not implemented');
        error.engine = 'netdisk';
        error.code = 'unavailable';
        throw error;
    },
    trash: null,
};
