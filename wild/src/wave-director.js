// 波次模式状态机（Brotato 化）—— 纯逻辑，零 DOM / 零 localStorage。
//
// ★ 与旧模式的边界：ArenaCore 只在 waveMode 下把「按秒调度」交给本类；
//   战斗 / 武器 / 敌人 / 伤害 / 掉落 / 存档全部复用 core 原有实现。
//   director 自己持有一条独立 rng 流（'wave:' + 种子），不碰主 rng ⟹
//   旧模式的「同种子同结果」与波次模式各自的确定性互不干扰。
//
// 状态机：battle（波内）→ endWave（清场/结算）→ shop（波间）→ nextWave → battle …
//         第 20 波结束且非无尽 → done（core.done / core.survived）；hp 归零随时结束。

import { Rng } from './rng.js';
import {
  WAVE_COUNT, WAVE_BOSS, WAVE_SECS, ENDLESS_WAVE_SEC, waveSec, waveWeights,
  waveSpawnInterval, waveEndMaterials, WAVE_STATS, statById, RARITIES, rarityOf,
  rollRarity, WAVE_WEAPONS, weaponGoodById, WAVE_ITEMS, itemGoodById,
  charById, dangerOf, SHOP_SLOTS, SHOP_REROLL_BASE, SHOP_REROLL_GROWTH,
  SHOP_SELL_RATE,
} from './wave-config.js';

const rarityIndex = (key) => Math.max(0, RARITIES.findIndex((r) => r.key === key));

export class WaveDirector {
  constructor(core, opts = {}) {
    this.core = core;
    this.rng = new Rng('wave:' + (core.rng && core.rng.seed ? core.rng.seed : 'seed')
      + ':' + (opts.seed || ''));
    this.char = charById(opts.char || 'wanderer');
    this.danger = dangerOf(opts.danger || 0);
    this.endless = !!opts.endless;

    this.phase = 'battle';        // battle | shop | done
    this.wave = 1;
    this.timeLeft = waveSec(1);
    this.waveElapsed = 0;
    this.spawnTimer = 0.4;
    this.bossSpawnedThisWave = false;

    this.materials = this.char.startMaterials;
    this.totalMaterials = this.char.startMaterials;
    this.carry = 0;               // 未拾取材料结转（下一波双倍）
    this.luck = this.char.luck;
    this.harvest = this.char.harvest;
    this.freeRerolls = 0;

    this.slots = [];              // [{ id, rarity }]，长度 ≤ char.maxWeapons
    this.statTaken = {};          // 属性升级次数（用于 max 过滤）
    this.shop = [];               // 当前货架
    this.rerollCount = 0;
    this.purchases = 0;
    this.rerolls = 0;
    this.sells = 0;

    this.wavesCleared = 0;
    this.bossWaves = [];
    this.history = [];            // 每波结算摘要
    this.waveDamage = {};         // 本波各武器击杀贡献（近似输出占比，见 endWave 注释）
    this.killSrcAtWaveStart = Object.assign({}, core.killSrc || {});

    // ── 角色落地 ──
    // 倍率乘在**已有值**上（保留 core 构造期 applyGrowth / applyLoadout 的加算，互不擦除）。
    core.maxHp = Math.round(core.maxHp * this.char.hpMul);
    core.hp = core.maxHp;
    core.dmgBase *= this.char.dmgMul;
    core.moveBase *= this.char.moveMul;
    core.attackInterval = Math.max(0.2, core.attackInterval / this.char.atkMul);
    for (const k of Object.keys(core.weapons)) core.weapons[k] = false;
    core.weapons[this.char.start] = true;
    if (typeof core.initWeapon === 'function') core.initWeapon(this.char.start);
    this.slots.push({ id: this.char.start, rarity: 0 });
    this._applyWeaponRarity();
    core._refreshClassBuffs();
  }

