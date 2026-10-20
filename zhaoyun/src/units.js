/* =============================================================================
 * 赵云与阿斗 · 规则表 (units.js)  — V5 原版对齐
 * 兵种 / 武将 / 道具 / 武器 / 征兵概率池 / 军衔 / 关卡 —— 全部数值集中在这里
 * 数值口径 = 原版录屏逐帧逆向（160s / 33 帧 OCR）：
 *   · 原版实测值（标注【原版】）：征兵 10 起步每次 +2 不封顶、一次 5 张进军营(5 槽)、
 *     手牌 8 格、开局资源 20、资源 +1/s、刀 4.50/1.88、刘备 16.00/1.25、经验 3.6/10、
 *     铁剑 攻击+3、击杀普通敌人 +1、阿斗 3 血、巨鹿关 6 波、五对武将字。
 *   · 原版未展示、按比例推导（标注【推导】）：枪/弓/骑/农民面板、精英/Boss 赏金、
 *     每击杀经验值、敌方行军速度、波次结构细节。全部可在 balance 复跑复调。
 * 纯经典脚本（非 ES Module），可 file:// 直接双击运行
 * ========================================================================== */
window.ZY = window.ZY || {};
(function (ZY) {
  'use strict';

  /* ---------- 全局常量 ---------- */
  const GROW = { hp: 1.55, atk: 1.85, aspd: 1.05 }; // 每升 1 级的成长系数【推导，沿用 V4】
  const MAX_LEVEL = 5;            // 兵种/武将等级上限【原版：满级 5 级】
  const RECRUIT_BASE_COST = 10;   // 征兵初始成本【原版：10 起步】
  const RECRUIT_STEP = 2;         // 每次成功征兵成本 +2【原版：10→12→14…不封顶】
  // 注意：原版征兵成本不封顶（无 RECRUIT_MAX_COST）
  const BATCH = 5;                // 一次征兵产出 5 张【原版】
  const BARRACKS_MAX = 5;         // 军营栏 5 槽【原版】
  const HAND_MAX = 8;             // 手牌区 8 格（武将卡占 2 格）【原版】
  const START_BUN = 20;           // 开局资源 20【原版】（界面显示为「资源」，蛋形/圆形图标）
  const BASE_INCOME = 1;          // 资源自动增长 +1/s【原版：5 秒内 +2~4，含击杀奖励 · 校准确认】
  const ADOU_HP = 3;              // 阿斗血量【原版：三颗红心】
  const ADOU_BONUS = 10;          // 阿斗掉 1 血补偿资源【推导，沿用 V4：卖血换经济】
  const ADOU_LINE_WAVE = '护驾！护驾！';   // 阿斗台词：敌人来袭时【原版】
  const ADOU_LINE_LOW = '我快不行了';     // 阿斗台词：血量告急时【原版】
  const WARCRY_MULT = 1.5;        // 神兵符攻击倍率【推导，沿用 V4】
  const WARCRY_TIME = 10;         // 神兵符持续秒数【推导，沿用 V4】
  const FIREBALL_DMG = 80;        // 火球固定伤害（精英/Boss 同样生效）【推导，沿用 V4】
  const FIREBALL_RADIUS = 1;      // 火球爆炸半径（切比雪夫，3×3）【推导，沿用 V4】
  const NORMAL_BOUNTY = 1;        // 击杀普通敌人资源 +1【原版】
  const ELITE_BOUNTY = 8;         // 击杀精英赏金【推导·校准确认：V4 口径，无尽强化波/关卡突破口，血厚难杀，8 对得起收益】
  const BOSS_BOUNTY = 30;         // 击杀 Boss 赏金【推导·校准确认：张梁血=贼24×10倍率×波次倍率，30 合理】
  const XP_PER_KILL = 1.2;        // 每击杀 1 个 Lv1 敌人获得的经验【推导·校准确认：3 只 = 3.6，对齐原版刘备面板 3.6/10】
  const XP_PER_LEVEL = 10;        // 经验满 10 升 1 级【原版：经验值 (x/10) · 校准确认】
  const LEVEL_WAVES = 6;          // 关卡模式每关波数【原版：巨鹿关 = 6 波】
  const STAR_PAR_WAVE = 25;       // 星级时间基准：每波 25s 内清完算快【推导·校准确认】
  const LEVEL_CLEAR_BONUS = 25;   // 关卡模式：过关战利品（资源）【推导·校准确认：结算界面金币 +20 为原版展示值，两者不同体系，均保留】
  const SHOVEL_START = 2;         // 开局道具栏铲子数量【原版：道具栏（铲子 x2）】
  const SHOVEL_WAVE_BONUS = 5;    // 每多少波奖励 1 把铲子【推导】
  const BOSS_HP_MUL = 10;         // Boss 血量倍率（相对同波敌）【推导，沿用 V4】
  const BOSS_ATK_MUL = 3;         // Boss 攻击倍率【推导，沿用 V4】
  const BOSS_SKILL_CD = 6;        // Boss 震击技能 CD（秒）【推导，沿用 V4】
  const BOSS_SLOW = 1;            // Boss 震击减速（秒，即 stun）【推导，沿用 V4】

  /* ---------- 兵种表（1 级面板） ----------
   * atk/aspd = 原版展示值或按「刀 4.50/1.88」基准的比例推导值（逐项注释）
   * move   = 敌人每前进 1 格所需秒数（行军速度沿用 V4 实测口径，指令未要求改）
   * range  = 射程（格，切比雪夫）
   * pierce = 直线贯穿（打到射程内同列所有敌人）
   * splash = 溅射系数（对目标周围 1 格造成 X 倍伤害）
   * produce= 农民每秒产资源
   */
  const UNITS = {
    dao:   { key: 'dao',   char: '刀', name: '刀兵', hp: 40,  atk: 4.50, aspd: 1.88, range: 1, move: 2.60, role: 'front', tag: '单体' }, // 刀 = 原版展示值
    qiang: { key: 'qiang', char: '枪', name: '枪兵', hp: 32,  atk: 3.80, aspd: 2.05, range: 2, move: 2.30, role: 'mid',   pierce: true,  tag: '贯穿' }, // 推导·校准确认：肉盾刀40 > 骑36 > 枪32 > 弓20 > 农18，定位自洽
    gong:  { key: 'gong',  char: '弓', name: '弓兵', hp: 20,  atk: 3.20, aspd: 1.60, range: 4, move: 2.40, role: 'back',  tag: '远程' },                   // 推导·校准确认：远程低血；弓 3.20 即武将黄忠/诸葛亮攻击公式基准
    qi:    { key: 'qi',    char: '骑', name: '骑兵', hp: 36,  atk: 4.20, aspd: 1.70, range: 1, move: 1.75, role: 'flank', splash: 0.5, tag: '溅射' },      // 推导·校准确认：近战溅射；骑 4.20 即武将马超攻击公式基准
    zei:   { key: 'zei',   char: '贼', name: '贼兵', hp: 24,  atk: 2.00, aspd: 1.20, range: 1, move: 1.85, role: 'front', tag: '敌方' },                   // 敌方普通兵种
    nong:  { key: 'nong',  char: '农', name: '农民', hp: 18,  atk: 0,    aspd: 0,    range: 0, move: 0,    role: 'back',  produce: 0.4, tag: '产出' },      // 推导·校准确认：资源产出 0.4/s，征兵池 5%，回本约 25-30s
  };

  // 汉字 → 兵种 key
  const CHAR2TYPE = {};
  Object.keys(UNITS).forEach(function (k) { CHAR2TYPE[UNITS[k].char] = k; });

  // 兵种字（毛笔同色替换的黑字池）
  const SOLDIER_CHARS = ['刀', '枪', '弓', '骑'];

  /* ---------- 武将表 ----------
   * V5：五对武将字（原版字对合成表）。
   * V6 数值校准（用户拍板）：武将攻击面板统一按「对应兵种 3 级 × 1.2」复算
   *   （V1 已确立并被接受的规则：武将 = 对应兵种 3 级 × 1.2，保留两位小数），
   *   即 atk = UNITS[base].atk × GROW.atk^(3-1) × 1.2 = UNITS[base].atk × 1.85² × 1.2。
   *   刘备 = 原版展示锚定值 16.00，不参与公式；其余武将略高于刘备是「有意且正确」的
   *   （原版只展示了刘备面板，其余武将攻击未展示、不构成冲突；刘备靠「仁德」群体回血定位）。
   *   同系武将攻击相同是公式决定的、有意且正确（张飞=关羽=18.48、黄忠=诸葛亮=13.14）；
   *   武将个体差异由 hp/攻速/技能/特性字段承担。攻速/hpBase/技能/标签/占 2 格宽均不动。
   * heroLevel 成长走 GROW。武将卡占 2 格宽（手牌 2 槽 / 棋盘横跨 2 格）。
   */
  const HEROES = [
    {
      id: 'zhaoyun', name: '赵云', chars: ['赵', '云'], base: 'qiang',
      atk: 15.61, aspd: 1.45, hpBase: 32, range: 3, pierce: true, tag: '枪兵系 · 贯穿', // atk = 枪 3 级 ×1.2（V1 规则）= 3.80×1.85²×1.2 = 15.61
      skill: { cd: 8, type: 'sweep', name: '横扫剑气', desc: '前方直线群伤' },
    },
    {
      id: 'zhangfei', name: '张飞', chars: ['张', '飞'], base: 'dao',
      atk: 18.48, aspd: 1.30, hpBase: 40, hpMul: 1.25, dmgReduce: 0.25, range: 1, tag: '刀兵系 · 高血高防', // atk = 刀 3 级 ×1.2 = 4.50×1.85²×1.2 = 18.48
      skill: { cd: 10, type: 'roar', name: '怒吼', desc: '震晕前方 1 格敌人 1 秒' },
    },
    {
      id: 'huangzhong', name: '黄忠', chars: ['黄', '忠'], base: 'gong',
      atk: 13.14, aspd: 1.10, hpBase: 20, range: 5, crit: 0.4, critMul: 2.0, tag: '弓兵系 · 远程暴击', // atk = 弓 3 级 ×1.2 = 3.20×1.85²×1.2 = 13.14
      skill: { cd: 9, type: 'snipe', name: '蓄力狙击', desc: '对最远敌人单体大伤' },
    },
    {
      id: 'liubei', name: '刘备', chars: ['刘', '备'], base: 'dao',
      atk: 16.00, aspd: 1.25, hpBase: 40, range: 1, tag: '主公 · 单体', // 原版展示锚定值（攻击 16.00 / 攻速 1.25 / 单体），不参与公式
      skill: { cd: 5, type: 'heal', name: '仁德', desc: '相邻己方单位回血' },
    },
    {
      id: 'machao', name: '马超', chars: ['马', '超'], base: 'qi',
      atk: 17.25, aspd: 1.35, hpBase: 36, range: 1, splash: 0.6, tag: '骑兵系 · 群伤', // atk = 骑 3 级 ×1.2 = 4.20×1.85²×1.2 = 17.25
      skill: { cd: 10, type: 'cleave', name: '青龙斩', desc: '周围溅射大伤害' },
    },
    // —— V6 内容扩展：补入武圣关羽 + 军师诸葛亮（字对由 HEROES 自动派生到 GOLD_CHARS）
    {
      id: 'guanyu', name: '关羽', chars: ['关', '羽'], base: 'dao',
      atk: 18.48, aspd: 1.15, hpBase: 44, hpMul: 1.2, dmgReduce: 0.15, range: 2, splash: 0.35,
      tag: '刀兵系 · 横扫重击', // atk = 刀 3 级 ×1.2 = 4.50×1.85²×1.2 = 18.48（V6 新增，一并校准）；同系张飞=关羽=18.48 为公式决定、有意
      skill: { cd: 9, type: 'sweep', name: '青龙偃月', desc: '前方扇形群伤' },
    },
    {
      id: 'zhugeliang', name: '诸葛亮', chars: ['诸', '葛'], base: 'gong',
      atk: 13.14, aspd: 1.25, hpBase: 18, range: 4, crit: 0.15, critMul: 1.8,
      tag: '军师 · 范围火计', // atk = 弓 3 级 ×1.2 = 3.20×1.85²×1.2 = 13.14（V6 新增，一并校准）；同系黄忠=诸葛亮=13.14 为公式决定、有意
      skill: { cd: 11, type: 'burn', name: '八阵图', desc: '范围内群伤并短眩晕' },
    },
  ];

  const HERO_BY_ID = {};
  const HERO_BY_NAME = {};
  HEROES.forEach(function (h) { HERO_BY_ID[h.id] = h; HERO_BY_NAME[h.name] = h; });

  // 金色武将字池（去重，共 10 字 = 5 对）
  const GOLD_CHARS = (function () {
    const set = {};
    HEROES.forEach(function (h) { h.chars.forEach(function (c) { set[c] = true; }); });
    return Object.keys(set);
  })();

  /* ---------- 道具表 ----------
   * V5：铲子移到道具栏（计数式，开局 ×2，每 SHOVEL_WAVE_BONUS 波 +1）；
   * 神兵符/毛笔/火球仍以卡牌形态从征兵产出，全部拖放释放。
   */
  const ITEMS = {
    shovel:    { id: 'shovel',    name: '铲子',   glyph: '铲', color: '#7a6a52', desc: '拖到荒地塔位上，扩成可建塔地块' },
    brush:     { id: 'brush',     name: '毛笔',   glyph: '笔', color: '#3b4a63', desc: '拖到己方塔上，改写该塔兵种（金/将不可）' },
    warcry:    { id: 'warcry',    name: '神兵符', glyph: '符', color: '#b3352f', desc: '拖出释放：全队攻击 ×1.5，持续 10 秒' },
    fireball:  { id: 'fireball',  name: '火球',   glyph: '火', color: '#c65a1e', desc: '拖到主路上：落点 3×3 内敌人受 80 点固定伤害' },
  };

  /* ---------- 武器背包 ----------
   * V5 新增：至少提供「铁剑 攻击+3」，可装备给武将（面板显示装备加成）。
   * 其他武器为预留推导位。
   */
  const WEAPONS = {
    tiejian: { id: 'tiejian', name: '铁剑', glyph: '剑', atk: 3, desc: '攻击 +3' }, // 原版展示值
  };

  /* ---------- Boss（关卡关底 / 无尽强化波） ----------
   * V5：敌方带名武将「张梁」作为精英/Boss 出场，带名字。
   */
  const BOSS = {
    char: '梁', name: '张梁', base: 'zei',
    hp: 24, atk: 2, aspd: 0.9, range: 1, move: 2.0,
    hpMul: BOSS_HP_MUL, atkMul: BOSS_ATK_MUL, skillCd: BOSS_SKILL_CD, slow: BOSS_SLOW,
  };

  /* ---------- 征兵概率池（合计 100） ----------
   * V5：铲子改走道具栏计数，不再占卡牌池；权重向兵种/金字倾斜。
   */
  const RECRUIT_POOL = [
    { w: 24, kind: 'unit', type: 'dao' },
    { w: 18, kind: 'unit', type: 'qiang' },
    { w: 13, kind: 'unit', type: 'gong' },
    { w: 10, kind: 'unit', type: 'qi' },
    { w: 16, kind: 'gold' },
    { w: 5,  kind: 'unit', type: 'nong' },
    { w: 4,  kind: 'item', item: 'brush' },
    { w: 4,  kind: 'item', item: 'warcry' },
    { w: 6,  kind: 'item', item: 'fireball' },
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
    levelFirstGap: 20,      // 关卡：第一波之前的备战时间（秒）
    levelGap: 18,           // 关卡：普通波间隔
    levelBossGap: 24,       // 关卡：关底波（第 6 波）之前的间隔
    levelWaves: LEVEL_WAVES,// 关卡：每关波数（第 6 波 = 关底，出张梁）
    levelStep: 1,           // 关卡：每波递增兵数
    levelEnemyDiv: 3,       // 关卡：敌方等级每几关 +1
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
    gateExit: 0.5,          // 出兵：敌人离开入口格的第一步耗时（秒，出关后恢复原移速）
                            //       —— 单格入口 + 单占位会把出兵吞吐压到「移速/个」，此值解除吞兵节流
    levelBreakWave: 3,      // 关卡：每关第几波随机一次突破口
    versusWaves: 15,        // 竞技：公共波次总数（打满比阿斗剩血，持平比击杀；进行中仍谁先破谁输）
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
    { name: '街亭',   hpMul: 1.80, atkMul: 1.40, count: 4 },
    { name: '麦城',   hpMul: 1.95, atkMul: 1.48, count: 5 },
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

  /** 武将在某武将等级下的数值（基准 = 武将表 atk/aspd + GROW 成长） */
  function heroStats(heroId, heroLevel) {
    const h = HERO_BY_ID[heroId] || HEROES[0];
    const n = Math.max(1, safe(heroLevel)) - 1;
    const hp = (h.hpBase || 30) * 2.2 * Math.pow(GROW.hp, n) * (h.hpMul || 1);
    return {
      hp: hp,
      atk: h.atk * Math.pow(GROW.atk, n),
      aspd: h.aspd ? h.aspd * Math.pow(GROW.aspd, n) : 0,
      range: h.range != null ? h.range : UNITS[h.base].range,
      move: 2.10,
      pierce: !!h.pierce,
      splash: h.splash || 0,
      crit: h.crit || 0,
      critMul: h.critMul || 1,
      dmgReduce: h.dmgReduce || 0,
      noAttack: false,
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

  /** 金字「凑将」辅助抽取：
   *  字池有 10 个字（5 对），纯随机凑对太慢，所以有一定概率优先抽
   *  「能把手里/军营里的孤字凑成对」的那个字。传 state/side 才能读到局面；
   *  不传就退化成纯随机（测试用）。
   */
  const GOLD_MATCH_RATE = 0.7;
  function goldNeeds(state, side) {
    const need = [];
    const add = function (ch) { if (need.indexOf(ch) < 0) need.push(ch); };
    if (state && side) {
      const s = side === 'player' ? state.player : state.enemy;
      (s.hand || []).forEach(function (c) { if (c.kind === 'gold') add(c.char); });
      (s.barracks || []).forEach(function (c) { if (c.kind === 'gold') add(c.char); });
      (state.units || []).forEach(function (u) {
        if (u.side === side && u.cls === 'gold' && !u.dead) add(u.char);
      });
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

  /** 手牌/军营占用格数（武将卡占 2 格） */
  function cardSpan(card) { return card && card.kind === 'hero' ? 2 : 1; }
  function handUsed(side) {
    let n = 0;
    (side.hand || []).forEach(function (c) { n += cardSpan(c); });
    return n;
  }

  /** 当前可合成的武将（手里同时持有某对两个字 → 返回该武将，否则 null） */
  function heroSynthReady(state, side) {
    const s = side === 'player' ? state.player : state.enemy;
    const hand = s.hand || [];
    for (let i = 0; i < HEROES.length; i++) {
      const h = HEROES[i];
      const a = hand.find(function (c) { return c.kind === 'gold' && c.char === h.chars[0]; });
      const b = hand.find(function (c) { return c.kind === 'gold' && c.char === h.chars[1]; });
      if (a && b) return h;
    }
    return null;
  }

  /** V6 合成深化：同名武将卡凑齐 2 张（均未满星）→ 返回该 heroId，可升星，否则 null */
  function heroStarReady(state, side) {
    const s = side === 'player' ? state.player : state.enemy;
    const hand = s.hand || [];
    const seen = {};
    for (let i = 0; i < hand.length; i++) {
      const c = hand[i];
      if (c.kind !== 'hero' || !c.heroId) continue;
      if ((c.level || 1) >= MAX_LEVEL) continue;          // 满星不再升
      seen[c.heroId] = (seen[c.heroId] || 0) + 1;
      if (seen[c.heroId] >= 2) return c.heroId;
    }
    return null;
  }

  ZY.C = {
    GROW: GROW, MAX_LEVEL: MAX_LEVEL,
    RECRUIT_BASE_COST: RECRUIT_BASE_COST, RECRUIT_STEP: RECRUIT_STEP,
    BATCH: BATCH, BARRACKS_MAX: BARRACKS_MAX, HAND_MAX: HAND_MAX, START_BUN: START_BUN,
    BASE_INCOME: BASE_INCOME, ADOU_HP: ADOU_HP, ADOU_BONUS: ADOU_BONUS,
    ADOU_LINE_WAVE: ADOU_LINE_WAVE, ADOU_LINE_LOW: ADOU_LINE_LOW,
    WARCRY_MULT: WARCRY_MULT, WARCRY_TIME: WARCRY_TIME,
    FIREBALL_DMG: FIREBALL_DMG, FIREBALL_RADIUS: FIREBALL_RADIUS,
    NORMAL_BOUNTY: NORMAL_BOUNTY, ELITE_BOUNTY: ELITE_BOUNTY, BOSS_BOUNTY: BOSS_BOUNTY,
    XP_PER_KILL: XP_PER_KILL, XP_PER_LEVEL: XP_PER_LEVEL,
    LEVEL_WAVES: LEVEL_WAVES, STAR_PAR_WAVE: STAR_PAR_WAVE,
    LEVEL_CLEAR_BONUS: LEVEL_CLEAR_BONUS,
    SHOVEL_START: SHOVEL_START, SHOVEL_WAVE_BONUS: SHOVEL_WAVE_BONUS,
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
  ZY.WEAPONS = WEAPONS;
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
  ZY.cardSpan = cardSpan;
  ZY.handUsed = handUsed;
  ZY.heroSynthReady = heroSynthReady;
  ZY.heroStarReady = heroStarReady;
})(window.ZY);
