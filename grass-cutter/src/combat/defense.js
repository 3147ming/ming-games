/**
 * 防御 / 卸势（2026-09-25 键位对齐参考布局时新增，主理人裁决）
 * ---------------------------------------------------------------------------
 * 纯逻辑层：不 import three / DOM，`node --test` 可测。数值唯一来源是 config.DEFENSE。
 *
 * · 防御（F 按住）
 *     受伤 ×BLOCK.DAMAGE_TAKEN；移速由 main 按 BLOCK.MOVE_SCALE 压（运动不在这一层管）。
 *     按住期间**吃掉攻击键的按下缓冲** —— 出招必须先松防御，这条做在输入层而不是
 *     战斗层，是因为 playerCombat 读的是同一份 input：在这里清掉，combat 自然看不到，
 *     一行 combat 代码都不用改。
 * · 卸势（鼠标右键点按）
 *     按下后 WINDOW 秒内有敌方命中结算打过来（enemy-hit / boss-hit 都会走 resolveHit）
 *     → 伤害归零、攻击者硬直、回无双/斗气、玩家拿无敌余量。
 *     空按（窗口内没有任何命中打过来）进 COOLDOWN，防止"连点右键赌运气"。
 *
 * 时序口径：卸势判定看的是"命中结算发生的那一刻 parryTimer 是否 > 0"。
 * 敌人出手有前摇（windup），玩家看到抬手 → 按右键 → 结算落在窗口内 = 成功。
 * 这是"反应型弹反"的标准实现：窗口从按下时刻起算，不需要预测未来。
 */
import { DEFENSE } from '../core/config.js';

export class DefenseSystem {
  constructor(cfg = DEFENSE) {
    this.cfg = cfg;
    this.blocking = false; // 本帧是否按住防御
    this.parryTimer = 0; // 卸势判定窗口剩余（秒）
    this.parryCd = 0; // 卸势冷却剩余（秒）
    this.parryFlash = 0; // 卸势成功后的高亮余量（秒，给 FX/HUD 用）
    this.blocks = 0; // 累计防御住的攻击次数
    this.parries = 0; // 累计卸势成功次数
  }

  /**
   * 每帧调用，必须在 combat.update **之前**（要先吃掉攻击缓冲，combat 才看不到）。
   * @param input InputState（读 block/parry，清 lightAttack/heavyAttack 缓冲）
   */
  update(dt, input) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.05, dt)) : 0;
    this.parryTimer = Math.max(0, this.parryTimer - step);
    this.parryCd = Math.max(0, this.parryCd - step);
    this.parryFlash = Math.max(0, this.parryFlash - step);

    this.blocking = input.isActionDown('block');
    if (this.blocking) {
      // 按住防御 = 不出招：清掉攻击键缓冲（含"先按攻击再秒按防御"的残留）
      input.consumeActionPress('lightAttack');
      input.consumeActionPress('heavyAttack');
    }

    // 卸势：冷却结束后的一次点按开一个判定窗口（按住防御中也可以用，卸势是防御的进阶）
    if (this.parryCd <= 0 && input.consumeActionPress('parry')) {
      this.parryTimer = this.cfg.PARRY.WINDOW;
      this.parryCd = this.cfg.PARRY.COOLDOWN;
    }
    return this;
  }

  /**
   * 一记敌方命中结算打过来时调用（main 的 enemy-hit / boss-hit 分支）。
   * @returns {{type:'parry'|'block'|'hit', damageScale:number, stun:number,
   *            gainMusou:number, gainKi:number, invincible:number}}
   *   parry：伤害归零 + 攻击者硬直 stun 秒 + 回资源 + 玩家无敌余量
   *   block：伤害 ×BLOCK.DAMAGE_TAKEN
   *   hit  ：全额伤害
   */
  resolveHit() {
    const P = this.cfg.PARRY;
    if (this.parryTimer > 0) {
      this.parryTimer = 0; // 一次窗口只卸一记（面对围殴不能一键全免）
      this.parryFlash = 0.35;
      this.parries++;
      return {
        type: 'parry',
        damageScale: 0,
        stun: P.STUN,
        gainMusou: P.GAIN_MUSOU,
        gainKi: P.GAIN_KI,
        invincible: P.INVINCIBLE,
      };
    }
    if (this.blocking) {
      this.blocks++;
      return { type: 'block', damageScale: this.cfg.BLOCK.DAMAGE_TAKEN, stun: 0, gainMusou: 0, gainKi: 0, invincible: 0 };
    }
    return { type: 'hit', damageScale: 1, stun: 0, gainMusou: 0, gainKi: 0, invincible: 0 };
  }

  snapshot() {
    return {
      blocking: this.blocking,
      parryActive: this.parryTimer > 0,
      parryCd: this.parryCd,
      parryFlash: this.parryFlash,
      blocks: this.blocks,
      parries: this.parries,
    };
  }
}
