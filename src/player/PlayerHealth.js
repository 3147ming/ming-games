/**
 * 玩家生命 / 护甲（CF 风格护甲机制）
 * - 护甲优先承受伤害：有护甲时，固定比例（armorReduction）的伤害由护甲吸收，
 *   剩余部分扣除生命值；护甲归零后伤害全部作用于生命值。
 * - 护甲值按 1:1 消耗（吸收多少伤害扣多少护甲）。
 */
import { PLAYER } from '../config/weapon.js';

export class PlayerHealth {
  constructor() {
    this.maxHealth = PLAYER.maxHealth;
    this.maxArmor = PLAYER.maxArmor;
    this.health = this.maxHealth;
    this.armor = this.maxArmor;
    this.dead = false;
  }

  /** 承伤：护甲按固定比例吸收，剩余扣血。返回本次实际扣除的生命值 */
  damage(amount) {
    if (this.dead) return 0;
    const reduction = PLAYER.armorReduction;
    let remain = amount;

    if (this.armor > 0 && reduction > 0) {
      // 可被护甲吸收的伤害量
      const absorbedMax = amount * reduction;
      const absorb = Math.min(this.armor, absorbedMax);
      this.armor -= absorb;
      remain -= absorb;
    }

    this.health -= remain;
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
    }
    return remain;
  }

  /** 复活 / 重开 */
  reset() {
    this.health = this.maxHealth;
    this.armor = this.maxArmor;
    this.dead = false;
  }

  get healthRatio() {
    return this.health / this.maxHealth;
  }

  get armorRatio() {
    return this.armor / this.maxArmor;
  }
}
