/**
 * waveview.js — 示波器风格波形查看器（Canvas 渲染 + 控件）
 *
 * 分层绘制（性能 + 毫无闪烁）：
 *   离屏层（gridCanvas）：纸白底 + 浅灰网格 + 坐标轴刻度，只在尺寸/量程变化时重画；
 *   波形层（主 canvas）：每帧先把离屏层整块 blit 过来，再画曲线，
 *   于是重绘波形不重算网格，切通道也只是一次 blit + 折线。
 *
 * 坐标轴：
 *   横轴 = 时间，范围 [0, duration]，刻度用 1-2-5 系列自适应；
 *   纵轴 = 电压，自动量程（至少覆盖 0-5V），也可勾选固定 0-5V。
 *
 * 控件：运行/暂停、时长（秒）、步长（秒）、清空、固定量程；
 * 通道列表可勾选显隐（最多 6 色循环）。
 *
 * 全程 createElement / textContent，零 innerHTML。
 */

/** 通道配色（最多 6 色循环） */
const CHANNEL_COLORS = [
  '#c0392b', // 红
  '#2471a3', // 蓝
  '#1e8449', // 绿
  '#b9770e', // 琥珀
  '#7d3c98', // 紫
  '#117a65', // 青
];

/** 画布内边距（左留出纵轴标签，下留出横轴标签） */
const PAD = { left: 52, right: 12, top: 12, bottom: 26 };

/** 网格线颜色（纸白底上的浅灰） */
const GRID_COLOR = 'rgba(120, 135, 160, 0.22)';
const AXIS_COLOR = 'rgba(90, 100, 120, 0.55)';
const PAPER = '#f8f5ec';

/**
 * 创建波形查看器。
 * @param {HTMLElement} host 挂载点（board 传右栏的 #wave-panel）
 * @param {object} callbacks
 *   onRun    () => void     点「运行/暂停」时回调（由 board 决定启动还是暂停）
 *   onClear  () => void     点「清空」时回调（board 清结果 + 电容状态）
 *   onOptions (opts) => void 时长/步长改动时回调
 * @returns {object} 控制句柄
 */
