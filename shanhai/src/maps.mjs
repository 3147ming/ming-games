/**
 * 《山海拾遗》关卡数据。
 *
 * 地图固定 8×6（宽 8、高 6），字符含义：
 *   . 平地   F 林地（防御 ×1.35）   M 山地（移动 ×2，防御 ×1.2）   W 水泽（不可通行）
 *
 * 为什么把地图写成字符行而不是 JSON：
 *   file:// 下 fetch/XHR 会被浏览器拦截；地图直接写在 .mjs 里，
 *   双击 index.html 也能读到，且肉眼看得出地形形状。
 *
 * 行军距离的刻意设计：
 *   双方接敌约 2 回合，第一回合就能碰到前排 —— 玩家在开场便要学“移动后攻击”，
 *   而不是先空走两回合。第二关加入四名敌人和更碎的地形，考验换位与集火。
 */
(function attachMaps(root) {
  'use strict';

  const STAGES = Object.freeze([
    Object.freeze({
      id: 'qingqiu',
      order: 1,
      seal: '青丘',
      name: '青丘·迷林',
      subtitle: '旧道有魈',
      difficulty: '一星',
      objective: '击破林中三名山精，夺回青丘旧道。',
      intro: '雾从林隙里漫出来。山鬼按剑，羽民张弓，巫咸指间已有火意。',
      grid: Object.freeze([
        '..M.....',
        '.....F..',
        '..F...F.',
        '.....W..',
        '........',
        '........',
      ]),
      deploy: Object.freeze([
        Object.freeze({ templateId: 'shangui', x: 2, y: 5 }),
        Object.freeze({ templateId: 'yumin', x: 1, y: 5 }),
        Object.freeze({ templateId: 'wuxian', x: 3, y: 5 }),
        Object.freeze({ templateId: 'shanxiao', team: 'enemy', x: 4, y: 2 }),
        Object.freeze({ templateId: 'zhenyu', team: 'enemy', x: 6, y: 2 }),
        Object.freeze({ templateId: 'wangxiang', team: 'enemy', x: 5, y: 1 }),
      ]),
    }),
    Object.freeze({
      id: 'buzhou',
      order: 2,
      seal: '不周',
      name: '不周·残垣',
      subtitle: '九首余响',
      difficulty: '二星',
      objective: '穿过残垣，在相柳重整祭坛前击破全部敌人。',
      intro: '天柱折处，水泽倒悬。相柳的九道影子盘在残垣之后，等一个活人靠近。',
      grid: Object.freeze([
        '..M...M.',
        '.F..W...',
        '...W....',
        '.F...F..',
        '...M....',
        '........',
      ]),
      deploy: Object.freeze([
        Object.freeze({ templateId: 'shangui', x: 2, y: 5 }),
        Object.freeze({ templateId: 'yumin', x: 1, y: 5 }),
        Object.freeze({ templateId: 'wuxian', x: 3, y: 5 }),
        Object.freeze({ templateId: 'shanxiao', team: 'enemy', x: 5, y: 1 }),
        Object.freeze({ templateId: 'zhenyu', team: 'enemy', x: 6, y: 1 }),
        Object.freeze({ templateId: 'zhenyu', team: 'enemy', x: 6, y: 2 }),
        Object.freeze({ templateId: 'xiangliu', team: 'enemy', x: 5, y: 3 }),
      ]),
    }),
  ]);

  function getStage(stageId) {
    return STAGES.find((stage) => stage.id === stageId) || null;
  }

  function nextStage(stageId) {
    const current = getStage(stageId);
    if (!current) return null;
    return STAGES.find((stage) => stage.order === current.order + 1) || null;
  }

  const api = { STAGES, getStage, nextStage };

  Object.defineProperty(root, 'ShanhaiMaps', {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
