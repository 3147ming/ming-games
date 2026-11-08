/**
 * 大厅「物资交易所」页签
 *
 * 三块内容：备弹补给（按武器口径）、材料采购（价格随购买次数递增）、货币兑换（双向差价）。
 * 只负责 UI 与调用 SaveManager 的经济方法，不直接写存档字段。
 */
import { AMMO_SHOP, MATERIAL_SHOP, EXCHANGE_OPS, EXCHANGE_UNLOCK } from '../config/progression.js';

export class ExchangeUI {
  /**
   * @param {{save: import('../core/SaveManager.js').SaveManager, onChange?: Function}} opts
   */
  constructor(opts) {
    this.save = opts.save;
    this.onChange = opts.onChange || (() => {});
    this.ammoEl = document.getElementById('exchange-ammo');
    this.materialEl = document.getElementById('exchange-materials');
    this.currencyEl = document.getElementById('exchange-currency');
    this.feedbackEl = document.getElementById('exchange-feedback');
    this._bind();
    this.refresh();
  }

  _bind() {
    this.ammoEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ammo]');
      if (!btn || btn.disabled) return;
      const res = this.save.buyAmmo(btn.dataset.ammo);
      this._feedback(res.message);
      this.refresh();
      if (res.ok) this.onChange();
    });
    this.materialEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-material]');
      if (!btn || btn.disabled) return;
      const res = this.save.buyMaterial(btn.dataset.material);
      this._feedback(res.message);
      this.refresh();
      if (res.ok) this.onChange();
    });
    this.currencyEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-exchange]');
      if (!btn || btn.disabled) return;
      const res = this.save.exchange(btn.dataset.exchange);
      this._feedback(res.message);
      this.refresh();
      if (res.ok) this.onChange();
    });
  }

  _feedback(text) {
    if (!this.feedbackEl) return;
    this.feedbackEl.textContent = text || '';
  }

  refresh() {
    const d = this.save.data;
    const coins = d.meta.coins || 0;
    const rep = d.meta.reputation || 0;
    const cores = d.meta.cores || 0;

    // ---- 备弹 ----
    if (this.ammoEl) {
      this.ammoEl.innerHTML = Object.values(AMMO_SHOP).map((def) => {
        const stock = d.meta.ammoStock[def.weapon] || 0;
        const full = stock >= def.cap;
        const can = !full && coins >= def.price;
        return [
          '<div class="shop-card">',
          `  <h3>${def.name}</h3>`,
          `  <p>+${def.rounds} 发 · 库存 ${stock}/${def.cap}</p>`,
          '  <div class="shop-card-foot">',
          `    <span class="shop-cost">${def.price} 金币</span>`,
          `    <span class="shop-tip">${full ? '已满' : '开局带入'}</span>`,
          '  </div>',
          `  <button class="btn mini shop-buy" data-ammo="${def.weapon}" ${can ? '' : 'disabled'}>购买</button>`,
          '</div>',
        ].join('');
      }).join('');
    }

    // ---- 材料采购 ----
    if (this.materialEl) {
      this.materialEl.innerHTML = Object.keys(MATERIAL_SHOP).map((id) => {
        const def = MATERIAL_SHOP[id];
        const key = def.material || id;
        const price = this.save.materialShopPrice(id);
        const owned = this.save.materialCount(key);
        const unlocked = this.save.materialUnlocked(id);
        const can = unlocked && coins >= price;
        return [
          `<div class="shop-card${unlocked ? '' : ' disabled'}">`,
          `  <h3>${def.name}</h3>`,
          `  <p>持有 ${owned} · 本次售价 ${price} 金币</p>`,
          '  <div class="shop-card-foot">',
          `    <span class="shop-cost">${unlocked ? '价格递增' : this.save.requirementText(def.unlock)}</span>`,
          `    <span class="shop-tip">${unlocked ? '不限购' : '未解锁'}</span>`,
          '  </div>',
          `  <button class="btn mini shop-buy" data-material="${id}" ${can ? '' : 'disabled'}>采购</button>`,
          '</div>',
        ].join('');
      }).join('');
    }

    // ---- 货币兑换 ----
    if (this.currencyEl) {
      const unlocked = this.save.exchangeUnlocked();
      this.currencyEl.innerHTML = EXCHANGE_OPS.map((op) => {
        const have = op.from === 'coins' ? coins : op.from === 'reputation' ? rep : cores;
        const can = unlocked && have >= op.fromAmount;
        const fromName = op.from === 'coins' ? '金币' : op.from === 'reputation' ? '声望' : '核心';
        return [
          `<div class="shop-card${unlocked ? '' : ' disabled'}">`,
          `  <h3>${op.label}</h3>`,
          `  <p>当前${fromName} ${have}</p>`,
          '  <div class="shop-card-foot">',
          `    <span class="shop-cost">${unlocked ? `需 ${op.fromAmount} ${fromName}` : this.save.requirementText(EXCHANGE_UNLOCK)}</span>`,
          '    <span class="shop-tip">卖出 / 买入差价</span>',
          '  </div>',
          `  <button class="btn mini shop-buy" data-exchange="${op.id}" ${can ? '' : 'disabled'}>兑换</button>`,
          '</div>',
        ].join('');
      }).join('');
    }
  }
}
