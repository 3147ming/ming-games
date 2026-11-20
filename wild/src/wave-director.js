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
  WAVE_COUNT, WAVE_BOSS, WAVE_BOSS_D5, ENDLESS_WAVE_SEC, waveSec, waveWeights,
  waveSpawnInterval, waveEnemyCap, waveHpScale, waveDmgScale,
  waveEndMaterials, WAVE_STATS, statById, RARITIES, rarityOf,
  rollRarity, WAVE_WEAPONS, weaponGoodById, weaponBaseOf, WAVE_ITEMS, itemGoodById,
  charById, dangerOf, SHOP_SLOTS, SHOP_SELL_RATE, SHOP_WEAPON_CHANCE,
  SHOP_GUARANTEED_WEAPONS, shopPrice, rerollPrice, eliteWavesOf, CARRY_KEEP,
  WAVE_GEM_MAGNET,
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
    this.carry = 0;               // 未拾取材料结转（只带 CARRY_KEEP 比例）
    this.matFrac = 0;             // 材料折算的小数累加器（见 onPickup 注释）
    this.luck = this.char.luck;
    this.harvest = this.char.harvest;
    this.freeRerolls = 0;

    this.slots = [];              // [{ id, rarity }]，长度 ≤ char.maxWeapons
    this.statTaken = {};          // 属性升级次数（用于 max 过滤）
    // ★ Brotato 口径：战斗中经验满**不弹窗**，只把升级次数排进队列；
    //   波末倒计时结束后逐张弹出选择，全部选完才开商店。
    this.pendingLevels = 0;
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
    // ★ 波次模式基础拾取半径压到 90：旧连续局的 280 在固定竞技场里 ≈ 全场自动吸，
    //   走位捡材料这条核心玩法会直接消失。局外 magnet 加算在此被有意覆盖，
    //   后续成长走 WAVE_STATS.magnet / i_magnet / 磁暴事件。
    core.magnet = WAVE_GEM_MAGNET;
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
  /** 按波数标定难度 —— **Brotato 指数曲线**：wave1 ×1、wave20 约 ×300（HP）/ ×32（伤害）。
   *  ★ 旧实现是线性 `1 + 0.09×(w-1)`（wave20 仅 ×2.7），而玩家武器与属性是指数成长，
   *    后期必然碾压 —— 这就是「难度与自身强度失衡」的根因。
   *  波数无上限（无尽继续爬），不按 WAVE_COUNT 夹住。 */
  hpScale() { return this.danger.hpMul * waveHpScale(this.wave); }
  contactScale() { return this.danger.dmgMul * waveDmgScale(this.wave); }

  /** 波内步进：由 core.stepWorld 在 waveMode 下调用（dt 为游戏时间秒）。 */
  step(dt) {
    if (this.phase !== 'battle') return;
    this.waveElapsed += dt;
    this.timeLeft -= dt;

    // Boss 波：Brotato **只有第 20 波**；Danger 5 双 Boss（各 -25% 血）。
    if (!this.bossSpawnedThisWave && this.waveElapsed >= 3) {
      const ids = this.wave === 20 && this.danger.level >= 5
        ? WAVE_BOSS_D5
        : (WAVE_BOSS[this.wave] ? [WAVE_BOSS[this.wave]] : null);
      if (ids) {
        this.bossSpawnedThisWave = true;
        for (const id of ids) this.core.spawnBoss(id);
        this.bossWaves.push(this.wave);
      }
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      // ★ Brotato 同屏 30-60 只，到上限就停刷、等玩家清场后再补。
      //   旧实现沿用旧模式的 MAX_ENEMIES=220 ⟹ 同屏密度是原版约 4 倍，
      //   配合「击杀掉材料」还会同时冲垮经济。
      const cap = waveEnemyCap(this.wave);
      const elite = eliteWavesOf(this.danger.level).includes(this.wave);
      // 精英/部落波：同一拍多刷一倍（引擎暂无独立精英单位，先用密度近似）。
      const batch = (1 + Math.floor((this.wave - 1) / 4)) * (elite ? 2 : 1);
      for (let i = 0; i < batch && this.core.enemies.length < cap; i++) {
        this.core.spawnEnemy();
      }
      this.spawnTimer = waveSpawnInterval(this.wave) / (elite ? 1.5 : 1);
    }
    if (this.timeLeft <= 0) this.endWave();
  }

  /** 波末：清场 + 结算材料 + 结转未拾取 + 进商店（或通关）。 */
  endWave() {
    if (this.phase !== 'battle') return;   // 升级阶段 phase 仍在 battle，防同一波重复结算
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

    // 未拾取材料留到下一波，拾取时 1:1 补发；但只带 **CARRY_KEEP（50%）** 过去。
    // ★ 量纲修正：carry 必须按**经验值**累计，不能按宝石个数 —— onPickup 收到的是 xp，
    //   而补给/精英宝石的 xp 是普通宝石的数倍（SUPPLY_GEM_XP）。按个数记会低估，
    //   二者不同量纲，补发时对不上账。
    let leftover = 0;
    for (const g of (c.gems || [])) leftover += (g.xp || 1);
    this.carry += leftover * CARRY_KEEP;
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
    // ★ Brotato 口径：倒计时结束后**先选升级，再进商店**。
    //   战斗中攒下的 pendingLevels 在这里逐张弹出，全部选完才 openShop。
    this.afterWaveUpgrades();
  }

  /** 波末关卡：先把战斗中攒下的升级逐张弹出来，选完再开商店。 */
  afterWaveUpgrades() {
    if (this.pendingLevels > 0) this.openLevelChoices();
    else this.openShop();
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
    // Brotato 保底：前两个商店各 2 把武器，接下来三个各 1 把。
    let forced = Math.max(0, (SHOP_GUARANTEED_WEAPONS[this.wave - 1] || 0)
      - goods.filter((g) => g.kind === 'weapon').length);
    while (goods.length < SHOP_SLOTS && pool.length) {
      // 35% 出武器 / 65% 出道具；保底名额没用完时优先武器。
      const wantWeapon = forced > 0 || this.rng.next() < SHOP_WEAPON_CHANCE;
      let idx = pool.findIndex((p) => p.kind === (wantWeapon ? 'weapon' : 'item'));
      if (idx < 0) idx = this.rng.int(pool.length);
      const p = pool.splice(idx, 1)[0];
      const key = p.kind === 'weapon' ? rollRarity(this.rng, this.wave, this.luck) : 'common';
      const ri = rarityIndex(key);
      const r = rarityOf(ri);
      // Brotato：Tier 只抬基础价（Tier1 便宜 / Tier4 贵），通胀统一由 shopPrice 处理。
      const base = Math.round(p.good.cost * (1 + ri * 0.45));
      const cost = shopPrice(base, this.wave);
      if (p.kind === 'weapon' && forced > 0) forced -= 1;
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
    // Brotato：基数 = 当前波，增量 = 次数 × floor(max(0.5×波, 1))。
    return rerollPrice(this.wave, this.rerollCount, this.char.rerollMul);
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
        // ★ 进阶型号（smg/sniper/…）没有独立底层机制，统一映射回 base 开火；
        //   差异化由 _applyWeaponRarity 的 pow/cd/pierce 折算进伤害乘区实现。
        const b = weaponBaseOf(g.id);
        c.weapons[b] = true;
        if (typeof c.initWeapon === 'function') c.initWeapon(b);
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
    // 卖出价 = 当前商店口径的价格 × 60%（与买入同一套通胀公式，避免"低波买高波卖"套利）。
    const baseCost = (base ? base.cost : 14) * (1 + (s.rarity || 0) * 0.45);
    const value = Math.max(1, Math.round(shopPrice(Math.round(baseCost), this.wave) * SHOP_SELL_RATE));
    this.materials += value;
    this.slots.splice(i, 1);
    const baseId = weaponBaseOf(s.id);
    if (!this.slots.some((x) => weaponBaseOf(x.id) === baseId)) this.core.weapons[baseId] = false;
    this.sells += 1;
    this._applyWeaponRarity();
    this.core._refreshClassBuffs();
    return value;
  }

  /** 槽位稀有度折算成全局输出加成（走 gUpMul 独立乘区，不与 dmgBase 的属性加成互相覆盖）。
   *  ★ 简化模型：Brotato 是「每把武器各自的伤害」；这里统一进全局乘区，
   *    避免改动 applyHit 的伤害入口（旧模式护栏）。系数封顶 +60% 防失衡。 */
  _applyWeaponRarity() {
    // ★ Brotato 的武器 Tier 是「直接乘伤害」：Tier1 ×1 / Tier2 ×1.5 / Tier3 ×2.2 / Tier4 ×3.2。
    //   旧实现是 `1 + min(0.6, 稀有度和×0.05)` —— 六把传说也只有 +60%，
    //   而敌人 HP 是指数增长 ⟹ 玩家强度永远追不上，后期必然打不动。
    //   这里按「每把武器的稀有度加成累加」重建：6 把普通 ×2.8、6 把传说 ×8.2。
    const sum = this.slots.reduce((a, s) => a + s.rarity, 0);
    // ★ 12 把武器的差异化：进阶型号没有独立开火机制，把 pow/cd/pierce 折算进同一乘区。
    //   等效 DPS ∝ 单发伤害 / 攻击间隔，所以 `pow / cd` 才是对口径的折算
    //   （早期写成 pow + (1/cd-1)*0.5，把连弩的攻速优势打了半折，净收益反而 <1）。
    //   pierce 是额外命中机会，保守按每次 +6% 计入。按**平均**计入避免同 base 多把叠加爆炸，
    //   也不碰 arena.js 的开火护栏。
    let model = 0;
    for (const s of this.slots) {
      const g = weaponGoodById(s.id);
      if (!g) continue;
      model += (g.pow || 1) / (g.cd || 1) + (g.pierce || 0) * 0.06;
    }
    const modelMul = this.slots.length ? model / this.slots.length : 1;
    this.core.gUpMul = (1 + sum * 0.30) * modelMul;
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
    // 材料与经验同源但不同量纲：经验按原值走 gainXp（升级曲线不变）。
    // ★ 阶段12 经济校准：0.4 → 分段 0.26 / 0.18 / 0.12。
    //   实测 0.4 时一局 3.0~3.4 万材料、购买 46~53 次，商店四格几乎每波清空，
    //   没有"这波买武器还是攒钱"的取舍。但一刀切压到 0.26 又会把**前 5 波**卡死
    //   （开局 20s 只掉几百 xp，买不起第一把武器就进入死亡螺旋）。
    //   所以按波数分段：前期宽松保起步，中期收紧，15 波后最紧 —— 后期材料多、
    //   价格也高，正好把"要不要刷新"变成真正的选择。
    // ★★ 阶段12 经济校准的真正关键：**不能逐次 max(1, round())**。
    //   一颗普通宝石的 xp 是 1，折算 0.06 后 round → 0，再被 max(1) 抬到 1 ——
    //   等于每颗宝石固定给 1 材料。实测一局拾取 33,579 次 ⟹ 下限就是 33,579 材料，
    //   折算率怎么调都没用（余额永远 3 万+，商店只花掉一千多）。
    //   改成浮点累加器：每次只加 `amount * rate` 的小数，攒够 1 才入账，零头保留。
    // ★ Brotato 口径：材料 **1:1** 掉落（击杀数≈材料数），不再按比例折算。
    //   之前每波收入靠"波末补贴 + 0.06 折算"硬凑，与击杀脱钩，玩家打得再好也就那么多。
    const rate = 1;
    this.matFrac += amount * rate;
    // +1e-9：0.12 这类十进制小数在二进制里累加会出现 0.2+1.8=1.9999999999999998，
    // 直接 floor 会无缘无故少给 1 材料（测试②就抓到过）。
    const whole = Math.floor(this.matFrac + 1e-9);
    if (whole > 0) {
      this.matFrac -= whole;
      this.materials += whole;
      this.totalMaterials += whole;
    }
  }

  /** 战斗中经验满级：**只排队、不弹窗**（Brotato 口径：升级选择放在波末倒计时后）。
   *  ★ 等级 / 经验 / 门槛在这里一次性结算，波末的 chooseLevel 只负责"选哪张牌"。
   *    这样连升时几何门槛不会错位，战斗也不会被弹窗打断。
   *    等级自带的随级成长（gDmgMul 里的 perLv）即时生效 —— 属性牌才是延后的那部分。 */
  queueLevelUps() {
    const c = this.core;
    let queued = 0;
    while (c.xp >= c.xpToLevel) {
      c.xp -= c.xpToLevel;
      c.level += 1;
      c.xpToLevel = c.xpNeed();
      queued += 1;
    }
    if (queued > 0) {
      this.pendingLevels += queued;
      c._refreshClassBuffs();
    }
  }

  /** 打开 4 选 1：复用 core.pendingUpgrade 的暂停语义（渲染层已有弹窗）。 */
  openLevelChoices(opts = {}) {
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
    // 精英波奖励走同一个弹窗，但来路不同：选完要继续打，绝不能误开波间商店。
    c.pendingUpgradeKind = opts.reason || 'wave';
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
    const reason = c.pendingUpgradeKind;
    c.pendingUpgrade = null;
    c.pendingUpgradeKind = null;
    c._refreshClassBuffs();
    // ★ 只有波末升级（reason='wave'）才推进待选队列并决定进不进商店。
    //   精英波奖励是**波内**即时奖励，选完继续打 —— 若在这里误开商店，
    //   一局会被中途打断、波次状态机直接错位。
    if (reason !== 'elite') {
      this.pendingLevels = Math.max(0, this.pendingLevels - 1);
      if (this.pendingLevels > 0) this.openLevelChoices();       // 连升：继续逐张选
      else if (this.phase !== 'done') this.openShop();           // 全选完 → 波间商店
    }
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
      pendingLevels: this.pendingLevels,
      wavesCleared: this.wavesCleared, danger: this.danger.level,
      char: this.char.id, endless: this.endless,
    };
  }
}
