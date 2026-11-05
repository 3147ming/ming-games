/**
 * HUD 控制器：负责所有 DOM 数值与反馈更新
 */
import { PLAYER, WEAPON, MATCH } from '../config/weapon.js';

export class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.root = $('hud');
    this.hpValue = $('hp-value');
    this.hpFill = $('hp-fill');
    this.armorValue = $('armor-value');
    this.armorFill = $('armor-fill');
    this.killValue = $('kill-value');
    this.enemyValue = $('enemy-value');
    this.headshotValue = $('headshot-value');   // 第三轮：爆头击杀计数
    this.killPopup = $('kill-popup');           // 第三轮：悬浮击杀文字
    this.headshotKills = 0;
    // 波次 HUD（v0.2）
    this.waveNow = $('wave-now');
    this.waveTotal = $('wave-total');
    this.waveRemain = $('wave-remain');
    this.waveHud = $('wave-hud');
    // 局内任务目标
    this.missionObj = $('mission-objective');
    this.missionObjName = $('mission-obj-name');
    this.missionObjNow = $('mission-obj-now');
    this.missionObjTotal = $('mission-obj-total');
    this.magValue = $('mag-value');
    this.reserveValue = $('reserve-value');
    this.reloadTip = $('reload-tip');
    this.crosshair = $('crosshair');
    this.hitmarker = $('hitmarker');
    this.vignette = $('damage-vignette');
    this.killfeed = $('killfeed');
    this.reloadBar = $('reload-bar');
    this.reloadBarFill = this.reloadBar.querySelector('i');
    this.weaponName = $('weapon-name');
    this.weaponTag = $('weapon-tag');
    this.ammoType = $('ammo-type');
    this.ammoWheel = $('ammo-wheel');
    this.scopeOverlay = $('scope-overlay');
    this._wheelItems = null;

    this._lastHealth = -1;
  }

  setVisible(visible) {
    this.root.classList.toggle('hidden', !visible);
  }

  setHealth(hp, max = PLAYER.maxHealth) {
    if (hp === this._lastHealth) return;
    this._lastHealth = hp;
    this.hpValue.textContent = Math.max(0, Math.round(hp));
    const ratio = Math.max(0, Math.min(1, hp / max));
    this.hpFill.style.width = (ratio * 100) + '%';
    this.hpFill.classList.toggle('low', ratio <= 0.3);
  }

  setArmor(armor, max = PLAYER.maxArmor) {
    this.armorValue.textContent = Math.max(0, Math.round(armor));
    this.armorFill.style.width = (Math.max(0, Math.min(1, armor / max)) * 100) + '%';
  }

  setAmmo(mag, reserve) {
    this.magValue.textContent = mag;
    this.reserveValue.textContent = reserve;
    this.magValue.classList.toggle('low', mag <= 5 && mag > 0);
    this.magValue.classList.toggle('empty', mag <= 0);
  }

  setWeaponName(name, tag) {
    if (this.weaponName) {
      // 保留武器名文本，替换 tag
      this.weaponName.childNodes[0].textContent = name + ' ';
    }
    if (this.weaponTag && tag) this.weaponTag.textContent = tag;
  }

  /** 当前弹种（Ctrl+R 轮盘切换后刷新） */
  setAmmoType(name, color = 0xffd27a) {
    if (!this.ammoType) return;
    this.ammoType.textContent = name;
    this.ammoType.style.color = '#' + color.toString(16).padStart(6, '0');
  }

  /** 开镜：收束 / 隐藏准星 */
  setAiming(on) {
    if (this.crosshair) this.crosshair.classList.toggle('aiming', !!on);
  }

  /** 重狙开镜：显示全屏瞄镜遮罩 */
  setScope(on) {
    if (this.scopeOverlay) this.scopeOverlay.classList.toggle('hidden', !on);
  }

  /** 弹种轮盘 */
  showAmmoWheel(types, index) {
    if (!this.ammoWheel) return;
    if (!this._wheelItems) {
      this.ammoWheel.innerHTML = '';
      this._wheelItems = types.map((t) => {
        const item = document.createElement('div');
        item.className = 'ammo-wheel-item';
        item.style.color = '#' + t.color.toString(16).padStart(6, '0');
        const name = document.createElement('b');
        name.textContent = t.name;
        const desc = document.createElement('span');
        desc.textContent = t.desc;
        item.appendChild(name);
        item.appendChild(desc);
        this.ammoWheel.appendChild(item);
        return item;
      });
    }
    this._wheelItems.forEach((el, i) => el.classList.toggle('active', i === index));
    this.ammoWheel.classList.remove('hidden');
  }

  hideAmmoWheel() {
    if (this.ammoWheel) this.ammoWheel.classList.add('hidden');
  }

  setKills(kills) {
    this.killValue.textContent = kills;
  }

  /** 第三轮：爆头击杀计数 */
  addHeadshotKill() {
    this.headshotKills += 1;
    if (this.headshotValue) this.headshotValue.textContent = this.headshotKills;
  }

  /** 第三轮：悬浮击杀文字（爆头单独样式） */
  showKillPopup(text) {
    const el = this.killPopup;
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('headshot', text === '爆头');
    el.classList.remove('show');
    // 强制重排以重新触发动画
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._killPopupTimer);
    this._killPopupTimer = setTimeout(() => el.classList.remove('show'), 1100);
  }

  setEnemies(n) {
    this.enemyValue.textContent = n;
    if (this.waveRemain) this.waveRemain.textContent = n;
  }

  /** 波次指示：当前第几波 / 共几波 / 本波剩余（total 为 null 表示无限模式） */
  setWave(current, total, remaining) {
    if (this.waveNow) this.waveNow.textContent = current;
    if (this.waveTotal) this.waveTotal.textContent = total == null ? '∞' : total;
    if (this.waveRemain) this.waveRemain.textContent = remaining;
    if (this.waveHud) {
      this.waveHud.classList.toggle('final', total != null && current >= total);
    }
  }

  /** 局内任务目标：显示当前进度最高的未领取任务 */
  setMissionObjective(name, progress, target) {
    if (!this.missionObj) return;
    if (this.missionObjName) this.missionObjName.textContent = name;
    if (this.missionObjNow) this.missionObjNow.textContent = Math.min(progress, target);
    if (this.missionObjTotal) this.missionObjTotal.textContent = target;
    this.missionObj.classList.remove('hidden');
  }

  /** 隐藏任务目标（全部已领取 / 已达成时调用） */
  hideMissionObjective() {
    if (this.missionObj) this.missionObj.classList.add('hidden');
  }

  /** 准星散布（弧度 -> 像素） */
  setCrosshairSpread(spread) {
    const px = Math.min(26, 7 + spread * 620);
    this.crosshair.style.setProperty('--spread', px.toFixed(1) + 'px');
  }

  /** 命中标记（第三轮：爆头使用金色标记） */
  showHitmarker(kill = false, headshot = false) {
    this.hitmarker.classList.remove('show');
    this.hitmarker.classList.toggle('kill', !!kill);
    this.hitmarker.classList.toggle('head', !!headshot);
    // 强制重排以重新触发动画
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add('show');
  }

  /** 受击暗角（第三轮：伤害越高红边越浓） */
  showDamage(amount = 0) {
    const k = Math.min(1, 0.35 + amount / 40);
    this.vignette.style.opacity = k.toFixed(2);
    this.vignette.classList.add('show');
    clearTimeout(this._vignetteTimer);
    this._vignetteTimer = setTimeout(() => {
      this.vignette.classList.remove('show');
      this.vignette.style.opacity = '';
    }, 420);
  }

  /** 伤害数字（屏幕中心下方） */
  setDamageAmount(amount) {
    if (!amount || amount <= 0) return;
    const el = document.createElement('div');
    el.className = 'damage-num';
    el.textContent = '-' + Math.round(amount);
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  /** 击杀播报 */
  pushKill(prefix, how) {
    const line = document.createElement('div');
    line.className = 'kill-line';
    line.innerHTML = `<b>${prefix}</b> · ${how}`;
    this.killfeed.appendChild(line);
    setTimeout(() => line.classList.add('fade'), 1800);
    setTimeout(() => line.remove(), 2300);
    // 最多显示 4 条
    while (this.killfeed.children.length > 4) this.killfeed.firstChild.remove();
  }

  /** 补给拾取提示（屏幕右侧浮出） */
  showSupplyToast(label, hint) {
    let el = document.getElementById('supply-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'supply-toast';
      this.root.appendChild(el);
    }
    el.innerHTML = `<b>${label}</b><span>${hint || ''}</span>`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._supplyToastTimer);
    this._supplyToastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  /** 换弹提示 */
  showReloadTip(show, blink = false) {
    this.reloadTip.classList.toggle('show', !!show);
    this.reloadTip.classList.toggle('blink', !!blink);
  }

  showReloadBar(show) {
    this.reloadBar.classList.toggle('hidden', !show);
    if (!show) this.setReloadProgress(0);
  }

  setReloadProgress(t) {
    this.reloadBarFill.style.width = (Math.max(0, Math.min(1, t)) * 100) + '%';
  }

  /** 复活时整体刷新（total 为 null 时显示无限波） */
  reset(total = MATCH.waves.length) {
    this._lastHealth = -1;
    this.setHealth(PLAYER.maxHealth);
    this.setArmor(PLAYER.maxArmor);
    this.setAmmo(WEAPON.magazineSize, WEAPON.reserveAmmo);
    this.setWave(1, total, 0);
    this.showReloadBar(false);
    this.showReloadTip(false, false);
    // 第三轮：重置爆头击杀计数
    this.headshotKills = 0;
    if (this.headshotValue) this.headshotValue.textContent = '0';
  }
}