  /** 供 core.wave() 用：波次模式下的刷怪档（怪种权重按波解锁）。 */
  spawnWave() {
    return { spawn: waveSpawnInterval(this.wave, this.danger), w: waveWeights(this.wave) };
  }
  /** 按波数标定难度，避免整局 1100+ 秒把旧的时间幂曲线拉爆。 */
  // 波数无上限（无尽模式继续爬），不按 WAVE_COUNT 夹住。
  hpScale() { return this.danger.hpMul * (1 + (this.wave - 1) * 0.09); }
  contactScale() { return this.danger.dmgMul * (1 + (this.wave - 1) * 0.05); }

  /** 波内步进：由 core.stepWorld 在 waveMode 下调用（dt 为游戏时间秒）。 */
  step(dt) {
    if (this.phase !== 'battle') return;
    this.waveElapsed += dt;
    this.timeLeft -= dt;

    const bossId = WAVE_BOSS[this.wave];
    if (bossId && !this.bossSpawnedThisWave && this.waveElapsed >= 2) {
      this.bossSpawnedThisWave = true;
      this.core.spawnBoss(bossId);
      this.bossWaves.push(this.wave);
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      // 每拍批量刷：波数越高一次涌进来的越多（Brotato 的满屏感）。
      // 上限由 ArenaCore.spawnEnemy() 门口的 MAX_ENEMIES 守卫兜住，这里不额外夹。
      const batch = 1 + Math.floor((this.wave - 1) / 3);
      for (let i = 0; i < batch; i++) this.core.spawnEnemy();
      this.spawnTimer = waveSpawnInterval(this.wave, this.danger);
    }
    if (this.timeLeft <= 0) this.endWave();
  }

  /** 波末：清场 + 结算材料 + 结转未拾取 + 进商店（或通关）。 */
  endWave() {
    const c = this.core;
    // 输出统计：core.killSrc 本来就按伤害来源归因。取本波增量做「谁在摸鱼」的近似，
    // 比在各武器开火处插桩侵入性小得多；UI 文案标为「击杀贡献」而非精确伤害。
    const cur = Object.assign({}, c.killSrc || {});
    const dmg = {};
    for (const k of Object.keys(cur)) {
      const v = (cur[k] || 0) - (this.killSrcAtWaveStart[k] || 0);
      if (v > 0) dmg[k] = v;
    }
    this.waveDamage = dmg;
    this.killSrcAtWaveStart = cur;

    // 未拾取材料留到下一波，拾取时按 CARRY_DOUBLE 双倍发放。
    this.carry += (c.gems || []).length;
    if (c.gems) c.gems.length = 0;
    c.enemies.length = 0;
    if (c.bullets) c.bullets.length = 0;
    c.bossRef = null;             // 撑过一波即清场，Boss 不跨波
    if (c.projectiles) c.projectiles.length = 0;

    const gain = waveEndMaterials(this.wave, this);
    this.materials += gain;
    this.totalMaterials += gain;
    this.history.push({
      wave: this.wave, gain, materials: this.materials,
      kills: c.kills, level: c.level, damage: Object.assign({}, dmg),
    });
    this.wavesCleared = this.wave;

    if (this.wave >= WAVE_COUNT && !this.endless) {
      this.phase = 'done';
      c.done = true;
      c.survived = true;
      return;
    }
    this.openShop();
  }

  /* ─────────────── 波间商店 ─────────────── */
  openShop() {
    this.phase = 'shop';
    this.rerollCount = 0;
    this.shop = this.rollGoods();
  }

  /** 抽货架：保留锁定项；角色 shopFilter 过滤武器；价格随波数与稀有度上涨。 */
  rollGoods() {
    const goods = this.shop.filter((g) => g.locked && !g.sold).map((g) => g);
    const pool = [
      ...WAVE_WEAPONS.filter((w) => this.char.shopFilter(w)).map((w) => ({ kind: 'weapon', good: w })),
      ...WAVE_ITEMS.map((i) => ({ kind: 'item', good: i })),
    ];
    while (goods.length < SHOP_SLOTS && pool.length) {
      const p = pool.splice(this.rng.int(pool.length), 1)[0];
      const key = p.kind === 'weapon' ? rollRarity(this.rng, this.wave, this.luck) : 'common';
      const r = rarityOf(rarityIndex(key));
      const cost = Math.max(1, Math.round(p.good.cost * r.cost * (1 + this.wave * 0.10)));
      goods.push({
        kind: p.kind, id: p.good.id, label: p.good.label, desc: p.good.desc,
        tag: p.good.tag || '', rarity: key, rarityLabel: r.label, rarityColor: r.color,
        cost, locked: false, sold: false,
      });
    }
    return goods;
  }

