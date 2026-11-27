// 波次模式的 DOM 层：波次 HUD + 波间商店面板。零玩法逻辑（全在 WaveDirector）。
// 由 Arena._loop 每帧调 syncWaveUi(arena)；旧模式不 import 本模块的行为路径。

import { RARITIES, WAVE_COUNT, weaponGoodById } from './wave-config.js';
import { WEAPONS } from './content.js';

// 波次武器池有 12 把（含 6 把进阶型号），content.js 只有 6 把底层机制。
// 先查波次表，货架/槽位才能正确显示「连弩 / 贯穿枪 / 磁轨炮」这些进阶型号。
const weaponLabel = (id) => {
  const g = weaponGoodById(id);
  if (g) return g.label;
  return (WEAPONS.find((w) => w.id === id) || { label: id }).label;
};
const rarColor = (i) => RARITIES[Math.max(0, Math.min(RARITIES.length - 1, i | 0))].color;
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function syncWaveUi(a) {
  const c = a.core;
  const d = c && c.wd;
  if (!d) return;

  const hud = a.waveHudEl;
  if (hud) {
    hud.hidden = false;
    const label = d.wave > WAVE_COUNT ? `无尽 · 第 ${d.wave} 波` : `第 ${d.wave} / ${WAVE_COUNT} 波`;
    const boss = d.bossWaves.includes(d.wave) && d.phase === 'battle' ? ' · BOSS' : '';
    const phase = d.phase === 'shop' ? '波间整备'
      : d.phase === 'done' ? '已结束'
        : c.pendingUpgrade && d.timeLeft <= 0 ? '波末升级'
          : `${Math.ceil(Math.max(0, d.timeLeft))}s`;
    hud.textContent = `${label}${boss} · ${phase} · 材料 ${d.materials} · ${d.danger.label}`;
  }

  const el = a.waveShopEl;
  if (!el) return;
  if (d.phase === 'shop') {
    if (el.hidden || el.dataset.wave !== String(d.wave)) renderWaveShop(a, d, el);
  } else if (!el.hidden) {
    el.hidden = true;
  }
}

function renderWaveShop(a, d, el) {
  el.hidden = false;
  el.dataset.wave = String(d.wave);

  const slotRows = d.slots.map((s, i) => `
    <button class="ws-slot" data-slot="${i}" type="button" title="卖出该武器">
      <span class="ws-slot-n">${i + 1}</span>
      <span class="ws-slot-name">${esc(weaponLabel(s.id))}</span>
      <span class="ws-slot-r" style="color:${rarColor(s.rarity)}">${'★'.repeat(s.rarity + 1)}</span>
      <span class="ws-slot-sell">卖</span>
    </button>`).join('');

  const goods = d.shop.map((g, i) => {
    const full = g.kind === 'weapon' && d.slots.length >= d.char.maxWeapons;
    const dis = g.sold || d.materials < g.cost || full;
    const why = g.sold ? '已购买' : full ? '武器槽已满' : (d.materials < g.cost ? '材料不足' : g.cost + ' 材料');
    return `
    <button class="ws-good${g.sold ? ' sold' : ''}" data-buy="${i}" type="button" ${dis ? 'disabled' : ''}>
      <span class="ws-good-r" style="color:${g.rarityColor}">${g.rarityLabel}</span>
      <span class="ws-good-name">${esc(g.label)}</span>
      <span class="ws-good-desc">${esc(g.desc)}</span>
      <span class="ws-good-cost">${why}</span>
      <span class="ws-lock${g.locked ? ' on' : ''}" data-lock="${i}">${g.locked ? '已锁定' : '锁定'}</span>
    </button>`;
  }).join('');

  const contrib = Object.entries(d.waveDamage || {})
    .sort((x, y) => y[1] - x[1]).slice(0, 4)
    .map(([k, v]) => `${esc(k)} ${v}`).join(' · ');

  // 合成升阶高光：买武器触发同类合成时 director 写入，这里读一次后清空。
  const fusion = d.fusionFlash;
  d.fusionFlash = null;
  const fusionRow = fusion
    ? `<div class="ws-fusion">⚗ 合成升阶！${esc(fusion.label)} → <b style="color:${fusion.color}">${esc(fusion.rarityLabel)} ${fusion.stars}</b></div>`
    : '';

  el.innerHTML = `
    <div class="ws-panel">
      <div class="ws-head">第 ${d.wave} 波结束 · 波间商店</div>
      ${fusionRow}
      <div class="ws-mat">材料 <b>${d.materials}</b>　·　${d.danger.label}　·　武器槽 ${d.slots.length}/${d.char.maxWeapons}　·　${esc(d.char.label)}</div>
      <div class="ws-sub">武器槽（点击卖出，同类同稀有度自动合成升阶）</div>
      <div class="ws-weapons">${slotRows || '<span class="ws-empty">暂无武器</span>'}</div>
      <div class="ws-sub">货架（点「锁定」可在刷新时保留）</div>
      <div class="ws-goods">${goods}</div>
      <div class="ws-actions">
        <button class="ws-reroll" type="button">刷新 · ${d.rerollCost()} 材料</button>
        <button class="ws-next" type="button">进入第 ${d.wave + 1} 波</button>
      </div>
      <div class="ws-foot">${contrib ? `上一波输出贡献：${contrib}` : '上一波没有击杀记录'}</div>
    </div>`;

  el.querySelectorAll('[data-buy]').forEach((b) => {
    b.onclick = () => { if (d.buy(Number(b.dataset.buy))) { renderWaveShop(a, d, el); a._needsPaint = true; } };
  });
  el.querySelectorAll('[data-lock]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      d.toggleLock(Number(b.dataset.lock));
      renderWaveShop(a, d, el);
    };
  });
  el.querySelectorAll('[data-slot]').forEach((b) => {
    b.onclick = () => { if (d.sellSlot(Number(b.dataset.slot))) renderWaveShop(a, d, el); };
  });
  const rr = el.querySelector('.ws-reroll');
  if (rr) rr.onclick = () => { if (d.reroll()) renderWaveShop(a, d, el); };
  const nx = el.querySelector('.ws-next');
  if (nx) nx.onclick = () => {
    d.nextWave();
    el.hidden = true;
    a._needsPaint = true;
    // 立刻把 HUD 推到新波次：只靠下一帧 _loop 同步的话，点击回调/自动化脚本
    // 在同一拍读到的时间还是「第 N 波 · 波间整备」（截图脚本就踩过这条）。
    syncWaveUi(a);
  };
}
