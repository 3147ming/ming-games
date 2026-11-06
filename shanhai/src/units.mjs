/**
 * 《山海拾遗》兵种与单位数值。
 *
 * 数值设计目标（先说结论再列数据）：
 *   - 一场普通遭遇 4~7 回合结束，每回合都有明确选择，不靠随机数拖时间；
 *   - 三个兵种的血量/攻击/防御/移动/射程五项至少三项不同，玩家一眼能懂定位；
 *   - 剑士能抗 4 刀左右，弓手 3 刀左右，术士 3~4 刀：前排倒下之前必须做出换位；
 *   - 所有伤害取整，玩家可以在心里复算。
 *
 * 浏览器以 classic script 加载，Node 测试直接 import 本文件后读 ShanhaiUnits。
 */
(function attachUnits(root) {
  'use strict';

  /**
   * 兵种元数据只负责“展示和定位”。
   * 真正的克制倍率在 core.mjs 的 CLASS_CYCLE 中，避免数值双写。
   */
  const CLASSES = Object.freeze({
    sword: Object.freeze({
      id: 'sword',
      name: '剑士',
      sigil: '剑',
      tone: 'cinnabar',
      role: '近战 · 高防',
      strongLabel: '弓手',
      weakLabel: '术士',
      blurb: '身披石甲，贴身缠斗。防高血厚，但只能打相邻一格。',
    }),
    bow: Object.freeze({
      id: 'bow',
      name: '弓手',
      sigil: '弓',
      tone: 'stone',
      role: '远程 · 脆皮',
      strongLabel: '术士',
      weakLabel: '剑士',
      blurb: '射程三格，隔着水泽与山口消耗敌人；被剑士近身则非常危险。',
    }),
    mystic: Object.freeze({
      id: 'mystic',
      name: '术士',
      sigil: '术',
      tone: 'jade',
      role: '范围 · 破甲',
      strongLabel: '剑士',
      weakLabel: '弓手',
      blurb: '射程两格，命中主目标时溅射相邻敌人；单体伤害低于弓手。',
    }),
  });

  /**
   * 单位模板。移动力以“格”计；山地一格算两点。
   *
   * 我方三人的数值略高于同定位敌人，原因：
   *   本作没有装备、升级与随机暴击，玩家唯一的成长是“打得更好”；
   *   若双方完全镜像，教学关会过度依赖先手，容错太低。
   */
  const TEMPLATES = Object.freeze({
    // ── 我方 ────────────────────────────────────────────────
    shangui: Object.freeze({
      id: 'shangui',
      name: '山鬼',
      epithet: '青丘执剑',
      classId: 'sword',
      teamHint: 'player',
      hp: 34, atk: 9, def: 6, move: 4, range: 1,
      lore: '披薜荔、带女萝，守青丘旧道。近身之后极难撼动。',
    }),
    yumin: Object.freeze({
      id: 'yumin',
      name: '羽民',
      epithet: '鸣弦之裔',
      classId: 'bow',
      teamHint: 'player',
      hp: 24, atk: 8, def: 3, move: 3, range: 3,
      lore: '羽民国之后，目锐手稳。三格之内，先发制人。',
    }),
    wuxian: Object.freeze({
      id: 'wuxian',
      name: '巫咸',
      epithet: '执火问天',
      classId: 'mystic',
      teamHint: 'player',
      hp: 27, atk: 7, def: 4, move: 3, range: 2,
      splash: true,
      lore: '登葆山、采灵草。术火落处，相邻之敌亦受余烬。',
    }),

    // ── 敌方 ────────────────────────────────────────────────
    shanxiao: Object.freeze({
      id: 'shanxiao',
      name: '山魈',
      epithet: '裂石山魈',
      classId: 'sword',
      teamHint: 'enemy',
      hp: 30, atk: 8, def: 5, move: 3, range: 1,
      lore: '山中精怪，喜持石斧拦路。',
    }),
    zhenyu: Object.freeze({
      id: 'zhenyu',
      name: '鸩羽',
      epithet: '毒翎羽民',
      classId: 'bow',
      teamHint: 'enemy',
      hp: 22, atk: 7, def: 3, move: 3, range: 3,
      lore: '其羽有毒，远掷如雨。',
    }),
    wangxiang: Object.freeze({
      id: 'wangxiang',
      name: '罔象',
      epithet: '泽影巫祝',
      classId: 'mystic',
      teamHint: 'enemy',
      hp: 24, atk: 6, def: 3, move: 3, range: 2,
      splash: true,
      lore: '藏于水泽的影，借残祭施术。',
    }),
    xiangliu: Object.freeze({
      id: 'xiangliu',
      name: '相柳',
      epithet: '九首残影',
      classId: 'mystic',
      teamHint: 'enemy',
      // 这不是全盛相柳，而是祭坛里残存的一缕影；血少但射程和溅射仍在。
      hp: 24, atk: 7, def: 4, move: 2, range: 2,
      splash: true,
      lore: '所抵之处尽成泽溪。九首只剩一道影子，仍守着不周残坛。',
    }),
  });

  const PLAYER_TEMPLATE_IDS = Object.freeze(['shangui', 'yumin', 'wuxian']);

  function getClass(classId) {
    return CLASSES[classId] || null;
  }

  function getTemplate(templateId) {
    return TEMPLATES[templateId] || null;
  }

  /**
   * 从模板实例化一个战场单位。纯函数，不读全局游戏状态。
   * 生成字段：
   *   hp/maxHp, atk, def, move, range, alive —— 战斗核心直接使用；
   *   classId/sigil/tone —— 界面直接使用；
   *   acted/moved —— 游戏层每回合重置的行动标记。
   */
  function createUnit(templateId, options) {
    const template = getTemplate(templateId);
    if (!template) throw new Error(`未知单位模板：${templateId}`);
    const opts = options || {};
    const team = opts.team || template.teamHint || 'enemy';
    const suffix = opts.index == null ? 0 : opts.index;
    const cls = getClass(template.classId);
    return {
      id: opts.id || `${team}-${template.id}-${suffix}`,
      templateId: template.id,
      name: template.name,
      epithet: template.epithet,
      classId: template.classId,
      className: cls.name,
      sigil: cls.sigil,
      tone: cls.tone,
      team,
      x: opts.x,
      y: opts.y,
      hp: template.hp,
      maxHp: template.hp,
      atk: template.atk,
      def: template.def,
      move: template.move,
      range: template.range,
      splash: Boolean(template.splash),
      lore: template.lore,
      alive: true,
      acted: false,
      moved: false,
    };
  }

  const api = {
    CLASSES,
    TEMPLATES,
    PLAYER_TEMPLATE_IDS,
    getClass,
    getTemplate,
    createUnit,
  };

  Object.defineProperty(root, 'ShanhaiUnits', {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
