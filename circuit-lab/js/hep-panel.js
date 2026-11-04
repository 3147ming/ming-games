/**
 * hep-panel.js — HEP-DCTS-01 实物平台「三层显示」层
 *
 * 显示分层（用户 2026-11-04 要求：默认不要霸占屏幕）：
 *   1. 静态信息 → canvas 机箱丝印（hep-skin.js，常驻、可用「隐藏丝印」关掉）
 *   2. 动态信息 → hover 轻量信息卡（两行、无按钮、pointer-events:none、移开即隐）
 *   3. 操作     → click 展开单张可操作面板；图钉 / 教学模式 / 总开关可让它常驻
 *
 * 设计边界：
 *   - DOM 覆盖层不吃事件：.hep-panel-layer 与 hover 卡都是 pointer-events:none，
 *     只有展开卡片里的按钮 auto；事件监听挂在 host 的 bubble 阶段，从不
 *     preventDefault / stopPropagation，绝不抢画布的连线 / 放置 / 拖拽 / 右键。
 *   - 不碰仿真内核：所有操作走 __labBoard 已暴露的 simdig / model / simdc，
 *     读数来自 model 参数与 instruments.read()。
 *   - 不进 model 存档：卡片状态每次从电路与仿真结果实时推导。
 *   - 帧前钩子 writeRuntime(view)：在平台层缓存键计算前写好状态灯数据，
 *     render.js 的 layerKey 才会当帧重建；与 probe-markers 共用 onAfterRender。
 */

import { HEP_MODULES } from './hep-skin.js';
import { project, unproject, invalidatePlatformLayer } from './render.js';

const HEP_SKIN = 'hep';

