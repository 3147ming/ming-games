// src/guard.js
// 全局错误边界 + 主循环帧故障熔断。
// 目标：把"白屏 / 卡死无解释"变成可诊断、可恢复的现场 ——
//   - window 上未捕获的 JS 运行时错误（error / unhandledrejection）一律记录并触发致命处理；
//   - 主循环每帧若周期性抛错，连续 FATAL_STREAK 帧同指纹即熔断，避免只在控制台刷同一行。

const RING_MAX = 20;
const FATAL_STREAK = 3;

let _ring = [];
let _streakKey = null;
let _streak = 0;
let _fatal = false;
let _onFatal = null;
let _installed = false;

function _fingerprint(err) {
  const s = (err && (err.stack || err.message)) || String(err);
  return String(s).split('\n').slice(0, 2).join(' | ');
}

function _push(kind, err) {
  _ring.push({ t: Date.now(), kind, fp: _fingerprint(err), msg: (err && err.message) || String(err) });
  if (_ring.length > RING_MAX) _ring.shift();
}

function _fire(err, kind) {
  _push(kind, err);
  if (!_fatal && _onFatal) {
    _fatal = true;
    try { _onFatal(buildReport(err, kind)); } catch (_) {}
  }
}

/** 安装全局监听（幂等）。onFatal(report) 在触发致命故障时调用一次。 */
export function installGuard(opts = {}) {
  _onFatal = opts.onFatal || null;
  if (_installed || typeof window === 'undefined') return;
  _installed = true;
  window.addEventListener('error', (e) => {
    // 资源加载错误（img/script）没有 .error，忽略，避免误熔断
    if (!e || !e.error) return;
    _fire(e.error, 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    _fire((e && e.reason) || e, 'unhandledrejection');
  });
}

/** 主循环每帧捕获的同步错误走这里。连续 FATAL_STREAK 帧同指纹即熔断。 */
export function frameError(err) {
  const fp = _fingerprint(err);
  if (fp === _streakKey) _streak += 1; else { _streakKey = fp; _streak = 1; }
  _push('frame', err);
  if (!_fatal && _streak >= FATAL_STREAK && _onFatal) {
    _fatal = true;
    try { _onFatal(buildReport(err, 'frame')); } catch (_) {}
  }
}

/** 干净帧后调用：重置连续计数，避免孤立单帧错误累积成熔断。 */
export function resetFrameStreak() {
  _streakKey = null;
  _streak = 0;
}

/** 恢复后由上层调用，解除熔断并允许继续（同指纹重新计数）。 */
export function clearFatal() {
  _fatal = false;
  _streakKey = null;
  _streak = 0;
}

export function isFatal() { return _fatal; }

export function buildReport(err, kind) {
  return {
    fatal: _fatal,
    kind,
    message: (err && err.message) || String(err),
    fingerprint: _fingerprint(err),
    recent: _ring.slice(),
  };
}

export function getErrors() { return _ring.slice(); }
