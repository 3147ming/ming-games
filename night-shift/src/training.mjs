/**
 * 员工培训树 —— 纯逻辑层（不 import three、不碰 DOM）
 *
 * ── 为什么单独成模块 ──────────────────────────────────────────────
 * 培训是"员工 × 节点 × 前置 × 价格 × 效果"的纯数据，和渲染、AI 调度都不该混在一起：
 *   · staff.mjs 只负责"什么时候该干活"（每帧 AI），它读 getBonuses() 拿倍率；
 *   · economy.mjs 只负责"夜末结算"，它读 staffNightOutput() 拿一份被动产出；
 *   · hud.mjs 只负责画，它读 snapshotFor() 拿节点状态与下一级价格。
 * 三处消费同一个真源，价格/效果就不会在某一处悄悄漂移。
 *
 * ── 为什么存档按 staffId 而不是 type ───────────────────────────────
 * 店员是"人"不是"岗位"：id 形如 `purchaser#1`，解雇后再雇会拿到新 id。
 * 按 id 存意味着"培训跟着这个人走"，与"雇一个人、练一个人"的语义一致；
 * 也避免未来同岗位可雇 2 人时，两个人的技能线被合并成一条。
 *
 * ── 数值口径（为什么这么定）──────────────────────────────────────
 * 1) 价格递增、总量克制：单条线 4 个节点共 ¥1400~¥1650，约等于该员工
 *    5~8 次发薪（60×2/夜 ≈ 120/夜）。玩家要"养"两三夜才点得起最后一级，
 *    但第一级（¥120~¥160）在雇完人后的当夜就能买 —— 先给一次即时正反馈，
 *    再让后续节点变成需要规划的投资，而不是"一口气全点满"。
 * 2) 效果只做"百分比小步 + 一个有感知的夜产出"：倍率类每级 15%~30%，
 *    叠满也不会把某条线压到 0（下面有 clamp 兜底）。夜产出（¥35~¥45）
 *    参照咖啡机升级的 +¥30/夜定档 —— 培训是更贵的长期投资，
 *    收益略高但不该让"买咖啡机"失去意义。
 * 3) 节点顺序按"先省成本/提速度，最后才给夜产出"：前三级改变的是
 *    玩家看得见的操作节奏（修得快、清得多、买得便宜），最后一级才是
 *    纯数字回报。这样每一次培训都能在当夜的操作里被感觉到。
 */

import { PICK_BATCH, SLOT_CAP } from './config.mjs';
import { fmtYuan } from './fmt.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * 各条线的兜底下限。
 * 为什么需要 clamp：节点效果是"可叠加的减免百分比"，如果未来有人加节点
 * （或手改存档塞进重复 id），累加后可能把倍率压到 0 甚至负数 ——
 * 维修免费、采购 0 成本会让整条经济曲线瞬间失效。下限保证任何改动都不会击穿平衡。
 */
export const TRAINING_LIMITS = {
  minRepairCostMul: 0.5,     // 维修费最多打 5 折
  minActionCdMul: 0.4,       // 行动冷却最多缩到 40%
  minPurchasePremiumMul: 0,  // 采购溢价最低可为 0（即按成本价进货）
  minErrandMul: 0.4,         // 外出往返最多缩到 40%
};

/**
 * 四条独立技能线。
 *
 * 节点字段：
 *   id       稳定 id（进存档；**一旦发布不要改**，改了等于老存档的技能丢失）
 *   name/desc 展示文案（desc 直接写"点完能感觉到什么"，不写内部字段名）
 *   cost     现金价格（游戏内金币）
 *   requires 前置节点 id 数组（逐级解锁；空数组 = 第一级）
 *   effect   纯数值增量，由 getBonuses() 聚合
 */