  rerollCost() {
    if (this.freeRerolls > 0) return 0;
    return Math.max(1, Math.round(SHOP_REROLL_BASE
      * Math.pow(SHOP_REROLL_GROWTH, this.rerollCount)
      * this.char.rerollMul * (1 + this.wave * 0.04)));
  }
  reroll() {
    if (this.phase !== 'shop') return false;
    const cost = this.rerollCost();
    if (this.materials < cost) return false;
    if (this.freeRerolls > 0) this.freeRerolls -= 1;
    else this.materials -= cost;
    this.rerollCount += 1;
    this.rerolls += 1;
    this.shop = this.rollGoods();
    return true;
  }
  toggleLock(i) {
    const g = this.shop[i];
    if (!g || g.sold) return false;
    g.locked = !g.locked;
    return true;
  }

  buy(i) {
    if (this.phase !== 'shop') return false;
    const g = this.shop[i];
    if (!g || g.sold || this.materials < g.cost) return false;
    if (g.kind === 'weapon' && this.slots.length >= this.char.maxWeapons) return false;
    this.materials -= g.cost;
    g.sold = true;
    this.purchases += 1;
    const c = this.core;
    if (g.kind === 'weapon') {
      const ri = rarityIndex(g.rarity);
      // 同类同稀有度 → 合成升一阶（不占新槽）；4 阶封顶。
      const same = this.slots.find((s) => s.id === g.id && s.rarity === ri && ri < RARITIES.length - 1);
      if (same) same.rarity += 1;
      else {
        this.slots.push({ id: g.id, rarity: ri });
        c.weapons[g.id] = true;
        if (typeof c.initWeapon === 'function') c.initWeapon(g.id);
      }
      this._applyWeaponRarity();
    } else {
      const item = itemGoodById(g.id);
      if (item) item.apply(c, this);
    }
    c._refreshClassBuffs();
    return true;
  }

  /** 卖出武器槽：返还 60%，同类全卖光才把 core.weapons 关掉。 */
  sellSlot(i) {
    if (this.phase !== 'shop') return 0;
    const s = this.slots[i];
    if (!s) return 0;
    const base = weaponGoodById(s.id);
    const value = Math.max(1, Math.round((base ? base.cost : 14)
      * rarityOf(s.rarity).cost * SHOP_SELL_RATE));
    this.materials += value;
    this.slots.splice(i, 1);
    if (!this.slots.some((x) => x.id === s.id)) this.core.weapons[s.id] = false;
    this.sells += 1;
    this._applyWeaponRarity();
    this.core._refreshClassBuffs();
    return value;
  }

  /** 槽位稀有度折算成全局输出加成（走 gUpMul 独立乘区，不与 dmgBase 的属性加成互相覆盖）。
   *  ★ 简化模型：Brotato 是「每把武器各自的伤害」；这里统一进全局乘区，
   *    避免改动 applyHit 的伤害入口（旧模式护栏）。系数封顶 +60% 防失衡。 */
  _applyWeaponRarity() {
    const sum = this.slots.reduce((a, s) => a + s.rarity, 0);
    this.core.gUpMul = 1 + Math.min(0.6, sum * 0.05);
  }

  nextWave() {
    if (this.phase !== 'shop') return false;
    this.phase = 'battle';
    this.wave += 1;
    this.timeLeft = this.wave > WAVE_COUNT ? ENDLESS_WAVE_SEC : waveSec(this.wave);
    this.waveElapsed = 0;
    this.spawnTimer = 0.4;
    this.bossSpawnedThisWave = false;
    this.shop = [];
    return true;
  }