/** 共阴七段：0–F 对应的 a–g 亮段（canvas 状态数码管与卡片译码共用） */
const SEG_MAP = [
  'abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc',
  'abcdefg', 'abcdfg', 'abcefg', 'cdefg', 'adef', 'bcdeg', 'adefg', 'aefg',
];
const SEG_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createHepPanel(options = {}) {
  const host = options.host || document.getElementById('canvas-area');
  const boardOf = options.board || (() => window.__labBoard);
  const instruments = options.instruments || null;
  const onToast = options.onToast || (() => {});
  if (!host) return null;

  const B = () => boardOf();
  const layer = el('div', 'hep-panel-layer');
  layer.setAttribute('aria-label', 'HEP-DCTS-01 实验平台模块面板');
  host.append(layer);

  // 悬停信息卡：单例、两行、纯展示，不吃任何指针事件
  const hoverCard = el('div', 'hep-hover-card');
  hoverCard.setAttribute('aria-hidden', 'true');
  hoverCard.hidden = true;
  layer.append(hoverCard);

  let visible = true;
  let openId = null;                 // 当前点击展开的模块（一次只有一张）
  let hoverId = null;                // 当前悬停的模块
  let hoverHit = null;               // 当前悬停的真实元件 { id, type }
  let hoverPinned = false;           // 点击真实元件后把信息卡钉住
  const pinned = new Set();          // 图钉钉住的模块
  let lastViewKey = '';
  let lastStateKey = '';
  let lastHoverKey = '';
  let lastPointer = { x: 0, y: 0 };
  const cards = new Map();

  HEP_MODULES.forEach((mod) => {
    const card = el('div', `hep-module-card hep-module-card--${mod.kind}`);
    card.dataset.module = mod.id;
    card.hidden = true;
    const title = el('div', 'hep-card-title');
    const titleText = el('span', 'hep-card-title-text', mod.label);
    const pinBtn = el('button', 'hep-pin', '钉');
    pinBtn.type = 'button';
    pinBtn.title = '图钉：钉住后此模块常驻显示';
    pinBtn.setAttribute('aria-pressed', 'false');
    pinBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (pinned.has(mod.id)) {
        pinned.delete(mod.id);
        onToast(`${mod.label} 已取消图钉`, 'info');
      } else {
        pinned.add(mod.id);
        onToast(`${mod.label} 已钉住，切外观前会一直显示`, 'success');
      }
      refresh(true);
      requestFrame();
    });
    title.append(titleText, pinBtn);
    const body = el('div', 'hep-card-body');
    const actions = el('div', 'hep-card-actions');
    card.append(title, body, actions);
    layer.append(card);
    cards.set(mod.id, { mod, card, body, actions, pinBtn });
  });

  function button(label, onClick, extraClass) {
    const btn = el('button', `hep-btn${extraClass ? ` ${extraClass}` : ''}`, label);
    btn.type = 'button';
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  /* ------------------------------------------------------------ 数据读取 */

  function collect() {
    const board = B();
    if (!board || !board.model) return null;
    const comps = board.model.getState().components || [];
    return {
      board,
      comps,
      switches: comps.filter((c) => c.type === 'logic-switch'),
      pulses: comps.filter((c) => c.type === 'pulse'),
      clocks: comps.filter((c) => c.type === 'clock'),
      ics: comps.filter((c) => ['ic74xx', 'buffer74', 'dac8', 'adc8', 'comparator'].includes(c.type)),
    };
  }

  function readDmm() {
    if (!instruments || typeof instruments.read !== 'function') return null;
    try {
      const r = instruments.read();
      return r && r.dmm ? r.dmm : null;
    } catch (_) {
      return null;
    }
  }

  function digState() {
    const board = B();
    if (!board || !board.simdig) return null;
    try { return board.simdig.last(); } catch (_) { return null; }
  }

  function bcdValue(st) {
    if (!st || st.switches.length < 4) return null;
    return st.switches.slice(0, 4).reduce(
      (acc, c, i) => acc + ((c.params && c.params.state === 'hi') ? 1 : 0) * (1 << (3 - i)), 0,
    );
  }

  function moduleSummary(mod, st) {
    if (!st) return '未就绪';
    switch (mod.kind) {
      case 'switches': return `已接入 ${st.switches.length} 路`;
      case 'sockets': return `${st.ics.length} 颗 IC`;
      case 'display': {
        const v = bcdValue(st);
        return v === null ? '待 4 路 BCD 输入' : `BCD → ${v.toString(16).toUpperCase()}`;
      }
      case 'pulse': {
        const c = st.clocks[0];
        return c ? `连续 ${c.params.frequency}Hz` : '未放置时钟源';
      }
      case 'utility': return '+5V / GND / CON 就绪';
      default: return '';
    }
  }

  /* ------------------------------------------------------------ 显示判定 */

  function isActive() {
    const board = B();
    return Boolean(visible && board && board.skin === HEP_SKIN && board.platformId === 'exp-box');
  }

  function isShown(mod, board) {
    const hep = (board && board.view && board.view.hep) || {};
    return hep.teach === true || hep.all === true || pinned.has(mod.id) || openId === mod.id;
  }

  function stateKey(st, dmm, dig, active) {
    if (!st) return 'none';
    const bits = (list) => list.map((c) => `${c.id}:${JSON.stringify(c.params || {})}`).join(',');
    const board = B();
    const hep = (board && board.view && board.view.hep) || {};
    return [
      bits(st.switches), bits(st.pulses), bits(st.clocks), bits(st.ics),
      dmm ? `${dmm.ok}|${dmm.value}` : 'no-dmm',
      dig ? `dig:${Boolean(dig.hasDigital)}` : 'no-dig',
      visible, active, openId, [...pinned].sort().join(','),
      hep.teach, hep.all, hep.silk,
    ].join('|');
  }

  /* ------------------------------------------------------------ 模块卡片内容 */

  function bitRow(st, board) {
    const row = el('div', 'hep-bit-row');
    const list = st.switches.slice(0, 8);
    for (let i = 0; i < 8; i += 1) {
      const comp = list[i];
      const on = Boolean(comp && comp.params && comp.params.state === 'hi');
      const btn = el('button', `hep-bit${on ? ' is-on' : ''}`, String(i + 1));
      btn.type = 'button';
      btn.disabled = !comp;
      btn.title = comp
        ? `${comp.id} · ${on ? '高电平 1' : '低电平 0'}（点击拨动）`
        : `第 ${i + 1} 位：先放入逻辑电平开关元件`;
      if (comp) {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          board.simdig.toggleSwitch(comp.id);
          onToast(`${comp.id} 拨到${on ? '低电平 0' : '高电平 1'}`, 'info');
          refresh(true);
          requestFrame();
        });
      }
      row.append(btn);
    }
    return row;
  }

  function renderSwitches(entry, st) {
    const { board } = st;
    entry.body.append(bitRow(st, board));
    entry.body.append(el('div', 'hep-card-note',
      st.switches.length
        ? `已接入 ${st.switches.length} 路逻辑开关 · 点击位号拨动，电路立即重仿`
        : '元件库放入「逻辑电平开关」后，这里可逐位拨动'));
    if (st.switches.length === 0) {
      entry.actions.append(button('放入 4 路开关', () => {
        const platform = board.platforms.getPlatform(board.platformId);
        let placed = 0;
        for (let y = 1; y < platform.rows - 2 && placed < 4; y += 2) {
          for (let x = 1; x < platform.cols - 2 && placed < 4; x += 2) {
            const r = board.model.addComponent('logic-switch', x, y, { silent: true });
            if (r && r.ok) placed += 1;
          }
        }
        board.simdc.solve('hep-panel');
        onToast(placed ? `已放入 ${placed} 路逻辑电平开关` : '没有空位可放置', placed ? 'success' : 'warn');
        refresh(true);
        requestFrame();
      }, 'hep-btn--primary'));
    } else {
      entry.actions.append(button('全部翻转', () => {
        st.switches.slice(0, 8).forEach((c) => board.simdig.toggleSwitch(c.id));
        onToast('8 路逻辑开关已全部翻转', 'info');
        refresh(true);
        requestFrame();
      }));
    }
  }

  function renderSockets(entry, st) {
    const list = el('div', 'hep-chip-list');
    if (st.ics.length === 0) {
      list.append(el('span', 'hep-card-note', '尚未插入 IC；14P / 16P 锁紧座待用'));
    } else {
      st.ics.slice(0, 4).forEach((c) => {
        list.append(el('span', 'hep-chip', `${c.id} · ${c.type}`));
      });
    }
    entry.body.append(list);
    entry.body.append(el('div', 'hep-card-note', 'U1 14P · U2 16P · 蓝色主板锁紧座'));
    entry.body.append(el('div', 'hep-card-note',
      `逻辑笔：${st.ics.length ? '已接芯片' : '待接线'} · 点右下「逻辑笔」模块读电平`));
  }

  function renderDisplay(entry, st) {
    const list = st.switches.slice(0, 4);
    const value = bcdValue(st);
    entry.body.append(el('div', 'hep-seven-seg', value === null ? '—' : value.toString(16).toUpperCase()));
    const segs = el('div', 'hep-seg-row');
    const lit = value === null ? '' : SEG_MAP[value];
    SEG_NAMES.forEach((name) => {
      segs.append(el('span', `hep-seg${lit.includes(name) ? ' is-on' : ''}`, name));
    });
    entry.body.append(segs);
    entry.body.append(el('div', 'hep-card-note',
      value === null
        ? '4 路逻辑开关 → BCD 段码；放入 4 路后显示 0–F（机箱上 DS1 同步显示）'
        : `BCD = ${list.map((c) => (c.params && c.params.state === 'hi') ? 1 : 0).join('')} → ${value.toString(16).toUpperCase()}`));
  }

  function renderPulse(entry, st) {
    const { board } = st;
    const clock = st.clocks[0];
    const pulseComp = st.pulses[0];
    entry.body.append(el('div', 'hep-card-note',
      `连续脉冲：${clock ? `${clock.params.frequency}Hz / ${clock.params.duty}%` : '未放置时钟源'} · 单次：${pulseComp ? pulseComp.id : '未放置脉冲源'}`));
    entry.actions.append(button('单次脉冲', () => {
      if (!pulseComp) { onToast('先在元件库放入「脉冲源」', 'warn'); return; }
      board.simdig.triggerPulse(pulseComp.id);
      onToast(`${pulseComp.id} 触发一次脉冲`, 'success');
      refresh(true);
    }));
    entry.actions.append(button('时钟步进', () => {
      if (!clock) { onToast('先在元件库放入「时钟源」', 'warn'); return; }
      board.simdig.stepClock();
      refresh(true);
    }));
    const freqRow = el('div', 'hep-freq-row');
    [1, 10, 100, 1000].forEach((hz) => {
      const btn = button(hz >= 1000 ? '1kHz' : `${hz}Hz`, () => {
        if (!clock) { onToast('先在元件库放入「时钟源」', 'warn'); return; }
        board.model.updateParams(clock.id, { frequency: hz });
        board.simdc.solve('hep-freq');
        onToast(`连续脉冲频率 → ${hz >= 1000 ? '1kHz' : `${hz}Hz`}`, 'info');
        refresh(true);
        requestFrame();
      });
      if (clock && Number(clock.params.frequency) === hz) btn.classList.add('is-active');
      freqRow.append(btn);
    });
    entry.actions.append(freqRow);
  }

  function renderUtility(entry, st, dmm, dig) {
    const level = dmm && dmm.ok && Number.isFinite(dmm.value)
      ? (dmm.value >= 2.5 ? '1' : '0')
      : '—';
    const lampClass = level === '1' ? 'is-hi' : (level === '0' ? 'is-lo' : 'is-na');
    const probe = el('div', 'hep-probe');
    probe.append(el('span', `hep-probe-lamp ${lampClass}`, level));
    probe.append(el('span', 'hep-probe-label', '逻辑笔 LOGIC PROBE'));
    entry.body.append(probe);
    entry.body.append(el('div', 'hep-card-note',
      dmm && dmm.ok ? `DMM ${Number(dmm.value).toFixed(3)}V → 逻辑 ${level}` : '把 DMM 探针挂到网上即可读逻辑电平'));
    const rails = el('div', 'hep-rails');
    rails.append(el('span', 'hep-rail is-pos', '+5V'));
    rails.append(el('span', 'hep-rail', 'GND'));
    rails.append(el('span', 'hep-rail is-on', 'CON'));
    entry.body.append(rails);
    entry.body.append(el('div', 'hep-card-note',
      `数字内核：${dig && dig.hasDigital ? '已启用' : '未启用（纯数字电路自动启用）'}`));
  }

  function renderCard(entry, st, dmm, dig) {
    entry.body.replaceChildren();
    entry.actions.replaceChildren();
    switch (entry.mod.kind) {
      case 'switches': renderSwitches(entry, st); break;
      case 'sockets': renderSockets(entry, st); break;
      case 'display': renderDisplay(entry, st); break;
      case 'pulse': renderPulse(entry, st); break;
      case 'utility': renderUtility(entry, st, dmm, dig); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------ 悬停信息卡 */

  function updateHoverCard() {
    const key = `${hoverId}|${hoverHit ? hoverHit.id + hoverHit.type : '-'}|${hoverPinned}`;
    if (key === lastHoverKey) return;
    lastHoverKey = key;
    hoverCard.replaceChildren();
    const st = collect();
    let title = '';
    let sub = '';
    if (hoverHit) {
      const comp = st ? st.comps.find((c) => c.id === hoverHit.id) : null;
      const mod = hoverId ? HEP_MODULES.find((m) => m.id === hoverId) : null;
      title = comp ? `${comp.id} · ${comp.type}` : hoverHit.id;
      sub = `${mod ? mod.label : '画布元件'} · ${hoverPinned ? '已钉住，点空白处取消' : '悬停查看 · 点击可钉住'}`;
    } else if (hoverId) {
      const mod = HEP_MODULES.find((m) => m.id === hoverId);
      if (mod) {
        title = mod.label;
        sub = `${mod.sub} · ${moduleSummary(mod, st)} · 点击展开操作`;
      }
    }
    if (!title) return;
    hoverCard.append(el('div', 'hep-hover-title', title));
    hoverCard.append(el('div', 'hep-hover-sub', sub));
  }

  function positionHoverCard() {
    const rect = host.getBoundingClientRect();
    const x = Math.min(lastPointer.x - rect.left + 14, Math.max(8, rect.width - 216));
    const y = Math.min(lastPointer.y - rect.top + 14, Math.max(8, rect.height - 62));
    hoverCard.style.left = `${x}px`;
    hoverCard.style.top = `${y}px`;
  }

  /* ------------------------------------------------------------ 坐标与命中 */

  function pointerToGrid(event) {
    const board = B();
    const canvas = document.getElementById('breadboard-canvas');
    if (!board || !board.view || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const sx = (event.clientX - rect.left) * (board.view.width / rect.width);
    const sy = (event.clientY - rect.top) * (board.view.height / rect.height);
    return { ...unproject(board.view, sx, sy), sx, sy };
  }

  function gridToModule(gx, gy) {
    return HEP_MODULES.find((m) => gx >= m.x && gx <= m.x + m.w && gy >= m.y && gy <= m.y + m.h) || null;
  }

  function pickComponent(board, sx, sy) {
    if (!board || typeof board.pick !== 'function') return null;
    try {
      const hit = board.pick(sx, sy);
      return hit && hit.componentId ? { id: hit.componentId, type: hit.type } : null;
    } catch (_) {
      return null;
    }
  }

  function requestFrame() {
    const board = B();
    if (board && typeof board.requestRender === 'function') board.requestRender();
  }

  /* ------------------------------------------------------------ 帧同步 */

  function refresh(force) {
    const board = B();
    if (!board) return;
    const active = isActive();
    const st = collect();
    const dmm = readDmm();
    const dig = digState();
    const key = stateKey(st, dmm, dig, active);
    if (!force && key === lastStateKey) return;
    lastStateKey = key;

    HEP_MODULES.forEach((mod) => {
      const entry = cards.get(mod.id);
      const shown = active && isShown(mod, board);
      entry.card.hidden = !shown;
      entry.card.classList.toggle('is-open', openId === mod.id);
      entry.pinBtn.classList.toggle('is-pinned', pinned.has(mod.id));
      entry.pinBtn.setAttribute('aria-pressed', String(pinned.has(mod.id)));
      if (shown && st) renderCard(entry, st, dmm, dig);
    });

    const anyShown = active && HEP_MODULES.some((mod) => isShown(mod, board));
    const hoverShown = active && Boolean(hoverId || hoverHit);
    layer.hidden = !active || (!anyShown && !hoverShown);
    hoverCard.hidden = !hoverShown;
    updateHoverCard();
  }

  /**
   * 帧前钩子（board.onBeforeRender）：把状态灯数据写进 view.hep，
   * 让 render.js 的 layerKey 当帧就能看到变化并重建平台层离屏画布。
   */
  function writeRuntime(view) {
    const board = B();
    if (!board || !view) return;
    const hep = view.hep || (view.hep = {});
    const st = collect();
    const dmm = readDmm();
    const bits = st ? st.switches.slice(0, 8).map((c) => (c.params && c.params.state === 'hi' ? 1 : 0)) : [];
    while (bits.length < 8) bits.push(0);
    const value = bcdValue(st);
    const digit = value === null ? null : value.toString(16).toUpperCase();
    const clock = st ? st.clocks[0] : null;
    const freq = clock ? Number(clock.params.frequency) : null;
    const probe = dmm && dmm.ok && Number.isFinite(dmm.value)
      ? (dmm.value >= 2.5 ? '1' : '0')
      : '—';
    hep.runtime = { bits, digit, freq, probe };

    const key = [
      bits.join(''), digit, freq, probe, hoverId || '-',
      hep.silk ? 1 : 0, hep.teach ? 1 : 0, hep.all ? 1 : 0,
    ].join('|');
    let changed = false;
    if (hep.hoverModule !== hoverId) { hep.hoverModule = hoverId; changed = true; }
    if (hep.runtimeKey !== key) { hep.runtimeKey = key; changed = true; }
    if (changed) invalidatePlatformLayer();
  }

  /** 与 probe-markers 共用 onAfterRender；view 六参数变化才重投影 */
  function onViewFrame(view) {
    const board = B();
    if (!board) return;
    const drawer = window.innerWidth <= 720;
    const key = [
      view.tileW, view.tileH, view.originX, view.originY,
      view.zoom, view.panX, view.panY, board.skin, board.platformId, drawer,
    ].join('|');
    if (key !== lastViewKey) {
      lastViewKey = key;
      HEP_MODULES.forEach((mod) => {
        const p = project(view, mod.x + mod.w / 2, mod.y + mod.h / 2);
        const card = cards.get(mod.id).card;
        if (drawer) { card.style.left = ''; card.style.top = ''; }
        else { card.style.left = `${p.x}px`; card.style.top = `${p.y}px`; }
      });
    }
    refresh(false);
  }

  /* ------------------------------------------------------------ DOM 事件 */

  function clearHover(keepPinned) {
    const changed = Boolean(hoverId || hoverHit);
    hoverId = null;
    hoverHit = null;
    if (!keepPinned) hoverPinned = false;
    updateHoverCard();
    refresh(true);
    if (changed) requestFrame();
  }

  function onPointerMove(event) {
    if (!isActive()) return;
    const g = pointerToGrid(event);
    if (!g) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    const mod = gridToModule(g.gx, g.gy);
    const nextHoverId = mod ? mod.id : null;
    const nextHit = pickComponent(B(), g.sx, g.sy);
    const changed = nextHoverId !== hoverId;
    hoverId = nextHoverId;
    hoverHit = nextHit;
    positionHoverCard();
    updateHoverCard();
    refresh(true);
    if (changed) requestFrame();
  }

  function onPointerLeave() {
    clearHover(false);
  }

  function onClick(event) {
    if (!isActive()) return;
    // 卡片内按钮 / 图钉自己处理，别再触发一次展开
    if (event.target && event.target.closest
      && event.target.closest('.hep-btn, .hep-pin, .hep-bit, .hep-hover-card')) return;
    const board = B();
    // 正在放置元件（幽灵）或连续放置模式：让画布交互优先，不弹面板
    if (board.scene && board.scene.ghost) return;
    if (board.interact && typeof board.interact.isContinuousPlace === 'function'
      && board.interact.isContinuousPlace()) return;
    const g = pointerToGrid(event);
    if (!g) return;
    const mod = gridToModule(g.gx, g.gy);
    const hit = pickComponent(board, g.sx, g.sy);

    // 点到真实元件：把信息卡钉住 / 取消钉住，不展开操作面板（避免抢选中与连线）
    if (hit) {
      hoverPinned = !hoverPinned;
      hoverHit = hit;
      hoverId = mod ? mod.id : null;
      lastPointer = { x: event.clientX, y: event.clientY };
      positionHoverCard();
      updateHoverCard();
      refresh(true);
      requestFrame();
      return;
    }

    if (mod) openId = openId === mod.id ? null : mod.id;
    else {
      // 点空白：收起展开面板，同时撤掉悬停信息卡
      //（真实指针通常先触发 pointermove 清空 hover，但触摸 / 注入式点击没有这一步）
      openId = null;
      hoverPinned = false;
      hoverId = null;
      hoverHit = null;
    }
    refresh(true);
    requestFrame();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    const had = Boolean(openId || hoverPinned);
    openId = null;
    hoverPinned = false;
    if (had) { clearHover(false); refresh(true); requestFrame(); }
  }

  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerleave', onPointerLeave);
  host.addEventListener('click', onClick);
  window.addEventListener('keydown', onKeyDown);

  /* ------------------------------------------------------------ 对外接口 */

  return {
    layer,
    hoverCard,
    sync: () => refresh(true),
    onViewFrame,
    writeRuntime,
    setVisible(on) { visible = Boolean(on); refresh(true); return visible; },
    isVisible() { return visible; },
    /** 探针用：6 模块的结构与当前状态摘要 */
    list() {
      const board = B();
      const st = collect();
      return HEP_MODULES.map((mod) => {
        const entry = cards.get(mod.id);
        return {
          id: mod.id,
          label: mod.label,
          kind: mod.kind,
          visible: !layer.hidden && !entry.card.hidden,
          hidden: entry.card.hidden,
          open: openId === mod.id,
          pinned: pinned.has(mod.id),
          switches: st ? st.switches.length : 0,
          pulses: st ? st.pulses.length : 0,
          clocks: st ? st.clocks.length : 0,
          ics: st ? st.ics.length : 0,
          skin: board ? board.skin : null,
        };
      });
    },
    /** 探针用：读取 / 注入显示状态 */
    state() {
      const board = B();
      const hep = (board && board.view && board.view.hep) || {};
      return {
        openId, hoverId, hoverHit, hoverPinned,
        pinned: [...pinned], visible,
        layerHidden: layer.hidden,
        hoverCardHidden: hoverCard.hidden,
        shown: HEP_MODULES.filter((m) => !cards.get(m.id).card.hidden).map((m) => m.id),
        silk: Boolean(hep.silk), teach: Boolean(hep.teach), all: Boolean(hep.all),
        runtimeKey: hep.runtimeKey || '',
        runtime: hep.runtime || null,
        drawer: window.innerWidth <= 720,
      };
    },
    open(id) {
      openId = HEP_MODULES.some((m) => m.id === id) ? id : null;
      refresh(true); requestFrame();
      return openId;
    },
    close() {
      openId = null; hoverPinned = false;
      clearHover(false); refresh(true); requestFrame();
      return true;
    },
    /** 探针用：一键回到「默认 0 张卡片」状态 */
    resetView() {
      openId = null; hoverId = null; hoverHit = null; hoverPinned = false;
      pinned.clear();
      const board = B();
      if (board && typeof board.setHepPref === 'function') {
        board.setHepPref('all', false);
        board.setHepPref('teach', false);
      }
      refresh(true); requestFrame();
      return true;
    },
    pin(id) {
      if (!HEP_MODULES.some((m) => m.id === id)) return false;
      pinned.add(id); refresh(true); requestFrame();
      return true;
    },
    unpin(id) {
      pinned.delete(id); refresh(true); requestFrame();
      return true;
    },
    setPref(name, value) {
      const board = B();
      if (board && typeof board.setHepPref === 'function') {
        const r = board.setHepPref(name, value);
        refresh(true);
        return r;
      }
      return null;
    },
    /** 探针用：按网格坐标注入悬停 / 点击（与真实指针走同一套判定） */
    hoverAt(gx, gy) {
      const board = B();
      const p = board && board.view ? project(board.view, gx, gy) : { x: 0, y: 0 };
      lastPointer = { x: p.x, y: p.y };
      const mod = gridToModule(gx, gy);
      hoverId = mod ? mod.id : null;
      hoverHit = null;
      positionHoverCard(); updateHoverCard(); refresh(true); requestFrame();
      return hoverId;
    },
    clickAt(gx, gy) {
      const mod = gridToModule(gx, gy);
      if (mod) {
        openId = openId === mod.id ? null : mod.id;
      } else {
        // 与 onClick 的空白分支保持一致：点空白同时撤掉悬停信息卡
        openId = null;
        hoverPinned = false;
        hoverId = null;
        hoverHit = null;
      }
      positionHoverCard(); updateHoverCard(); refresh(true); requestFrame();
      return openId;
    },
    destroy() {
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKeyDown);
      layer.remove();
    },
  };
}
