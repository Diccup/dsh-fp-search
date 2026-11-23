/**
 * engine/libs/log.js — FP 自己的极小日志（零依赖）
 *
 * 为什么不用宿主 logger：`engine/` 要能脱离 DSH 单独跑（`node engine/index.mjs --selftest`），
 *   那时候没有 ctx，也没有任何外部包。CTX 当年就是被"离开宿主的 zod 就炸"坑过。
 * 边界：只在 stderr 打；**绝不往 stdout 打**（stdout 是自检 JSON 的通道）。
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(opts = {}) {
    const threshold = LEVELS[opts.level ?? 'info'] ?? LEVELS.info;
    const sink = opts.sink ?? ((line) => process.stderr.write(line + '\n'));
    const make = (scope) => {
        const emit = (level, msg) => {
            if ((LEVELS[level] ?? 0) > threshold) return;
            sink(`[fp:${level}]${scope ? `(${scope})` : ''} ${msg}`);
        };
        return {
            error: (m) => emit('error', m),
            warn: (m) => emit('warn', m),
            info: (m) => emit('info', m),
            debug: (m) => emit('debug', m),
            forScope: (s) => make(scope ? `${scope}/${s}` : s),
        };
    };
    return make('');
}
