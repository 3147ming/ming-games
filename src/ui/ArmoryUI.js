/**
 * 大厅「军械库」改装面板
 *
 * 数据流：SaveManager.loadout -> 玩家选择配件 -> onChange 让 GunSystem 重新合成。
 * 只负责 UI，不直接修改武器运行时状态。
 */
import { WEAPONS, WEAPON_UNLOCKED } from '../config/weapon.js';
import { MOD_SLOTS, ATTACHMENTS, ELEMENTS, deriveWeapon } from '../config/mods.js';

export class ArmoryUI {
  /**
   * @param {{save: import('../core/SaveManager.js').SaveManager, onChange?: Function}} opts
   */
  constructor(opts) {
    this.save = opts.save;
    this.onChange = opts.onChange || (() => {});
    this.weaponId = WEAPON_UNLOCKED[0];

    this.navEl = document.getElementById('armory-weapons');
    this.infoEl = document.getElementById('armory-info');
    this.slotsEl = document.getElementById('armory-slots');
    this.resetBtn = document.getElementById('btn-reset-mods');

    this._buildWeaponNav();
    this._bindEvents();
    this.refresh();
  }

  _buildWeaponNav() {
    if (!this.navEl) return;
    this.navEl.innerHTML = '';
    for (const id of WEAPON_UNLOCKED) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'armory-weapon';
      btn.dataset.weapon = id;
      btn.textContent = WEAPONS[id].name;
      this.navEl.appendChild(btn);
    }
  }

  _bindEvents() {
    if (this.navEl) {
      this.navEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.armory-weapon');
        if (!btn) return;
        this.weaponId = btn.dataset.weapon;
        this.refresh();
      });
    }

    if (this.slotsEl) {
      this.slotsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.armory-option');
        if (!btn) return;
        this.save.setMod(this.weaponId, btn.dataset.slot, btn.dataset.att);
        this.refresh();
        this.onChange();
      });
    }

    if (this.resetBtn) {
      this.resetBtn.addEventListener('click', () => {
        this.save.resetLoadout();
        this.refresh();
        this.onChange();
      });
    }
  }

  refresh() {
    const base = WEAPONS[this.weaponId];
    const loadout = this.save.data.loadout[this.weaponId] || {};
    const w = deriveWeapon(base, loadout);

    // 武器切换按钮高亮
    if (this.navEl) {
      for (const btn of this.navEl.querySelectorAll('.armory-weapon')) {
        btn.classList.toggle('active', btn.dataset.weapon === this.weaponId);
      }
    }

    // 左侧实时属性
    if (this.infoEl) {
      const element = ELEMENTS[w.element] || ELEMENTS.none;
      const rows = [
        ['伤害', w.damage.toFixed(1)],
        ['弹匣', `${w.magazineSize} 发`],
        ['换弹', `${w.reloadTime.toFixed(2)}s`],
        ['开镜 FOV', `${Math.round(w.adsFov)}°`],
        ['元素', element.name],
        ['射速', `${(60 / w.fireInterval).toFixed(0)} RPM`],
      ];
      this.infoEl.innerHTML = `<h3>${w.name} · 实时属性</h3>` + rows.map(([k, v]) =>
        `<div class="armory-stat"><span>${k}</span><b>${v}</b></div>`
      ).join('') + `<p class="setting-hint">${element.desc || '枪口可赋予风 / 火 / 雷 / 电 / 毒 / 连爆元素'}</p>`;
    }

    // 右侧五个槽位
    if (this.slotsEl) {
      this.slotsEl.innerHTML = '';
      for (const slot of MOD_SLOTS) {
        const card = document.createElement('div');
        card.className = 'armory-slot';

        const head = document.createElement('div');
        head.className = 'armory-slot-head';
        const title = document.createElement('b');
        title.textContent = slot.name;
        const hint = document.createElement('span');
        hint.textContent = slot.hint;
        head.appendChild(title);
        head.appendChild(hint);
        card.appendChild(head);

        const options = document.createElement('div');
        options.className = 'armory-options';
        for (const att of ATTACHMENTS[slot.id]) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'armory-option';
          btn.dataset.slot = slot.id;
          btn.dataset.att = att.id;
          if (att.id === loadout[slot.id]) btn.classList.add('active');

          const name = document.createElement('b');
          name.textContent = att.name;
          const desc = document.createElement('small');
          desc.textContent = att.desc;
          btn.appendChild(name);
          btn.appendChild(desc);
          options.appendChild(btn);
        }
        card.appendChild(options);
        this.slotsEl.appendChild(card);
      }
    }
  }
}
