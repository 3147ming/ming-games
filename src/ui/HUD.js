/**
 * HUD 控制器：负责所有 DOM 数值与反馈更新
 */
import { PLAYER } from '../config/weapon.js';

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
    this.magValue = $('mag-value');
    this.reserveValue = $('reserve-value');
    this.reloadTip = $('reload-tip');
    this.crosshair = $('crosshair');
    this.hitmarker = $('hitmarker');
    this.vignette = $('damage-vignette');
    this.killfeed = $('killfeed');
    this.reloadBar = $('reload-bar');
    this.reloadBarFill = this.reloadBar.querySelector('i');

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
    // 第三轮：空弹时数字变红闪烁
    this.magValue.classList.toggle('empty', mag <= 0);
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

  /** 复活时整体刷新 */
  reset() {
    this.setHealth(PLAYER.maxHealth);
    this.setArmor(PLAYER.maxArmor);
    this.setAmmo(30, 120);
    this.showReloadBar(false);
    this.showReloadTip(false, false);
    // 第三轮：重置爆头击杀计数
    this.headshotKills = 0;
    if (this.headshotValue) this.headshotValue.textContent = '0';
  }
}
