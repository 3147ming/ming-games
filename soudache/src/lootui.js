/**
 * 双栏搜刮界面（P18）——纯 DOM 控制器，不依赖 three / 画布。
 *
 * 设计铁律：
 * 1. UI 不写任何游戏规则。所有操作都只调 lootable.transferItem(ctx, uid, action)，
 *    占位预览只调 previewPlacement —— 与数据层共用同一套 canPlace，杜绝"预览合法、放下失败"。
 * 2. 所有失败都有可读提示（REASON_TEXT），相同原因短时间内合并，不刷屏。
 * 3. 任何不确定状态（拖拽中关闭 / 切换容器 / 失败放置）都回滚，物品不丢不复制。
 * 4. 价值提示只读，绝不写交易/出售数据。
 *
 * 快捷键：F 交互（由 main 接线）· 双击 快速拾取 · Ctrl+左键 快速转移 ·
 * Alt+左键 快速装备 · R 旋转 · Shift+左键 拆分 · Delete 丢弃 · T 自动整理 · Esc 关闭 ·
 * G 全部拾取。文本输入框聚焦时全部禁用（防误触）。
 */

import {
  itemW, itemH, itemValue, itemWeight, valuePerCell, displayUnits,
  usedCells, totalValue, REASON_TEXT,
} from './inventory.js';
import {
  transferItem, previewPlacement, findEquipSlot, entityContainers,
  entityValue, gearValue, gearWeight, REASON_TEXT as LOOT_REASON_TEXT,
  findItemInEntity, findGearItem,
} from './lootable.js';
import { RARITY } from './config.js';

const HIGH_VALUE = 6000; // 高价值边框阈值（单件总值）
const TOAST_MS = 1100; // 相同失败原因合并窗口

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function money(n) { return `¥${Math.round(n).toLocaleString('en-US')}`; }

/**
 * 创建双栏搜刮 UI。
 * @param {HTMLElement} host 挂载容器（ui-root 下的一个新节点）
 * @param {object} hooks { toast(msg,type), sound(kind), onChange(), onDiscard(uid,item), onClose() }
 * @returns {object} 控制器
 */