  /* ─────────────── 4 选 1 属性升级 ─────────────── */
  /** 由 core.gainXp 触发：材料入账 + 未拾取结转的双倍发放。 */
  onPickup(n) {
    let amount = n;
    if (this.carry > 0) {
      const bonus = Math.min(this.carry, amount);
      this.carry -= bonus;
      amount += bonus;
    }
    // 材料与经验同源但不同量纲：经验按原值走 gainXp（升级曲线不变），
    // 材料按 0.4 折算 —— 满屏局一局能拾取 2~3 万颗宝石，1:1 入账会让
    // 「买什么」失去决策意义（实测 5 万材料 / 商店只要几十）。
    const v = Math.max(1, Math.round(amount * 0.4));
    this.materials += v;
    this.totalMaterials += v;
  }

  /** 打开 4 选 1：复用 core.pendingUpgrade 的暂停语义（渲染层已有弹窗）。 */
  openLevelChoices() {
    const c = this.core;
    const pool = WAVE_STATS.filter((s) => (this.statTaken[s.id] || 0) < s.max).slice();
    const picks = [];
    while (picks.length < 4 && pool.length) {
      const s = pool.splice(this.rng.int(pool.length), 1)[0];
      const key = rollRarity(this.rng, this.wave, this.luck);
      const r = rarityOf(rarityIndex(key));
      picks.push({
        id: 'wv_' + s.id, statId: s.id, cat: '', label: s.name,
        desc: `${s.unit} · ${r.label}`, rarity: key, rarityLabel: r.label,
        rarityColor: r.color, mul: r.mul,
      });
    }
    // 封顶项全拿完时用「补给」兜底：4 张牌永远不空转。
    while (picks.length < 4) {
      picks.push({
        id: 'wv_supply', statId: null, cat: '', label: '补给', desc: '+12 材料',
        rarity: 'common', rarityLabel: '普通', rarityColor: rarityOf(0).color, mul: 1,
      });
    }
    c.pendingUpgrade = picks;
    c.pendingUpgradeKind = 'wave';
    return picks;
  }

  chooseLevel(i) {
    const c = this.core;
    const up = c.pendingUpgrade && c.pendingUpgrade[i];
    if (!up) return false;
    if (up.statId) {
      const s = statById(up.statId);
      if (s) {
        s.apply(c, up.mul, this);
        this.statTaken[up.statId] = (this.statTaken[up.statId] || 0) + 1;
      }
    } else {
      this.materials += 12;
      this.totalMaterials += 12;
    }
    c.pendingUpgrade = null;
    c.pendingUpgradeKind = null;
    c.level += 1;
    c.xp -= c.xpToLevel;
    c.xpToLevel = c.xpNeed();
    c._refreshClassBuffs();
    if (c.xp >= c.xpToLevel && !c.pendingUpgrade) c.openUpgrade(); // 连升
    return true;
  }

  /** 结算附加字段（旧字段由 core.result() 原样返回）。 */
  resultFields() {
    return {
      mode: 'waves',
      wave: this.wave,
      wavesCleared: this.wavesCleared,
      danger: this.danger.level,
      character: this.char.id,
      endless: this.endless,
      materials: this.materials,
      totalMaterials: this.totalMaterials,
      slots: this.slots.map((s) => Object.assign({}, s)),
      stats: Object.assign({}, this.statTaken),
      purchases: this.purchases,
      rerolls: this.rerolls,
      sells: this.sells,
      bossWaves: this.bossWaves.slice(),
      history: this.history.slice(),
    };
  }

  /** 无头模拟/测试用的紧凑状态。 */
  state() {
    return {
      phase: this.phase, wave: this.wave, timeLeft: Math.max(0, this.timeLeft),
      materials: this.materials, carry: this.carry, slots: this.slots.length,
      wavesCleared: this.wavesCleared, danger: this.danger.level,
      char: this.char.id, endless: this.endless,
    };
  }
}
