/**
 * 大厅「军械库」改装面板
 *
 * 解锁规则：
 *  - 槽位需要金币解锁；
 *  - 配件需要"制造"（花金币）后才可装配；
 *  - 元素类配件额外需要声望 + 首领核心。
 */
import { WEAPONS, WEAPON_UNLOCKED } from '../config/weapon.js';
import { MOD_SLOTS, ATTACHMENTS, ELEMENTS, deriveWeapon } from '../config/mods.js';
import { MOD_UNLOCK } from '../config/progression.js';

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
      this.feedbackEl = document.createElement('p');
      this.feedbackEl.className = 'mission-feedback';
      this.slotsEl.parentElement?.insertBefore(this.feedbackEl, this.slotsEl.nextSibling);
      this.slotsEl.addEventListener('click', (e) => {
        const unlockBtn = e.target.closest('[data-unlock-slot]');
        if (unlockBtn) {
          const res = this.save.unlockModSlot(unlockBtn.dataset.unlockSlot);
          this._feedback(res.message);
          this.refresh();
          if (res.ok) this.onChange();
          return;
        }
        const btn = e.target.closest('.armory-option');
        if (!btn) return;
        // 未制造：先花钱解锁制造权限
        if (btn.dataset.crafted !== '1') {
          const res = this.save.craftAttachment(btn.dataset.slot, btn.dataset.att);
          this._feedback(res.message);
          this.refresh();
          if (res.ok) this.onChange();
          return;
        }
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

  _feedback(text) {
    if (this.feedbackEl) this.feedbackEl.textContent = text || '';
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

        // 槽位未解锁：只显示解锁按钮
        if (!this.save.isModSlotUnlocked(slot.id)) {
          card.classList.add('locked');
          const lock = document.createElement('p');
          lock.className = 'armory-lock-hint';
          lock.textContent = `槽位未解锁 · ${MOD_UNLOCK.slots[slot.id]} 金币`;
          const unlockBtn = document.createElement('button');
          unlockBtn.type = 'button';
          unlockBtn.className = 'btn mini';
          unlockBtn.dataset.unlockSlot = slot.id;
          unlockBtn.textContent = '解锁槽位';
          card.appendChild(lock);
          card.appendChild(unlockBtn);
          this.slotsEl.appendChild(card);
          continue;
        }

        for (const att of ATTACHMENTS[slot.id]) {
          const crafted = this.save.isAttachmentCrafted(att.id);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'armory-option';
          btn.dataset.slot = slot.id;
          btn.dataset.att = att.id;
          btn.dataset.crafted = crafted ? '1' : '0';
          if (att.id === loadout[slot.id]) btn.classList.add('active');
          if (!crafted) btn.classList.add('uncrafted');

          const name = document.createElement('b');
          name.textContent = crafted ? att.name : `${att.name} · 未制造`;
          const desc = document.createElement('small');
          if (crafted) {
            desc.textContent = att.desc;
          } else if (att.element) {
            const c = MOD_UNLOCK.elementCraft;
            desc.textContent = `元素配件 · 声望 ${c.reputation} + 首领核心 ${c.bossCore}`;
          } else {
            desc.textContent = `制造费 ${MOD_UNLOCK.craft} 金币`;
          }
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
