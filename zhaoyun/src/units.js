/* =============================================================================
 * 赵云与阿斗 · 规则表 (units.js)
 * 兵种 / 武将 / 道具 / 征兵概率池 / 军衔 / 关卡 —— 全部数值集中在这里
 * 纯经典脚本（非 ES Module），可 file:// 直接双击运行
 * ========================================================================== */
window.ZY = window.ZY || {};
(function (ZY) {
  'use strict';

  /* ---------- 全局常量 ---------- */
  const GROW = { hp: 1.55, atk: 1.85, aspd: 1.05 }; // 每升 1 级的成长系数
  const MAX_LEVEL = 5;            // 等级上限
  const HERO_MAX_LEVEL = 5;       // 武将等级上限
  const RECRUIT_BASE_COST = 12;   // 征兵初始成本（每次成功后 +1，上限 60）
  const RECRUIT_MAX_COST = 60;    // 征兵成本上限
  const RECRUIT_STEP = 1;         // 每次成功征兵成本递增
  const BATCH = 3;                // 一次征兵出 3 张
  const HAND_MAX = 12;            // 待部署栏格数
  const START_BUN = 24;           // 开局馒头
  const BASE_INCOME = 2;          // 自然收入 / 秒
  const ADOU_HP = 3;              // 阿斗血量
  const ADOU_BONUS = 10;          // 阿斗掉 1 血补偿馒头
  const WARCRY_MULT = 1.5;        // 神兵符攻击倍率
  const WARCRY_TIME = 10;         // 神兵符持续秒数
  const HERO_KILLS_PER_LEVEL = 8; // 武将每击杀多少个敌人升 1 级
  const LEVEL_CLEAR_BONUS = 25;   // 关卡模式：过关战利品（馒头）
  const FORK_CHANCE = 0.3;        // 岔口转向概率
  const NORMAL_BOUNTY = 1;        // 击杀普通敌人赏金
  const ELITE_BOUNTY = 8;         // 击杀精英赏金
  const BOSS_HP_MUL = 10;         // Boss 血量倍率（相对同波敌）
  const BOSS_ATK_MUL = 3;         // Boss 攻击倍率
  const BOSS_SKILL_CD = 6;        // Boss 震击技能 CD（秒）
  const BOSS_SLOW = 1;            // Boss 震击减速（秒，即 stun）
  const BOSS_BOUNTY = 30;         // 击杀 Boss 赏金

  /* ---------- 兵种表 ----------
   * move   = 每前进 1 格所需秒数（0 = 不移动）
   * range  = 射程（格，同列直线）
   * pierce = 直线贯穿（打到射程内同列所有敌人）
   * splash = 溅射系数（对目标周围 1 格造成 X 倍伤害）
   * role   = 布阵倾向：front 前排 / mid 二排 / back 后排 / flank 侧翼
   */
  const UNITS = {
    dao:   { key: 'dao',   char: '刀', name: '刀兵', hp: 40, atk: 4,   aspd: 1.0, range: 1, move: 2.60, role: 'front' },
    qiang: { key: 'qiang', char: '枪', name: '枪兵', hp: 32, atk: 3,   aspd: 0.8, range: 2, move: 2.30, role: 'mid', pierce: true },
    gong:  { key: 'gong',  char: '弓', name: '弓兵', hp: 20, atk: 2.5, aspd: 0.7, range: 4, move: 2.40, role: 'back' },
    qi:    { key: 'qi',    char: '骑', name: '骑兵', hp: 36, atk: 3,   aspd: 0.9, range: 1, move: 1.75, role: 'flank', splash: 0.5 },
    zei:   { key: 'zei',   char: '贼', name: '贼兵', hp: 24, atk: 2,   aspd: 1.2, range: 1, move: 1.85, role: 'front' },
    nong:  { key: 'nong',  char: '农', name: '农民', hp: 18, atk: 0,   aspd: 0,   range: 0, move: 0,    role: 'back', produce: 0.5 },
  };

  // 汉字 → 兵种 key
  const CHAR2TYPE = {};
  Object.keys(UNITS).forEach(function (k) { CHAR2TYPE[UNITS[k].char] = k; });

  // 兵种字（毛笔同色替换的黑字池）
  const SOLDIER_CHARS = ['刀', '枪', '弓', '骑'];

  /* ---------- 武将表 ----------
   * 数值 = 对应兵种 3 级 ×1.2，之后按武将等级继续成长
   * skill.cd 秒，自动释放
   */
  const HEROES = [
    {
      id: 'zhaoyun', name: '赵云', chars: ['赵', '云'], base: 'qiang',
      range: 3, pierce: true, tag: '枪兵系 · 贯穿',
      skill: { cd: 8, type: 'sweep', name: '横扫剑气', desc: '前方直线群伤' },
    },
    {
      id: 'zhangfei', name: '张飞', chars: ['张', '飞'], base: 'dao',
      range: 1, hpMul: 1.25, dmgReduce: 0.25, tag: '刀兵系 · 高血高防',
      skill: { cd: 10, type: 'roar', name: '怒吼', desc: '震晕前方 1 格敌人 1 秒' },
    },
    {
      id: 'huangzhong', name: '黄忠', chars: ['黄', '忠'], base: 'gong',
      range: 5, crit: 0.4, critMul: 2.0, tag: '弓兵系 · 远程暴击',
      skill: { cd: 9, type: 'snipe', name: '蓄力狙击', desc: '对最远敌人单体大伤' },
    },
    {
      id: 'guanyu', name: '关羽', chars: ['关', '羽'], base: 'qi',
      range: 1, splash: 0.6, tag: '骑兵系 · 群伤',
      skill: { cd: 10, type: 'cleave', name: '青龙斩', desc: '周围溅射大伤害' },
    },
    {
      id: 'liubei', name: '刘备', chars: ['刘', '备'], base: 'dao',
      range: 0, noAttack: true, noMove: true, tag: '辅助 · 不攻击',
      skill: { cd: 5, type: 'heal', name: '仁德', desc: '相邻己方单位回血' },
    },
    {
      id: 'zhangbao', name: '张苞', chars: ['张', '苞'], base: 'dao',
      range: 1, tag: '刀兵系 · 中规中矩',
      skill: { cd: 8, type: 'leap', name: '跳劈', desc: '单体重击' },
    },
  ];

  const HERO_BY_ID = {};
  const HERO_BY_NAME = {};
  HEROES.forEach(function (h) { HERO_BY_ID[h.id] = h; HERO_BY_NAME[h.name] = h; });

  // 金色武将字池（去重）
  const GOLD_CHARS = (function () {
    const set = {};
    HEROES.forEach(function (h) { h.chars.forEach(function (c) { set[c] = true; }); });
    return Object.keys(set);
  })();

  /* ---------- 道具表 ----------
   * 本轮实现：shovel 铲子 / brush 毛笔 / warcry 神兵符
   * 其余为预留枚举位（有枚举、无界面、无掉落）
   */
  const ITEMS = {
    shovel:    { id: 'shovel',    name: '铲子',   glyph: '铲', color: '#7a6a52', desc: '点己方相邻荒地兵线格，将其扩为可部署地' },
    brush:     { id: 'brush',     name: '毛笔',   glyph: '笔', color: '#3b4a63', desc: '把己方一个字块随机换成同色另一个字' },
    warcry:    { id: 'warcry',    name: '神兵符', glyph: '符', color: '#b3352f', desc: '全队攻击 ×1.5，持续 10 秒' },
    // —— 预留枚举位（本轮不做界面与掉落）——
    dabuwan:   { id: 'dabuwan',   name: '大补丸', glyph: '补', color: '#777', desc: '预留' },
    xumingdan: { id: 'xumingdan', name: '续命丹', glyph: '丹', color: '#777', desc: '预留' },
    gongsufu:  { id: 'gongsufu',  name: '攻速符', glyph: '速', color: '#777', desc: '预留' },
    jiansuni:  { id: 'jiansuni',  name: '减速淤泥', glyph: '泥', color: '#777', desc: '预留' },
    jiban:     { id: 'jiban',     name: '羁绊',   glyph: '绊', color: '#777', desc: '预留' },
  };

  /* ---------- Boss（关卡关底强化波） ---------- */
  const BOSS = {
    char: '魔', name: '魔将', base: 'zei',
    hp: 24, atk: 2, aspd: 0.9, range: 1, move: 2.0,
    hpMul: BOSS_HP_MUL, atkMul: BOSS_ATK_MUL, skillCd: BOSS_SKILL_CD, slow: BOSS_SLOW,
  };

  /* ---------- 征兵概率池（合计 100） ---------- */
  const RECRUIT_POOL = [
    { w: 22, kind: 'unit', type: 'dao' },
    { w: 18, kind: 'unit', type: 'qiang' },
    { w: 13, kind: 'unit', type: 'gong' },
    { w: 9,  kind: 'unit', type: 'qi' },
    { w: 15, kind: 'gold' },
    { w: 12, kind: 'item', item: 'shovel' },
    { w: 5,  kind: 'unit', type: 'nong' },
    { w: 3,  kind: 'item', item: 'brush' },
    { w: 3,  kind: 'item', item: 'warcry' },
  ];

  /* ---------- 敌军（无尽 / 关卡）出兵构成 ---------- */
  const ENEMY_MIX = [
    { w: 40, type: 'zei' },
    { w: 25, type: 'dao' },
    { w: 15, type: 'qiang' },
    { w: 12, type: 'gong' },
    { w: 8,  type: 'qi' },
  ];
  const ELITE_TYPES = ['dao', 'qi'];

  /* ---------- 波次节奏（关卡 / 无尽）—— 数值基线集中在这里，方便统一调平 ---------- */
  const TUNE = {
    levelFirstGap: 26,      // 关卡：第一波之前的备战时间（秒）
    levelGap: 22,           // 关卡：普通波间隔
    levelBossGap: 26,       // 关卡：关底波之前的间隔
    levelStep: 1,           // 关卡：每波递增兵数
    levelEnemyDiv: 3,        // 关卡：敌方等级每几关 +1
    levelHpRamp: 0.08,      // 关卡：每波血量递增比例
    levelAtkRamp: 0.05,     // 关卡：每波攻击递增比例
    bossCountMul: 1.5,      // 关底波兵数 = 关卡基准 × 此值
    bossHpMul: 1.4,         // 关底波血量倍率
    bossAtkMul: 1.25,       // 关底波攻击倍率
    endlessBase: 2,         // 无尽：第 1 波兵数基数
    endlessStep: 0.8,       // 无尽：每波递增兵数
    endlessHp: 1.05,        // 无尽：每波血量指数底
    endlessAtk: 1.035,      // 无尽：每波攻击指数底
    endlessEliteMul: 1.5,   // 无尽：强化波兵数倍率
    endlessInterval: 18,    // 无尽：初始波间隔
    endlessDecay: 0.95,     // 无尽：波间隔逐波衰减
    endlessMin: 8,          // 无尽：波间隔下限
    // —— V2：兵线分流 & 突破口 ——
    laneMidW: 0.5,          // 中路分流权重
    laneLWR: 0.25,          // 左右路分流权重
    breakStart: 4,          // 无尽：从第几波起可能触发突破口
    breakMin: 3,            // 突破口事件最小间隔（波）
    breakMax: 5,            // 突破口事件最大间隔（波）
    breakMul: 2.5,          // 突破口：该线出怪数量 ×2.5
    breakGapMul: 0.5,       // 突破口：出怪间隔减半
    levelBreakWave: 2,      // 关卡：每关第几波随机一次突破口
  };

  /* ---------- 军衔 ---------- */
  const RANKS = ['军士一', '军士二', '军士三', '校尉', '都尉', '偏将', '上将'];

  /* ---------- 关卡序列 ---------- */
  const LEVELS = [
    { name: '巨鹿',   hpMul: 0.85, atkMul: 0.90, count: 2 },
    { name: '界桥',   hpMul: 1.10, atkMul: 1.05, count: 2 },
    { name: '长坂坡', hpMul: 1.22, atkMul: 1.11, count: 3 },
    { name: '汉水',   hpMul: 1.36, atkMul: 1.18, count: 3 },
    { name: '定军山', hpMul: 1.52, atkMul: 1.26, count: 4 },
    { name: '五丈原', hpMul: 1.70, atkMul: 1.35, count: 4 },
  ];

  /* ---------- 数值工具 ---------- */
  function safe(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  /** 兵种在某等级下的数值 */
  function statsAt(typeKey, level) {
    const t = UNITS[typeKey] || UNITS.dao;
    const n = Math.max(1, safe(level)) - 1;
    return {
      hp: t.hp * Math.pow(GROW.hp, n),
      atk: t.atk * Math.pow(GROW.atk, n),
      aspd: t.aspd ? t.aspd * Math.pow(GROW.aspd, n) : 0,
    };
  }

  /** 武将在某武将等级下的数值（基准 = 对应兵种 3 级 ×1.2） */
  function heroStats(heroId, heroLevel) {
    const h = HERO_BY_ID[heroId] || HEROES[0];
    const b = statsAt(h.base, 3);
    const n = Math.max(1, safe(heroLevel)) - 1;
    let hp = b.hp * 1.2 * Math.pow(GROW.hp, n);
    const atk = b.atk * 1.2 * Math.pow(GROW.atk, n);
    const aspd = b.aspd ? b.aspd * Math.pow(GROW.aspd, n) : 0;
    if (h.hpMul) hp *= h.hpMul;
    return {
      hp: hp, atk: atk, aspd: aspd,
      range: h.range != null ? h.range : UNITS[h.base].range,
      move: h.noMove ? 0 : 2.10,
      pierce: !!h.pierce,
      splash: h.splash || 0,
      crit: h.crit || 0,
      critMul: h.critMul || 1,
      dmgReduce: h.dmgReduce || 0,
      noAttack: !!h.noAttack,
    };
  }

  /** 加权随机 */
  function weighted(list) {
    let total = 0;
    for (let i = 0; i < list.length; i++) total += list[i].w;
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) {
      r -= list[i].w;
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  /** 掷一次征兵，返回一张手牌描述 */
  /** 金字「凑将」辅助抽取：
   *  字池有 12 个字，纯随机的话要凑出「赵+云」这种固定搭配几乎不可能，
   *  武将这条主线就废了。所以有一定概率优先抽「能把场上/手里的孤字凑成对」的那个字。
   *  传 state / side 才能读到当前局面；不传就退化成纯随机（测试用）。
   */
  const GOLD_MATCH_RATE = 0.7;
  function goldNeeds(state, side) {
    const need = [];
    const add = function (ch) { if (need.indexOf(ch) < 0) need.push(ch); };
    if (state && side) {
      (state.units || []).forEach(function (u) {
        if (u.side === side && u.cls === 'gold' && !u.dead) add(u.char);
      });
      const hand = (state[side] && state[side].hand) || [];
      hand.forEach(function (c) { if (c.kind === 'gold') add(c.char); });
    }
    const out = [];
    need.forEach(function (ch) {
      HEROES.forEach(function (h) {
        if (h.chars[0] === ch) out.push(h.chars[1]);
        if (h.chars[1] === ch) out.push(h.chars[0]);
      });
    });
    return out;
  }
  function rollRecruit(state, side) {
    const hit = weighted(RECRUIT_POOL);
    if (hit.kind === 'unit') {
      return { kind: 'unit', char: UNITS[hit.type].char, type: hit.type, level: 1 };
    }
    if (hit.kind === 'gold') {
      let c = null;
      const wants = goldNeeds(state, side);
      if (wants.length && Math.random() < GOLD_MATCH_RATE) c = wants[Math.floor(Math.random() * wants.length)];
      else c = GOLD_CHARS[Math.floor(Math.random() * GOLD_CHARS.length)];
      return { kind: 'gold', char: c, level: 1 };
    }
    return { kind: 'item', item: hit.item };
  }

  ZY.C = {
    GROW: GROW, MAX_LEVEL: MAX_LEVEL, HERO_MAX_LEVEL: HERO_MAX_LEVEL,
    RECRUIT_BASE_COST: RECRUIT_BASE_COST, RECRUIT_MAX_COST: RECRUIT_MAX_COST,
    RECRUIT_STEP: RECRUIT_STEP, BATCH: BATCH, HAND_MAX: HAND_MAX, START_BUN: START_BUN,
    BASE_INCOME: BASE_INCOME, ADOU_HP: ADOU_HP, ADOU_BONUS: ADOU_BONUS,
    WARCRY_MULT: WARCRY_MULT, WARCRY_TIME: WARCRY_TIME,
    HERO_KILLS_PER_LEVEL: HERO_KILLS_PER_LEVEL,
    LEVEL_CLEAR_BONUS: LEVEL_CLEAR_BONUS, FORK_CHANCE: FORK_CHANCE,
    NORMAL_BOUNTY: NORMAL_BOUNTY, ELITE_BOUNTY: ELITE_BOUNTY, BOSS_BOUNTY: BOSS_BOUNTY,
    BOSS_HP_MUL: BOSS_HP_MUL, BOSS_ATK_MUL: BOSS_ATK_MUL, BOSS_SKILL_CD: BOSS_SKILL_CD,
    BOSS_SLOW: BOSS_SLOW,
  };
  ZY.UNITS = UNITS;
  ZY.CHAR2TYPE = CHAR2TYPE;
  ZY.SOLDIER_CHARS = SOLDIER_CHARS;
  ZY.HEROES = HEROES;
  ZY.HERO_BY_ID = HERO_BY_ID;
  ZY.HERO_BY_NAME = HERO_BY_NAME;
  ZY.GOLD_CHARS = GOLD_CHARS;
  ZY.ITEMS = ITEMS;
  ZY.BOSS = BOSS;
  ZY.RECRUIT_POOL = RECRUIT_POOL;
  ZY.ENEMY_MIX = ENEMY_MIX;
  ZY.ELITE_TYPES = ELITE_TYPES;
  ZY.RANKS = RANKS;
  ZY.LEVELS = LEVELS;
  ZY.TUNE = TUNE;
  ZY.statsAt = statsAt;
  ZY.heroStats = heroStats;
  ZY.weighted = weighted;
  ZY.rollRecruit = rollRecruit;
})(window.ZY);
