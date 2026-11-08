/**
 * 成长面板（局内 TAB 唤出）
 *
 * 三个分页：机甲 / 天赋 / 觉醒（属性点）。
 * DOM 全部动态创建，不依赖 index.html 结构；打开时游戏进入 panel 状态（暂停推进）。
 */
import { ATTRIBUTES, MECHS, MECH_ORDER, TALENTS, talentCost } from '../config/growth.js';

export class GrowthUI {
  /**
   * @param {{onClose:Function, onUnlockMech:Function, onActivateMech:Function,
   *          onUpgradeTalent:Function, onAllocate:Function}} handlers
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.tab = 'mech';
    this.visible = false;
    this._build();
  }

  _build() {
    if (document.getElementById('growth-panel')) {
      this.root = document.getElementById('growth-panel');
    } else {
      const el = document.createElement('div');
      el.id = 'growth-panel';
      el.className = 'overlay growth-panel hidden';
      el.innerHTML = `
        <div class="growth-card">
          <div class="growth-head">
            <div>
              <div class="growth-kicker">GROWTH</div>
              <h2 class="growth-title">成长面板</h2>
            </div>
            <div class="growth-head-right">
              <span class="growth-lv" id="growth-lv"></span>
              <button class="btn btn-ghost" id="btn-growth-close">继续（TAB）</button>
            </div>
          </div>
          <div class="growth-tabs">
            <button class="growth-tab active" data-gtab="mech">机甲</button>
            <button class="growth-tab" data-gtab="talent">天赋</button>
            <button class="growth-tab" data-gtab="awaken">觉醒</button>
          </div>
          <div class="growth-body" id="growth-body"></div>
        </div>`;
      document.getElementById('app')?.appendChild(el);
      this.root = el;
    }
    this.$lv = this.root.querySelector('#growth-lv');
    this.$body = this.root.querySelector('#growth-body');

    this.root.querySelector('#btn-growth-close').addEventListener('click', () => this.handlers.onClose?.());
    for (const btn of this.root.querySelectorAll('.growth-tab')) {
      btn.addEventListener('click', () => {
        this.tab = btn.dataset.gtab;
        this._syncTabs();
        this.render();
      });
    }
  }

  _syncTabs() {
    for (const btn of this.root.querySelectorAll('.growth-tab')) {
      btn.classList.toggle('active', btn.dataset.gtab === this.tab);
    }
  }

  /** 打开面板并渲染 */
  show(save, mechStates) {
    this.save = save;
    this.mechStates = mechStates || [];
    this.visible = true;
    this.root.classList.remove('hidden');
    this._syncTabs();
    this.render();
  }

  /** 机甲状态变化后（召唤/结束）刷新用 */
  setMechStates(states) {
    this.mechStates = states || [];
  }

  hide() {
    this.visible = false;
    this.root.classList.add('hidden');
  }

  /** 重新渲染当前分页（存档变化后调用） */
  render() {
    if (!this.save) return;
    const p = this.save.getProgress();
    this.$lv.textContent = p.max ? `Lv.${p.level} · 满级` : `Lv.${p.level} · ${p.xp}/${p.next} EXP`;
    if (this.tab === 'mech') this._renderMech();
    else if (this.tab === 'talent') this._renderTalent();
    else this._renderAwaken();
  }

  _renderMech() {
    const meta = this.save.data.meta;
    const cards = MECH_ORDER.map((id) => {
      const def = MECHS[id];
      const unlocked = this.save.hasMech(id);
      const active = this.mechStates.find((s) => s.def.id === id)?.active;
      const action = unlocked
        ? (def.type === 'deploy' ? '部署' : '出击')
        : `解锁（${def.cost.coins} 金币 + ${def.cost.mecha} 机甲材料）`;
      return `
        <div class="growth-card-item${unlocked ? '' : ' locked'}">
          <div class="growth-item-title">${def.name}${active ? ' · 进行中' : ''}</div>
          <div class="growth-item-desc">${def.desc}</div>
          <button class="btn growth-action" data-mech="${id}">${action}</button>
        </div>`;
    }).join('');
    this.$body.innerHTML = `
      <div class="growth-hint">金币 ${meta.coins} · 机甲材料 ${meta.materials.mecha}</div>
      <div class="growth-grid">${cards}</div>`;
    for (const btn of this.$body.querySelectorAll('[data-mech]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.mech;
        if (!this.save.hasMech(id)) this.handlers.onUnlockMech?.(id);
        else this.handlers.onActivateMech?.(id);
        this.render();
      });
    }
  }

  _renderTalent() {
    const talents = this.save.data.talents;
    const meta = this.save.data.meta;
    const cols = Object.values(TALENTS).map((def) => {
      const lv = talents[def.id] || 0;
      const cost = talentCost(def.id, lv);
      const pips = Array.from({ length: def.costs.length }, (_, i) => `
        <span class="talent-pip${i < lv ? ' on' : ''}"></span>`).join('');
      const action = cost
        ? `升级（${cost.coins} 金币 + ${cost.awaken} 觉醒材料）`
        : '已满级';
      return `
        <div class="growth-card-item">
          <div class="growth-item-title">${def.name} · ${lv}/${def.costs.length} 级</div>
          <div class="talent-pips">${pips}</div>
          <div class="growth-item-desc">${def.desc}</div>
          <button class="btn growth-action" data-talent="${def.id}" ${cost ? '' : 'disabled'}>${action}</button>
        </div>`;
    }).join('');
    this.$body.innerHTML = `
      <div class="growth-hint">金币 ${meta.coins} · 觉醒材料 ${meta.materials.awaken}</div>
      <div class="growth-grid">${cols}</div>`;
    for (const btn of this.$body.querySelectorAll('[data-talent]')) {
      btn.addEventListener('click', () => {
        this.handlers.onUpgradeTalent?.(btn.dataset.talent);
        this.render();
      });
    }
  }

  _renderAwaken() {
    const p = this.save.getProgress();
    const perm = this.save.data.permanent;
    const rows = Object.values(ATTRIBUTES).map((def) => {
      const cur = perm[def.id] || 0;
      const can = p.points > 0 && cur < def.max;
      return `
        <div class="growth-card-item">
          <div class="growth-item-title">${def.name} · ${cur}/${def.max}</div>
          <div class="growth-item-desc">${def.desc} / 点</div>
          <button class="btn growth-action" data-attr="${def.id}" ${can ? '' : 'disabled'}>分配属性点</button>
        </div>`;
    }).join('');
    this.$body.innerHTML = `
      <div class="growth-hint">可用属性点 ${p.points} · 每级获得 1 点</div>
      <div class="growth-grid">${rows}</div>`;
    for (const btn of this.$body.querySelectorAll('[data-attr]')) {
      btn.addEventListener('click', () => {
        this.handlers.onAllocate?.(btn.dataset.attr);
        this.render();
      });
    }
  }
}
