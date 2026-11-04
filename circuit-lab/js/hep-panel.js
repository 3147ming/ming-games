/**
 * hep-panel.js — HEP-DCTS-01 实物平台「模块元件行为」层
 *
 * 设计边界：
 *   - DOM 覆盖层：pointer-events:none，只有按钮 auto，绝不抢走画布的连线 /
 *     放置 / 拖拽 / 右键交互（与 probe-markers.js 同一套路）。
 *   - 不碰仿真内核：所有操作走 __labBoard 已经暴露的
 *     simdig.toggleSwitch / triggerPulse / stepClock、model.updateParams、
 *     simdc.solve；读数来自 model 参数与 instruments.read()。
 *   - 不进 model 存档：卡片状态每次从电路与仿真结果实时推导。
 *   - 位置用 project(view, 网格中心) 重投影，缩放 / 平移不漂移；
 *     与 probe-markers 共用一个 onAfterRender 回调（由 app.js 合流）。
 */

import { HEP_MODULES } from './hep-skin.js';
import { project } from './render.js';

const HEP_SKIN = 'hep';

/** 共阴七段：0–F 对应的 a–g 亮段 */
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

  let visible = true;
  let lastViewKey = '';
  let lastStateKey = '';
  const cards = new Map();

  HEP_MODULES.forEach((mod) => {
    const card = el('div', `hep-module-card hep-module-card--${mod.kind}`);
    card.dataset.module = mod.id;
    const title = el('div', 'hep-card-title', mod.label);
    const body = el('div', 'hep-card-body');
    const actions = el('div', 'hep-card-actions');
    card.append(title, body, actions);
    layer.append(card);
    cards.set(mod.id, { mod, card, body, actions });
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

  /** 电路里与 6 模块相关的元件 */
  function collect() {
    const board = B();
    if (!board || !board.model) return null;
    const comps = board.model.getState().components || [];
    return {
      board,
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

  function stateKey(st, dmm, dig) {
    if (!st) return 'none';
    const bits = (list) => list.map((c) => `${c.id}:${JSON.stringify(c.params || {})}`).join(',');
    return [
      bits(st.switches), bits(st.pulses), bits(st.clocks), bits(st.ics),
      dmm ? `${dmm.ok}|${dmm.value}` : 'no-dmm',
      dig ? `dig:${Boolean(dig.hasDigital)}` : 'no-dig',
      visible,
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
        });
      }
      row.append(btn);
    }
    return row;
  }

  function renderSwitches(entry, st) {
    const { board } = st;
    entry.body.append(bitRow(st, board));
    const note = el('div', 'hep-card-note',
      st.switches.length
        ? `已接入 ${st.switches.length} 路逻辑开关 · 点击位号拨动，电路立即重仿`
        : '元件库放入「逻辑电平开关」后，这里可逐位拨动');
    entry.body.append(note);
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
      }, 'hep-btn--primary'));
    } else {
      entry.actions.append(button('全部翻转', () => {
        st.switches.slice(0, 8).forEach((c) => board.simdig.toggleSwitch(c.id));
        onToast('8 路逻辑开关已全部翻转', 'info');
        refresh(true);
      }));
    }
  }

  function renderSockets(entry, st) {
    const list = el('div', 'hep-chip-list');
    if (st.ics.length === 0) {
      list.append(el('span', 'hep-card-note', '尚未插入 IC；14P / 16P 锁紧座待用'));
    } else {
      st.ics.slice(0, 4).forEach((c) => {
        const chip = el('span', 'hep-chip', `${c.id} · ${c.type}`);
        list.append(chip);
      });
    }
    entry.body.append(list);
    entry.body.append(el('div', 'hep-card-note', 'U1 14P · U2 16P · 蓝色主板锁紧座'));
    const probe = el('div', 'hep-card-note',
      `逻辑笔：${st.ics.length ? '已接芯片' : '待接线'} · 点击右下「逻辑笔」模块读电平`);
    entry.body.append(probe);
  }

  function renderDisplay(entry, st) {
    const list = st.switches.slice(0, 4);
    let value = null;
    if (list.length === 4) {
      value = list.reduce((acc, c, i) => acc + ((c.params && c.params.state === 'hi') ? 1 : 0) * (1 << (3 - i)), 0);
    }
    const screen = el('div', 'hep-seven-seg', value === null ? '—' : value.toString(16).toUpperCase());
    entry.body.append(screen);
    const segs = el('div', 'hep-seg-row');
    const lit = value === null ? '' : SEG_MAP[value];
    SEG_NAMES.forEach((name) => {
      const dot = el('span', `hep-seg${lit.includes(name) ? ' is-on' : ''}`, name);
      segs.append(dot);
    });
    entry.body.append(segs);
    entry.body.append(el('div', 'hep-card-note',
      value === null
        ? '4 路逻辑开关 → BCD 段码；放入 4 路后显示 0–F'
        : `BCD = ${list.map((c) => (c.params && c.params.state === 'hi') ? 1 : 0).join('')} → ${value.toString(16).toUpperCase()}`));
  }

  function renderPulse(entry, st) {
    const { board } = st;
    const clock = st.clocks[0];
    const pulseComp = st.pulses[0];
    const info = el('div', 'hep-card-note',
      `连续脉冲：${clock ? `${clock.params.frequency}Hz / ${clock.params.duty}%` : '未放置时钟源'} · 单次：${pulseComp ? pulseComp.id : '未放置脉冲源'}`);
    entry.body.append(info);

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
    const probe = el('div', 'hep-probe');
    const lampClass = level === '1' ? 'is-hi' : (level === '0' ? 'is-lo' : 'is-na');
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

  /* ---------------------------------------------------------------- 帧同步 */

  function refresh(force) {
    const board = B();
    if (!board) return;
    const show = visible && board.skin === HEP_SKIN && board.platformId === 'exp-box';
    layer.hidden = !show;
    if (!show) return;

    const st = collect();
    const dmm = readDmm();
    const dig = digState();
    const key = stateKey(st, dmm, dig);
    if (!force && key === lastStateKey) return;
    lastStateKey = key;
    if (!st) return;
    HEP_MODULES.forEach((mod) => {
      const entry = cards.get(mod.id);
      if (entry) renderCard(entry, st, dmm, dig);
    });
  }

  /** 与 probe-markers 共用 onAfterRender；view 六参数变化才重投影 */
  function onViewFrame(view) {
    const board = B();
    if (!board) return;
    const key = [
      view.tileW, view.tileH, view.originX, view.originY,
      view.zoom, view.panX, view.panY, board.skin, board.platformId,
    ].join('|');
    if (key !== lastViewKey) {
      lastViewKey = key;
      HEP_MODULES.forEach((mod) => {
        const p = project(view, mod.x + mod.w / 2, mod.y + mod.h / 2);
        const card = cards.get(mod.id).card;
        card.style.left = `${p.x}px`;
        card.style.top = `${p.y}px`;
      });
    }
    refresh(false);
  }

  return {
    layer,
    sync: () => refresh(true),
    onViewFrame,
    setVisible(on) { visible = Boolean(on); refresh(true); return visible; },
    isVisible() { return visible; },
    /** 探针用：6 模块的结构与当前状态摘要 */
    list() {
      const board = B();
      const st = collect();
      return HEP_MODULES.map((mod) => ({
        id: mod.id,
        label: mod.label,
        kind: mod.kind,
        visible: !layer.hidden && !cards.get(mod.id).card.hidden,
        switches: st ? st.switches.length : 0,
        pulses: st ? st.pulses.length : 0,
        clocks: st ? st.clocks.length : 0,
        ics: st ? st.ics.length : 0,
        skin: board ? board.skin : null,
      }));
    },
    destroy() { layer.remove(); },
  };
}
