/**
 * 局间成长树（纯数据模块）。
 *
 * 三个分支：体能 / 战术 / 装备，每支 3 个节点，共 9 级。
 * apply 把节点加成写入一个 perks 汇总对象（builder），startRaid 时读取。
 */

export const PERK_BRANCHES = {
  body: {
    id: 'body', name: '体能', color: '#5ddc7a',
    nodes: [
      { id: 'hp', name: '生命强化', desc: '最大生命 +15', apply: (p) => { p.hp = 15; } },
      { id: 'weight', name: '负重强化', desc: '负重上限 +2kg', apply: (p) => { p.weight = 2; } },
      { id: 'stamina', name: '体力恢复', desc: '体力恢复 +20%', apply: (p) => { p.stamina = 0.2; } },
    ],
  },
  tactics: {
    id: 'tactics', name: '战术', color: '#4fa3ff',
    nodes: [
      { id: 'pickup', name: '拾取专家', desc: '拾取范围 +25%', apply: (p) => { p.pickup = 0.25; } },
      { id: 'search', name: '快速搜索', desc: '搜索读条 -15%', apply: (p) => { p.search = 0.15; } },
      { id: 'extract', name: '快速撤离', desc: '撤离读条 -0.5 秒', apply: (p) => { p.extract = 0.5; } },
    ],
  },
  gear: {
    id: 'gear', name: '装备', color: '#ffb020',
    nodes: [
      { id: 'ammo', name: '弹药储备', desc: '初始弹药 +30 发', apply: (p) => { p.ammo = 30; } },
      { id: 'reload', name: '快速换弹', desc: '换弹速度 +15%', apply: (p) => { p.reload = 0.15; } },
      { id: 'recoil', name: '稳定射击', desc: '后坐力 -15%', apply: (p) => { p.recoil = 0.15; } },
    ],
  },
};

/** 升级所需经验：随等级递增（100, 160, 220, …） */
export function xpForLevel(level) {
  return 100 + (level - 1) * 60;
}

/** 由已学节点 id 列表构建 perks 汇总 */
export function buildPerks(nodeIds) {
  const p = { hp: 0, weight: 0, stamina: 0, pickup: 0, search: 0, extract: 0, ammo: 0, reload: 0, recoil: 0 };
  for (const id of nodeIds || []) {
    for (const branch of Object.values(PERK_BRANCHES)) {
      const node = branch.nodes.find((n) => n.id === id);
      if (node) node.apply(p);
    }
  }
  return p;
}

/** 所有节点 id 列表（校验用） */
export const ALL_NODE_IDS = Object.values(PERK_BRANCHES).flatMap((b) => b.nodes.map((n) => n.id));

/**
 * 结算发放经验，够则升级并给点数（一次可能连升多级）。
 * @param {object} save 存档对象（原地修改 tree）
 * @param {number} xp 经验值
 * @returns {number} 本次升了几级
 */
export function grantXp(save, xp) {
  const tree = save.tree || (save.tree = { xp: 0, level: 1, points: 0, nodes: [] });
  tree.xp += Math.max(0, Math.round(Number(xp) || 0));
  let levels = 0;
  let need = xpForLevel(tree.level);
  while (tree.xp >= need && levels < 50) { // 上限保险：避免异常 xp 造成死循环
    tree.xp -= need;
    tree.level += 1;
    tree.points += 1;
    levels += 1;
    need = xpForLevel(tree.level);
  }
  return levels;
}

/** 节点所属分支与在分支内的序号 */
function locate(nodeId) {
  for (const branch of Object.values(PERK_BRANCHES)) {
    const idx = branch.nodes.findIndex((n) => n.id === nodeId);
    if (idx >= 0) return { branch, idx };
  }
  return null;
}

/**
 * 能否学习该节点（点数够、未学过、同支前置已学）。
 * @param {object} save 存档对象
 * @param {string} nodeId 节点 id
 * @returns {{ok: boolean, reason: string}}
 */
export function canLearn(save, nodeId) {
  const tree = save.tree || { xp: 0, level: 1, points: 0, nodes: [] };
  const at = locate(nodeId);
  if (!at) return { ok: false, reason: '节点不存在' };
  if (tree.nodes.includes(nodeId)) return { ok: false, reason: '已学习' };
  if ((tree.points || 0) <= 0) return { ok: false, reason: '没有可用点数' };
  if (at.idx > 0 && !tree.nodes.includes(at.branch.nodes[at.idx - 1].id)) {
    return { ok: false, reason: '需先学习前一个节点' };
  }
  return { ok: true, reason: '' };
}

/**
 * 学习节点：扣 1 点并把节点写入已学列表。
 * @param {object} save 存档对象
 * @param {string} nodeId 节点 id
 * @returns {boolean} 是否成功
 */
export function learnNode(save, nodeId) {
  if (!canLearn(save, nodeId).ok) return false;
  save.tree.points -= 1;
  save.tree.nodes.push(nodeId);
  return true;
}