export const TRAINING_TREES = {
  /* ---------------- 维修员：省维修费 + 修得更快 + 少停摆 ---------------- */
  repairer: {
    title: '维修工坊',
    desc: '把"坏了等玩家来修"变成"故障刚冒头就被处理"',
    nodes: [
      {
        id: 'rep-toolkit', name: '顺手工具箱', cost: 150,
        desc: '维修费 -15%（工具齐全，不用临时买零件）',
        requires: [], effect: { repairCut: 0.15 },
      },
      {
        id: 'rep-drill', name: '快速拆装训练', cost: 280,
        desc: '行动冷却 -25%（拆一台机器的时间明显变短）',
        requires: ['rep-toolkit'], effect: { actionCut: 0.25 },
      },
      {
        id: 'rep-parts', name: '备件共享仓', cost: 450,
        desc: '维修费再 -15%（累计 -30%，常用备件提前囤好）',
        requires: ['rep-drill'], effect: { repairCut: 0.15 },
      },
      {
        id: 'rep-maintain', name: '预防性保养', cost: 700,
        desc: '每夜结算 +¥45（设备少停摆＝少漏掉的营业额）',
        requires: ['rep-parts'], effect: { nightOutput: 45 },
      },
    ],
  },

  /* ---------------- 保洁员：清得更快、一次清更多、店面更干净 ---------------- */
  cleaner: {
    title: '清洁规程',
    desc: '垃圾停留时间越短，顾客越愿意多待一会儿、多给小费',
    nodes: [
      {
        id: 'cln-cart', name: '分类清洁车', cost: 120,
        desc: '清洁冷却 -20%（工具就手，不用来回跑）',
        requires: [], effect: { actionCut: 0.20 },
      },
      {
        id: 'cln-route', name: '动线规划', cost: 240,
        desc: '每次多清 1 件垃圾（一趟能带走两件）',
        requires: ['cln-cart'], effect: { cleanExtra: 1 },
      },
      {
        id: 'cln-deep', name: '深度消毒', cost: 400,
        desc: '清洁冷却再 -20%（累计 -40%，打扫像开了加速）',
        requires: ['cln-route'], effect: { actionCut: 0.20 },
      },
      {
        id: 'cln-standard', name: '卫生标杆', cost: 620,
        desc: '每夜结算 +¥35（干净店面留住客人，多出来的成交）',
        requires: ['cln-deep'], effect: { nightOutput: 35 },
      },
    ],
  },

  /* ---------------- 采购员：进货更便宜、出门更快、少断货 ---------------- */
  purchaser: {
    title: '采购渠道',
    desc: '同样一批货，培训过的采购员能拿到底价',
    nodes: [
      {
        id: 'buy-channel', name: '熟客供货渠道', cost: 160,
        desc: '采购溢价 -30%（0.15 → 0.105）',
        requires: [], effect: { premiumCut: 0.30 },
      },
      {
        id: 'buy-route', name: '抄近路', cost: 300,
        desc: '外出采购往返 -25%（6s → 4.5s）',
        requires: ['buy-channel'], effect: { errandCut: 0.25 },
      },
      {
        id: 'buy-bulk', name: '整箱议价', cost: 480,
        desc: '采购溢价再 -30%（累计 -60%，0.15 → 0.06）',
        requires: ['buy-route'], effect: { premiumCut: 0.30 },
      },
      {
        id: 'buy-forecast', name: '库存预判', cost: 700,
        desc: '每夜结算 +¥40（该补的提前补上，少断货＝多成交）',
        requires: ['buy-bulk'], effect: { nightOutput: 40 },
      },
    ],
  },

  /* ---------------- 上货员：搬得更快、一次搬更多、每格补得更满 ---------------- */
  stocker: {
    title: '理货进阶',
    desc: '上货员的目标不是"搬过货"，而是"货架永远看起来是满的"',
    nodes: [
      {
        id: 'stk-scanner', name: '扫码盘点', cost: 140,
        desc: '补货冷却 -20%（扫一眼就知道该补哪格）',
        requires: [], effect: { actionCut: 0.20 },
      },
      {
        id: 'stk-stack', name: '立体码放', cost: 280,
        desc: '每次多搬 2 件（6 → 8 件/趟）',
        requires: ['stk-scanner'], effect: { restockExtra: 2 },
      },
      {
        id: 'stk-fefo', name: '先进先出', cost: 440,
        desc: '每格可补到满（员工软上限 80% → 100%）',
        requires: ['stk-stack'], effect: { restockCapExtra: SLOT_CAP },
      },
      {
        id: 'stk-ace', name: '金牌理货', cost: 680,
        desc: '每夜结算 +¥45（货架不缺货，顾客进来就能买到）',
        requires: ['stk-fefo'], effect: { nightOutput: 45 },
      },
    ],
  },
};

