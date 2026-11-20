/**
 * 真机性能采集浮层（P1-1 真机矩阵）。
 *
 * 只在 URL 带 ?perf=1 时挂载，正常玩家零开销、零视觉影响。
 * 用途：真机浏览器打开链接 → 玩一局 → 点「复制报告」→ 把 JSON 贴回对话。
 *
 * 数据口径与 perf-audit.mjs 对齐：
 *   - p50/p95/draws/tris 来自 perfMonitor.snapshot()（与游戏内同一采样器）
 *   - 长任务来自 PerformanceObserver('longtask')，buffered 抓挂载前的
 *   - 设备/视口/DPR/UA/核数/内存一并记录，便于三档归类
 *
 * 零依赖、零 three；每 1s 刷一次浮层（不进每帧渲染路径，避免自身成为热点）。
 */
export function installPerfHud({ perfMonitor, device, getWorld }) {
  if (typeof location === 'undefined' || !/[?&]perf=1(&|$)/.test(location.search)) return null;
  if (typeof document === 'undefined') return null;

  const longTasks = [];
  const pushLong = (e) => {
    longTasks.push({ d: Math.round(e.duration), at: Math.round(e.startTime) });
    if (longTasks.length > 400) longTasks.shift();
  };
  let obs = null;
  try {
    obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) pushLong(e); });
    obs.observe({ entryTypes: ['longtask'], buffered: true });
  } catch { /* 老浏览器无 longtask：报告里 longTasks=[]，不阻断 */ }

  const css = [
    'position:fixed', 'z-index:2147483000', 'right:8px', 'bottom:8px',
    'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#dbe7f3', 'background:rgba(9,14,22,.86)', 'border:1px solid rgba(120,180,240,.45)',
    'border-radius:8px', 'padding:6px 8px', 'max-width:min(300px,62vw)',
    'box-shadow:0 4px 18px rgba(0,0,0,.5)', 'touch-action:auto', 'user-select:text',
    '-webkit-user-select:text',
  ].join(';');
  const root = document.createElement('div');
  root.id = 'perf-hud';
  root.style.cssText = css;
  root.innerHTML = ''
    + '<div style="display:flex;align-items:center;gap:6px;cursor:pointer">'
    + '<b style="color:#7fc4ff;letter-spacing:.5px">PERF</b>'
    + '<span id="perf-hud-live" style="flex:1"></span>'
    + '<button id="perf-hud-toggle" style="font:11px monospace;padding:1px 6px">−</button>'
    + '</div>'
    + '<div id="perf-hud-body" style="margin-top:5px">'
    + '<div id="perf-hud-detail" style="white-space:pre-wrap"></div>'
    + '<input id="perf-hud-note" placeholder="设备型号/场景(如:红米Note12 交火)" '
    + 'style="width:100%;box-sizing:border-box;margin:5px 0;padding:3px 5px;'
    + 'font:11px monospace;background:#101a28;color:#dbe7f3;border:1px solid #34506f;border-radius:4px">'
    + '<textarea id="perf-hud-json" readonly style="width:100%;box-sizing:border-box;height:54px;'
    + 'font:10px monospace;background:#0b1420;color:#8fb4d8;border:1px solid #243a52;border-radius:4px"></textarea>'
    + '<div style="display:flex;gap:5px;margin-top:5px">'
    + '<button id="perf-hud-copy" style="flex:1;font:11px monospace;padding:3px 4px;cursor:pointer">复制报告</button>'
    + '<button id="perf-hud-reset" style="flex:1;font:11px monospace;padding:3px 4px;cursor:pointer">重置采样</button>'
    + '</div>'
    + '<div id="perf-hud-msg" style="margin-top:4px;color:#8fd8a0;min-height:14px"></div>'
    + '</div>';
  (document.body || document.documentElement).appendChild(root);

  const $ = (id) => root.querySelector('#' + id);
  const live = $('perf-hud-live');
  const detail = $('perf-hud-detail');
  const note = $('perf-hud-note');
  const jsonBox = $('perf-hud-json');
  const msg = $('perf-hud-msg');
  const body = $('perf-hud-body');
  const toggle = $('perf-hud-toggle');
  let collapsed = false;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    toggle.textContent = collapsed ? '+' : '−';
  });

  const report = () => {
    const s = perfMonitor.snapshot();
    const w = getWorld && getWorld();
    const lt = longTasks.slice();
    return {
      kind: 'soudache-perf-report', v: 1,
      at: new Date().toISOString(),
      url: location.href,
      ua: navigator.userAgent,
      note: note.value || '',
      device: {
        quality: device && device.quality, isTouch: device && device.isTouch,
        cores: navigator.hardwareConcurrency || null,
        memoryGB: navigator.deviceMemory || null,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      },
      perf: {
        fps: s.fps, draws: s.draws, triangles: s.triangles,
        budget: s.budget, over: s.over, overAny: s.overAny,
        samples: s.samples, windowSamples: s.windowSamples,
      },
      longTasks: {
        count: lt.length,
        max: lt.length ? Math.max(...lt.map((x) => x.d)) : 0,
        detail: lt.slice(-20),
      },
      world: w && w.player ? {
        mapId: w.map && w.map.id, seed: w.map && w.map.seed,
        time: Math.round(w.time || 0), kills: w.kills || 0,
        searched: w.searchedCount || 0,
        enemies: w.enemies ? w.enemies.length : (w.map && w.map.enemies ? w.map.enemies.length : null),
      } : null,
    };
  };

  const refresh = () => {
    const s = perfMonitor.snapshot();
    const lt = longTasks;
    const max = lt.length ? Math.max(...lt.map((x) => x.d)) : 0;
    live.textContent = `${s.fps.p50}/${s.fps.p95}fps d${s.draws} L${lt.length}/${max}`;
    detail.textContent = `p50/p95 ${s.fps.p50}/${s.fps.p95}fps  draws ${s.draws}  tris ${s.triangles}\n`
      + `画质 ${device && device.quality}  核 ${navigator.hardwareConcurrency || '?'}  内存 ${navigator.deviceMemory || '?'}GB\n`
      + `长任务 ${lt.length} 次 / 最长 ${max}ms  样本 ${s.windowSamples}\n`
      + `预算 ${s.overAny ? 'FAIL' : 'PASS'}  敌人+战利品正在实时采样`;
    jsonBox.value = JSON.stringify(report());
  };
  refresh();
  const timer = setInterval(refresh, 1000);

  $('perf-hud-copy').addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = JSON.stringify(report(), null, 2);
    jsonBox.value = text;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* http 非安全上下文可能无 clipboard，走 fallback */ }
    if (!ok) {
      try {
        jsonBox.focus(); jsonBox.select();
        ok = document.execCommand && document.execCommand('copy');
      } catch { ok = false; }
    }
    msg.textContent = ok ? '已复制 → 贴回对话即可' : '复制失败：请长按下方文本框全选复制';
    setTimeout(() => { msg.textContent = ''; }, 4000);
  });
  $('perf-hud-reset').addEventListener('click', (e) => {
    e.stopPropagation();
    perfMonitor.reset();
    longTasks.length = 0;
    refresh();
    msg.textContent = '已重置，继续玩一局再复制';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  });

  return {
    destroy() {
      clearInterval(timer);
      try { if (obs) obs.disconnect(); } catch { /* noop */ }
      if (root.parentNode) root.parentNode.removeChild(root);
    },
    report,
  };
}