export function createWaveView(host, callbacks = {}) {
  if (!host) return null;
  host.replaceChildren();

  /* ---- DOM 骨架 ---- */
  const wrap = document.createElement('div');
  wrap.className = 'wave-view';

  const head = document.createElement('div');
  head.className = 'wave-head';
  const title = document.createElement('span');
  title.className = 'wave-title';
  title.textContent = '波形';
  const status = document.createElement('span');
  status.className = 'wave-status';
  status.textContent = '未运行';
  const foldBtn = document.createElement('button');
  foldBtn.type = 'button';
  foldBtn.className = 'wave-fold';
  foldBtn.textContent = '收起';
  foldBtn.setAttribute('aria-expanded', 'true');
  head.append(title, status, foldBtn);

  const body = document.createElement('div');
  body.className = 'wave-body';

  const canvas = document.createElement('canvas');
  canvas.className = 'wave-canvas';
  canvas.setAttribute('aria-label', '波形图');

  const controls = document.createElement('div');
  controls.className = 'wave-controls';

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'btn btn-primary wave-run';
  runBtn.textContent = '运行';

  const mkField = (label, value, step, min) => {
    const box = document.createElement('label');
    box.className = 'wave-field';
    const text = document.createElement('span');
    text.className = 'wave-field-label';
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'wave-input';
    input.value = String(value);
    input.step = String(step);
    input.min = String(min);
    box.append(text, input);
    return { box, input };
  };

  const durField = mkField('时长(s)', 1, 0.5, 0.01);
  const dtField = mkField('步长(s)', 0.01, 0.005, 0.0005);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-ghost wave-clear';
  clearBtn.textContent = '清空';

  const fixLabel = document.createElement('label');
  fixLabel.className = 'wave-field wave-field--check';
  const fixInput = document.createElement('input');
  fixInput.type = 'checkbox';
  const fixText = document.createElement('span');
  fixText.className = 'wave-field-label';
  fixText.textContent = '固定 0-5V';
  fixLabel.append(fixInput, fixText);

  controls.append(runBtn, durField.box, dtField.box, clearBtn, fixLabel);

  const legend = document.createElement('div');
  legend.className = 'wave-legend';

  body.append(canvas, controls, legend);
  wrap.append(head, body);
  host.append(wrap);

  /* ---- 绘图状态 ---- */
  const gridCanvas = document.createElement('canvas'); // 离屏网格层
  const ctx = canvas.getContext('2d');
  const gctx = gridCanvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = 1;
  let result = null;          // 最近一次暂态结果
  let hidden = new Set();     // 隐藏的 netId
  let running = false;
  let collapsed = false;

  /* ---- 尺寸 ---- */
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(120, Math.floor(rect.width));
    const h = Math.max(120, Math.floor(rect.height));
    if (w === width && h === height) return false;
    width = w;
    height = h;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    gridCanvas.width = canvas.width;
    gridCanvas.height = canvas.height;
    return true;
  }

  /* ---- 量程 ---- */
  function rangeY() {
    if (fixInput.checked) return { min: 0, max: 5 };
    let min = 0;
    let max = 5;
    if (result && result.channels) {
      result.channels.forEach((ch) => {
        if (hidden.has(ch.netId)) return;
        if (Number.isFinite(ch.min) && ch.min < min) min = ch.min;
        if (Number.isFinite(ch.max) && ch.max > max) max = ch.max;
      });
    }
    const span = max - min || 1;
    return { min: min - span * 0.08, max: max + span * 0.08 };
  }

  /** 1-2-5 系列：返回约 target 个刻度值 */
  function niceTicks(lo, hi, target = 8) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      out.push(Number(v.toFixed(9)));
    }
    return out;
  }

  function fmt(v) {
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(0);
    if (abs >= 10) return v.toFixed(1);
    if (abs >= 1) return v.toFixed(2);
    if (abs >= 0.01) return v.toFixed(3);
    return v.toExponential(1);
  }

  /* ---- 网格层 ---- */
  function drawGrid() {
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, width, height);
    gctx.fillStyle = PAPER;
    gctx.fillRect(0, 0, width, height);

    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const yRange = rangeY();
    const duration = result && result.stats ? (result.stats.duration || 1) : 1;

    // 网格
    gctx.lineWidth = 1;
    gctx.strokeStyle = GRID_COLOR;
    const xTicks = niceTicks(0, duration, 8);
    const yTicks = niceTicks(yRange.min, yRange.max, 6);
    xTicks.forEach((t) => {
      const x = PAD.left + (t / duration) * plotW;
      gctx.beginPath();
      gctx.moveTo(x, PAD.top);
      gctx.lineTo(x, PAD.top + plotH);
      gctx.stroke();
    });
    yTicks.forEach((v) => {
      const y = PAD.top + plotH - ((v - yRange.min) / (yRange.max - yRange.min)) * plotH;
      gctx.beginPath();
      gctx.moveTo(PAD.left, y);
      gctx.lineTo(PAD.left + plotW, y);
      gctx.stroke();
    });

    // 坐标轴
    gctx.strokeStyle = AXIS_COLOR;
    gctx.beginPath();
    gctx.moveTo(PAD.left, PAD.top);
    gctx.lineTo(PAD.left, PAD.top + plotH);
    gctx.lineTo(PAD.left + plotW, PAD.top + plotH);
    gctx.stroke();

    // 刻度文字
    gctx.fillStyle = '#5b6478';
    gctx.font = '10px "Cascadia Mono", Consolas, monospace';
    gctx.textAlign = 'center';
    gctx.textBaseline = 'top';
    xTicks.forEach((t) => {
      const x = PAD.left + (t / duration) * plotW;
      gctx.fillText(fmt(t), x, PAD.top + plotH + 5);
    });
    gctx.textAlign = 'right';
    gctx.textBaseline = 'middle';
    yTicks.forEach((v) => {
      const y = PAD.top + plotH - ((v - yRange.min) / (yRange.max - yRange.min)) * plotH;
      gctx.fillText(fmt(v), PAD.left - 6, y);
    });
    gctx.save();
    gctx.translate(12, PAD.top + plotH / 2);
    gctx.rotate(-Math.PI / 2);
    gctx.textAlign = 'center';
    gctx.textBaseline = 'middle';
    gctx.fillText('电压 (V)', 0, 0);
    gctx.restore();
    gctx.textAlign = 'right';
    gctx.textBaseline = 'bottom';
    gctx.fillText('时间 (s)', PAD.left + plotW, height - 3);
  }

  /* ---- 波形层 ---- */
  function draw() {
    if (!ctx) return;
    if (resize() || !gridCanvas.width) drawGrid();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(gridCanvas, 0, 0); // blit 网格层（双缓冲）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!result || !result.waveforms) return;
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    const yRange = rangeY();
    const duration = result.stats ? (result.stats.duration || 1) : 1;
    const toX = (t) => PAD.left + (t / duration) * plotW;
    const toY = (v) => PAD.top + plotH - ((v - yRange.min) / (yRange.max - yRange.min)) * plotH;

    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    result.waveforms.forEach((wave, index) => {
      if (hidden.has(wave.netId)) return;
      ctx.strokeStyle = CHANNEL_COLORS[index % CHANNEL_COLORS.length];
      ctx.beginPath();
      if (wave.type === 'digital' && wave.samples.length > 0) {
        // 数字线画阶梯：保持到下一采样时刻再垂直跳变（与模拟曲线同一时间轴）
        let prev = wave.samples[0];
        ctx.moveTo(toX(prev.t), toY(prev.v));
        for (let i = 1; i < wave.samples.length; i += 1) {
          const sample = wave.samples[i];
          ctx.lineTo(toX(sample.t), toY(prev.v));
          ctx.lineTo(toX(sample.t), toY(sample.v));
          prev = sample;
        }
      } else {
        let started = false;
        wave.samples.forEach((sample) => {
          const x = toX(sample.t);
          const y = toY(sample.v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        });
      }
      ctx.stroke();
    });
  }

  /* ---- 图例 / 通道显隐 ---- */
  function renderLegend() {
    legend.replaceChildren();
    if (!result || !result.waveforms) return;
    result.waveforms.forEach((wave, index) => {
      const item = document.createElement('label');
      item.className = 'wave-legend-item';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !hidden.has(wave.netId);
      input.addEventListener('change', () => {
        if (input.checked) hidden.delete(wave.netId);
        else hidden.add(wave.netId);
        drawGrid();
        draw();
      });
      const swatch = document.createElement('span');
      swatch.className = 'wave-legend-swatch';
      swatch.style.backgroundColor = CHANNEL_COLORS[index % CHANNEL_COLORS.length];
      const name = document.createElement('span');
      name.className = 'wave-legend-name';
      const ch = result.channels ? result.channels.find((c) => c.netId === wave.netId) : null;
      const kind = wave.type === 'digital' ? '数字' : '模拟';
      name.textContent = ch ? `${wave.netId}（${ch.driver}·${kind}）` : `${wave.netId}（${kind}）`;
      item.append(input, swatch, name);
      legend.append(item);
    });
  }

  /* ---- 控件 ---- */
  runBtn.addEventListener('click', () => {
    if (typeof callbacks.onRun === 'function') callbacks.onRun();
  });
  clearBtn.addEventListener('click', () => {
    if (typeof callbacks.onClear === 'function') callbacks.onClear();
  });
  const emitOptions = () => {
    if (typeof callbacks.onOptions !== 'function') return;
    callbacks.onOptions({
      duration: Number(durField.input.value),
      dt: Number(dtField.input.value),
    });
  };
  durField.input.addEventListener('change', emitOptions);
  dtField.input.addEventListener('change', emitOptions);
  fixInput.addEventListener('change', () => {
    drawGrid();
    draw();
  });
  foldBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    body.hidden = collapsed;
    foldBtn.textContent = collapsed ? '展开' : '收起';
    foldBtn.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) draw();
  });

  // 画布尺寸随面板变化
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      if (resize()) {
        drawGrid();
        draw();
      }
    })
    : null;
  if (observer) observer.observe(canvas);

  /* ---- 对外 ---- */
  const api = {
    /** 写入一次暂态结果并重绘 */
    render(next) {
      result = next || null;
      resize();
      drawGrid();
      renderLegend();
      draw();
    },
    /** 清空画布与数据（不重置控件） */
    clear() {
      result = null;
      hidden = new Set();
      renderLegend();
      drawGrid();
      draw();
    },
    /** 运行/暂停态：按钮文案与状态行 */
    setRunning(on, progressText) {
      running = Boolean(on);
      runBtn.textContent = running ? '暂停' : '运行';
      runBtn.classList.toggle('is-running', running);
      status.textContent = progressText || (running ? '计算中…' : '未运行');
    },
    /** 进度显示：已仿真秒数 / 总秒数 */
    setProgress(done, total) {
      status.textContent = `计算中… ${done.toFixed(2)}/${total.toFixed(2)}s`;
    },
    setStatus(text) {
      status.textContent = text;
    },
    /** 控件当前值 */
    options() {
      return {
        duration: Number(durField.input.value),
        dt: Number(dtField.input.value),
      };
    },
    setOptions({ duration, dt }) {
      if (Number.isFinite(duration) && duration > 0) durField.input.value = String(duration);
      if (Number.isFinite(dt) && dt > 0) dtField.input.value = String(dt);
    },
    isRunning: () => running,
    /** 供探针：画布是否画出了非纸白的波形像素 */
    paintedRatio() {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // 纸白底是 (248,245,236)；曲线是高饱和色，明显不同
        if (Math.abs(r - 248) > 40 || Math.abs(g - 245) > 40 || Math.abs(b - 236) > 40) painted += 1;
      }
      return painted / (data.length / 16);
    },
    destroy() {
      if (observer) observer.disconnect();
      host.replaceChildren();
    },
  };

  resize();
  drawGrid();
  draw();
  return api;
}