/** 展示顺序：与 STAFF.order 一致（维修 → 保洁 → 采购 → 上货） */
export const TRAINING_ORDER = ['repairer', 'cleaner', 'purchaser', 'stocker'];

/** 取某岗位的培训树（没有则 null） */
export function trainingTreeOf(type) {
  return TRAINING_TREES[type] ?? null;
}

/** 取某个节点定义（用于 UI / 测试） */
export function trainingNodeOf(type, nodeId) {
  return trainingTreeOf(type)?.nodes.find((n) => n.id === nodeId) ?? null;
}

/** 该员工已培训的节点 id 列表（永远返回新数组，调用方改它不会污染存档） */
export function trainingOf(save, staffId) {
  const raw = isObj(save?.training) ? save.training[staffId] : null;
  return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
}

/** 在 save 上找到员工；找不到返回 null（canTrain/train 据此给"未雇佣"） */
function staffOf(save, staffId) {
  return Array.isArray(save?.staff) ? (save.staff.find((s) => s.id === staffId) ?? null) : null;
}

/** 确保 save.training 是对象，并返回该员工的数组（惰性建键） */
function ensureList(save, staffId) {
  if (!isObj(save.training)) save.training = {};
  if (!Array.isArray(save.training[staffId])) save.training[staffId] = [];
  return save.training[staffId];
}

/**
 * 计算某员工当前累计加成。
 *
 * 返回对象是**纯数据**（可 JSON 化），既给 AI 读，也给 HUD 的详情页读。
 * 关键字段：
 *   repairCostMul        维修费倍率（0.5~1）
 *   actionCdMul          行动冷却倍率（0.4~1）
 *   purchasePremiumMul   采购溢价倍率（0~1）—— 乘在 WAREHOUSE.purchaserPremium 上
 *   errandMul            外出耗时倍率（0.4~1）
 *   cleanBatch           单次清洁件数（>=1）
 *   restockBatch         单次上货取件数（PICK_BATCH + 加成）
 *   restockCapBonus      每格软上限的额外件数（由 economy 自行 clamp 到 SLOT_CAP）
 *   nightOutput          该员工每夜结算产出（¥，未按上班状态过滤）
 *   level / maxLevel     已培训级数 / 该线总节点数
 *   trained              已培训节点 id（按培训顺序）
 */
export function getBonuses(save, staffId) {
  const staff = staffOf(save, staffId);
  const type = staff?.type ?? null;
  const tree = trainingTreeOf(type);
  const trained = trainingOf(save, staffId);

  let repairCut = 0;
  let actionCut = 0;
  let premiumCut = 0;
  let errandCut = 0;
  let cleanExtra = 0;
  let restockExtra = 0;
  let restockCapExtra = 0;
  let nightOutput = 0;
  const valid = [];

  if (tree) {
    for (const id of trained) {
      const node = tree.nodes.find((n) => n.id === id);
      if (!node) continue;                 // 旧档 / 手改档里的陌生 id：忽略，不崩
      if (valid.includes(id)) continue;    // 重复 id 只算一次，避免手改存档刷加成
      valid.push(id);
      const e = node.effect ?? {};
      repairCut += e.repairCut ?? 0;
      actionCut += e.actionCut ?? 0;
      premiumCut += e.premiumCut ?? 0;
      errandCut += e.errandCut ?? 0;
      cleanExtra += e.cleanExtra ?? 0;
      restockExtra += e.restockExtra ?? 0;
      restockCapExtra += e.restockCapExtra ?? 0;
      nightOutput += e.nightOutput ?? 0;
    }
  }

  return {
    staffId,
    type,
    title: tree?.title ?? '',
    level: valid.length,
    maxLevel: tree?.nodes.length ?? 0,
    trained: valid,
    /* 把原始减免量也带出去：UI 想写"-30%"时不必自己再反推 */
    effects: { repairCut, actionCut, premiumCut, errandCut, cleanExtra, restockExtra, restockCapExtra },
    repairCostMul: clamp(1 - repairCut, TRAINING_LIMITS.minRepairCostMul, 1),
    actionCdMul: clamp(1 - actionCut, TRAINING_LIMITS.minActionCdMul, 1),
    purchasePremiumMul: clamp(1 - premiumCut, TRAINING_LIMITS.minPurchasePremiumMul, 1),
    errandMul: clamp(1 - errandCut, TRAINING_LIMITS.minErrandMul, 1),
    cleanBatch: Math.max(1, 1 + cleanExtra),
    restockBatch: Math.max(1, PICK_BATCH + restockExtra),
    restockCapBonus: Math.max(0, restockCapExtra),
    nightOutput: Math.max(0, Math.round(nightOutput)),
  };
}