export function createLootUI(host, hooks = {}) {
  const root = el('div', 'lg-overlay hidden');
  root.dataset.role = 'loot-grid';
  root.innerHTML = `
    <div class="lg-frame">
      <header class="lg-head">
        <div class="lg-head-l"><span class="lg-kicker">SALVAGE / 搜刮</span><h2 data-role="lg-title">物资</h2></div>
        <div class="lg-head-r">
          <div class="lg-stat"><span class="k">来源估值</span><span class="v" data-role="lg-src-value">¥0</span></div>
          <div class="lg-stat"><span class="k">携带估值</span><span class="v accent" data-role="lg-dst-value">¥0</span></div>
          <button class="lg-x" data-action="lg-close" aria-label="关闭">×</button>
        </div>
      </header>
      <div class="lg-body">
        <section class="lg-col" data-side="src">
          <div class="lg-col-head">
            <span class="lg-col-title" data-role="lg-src-name">来源</span>
            <div class="lg-tabs" data-role="lg-src-tabs"></div>
          </div>
          <div class="lg-slots" data-role="lg-src-slots"></div>
          <div class="lg-grid-scroll"><div class="lg-grid" data-role="lg-src-grid" data-cid=""></div></div>
          <div class="lg-col-foot"><span data-role="lg-src-foot"></span></div>
        </section>
        <section class="lg-col" data-side="dst">
          <div class="lg-col-head">
            <span class="lg-col-title">我的装备与背包</span>
            <div class="lg-tabs" data-role="lg-dst-tabs"></div>
          </div>
          <div class="lg-slots" data-role="lg-dst-slots"></div>
          <div class="lg-grid-scroll"><div class="lg-grid" data-role="lg-dst-grid" data-cid=""></div></div>
          <div class="lg-col-foot lg-foot-actions">
            <span data-role="lg-dst-foot"></span>
            <div class="lg-btns">
              <button class="lg-btn" data-action="lg-sort" title="T">整理</button>
              <button class="lg-btn primary" data-action="lg-takeall" title="G">全部拾取</button>
            </div>
          </div>
        </section>
      </div>
      <footer class="lg-hint">
        <span>双击 / <b>Ctrl+左键</b> 快速拾取</span>
        <span><b>Alt+左键</b> 装备</span>
        <span><b>R</b> 旋转</span>
        <span><b>Shift+左键</b> 拆分</span>
        <span><b>T</b> 整理</span>
        <span><b>Delete</b> 丢弃</span>
        <span><b>Esc</b> 关闭</span>
      </footer>
    </div>
    <div class="lg-tip hidden" data-role="lg-tip"></div>
    <div class="lg-ghost hidden" data-role="lg-ghost"></div>
    <div class="lg-dialog hidden" data-role="lg-dialog"></div>
  `;
  host.appendChild(root);

  const q = (role) => root.querySelector(`[data-role="${role}"]`);
  const gridOf = (side) => q(side === 'src' ? 'lg-src-grid' : 'lg-dst-grid');

  let ctx = null; // { entity, gear }
  let open = false;
  let srcCid = null;
  let dstCid = null;
  let selected = null; // uid
  let drag = null; // { uid, rotated, grabX, grabY, w, h, active }
  let suppressClick = false; // 拖拽结束后浏览器补发的 click 必须吞掉
  let lastFail = { reason: '', t: 0 };
  let dialogKind = null;

  const isTextInput = () => {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

  function toast(msg, type = 'info') { if (hooks.toast) hooks.toast(msg, type); }
  function sound(kind) { if (hooks.sound) hooks.sound(kind); }
  function changed() { if (hooks.onChange) hooks.onChange(); }

  function fail(result, fallback) {
    const reason = (result && result.reason) || fallback || 'UNKNOWN';
    const now = Date.now();
    if (reason === lastFail.reason && now - lastFail.t < TOAST_MS) return false;
    lastFail = { reason, t: now };
    toast(REASON_TEXT[reason] || LOOT_REASON_TEXT[reason] || '操作失败', 'warn');
    sound('error');
    return true;
  }

  /** 统一操作入口：UI 只在这里调数据层（sort / takeAll 不需要 uid） */
  function act(uid, action, opts = {}) {
    if (!ctx || (!uid && action.kind !== 'sort' && action.kind !== 'takeAll')) {
      return { ok: false, reason: 'UNKNOWN' };
    }
    const r = transferItem(ctx, uid, action);
    if (r.ok) {
      sound(action.kind === 'equip' || action.kind === 'quickPickup' ? 'pickup' : 'ui');
      changed();
      render();
      if (opts.okToast) toast(opts.okToast, 'info');
    } else {
      // 空间不足时给出"建议替换"提示（替代平淡的一句"空间不足"）
      if (r.reason === 'NOT_ENOUGH_SPACE' && (action.kind === 'quickPickup' || action.kind === 'move')) {
        const s = suggest(uid);
        if (s) { toast(s, 'warn'); sound('error'); }
        else fail(r);
      } else fail(r);
    }
    return r;
  }

  function suggest(uid) {
    try {
      const found = findItemInEntity(ctx.entity, uid) || findGearItem(ctx.gear, uid);
      if (!found) return null;
      const inVal = valuePerCell(found.item);
      let worst = null;
      let worstVal = Infinity;
      for (const c of ctx.gear.containers || []) {
        for (const it of c.items) {
          if (it.locked || (it.tags || []).includes('task') || (it.tags || []).includes('secure')) continue;
          const v = valuePerCell(it);
          if (v < worstVal) { worstVal = v; worst = it; }
        }
      }
      if (!worst || worstVal >= inVal) return null;
      return `空间不足 · 该物品单格价值 ${money(inVal)}，建议替换：${worst.name}（${money(worstVal)}/格）`;
    } catch { return null; }
  }

  /** 当前显示的容器（按侧 + cid） */
  function activeContainer(side) {
    const cid = side === 'src' ? srcCid : dstCid;
    const list = side === 'src' ? entityContainers(ctx.entity) : (ctx.gear.containers || []);
    return list.find((c) => c.cid === cid) || list[0] || null;
  }

  function rarityColor(it) {
    return (RARITY[it.rarity] || RARITY.common).color;
  }

  function itemNode(it, side, cid) {
    const n = el('div', `lg-item rar-${it.rarity || 'common'}`);
    n.dataset.uid = it.uid;
    n.dataset.side = side;
    n.dataset.cid = cid;
    n.style.gridColumn = `${it.col + 1} / span ${itemW(it)}`;
    n.style.gridRow = `${it.row + 1} / span ${itemH(it)}`;
    n.style.setProperty('--rar', rarityColor(it));
    const total = itemValue(it);
    if (total >= HIGH_VALUE) n.classList.add('hi-value');
    if (it.locked) n.classList.add('locked');
    if (it.rotated) n.classList.add('rotated');
    if (selected === it.uid) n.classList.add('selected');
    const icon = el('div', 'lg-ico');
    icon.style.setProperty('--rar', rarityColor(it));
    icon.appendChild(el('span', 'lg-ico-glyph', (it.name || '?').slice(0, 1)));
    n.appendChild(icon);
    n.appendChild(el('div', 'lg-name', it.name || it.id));
    const disp = displayUnits(it);
    const meta = el('div', 'lg-meta');
    meta.appendChild(el('span', 'lg-cells', `${itemW(it)}×${itemH(it)}`));
    meta.appendChild(el('span', 'lg-vpc', `${money(valuePerCell(it))}/格`));
    n.appendChild(meta);
    if (it.qty > 1) n.appendChild(el('div', 'lg-qty', `×${disp.count}${disp.unit}`));
    return n;
  }

  function renderGrid(side) {
    const grid = gridOf(side);
    const c = activeContainer(side);
    grid.innerHTML = '';
    if (!c) { grid.classList.add('lg-empty'); return; }
    grid.classList.remove('lg-empty');
    grid.dataset.cid = c.cid || '';
    grid.style.setProperty('--cols', c.cols);
    grid.style.setProperty('--rows', c.rows);
    // 格线由 CSS 背景绘制；这里只铺一层用于落点预览的定位层
    const overlay = el('div', 'lg-previews');
    overlay.dataset.role = 'lg-previews';
    grid.appendChild(overlay);
    for (const it of c.items) {
      if (it.col < 0 || it.row < 0) continue;
      grid.appendChild(itemNode(it, side, c.cid));
    }
  }

  function renderTabs(side) {
    const host = q(side === 'src' ? 'lg-src-tabs' : 'lg-dst-tabs');
    host.innerHTML = '';
    const list = side === 'src' ? entityContainers(ctx.entity) : (ctx.gear.containers || []);
    const cid = side === 'src' ? srcCid : dstCid;
    for (const c of list) {
      const b = el('button', 'lg-tab', c.name || c.cid);
      b.dataset.cid = c.cid;
      if (c.cid === cid) b.classList.add('active');
      b.addEventListener('click', () => {
        if (side === 'src') srcCid = c.cid; else dstCid = c.cid;
        selected = null;
        render();
      });
      host.appendChild(b);
    }
  }

  function slotNode(s, side) {
    const n = el('div', `lg-slot${s.item ? ' filled' : ''}`);
    n.dataset.sid = s.type;
    n.dataset.side = side;
    n.appendChild(el('div', 'lg-slot-name', s.name || s.type));
    if (s.item) {
      n.style.setProperty('--rar', rarityColor(s.item));
      // 槽位物品也用 .lg-item：拖拽 / 双击 / Ctrl / Alt / Shift / 详情全套交互自动复用。
      const chip = el('div', 'lg-item lg-slot-chip');
      chip.dataset.uid = s.item.uid;
      chip.dataset.side = side;
      chip.dataset.cid = '__slot__';
      chip.style.setProperty('--rar', rarityColor(s.item));
      if (itemValue(s.item) >= HIGH_VALUE) chip.classList.add('hi-value');
      if (selected === s.item.uid) chip.classList.add('selected');
      chip.appendChild(el('div', 'lg-name', s.item.name));
      chip.appendChild(el('div', 'lg-meta', money(itemValue(s.item))));
      n.appendChild(chip);
    } else {
      n.appendChild(el('div', 'lg-slot-item empty', '— 空 —'));
    }
    return n;
  }

  function renderSlots(side) {
    const host = q(side === 'src' ? 'lg-src-slots' : 'lg-dst-slots');
    host.innerHTML = '';
    const slots = side === 'src' ? (ctx.entity.slots || []) : (ctx.gear.slots || []);
    if (!slots.length) { host.classList.add('empty'); return; }
    host.classList.remove('empty');
    for (const s of slots) host.appendChild(slotNode(s, side));
  }

  function renderStats() {
    const sv = q('lg-src-value');
    const dv = q('lg-dst-value');
    sv.textContent = money(entityValue(ctx.entity));
    dv.textContent = money(gearValue(ctx.gear));
    const sc = activeContainer('src');
    const dc = activeContainer('dst');
    q('lg-src-foot').textContent = sc
      ? `剩余 ${sc.items.length} 件 · ${usedCells(sc)}/${sc.cols * sc.rows} 格 · ${money(totalValue(sc))}`
      : '已搜空';
    const w = gearWeight(ctx.gear);
    const limit = ctx.weightLimit || 28;
    const foot = q('lg-dst-foot');
    foot.textContent = dc
      ? `${usedCells(dc)}/${dc.cols * dc.rows} 格 · ${money(totalValue(dc))} · 负重 ${w.toFixed(1)}/${limit}kg${w > limit ? ' ⚠ 超重' : ''}`
      : '';
    foot.classList.toggle('over', w > limit);
  }

  function render() {
    if (!ctx) return;
    renderTabs('src');
    renderTabs('dst');
    renderSlots('src');
    renderSlots('dst');
    renderGrid('src');
    renderGrid('dst');
    renderStats();
  }

  /* ---------------- 详情浮层 ---------------- */
  function showTip(it, ev) {
    const tip = q('lg-tip');
    tip.innerHTML = '';
    const rows = [
      ['品质', (RARITY[it.rarity] || RARITY.common).name],
      ['类型', it.category || '物资'],
      ['占格', `${itemW(it)}×${itemH(it)}（${itemW(it) * itemH(it)} 格）${it.rotated ? ' · 已旋转' : ''}`],
      ['总价值', money(itemValue(it))],
      ['单格价值', `${money(valuePerCell(it))}/格`],
      ['重量', `${itemWeight(it).toFixed(1)} kg`],
    ];
    if (it.qty > 1) rows.splice(1, 0, ['数量', String(it.qty)]);
    const tags = it.tags || [];
    rows.push(['任务物品', tags.includes('task') ? '是' : '否']);
    rows.push(['制作材料', tags.includes('crafting') ? '是' : '否']);
    rows.push(['绑定', tags.includes('bound') ? '是' : '否']);
    rows.push(['可交易', tags.includes('bound') ? '否' : '是']);
    tip.appendChild(el('div', 'lg-tip-title', it.name || it.id));
    tip.style.setProperty('--rar', rarityColor(it));
    for (const [k, v] of rows) {
      const r = el('div', 'lg-tip-row');
      r.appendChild(el('span', 'k', k));
      r.appendChild(el('span', 'v', v));
      tip.appendChild(r);
    }
    if (it.desc) tip.appendChild(el('div', 'lg-tip-desc', it.desc));
    tip.classList.remove('hidden');
    placeTip(ev);
  }
  function placeTip(ev) {
    const tip = q('lg-tip');
    const x = Math.min(window.innerWidth - 260, (ev.clientX || 0) + 18);
    const y = Math.min(window.innerHeight - 280, (ev.clientY || 0) + 14);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() { q('lg-tip').classList.add('hidden'); }

  /* ---------------- 拖拽 ---------------- */
  function findItemByUid(uid) {
    return findItemInEntity(ctx.entity, uid) || findGearItem(ctx.gear, uid);
  }

  function startDrag(uid, ev) {
    const found = findItemByUid(uid);
    if (!found) return;
    const it = found.item;
    drag = {
      uid,
      rotated: !!it.rotated,
      rotatable: !!it.rotate && it.w !== it.h,
      grabX: 0,
      grabY: 0,
      w: itemW(it),
      h: itemH(it),
      active: false,
      startX: ev.clientX,
      startY: ev.clientY,
    };
    // 抓取点在物品内的格子偏移（让物品跟随手感自然）
    const node = ev.target.closest('.lg-item');
    if (node) {
      const r = node.getBoundingClientRect();
      drag.grabX = Math.min(drag.w - 1, Math.max(0, Math.floor((ev.clientX - r.left) / Math.max(1, r.width / drag.w))));
      drag.grabY = Math.min(drag.h - 1, Math.max(0, Math.floor((ev.clientY - r.top) / Math.max(1, r.height / drag.h))));
    }
  }

  function updateGhost(ev) {
    const g = q('lg-ghost');
    if (!drag) return;
    g.classList.remove('hidden');
    g.style.left = `${ev.clientX}px`;
    g.style.top = `${ev.clientY}px`;
    g.textContent = (findItemByUid(drag.uid) || {}).item?.name || '';
    g.style.setProperty('--gw', drag.w);
    g.style.setProperty('--gh', drag.h);
  }

  function clearPreview() {
    for (const side of ['src', 'dst']) {
      const p = gridOf(side).querySelector('[data-role="lg-previews"]');
      if (p) p.innerHTML = '';
      gridOf(side).classList.remove('lg-target-ok', 'lg-target-bad');
    }
  }

  function hoverPreview(ev) {
    clearPreview();
    if (!drag || !drag.active) return;
    const grid = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.lg-grid');
    if (!grid) return;
    const r = grid.getBoundingClientRect();
    const cw = r.width / Number(grid.style.getPropertyValue('--cols') || 1);
    const ch = r.height / Number(grid.style.getPropertyValue('--rows') || 1);
    if (cw <= 0 || ch <= 0) return;
    const x = Math.floor((ev.clientX - r.left) / cw) - drag.grabX;
    const y = Math.floor((ev.clientY - r.top) / ch) - drag.grabY;
    const cid = grid.dataset.cid;
    const pv = previewPlacement(ctx, drag.uid, cid, x, y, drag.rotated);
    drag.preview = { cid, x, y, ok: pv.ok };
    const p = grid.querySelector('[data-role="lg-previews"]');
    if (p) {
      const box = el('div', `lg-prev ${pv.ok ? 'ok' : 'bad'}`);
      box.style.gridColumn = `${Math.max(1, x + 1)} / span ${Math.max(1, pv.w)}`;
      box.style.gridRow = `${Math.max(1, y + 1)} / span ${Math.max(1, pv.h)}`;
      p.appendChild(box);
    }
    grid.classList.add(pv.ok ? 'lg-target-ok' : 'lg-target-bad');
  }

  function endDrag(ev) {
    if (!drag) return;
    const d = drag;
    drag = null;
    q('lg-ghost').classList.add('hidden');
    clearPreview();
    // 真拖拽过 → 吞掉紧随其后的 click，避免"拖完又触发一次选中/快速拾取"
    if (d.active) {
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
    }
    if (d.active && d.preview) {
      const { cid, x, y } = d.preview;
      if (x >= 0 && y >= 0) {
        act(d.uid, { kind: 'move', toCid: cid, x, y, rotated: d.rotated });
      }
    }
  }

  /* ---------------- 弹层（拆分 / 丢弃确认） ---------------- */
  function closeDialog() {
    q('lg-dialog').classList.add('hidden');
    q('lg-dialog').innerHTML = '';
    dialogKind = null;
  }

  function openSplit(it) {
    dialogKind = 'split';
    const d = q('lg-dialog');
    d.innerHTML = '';
    const card = el('div', 'lg-dialog-card');
    card.appendChild(el('div', 'lg-dialog-title', `拆分 ${it.name}`));
    card.appendChild(el('div', 'lg-dialog-sub', `当前 ${it.qty} 件 · 输入要分出的数量（1 ~ ${it.qty - 1}）`));
    const input = el('input', 'lg-input');
    input.type = 'number';
    input.min = '1';
    input.max = String(it.qty - 1);
    input.value = String(Math.max(1, Math.floor(it.qty / 2)));
    input.dataset.role = 'lg-split-input';
    card.appendChild(input);
    const btns = el('div', 'lg-dialog-btns');
    const yes = el('button', 'lg-btn primary', '拆分');
    const no = el('button', 'lg-btn', '取消');
    yes.addEventListener('click', () => {
      const n = Number(input.value);
      closeDialog();
      act(it.uid, { kind: 'split', n });
    });
    no.addEventListener('click', closeDialog);
    btns.appendChild(yes);
    btns.appendChild(no);
    card.appendChild(btns);
    d.appendChild(card);
    d.classList.remove('hidden');
    input.focus();
    input.select();
  }

  function openDiscard(it) {
    dialogKind = 'discard';
    const d = q('lg-dialog');
    d.innerHTML = '';
    const card = el('div', 'lg-dialog-card');
    const high = itemValue(it) >= HIGH_VALUE;
    card.appendChild(el('div', 'lg-dialog-title', high ? '确认丢弃高价值物品？' : `丢弃 ${it.name}？`));
    card.appendChild(el('div', 'lg-dialog-sub',
      high ? `${it.name} 价值 ${money(itemValue(it))}，丢弃后会掉在脚边（可按 E 捡回）。`
        : '物品会掉在脚边，可按 E 捡回。'));
    const btns = el('div', 'lg-dialog-btns');
    const yes = el('button', 'lg-btn danger', '丢弃');
    const no = el('button', 'lg-btn', '取消');
    yes.addEventListener('click', () => {
      closeDialog();
      if (hooks.onDiscard) hooks.onDiscard(it.uid, it);
      render();
    });
    no.addEventListener('click', closeDialog);
    btns.appendChild(yes);
    btns.appendChild(no);
    card.appendChild(btns);
    d.appendChild(card);
    d.classList.remove('hidden');
  }

  /* ---------------- 事件 ---------------- */
  root.addEventListener('pointerdown', (ev) => {
    if (!open || dialogKind) return;
    const node = ev.target.closest('.lg-item');
    if (!node) return;
    const uid = node.dataset.uid;
    selected = uid;
    startDrag(uid, ev);
    // 只在真正移动超过阈值后才算拖拽，避免单击被吞
    drag.active = false;
    ev.preventDefault();
  });

  window.addEventListener('pointermove', (ev) => {
    if (!open || !drag) return;
    if (!drag.active) {
      if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 6) return;
      drag.active = true;
    }
    updateGhost(ev);
    hoverPreview(ev);
  });

  window.addEventListener('pointerup', (ev) => {
    if (!open || !drag) return;
    endDrag(ev);
  });

  root.addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-action]')?.dataset.action;
    if (action) {
      if (action === 'lg-close') { close(); return; }
      if (action === 'lg-sort') {
        const c = activeContainer('dst');
        if (c) act(null, { kind: 'sort', cid: c.cid }, {}); // sort 不用 uid
        return;
      }
      if (action === 'lg-takeall') { takeAll(); return; }
      return;
    }
    const node = ev.target.closest('.lg-item');
    if (!node || !open || dialogKind) return;
    // 拖拽结束后浏览器仍会补一个 click：忽略，避免"拖完又触发一次快速拾取"
    if (suppressClick) return;
    const uid = node.dataset.uid;
    const side = node.dataset.side;
    if (ev.shiftKey) {
      const f = findItemByUid(uid);
      if (f && f.item.stack > 1 && f.item.qty > 1) openSplit(f.item);
      else fail({ reason: 'NOT_STACKABLE' });
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      act(uid, { kind: side === 'src' ? 'quickPickup' : 'quickStore' });
      return;
    }
    if (ev.altKey) {
      const f = findItemByUid(uid);
      const sid = f && findEquipSlot(ctx.gear, f.item);
      if (sid) act(uid, { kind: 'equip', sid });
      else fail({ reason: 'SLOT_NOT_ALLOWED' });
      return;
    }
    selected = uid;
    render();
  });

  root.addEventListener('dblclick', (ev) => {
    const node = ev.target.closest('.lg-item');
    if (!node || !open || dialogKind) return;
    const uid = node.dataset.uid;
    const side = node.dataset.side;
    act(uid, { kind: side === 'src' ? 'quickPickup' : 'quickStore' });
  });

  root.addEventListener('mousemove', (ev) => {
    if (!open || dialogKind || (drag && drag.active)) { if (drag && drag.active) hideTip(); return; }
    const node = ev.target.closest('.lg-item');
    if (node) {
      const f = findItemByUid(node.dataset.uid);
      if (f) { showTip(f.item, ev); return; }
    }
    hideTip();
  });
  root.addEventListener('mouseleave', hideTip);

  root.addEventListener('contextmenu', (ev) => {
    if (!open) return;
    ev.preventDefault();
    const node = ev.target.closest('.lg-item');
    if (!node) return;
    const f = findItemByUid(node.dataset.uid);
    if (f) openDiscard(f.item);
  });

  /** 全部拾取（原子：任一放不下则整体不动） */
  function takeAll() {
    if (!ctx) return;
    const c = activeContainer('src');
    if (!c || !c.items.length) { toast('这里已经空了'); return; }
    const r = transferItem(ctx, null, { kind: 'takeAll', cid: c.cid, atomic: true });
    if (r.ok) {
      toast(`拾取 ${r.taken} 件`, 'info');
      sound('pickup');
      changed();
      render();
    } else {
      // 原子失败：给出"空间不足"，并尝试非原子模式让玩家能拿多少拿多少
      const partial = transferItem(ctx, null, { kind: 'takeAll', cid: c.cid, atomic: false });
      if (partial.taken > 0) {
        toast(`拾取 ${partial.taken} 件，剩余空间不足`, 'warn');
        changed();
        render();
      } else fail(r);
    }
  }

  /** 键盘快捷键（由 main 的 keydown 转发） */
  function onKey(key, ev) {
    if (!open) return false;
    if (dialogKind) {
      if (key === 'escape') { ev.preventDefault(); closeDialog(); return true; }
      if (key === 'enter' && dialogKind === 'split') {
        ev.preventDefault();
        const input = q('lg-split-input');
        const btn = root.querySelector('.lg-dialog-btns .primary');
        if (input && btn) btn.click();
        return true;
      }
      return true; // 弹层打开时吞掉其它键
    }
    if (isTextInput()) return false;
    switch (key) {
      case 'escape': ev.preventDefault(); close(); return true;
      case 'r': {
        ev.preventDefault();
        if (drag && drag.active && drag.rotatable) {
          drag.rotated = !drag.rotated;
          const t = drag.w; drag.w = drag.h; drag.h = t;
          const g = q('lg-ghost');
          g.style.setProperty('--gw', drag.w);
          g.style.setProperty('--gh', drag.h);
        } else if (selected) act(selected, { kind: 'rotate' });
        return true;
      }
      case 't': {
        ev.preventDefault();
        const c = activeContainer('dst');
        if (c) {
          const r = transferItem(ctx, null, { kind: 'sort', cid: c.cid });
          if (r.ok) { toast('已整理当前容器', 'info'); sound('ui'); changed(); render(); }
          else fail(r);
        }
        return true;
      }
      case 'g': ev.preventDefault(); takeAll(); return true;
      case 'delete':
      case 'backspace': {
        ev.preventDefault();
        if (selected) {
          const f = findItemByUid(selected);
          if (f) openDiscard(f.item);
        }
        return true;
      }
      default: return true; // 面板打开时吞掉所有游戏按键（不再走动/开火）
    }
  }

  function openUI(entity, gear, opts = {}) {
    ctx = { entity, gear };
    ctx.weightLimit = opts.weightLimit || 28;
    open = true;
    selected = null;
    drag = null;
    const srcs = entityContainers(entity);
    srcCid = (srcs[0] && srcs[0].cid) || null;
    const dsts = gear.containers || [];
    const bp = dsts.find((c) => c.cid === 'backpack') || dsts[0];
    dstCid = bp ? bp.cid : null;
    q('lg-title').textContent = opts.title || entity.name || '物资';
    q('lg-src-name').textContent = entity.name || '来源';
    root.classList.remove('hidden');
    render();
  }

  function close() {
    if (!open) return;
    // 拖拽中关闭 = 取消拖拽，状态不损坏（数据层本来就没提交）
    drag = null;
    q('lg-ghost').classList.add('hidden');
    clearPreview();
    hideTip();
    closeDialog();
    open = false;
    root.classList.add('hidden');
    ctx = null;
    if (hooks.onClose) hooks.onClose();
  }

  return {
    open: openUI,
    close,
    isOpen: () => open,
    onKey,
    render,
    getContext: () => ctx,
    getSelected: () => selected,
    activeContainer,
    takeAll,
  };
}
