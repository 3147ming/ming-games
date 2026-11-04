/**
 * probe-markers.js — 画布可拖拽探针标记（包 15 遗留建议 2）
 *
 * 交互：DMM / DMM B / CH1 / CH2 四枚彩色标记浮在画布上，拖到任意端子、
 * 孔位或导线上松手，就把该处所在网络挂成对应槽位的测点。下拉框保留作
 * 精确输入与兼容，两者共用 instruments 里的同一份状态，永不打架。
 *
 * 标记吸附到「网格坐标」而不是屏幕像素：平移 / 缩放 / 改窗口尺寸时由
 * board 的 onAfterRender 回调在同一帧重投影，标记不会和电路脱节。
 * 位置写进 instruments.snapshot()，随项目存档一起保存 / 恢复。
 */

import { PROBE_SLOTS } from './instruments.js';
import { project, unproject } from './render.js';

/** 未挂测点时标记停靠在画布左上角托盘（像素，相对 #canvas-area） */
const DOCK_X = 14;
const DOCK_Y = 14;
const DOCK_GAP = 32;

export function createProbeMarkers(options = {}) {
  const host = options.host || document.getElementById('canvas-area');
  const boardOf = options.board || (() => window.__labBoard);
  const instruments = options.instruments || null;
  const onToast = options.onToast || (() => {});
  if (!host || !instruments) return null;

  const B = () => boardOf();
  const layer = document.createElement('div');
  layer.className = 'probe-layer';
  layer.setAttribute('aria-label', '画布探针标记');
  host.append(layer);

  let visible = true;
  let drag = null;
  let lastViewKey = '';
  const autoFailed = new Set();
  const els = new Map();

  /* ---------------------------------------------------------------- 落点解析 */

  /** 把一次松手位置解析成 { netId, gx, gy }；空白处 / 孤立端子返回 null */
  function resolveDrop(x, y) {
    const board = B();
    if (!board || !board.view) return null;
    const view = board.view;
    let pick = null;
    try { pick = board.pick(x, y); } catch (_) { pick = null; }
    const netlist = board.model.getNetlist();
    let netId = null;
    let anchor = { x, y };

    if (pick) {
      if (pick.type === 'terminal') {
        netId = netlist.netOf.get(`c:${pick.componentId}:${pick.terminal}`) || null;
        if (pick.x !== undefined) anchor = { x: pick.x, y: pick.y };
      } else if (pick.type === 'node') {
        netId = netlist.netOf.get(`n:${pick.nodeId}`) || null;
        if (pick.x !== undefined) anchor = { x: pick.x, y: pick.y };
      } else if (pick.type === 'wire') {
        const wire = board.model.findWire(pick.wireId);
        if (wire) netId = board.model.getNetOf(wire.a) || board.model.getNetOf(wire.b) || null;
      } else if (pick.type === 'component') {
        const comp = board.model.findComponent(pick.componentId);
        const terminal = comp && comp.terminals && comp.terminals[0];
        if (terminal) {
          netId = board.model.getNetOf({ componentId: comp.id, terminal: terminal.name }) || null;
          const p = board.geometry && board.geometry.terminal(comp.id, terminal.name);
          if (p) anchor = project(view, p.x, p.y);
        }
      }
    }

    // 孤立端子 / 空白落点没有网 id，不能作为测点
    if (!netId) return null;
    const g = unproject(view, anchor.x, anchor.y);
    return { netId, gx: g.gx, gy: g.gy };
  }

  /** 下拉选了测点但标记还没位置：自动落到该网第一个元件端子上 */
  function autoPosition(netId) {
    const board = B();
    if (!board || !board.model || !board.geometry) return null;
    const members = board.model.getNetMembers(netId) || [];
    const terminal = members.find((item) => item && item.componentId && item.terminal);
    if (!terminal) return null;
    const p = board.geometry.terminal(terminal.componentId, terminal.terminal);
    return p ? { gx: p.x, gy: p.y } : null;
  }

  /* ---------------------------------------------------------------- 标记同步 */

  function sync() {
    layer.classList.toggle('is-hidden', !visible);
    if (!visible) return;
    const board = B();
    const view = board && board.view;
    const probes = instruments.probes();
    const positions = instruments.markerPositions();

    probes.forEach((probe) => {
      const entry = els.get(probe.id);
      if (!entry) return;
      const { el, label, slot, index } = entry;
      let pos = positions[probe.id];

      if (probe.netId && !pos && view && !autoFailed.has(probe.netId)) {
        const auto = autoPosition(probe.netId);
        if (auto) {
          pos = auto;
          const all = instruments.markerPositions();
          all[probe.id] = auto;
          instruments.setMarkerPositions(all);
        } else {
          autoFailed.add(probe.netId);
        }
      }

      const docked = !probe.netId || !pos || !view;
      el.classList.toggle('is-docked', docked);
      el.classList.toggle('is-live', Boolean(probe.netId && !docked));
      label.textContent = probe.netId ? `${slot.label} · ${probe.netId}` : `${slot.label} · 未挂`;
      el.title = docked
        ? `${slot.hint}：拖到画布上的端子 / 孔位即可挂载`
        : `${slot.hint}：${probe.netId}（拖动换测点，× 移除）`;

      if (docked || !view) {
        el.style.left = `${DOCK_X}px`;
        el.style.top = `${DOCK_Y + index * DOCK_GAP}px`;
        el.style.transform = 'none';
      } else {
        const p = project(view, pos.gx, pos.gy);
        el.style.left = `${p.x}px`;
        el.style.top = `${p.y}px`;
        el.style.transform = 'translate(-50%, -100%)';
      }
    });
  }

  /** board 每帧渲染后调用：只在视图变换参数变化时重投影，避免每帧写 DOM */
  function onViewFrame(view) {
    if (!view) return;
    const key = [view.originX, view.originY, view.tileW, view.tileH, view.width, view.height].join('|');
    if (key === lastViewKey) return;
    lastViewKey = key;
    sync();
  }

  /* ---------------------------------------------------------------- 拖放 */

  function finishDrop(slotId, x, y) {
    const hit = resolveDrop(x, y);
    if (!hit || !hit.netId) {
      onToast('这里没有可测的网点：把探针拖到端子、孔位或导线上', 'warn');
      sync();
      return { ok: false, netId: null };
    }
    const all = instruments.markerPositions();
    all[slotId] = { gx: hit.gx, gy: hit.gy };
    instruments.setMarkerPositions(all);
    instruments.setProbe(slotId, hit.netId);
    autoFailed.delete(hit.netId);
    sync();
    return { ok: true, netId: hit.netId, gx: hit.gx, gy: hit.gy };
  }

  function remove(slotId) {
    const all = instruments.markerPositions();
    delete all[slotId];
    instruments.setMarkerPositions(all);
    instruments.setProbe(slotId, null);
    sync();
    return true;
  }

  function bindDrag(slotId, el) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.probe-marker-x')) return;
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* 某些浏览器不支持则忽略 */ }
      const rect = layer.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      drag = { slotId, pointerId: e.pointerId, startX: x, startY: y };
      el.classList.add('is-dragging');
    });

    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.slotId !== slotId || drag.pointerId !== e.pointerId) return;
      e.preventDefault();
      const rect = layer.getBoundingClientRect();
      el.style.left = `${e.clientX - rect.left}px`;
      el.style.top = `${e.clientY - rect.top}px`;
      el.style.transform = 'translate(-50%, -50%)';
    });

    const finish = (e) => {
      if (!drag || drag.slotId !== slotId || drag.pointerId !== e.pointerId) return;
      const rect = layer.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const moved = Math.hypot(x - drag.startX, y - drag.startY) > 3;
      drag = null;
      el.classList.remove('is-dragging');
      if (moved) finishDrop(slotId, x, y);
      else sync();
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', () => {
      drag = null;
      el.classList.remove('is-dragging');
      sync();
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToast('把探针标记拖到端子 / 孔位上即可挂载测点');
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove(slotId);
      }
    });
  }

  /* ---------------------------------------------------------------- 构建 */

  PROBE_SLOTS.forEach((slot, index) => {
    const el = document.createElement('div');
    el.className = 'probe-marker';
    el.dataset.slot = slot.id;
    el.style.setProperty('--probe-color', slot.color);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');

    const dot = document.createElement('span');
    dot.className = 'probe-marker-dot';
    const label = document.createElement('span');
    label.className = 'probe-marker-label';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'probe-marker-x';
    close.textContent = '×';
    close.title = '移除该测点';
    close.setAttribute('aria-label', `移除 ${slot.label} 测点`);
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => { e.stopPropagation(); remove(slot.id); });

    el.append(dot, label, close);
    layer.append(el);
    els.set(slot.id, { el, label, slot, index });
    bindDrag(slot.id, el);
  });

  sync();

  return {
    layer,
    sync,
    onViewFrame,
    destroy() { layer.remove(); },
    setVisible(on) { visible = Boolean(on); sync(); return visible; },
    isVisible() { return visible; },
    list() {
      const positions = instruments.markerPositions();
      return instruments.probes().map((probe) => ({
        slot: probe.id,
        label: probe.label,
        netId: probe.netId,
        gx: positions[probe.id] ? positions[probe.id].gx : null,
        gy: positions[probe.id] ? positions[probe.id].gy : null,
        docked: !probe.netId || !positions[probe.id],
        visible,
      }));
    },
    /** 无头探针用：直接把某槽位「拖放」到画布坐标（跳过真实指针事件） */
    drag: (slotId, x, y) => finishDrop(slotId, x, y),
    remove,
  };
}