/**
 * 能否培训。
 * @returns {{ok:boolean, reason?:string, node?:object, cost?:number, level?:number}}
 *
 * 只读，不改任何状态 —— HUD 每次重绘都会对每个节点调一次，不能有副作用。
 */
export function canTrain(save, staffId, nodeId) {
  const staff = staffOf(save, staffId);
  if (!staff) return { ok: false, reason: '未找到该员工' };
  const tree = trainingTreeOf(staff.type);
  if (!tree) return { ok: false, reason: '该员工没有培训线' };
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, reason: '没有这条培训' };

  const trained = trainingOf(save, staffId);
  if (trained.includes(nodeId)) return { ok: false, reason: '已培训过' };

  for (const req of node.requires ?? []) {
    if (trained.includes(req)) continue;
    const reqName = tree.nodes.find((n) => n.id === req)?.name ?? req;
    return { ok: false, reason: `需先培训「${reqName}」` };
  }

  const cash = Number.isFinite(save.cash) ? save.cash : 0;
  if (cash < node.cost) return { ok: false, reason: `现金不足 · 需 ${fmtYuan(node.cost)}` };

  return { ok: true, node, cost: node.cost, level: trained.length + 1 };
}

/**
 * 执行培训：扣现金 + 记录节点。
 * 校验全在 canTrain 里，这里只负责"通过后落账"，避免两处各写一份规则。
 *
 * @returns {{ok:boolean, reason?:string, node?:object, cost?:number, level?:number, bonuses?:object}}
 */
export function train(save, staffId, nodeId) {
  const chk = canTrain(save, staffId, nodeId);
  if (!chk.ok) return chk;

  const list = ensureList(save, staffId);
  save.cash -= chk.cost;
  list.push(nodeId);

  return {
    ok: true,
    node: chk.node,
    cost: chk.cost,
    level: list.length,
    bonuses: getBonuses(save, staffId),
  };
}

/**
 * 员工培训详情快照（HUD 用）：当前等级、每个节点的解锁/可购买状态、下一级价格。
 * 返回纯数据；`nodes[i].canTrain` 只是在当前现金下的建议，真正下单时 train() 会重新校验。
 */
export function snapshotFor(save, staffId) {
  const staff = staffOf(save, staffId);
  const tree = trainingTreeOf(staff?.type);
  if (!staff || !tree) return null;

  const bonuses = getBonuses(save, staffId);
  const trained = bonuses.trained;

  return {
    staffId,
    type: staff.type,
    title: tree.title,
    desc: tree.desc,
    level: bonuses.level,
    maxLevel: bonuses.maxLevel,
    bonuses,
    nodes: tree.nodes.map((node) => {
      const unlocked = trained.includes(node.id);
      const chk = unlocked ? null : canTrain(save, staffId, node.id);
      return {
        id: node.id,
        name: node.name,
        desc: node.desc,
        cost: node.cost,
        requires: [...(node.requires ?? [])],
        unlocked,
        canTrain: !!chk?.ok,
        reason: chk?.reason ?? '',
      };
    }),
  };
}

/**
 * 全部**今夜上班**员工带来的夜末结算产出（¥）。
 *
 * 为什么在这里过滤 onDuty：培训是"人的能力"，但只有排了班才转化为营业额。
 * 这也让排班开关有了第二层意义（除了省薪资，还会关掉培训产出），
 * 与 staff.paySalary() 的 `onDuty !== false` 口径保持一致。
 *
 * 旧档/未培训：getBonuses 的 nightOutput 为 0，所以整函数返回 0，不改变既有平衡。
 */
export function staffNightOutput(save) {
  const list = Array.isArray(save?.staff) ? save.staff : [];
  let sum = 0;
  for (const m of list) {
    if (m?.onDuty === false) continue;
    sum += getBonuses(save, m.id).nightOutput;
  }
  return Math.max(0, Math.round(sum));
}
