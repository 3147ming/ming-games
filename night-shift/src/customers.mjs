/**
 * 顾客需求系统（SYS-03）
 * 生成 → 进店 → 走向货架取货 → 排队 → 等待结账 → 离开
 *
 * 升级点：
 * 1) 角色换成二次元风格模型（character.mjs），带走路 / 待机动作与朝向。
 * 2) 寻路从"直线冲刺"改为**多段路点**：门口 → 主通道 → 货架前 → 主通道 → 收银台 → 出门。
 *    之前顾客会从门口斜穿便利店墙体，现在沿通道走，不再穿墙穿货架。
 * 玩法逻辑（到货判定 / 排队耐心 / 失销 / 清理）与升级前完全一致。
 */
import * as THREE from 'three';
import {
  SEGMENTS, QUEUE_MAX, PATIENCE_SEC, GAME_HOURS,
  ELASTICITY_K, DEMAND_MUL_MIN, DEMAND_MUL_MAX, POS, STORE,
  EVENTS, NIGHT_WALL_SECONDS, REGULARS,
  IDENTITIES, IDENTITY_IDS, SKU_BY_ID,
} from './config.mjs';
import { state, notify } from './state.mjs';
import { sellable, availableSkus, removeFromQueue } from './economy.mjs';
import { PRICING } from './pricing.mjs';
import { resolveDrunkOutcome } from './clerk.mjs';
import { toast } from './hud.mjs';
import { COUNTER_POS, slotWorldPos } from './scene.mjs';
import { createCharacter } from './character.mjs';

  const CUSTOMER_SPEED = 1.9;
  /** 主通道（两排货架之间）的 x 坐标 */
  const AISLE_X = -2.8;
  /** 靠南的东西向通道 z */
  const SOUTH_LANE = STORE.maxZ - 1.0; // 4.0
  /** 到达路点的判定半径 */
  const WP_R = 0.28;

let nextId = 1;
let activeDrunk = null;   // 本地引用，独立于 state.events 的清空时机（夜末清场用）

/** 当前夜段（S1–S4） */
export function currentSegment(gameHour = state.gameHour) {
  return SEGMENTS.find((s) => gameHour >= s.from && gameHour < s.to) ?? SEGMENTS[SEGMENTS.length - 1];
}

/** 价格弹性：售价高于建议价 → 需求下降（SYS-03 §2） */
function demandMul(sku) {
  const price = state.prices[sku.id] ?? sku.price;
  const ratio = price / sku.price;
  const m = 1 - ELASTICITY_K * (ratio - 1);
  return Math.max(DEMAND_MUL_MIN, Math.min(DEMAND_MUL_MAX, m));
}

/** 按夜段偏好 × 价格弹性 抽一个 SKU；RUSH 时改用 EVENTS.RUSH.bias 上浮饮料/泡面（§4.2 修复） */
export function pickSku(seg) {
  const inRush = state.rushUntil !== null && state.wallElapsed < state.rushUntil;
  const bias = inRush ? EVENTS.RUSH.bias : (seg.bias ?? {});
  const list = availableSkus();
  const weights = list.map((s) => Math.max(0.01, (bias[s.id] ?? 0.2) * demandMul(s)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[0];
}

/* ---------- 块7：顾客身份 + 组合购买 ---------- */

/** 按当前夜段的 idWeights 抽一个身份（权重已归一化；缺省权重 1 兜底） */
export function pickIdentity(seg) {
  const w = IDENTITY_IDS.map((id) => Math.max(0.0001, seg.idWeights?.[id] ?? 1));
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < IDENTITY_IDS.length; i++) {
    r -= w[i];
    if (r <= 0) return IDENTITY_IDS[i];
  }
  return IDENTITY_IDS[0];
}

/** 从身份偏好池里抽一个 SKU（带价格弹性 × 时段偏好；促销期权重抬升）。
 *  @param allowFallback 池内全不可售时是否退化为 pickSku 单件（搭配件传 false 更严格） */
function pickPreferSku(preferList, seg, allowFallback = true) {
  const avail = availableSkus().filter((s) => preferList.includes(s.id));
  if (!avail.length) return allowFallback ? pickSku(seg) : null;
  /* 促销期：组合权重抬升（"促销品进组合权重提升"），只作用于抽取，不改定价 */
  const promoOn = state.promoUntil !== null && state.promoUntil !== undefined && state.wallElapsed < state.promoUntil;
  const boost = promoOn ? (PRICING?.promo?.comboBoost ?? 1.6) : 1;
  const weights = avail.map((s) => Math.max(0.01, (seg.bias?.[s.id] ?? 0.2) * demandMul(s) * boost));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < avail.length; i++) {
    r -= weights[i];
    if (r <= 0) return avail[i];
  }
  return avail[0];
}

/** 按身份组合率抽「主件 +（概率）搭配件」组成购物篮；不可售则回退单件 */
function buildCart(identityId, seg) {
  const id = IDENTITIES[identityId];
  if (!id) return null;
  const main = pickPreferSku(id.prefer, seg);
  if (!main) return null;
  const items = [{ skuId: main.id, qty: main.id === 'bento' ? 1 : 1 + Math.floor(Math.random() * 3) }];
  if (Math.random() < (id.comboRate ?? 0)) {
    const side = pickPreferSku(id.prefer.filter((p) => p !== main.id), seg, false);
    if (side) items.push({ skuId: side.id, qty: 1 });
  }
  return items;
}

/** 购物篮文案（结账 toast / 队列展示用）：「泡面 ×1 + 饮料 ×1」 */
export function comboLabel(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map((it) => `${SKU_BY_ID[it.skuId]?.name ?? it.skuId} ×${it.qty}`).join(' + ');
}

function queuePos(i) {
  return new THREE.Vector3(COUNTER_POS.x - 0.9 - i * 0.72, 0, COUNTER_POS.z - 1.0);
}

const v3 = (x, z) => new THREE.Vector3(x, 0, z);

/** 进店路线：门口 → 主通道 → 货架前 */
function routeToShelf(slotIdx) {
  const p = slotWorldPos(slotIdx);
  const front = v3(p.x + 0.95, p.z);
  return [v3(POS.doorIn.x, POS.doorIn.z), v3(AISLE_X, SOUTH_LANE), v3(AISLE_X, p.z), front];
}

/** 前往收银台：货架前 → 主通道 → 队列位 */
function routeToQueue(z) {
  return [v3(AISLE_X, z), v3(AISLE_X, SOUTH_LANE), v3(POS.doorIn.x, SOUTH_LANE)];
}

/** 离店路线：回到主通道 → 门口 → 广场（导出给单测复用同一份定义） */
export function routeToExit(z) {
  return [
    v3(AISLE_X, z),
    v3(AISLE_X, SOUTH_LANE),
    v3(POS.doorIn.x, POS.doorIn.z),
    v3(POS.doorOut.x, POS.doorOut.z),
  ];
}

/** 门口判定半径（清场用：走到这一圈内就摘 mesh 出列） */
const DOOR_REACH = 0.9;

/**
 * ★ leaving 顾客的离店路线保障 —— "结账后顾客不走、堆在收银台前"的根治点。
 *
 * 原 bug：结账成功只写了 c.phase = 'leaving'，没有给路线（失销路径 loseCustomer 才有
 * routeToExit）。而 update 末尾的清场条件只看「leaving 且走到门口」，顾客原地不动
 * → 永远不满足 → 结账完的人永久钉在收银台前，后面排队的人再挤到同一格 → 视觉重叠。
 *
 * 为什么做成 customers.mjs 的函数而不是往 economy.checkout() 里塞两行：
 *   ① 路线是 THREE.Vector3 的数组，属于表现层资源 —— economy 是纯逻辑层（ADR-002）不该碰；
 *   ② 放在这里 = **所有**切 leaving 的路径（结账 / 失销 / 队列满 / 将来新增）共用同一道
 *      保险，不会再漏第二个 checkout；
 *   ③ 纯函数、可单测（不需要真的生成角色模型）。
 *
 * 每帧调用一次。返回 true 表示这一帧（重新）排了路线，便于断言。
 */
export function ensureLeavingRoute(c) {
  if (!c || c.phase !== 'leaving') return false;
  const z = c.mesh?.position?.z ?? 0;
  const finished = !Array.isArray(c.route) || c.routeIdx >= c.route.length;
  const nearDoor = Math.abs(z - POS.doorOut.z) <= 1.2;
  /* 只有两种情形需要排线：
   *   ① 刚切成 leaving（exitRouted 还没标过）—— 包括 checkout() 那条漏了的路
   *   ② 路线已走完却还没走到门口（路线被中途改写过 / 被醉汉挤偏）→ 重排一次
   * 其余情况一律不动：否则会在门口把 routeIdx 反复归零，人永远出不去。 */
  if (c.exitRouted && !(finished && !nearDoor)) return false;
  c.route = routeToExit(z);
  c.routeIdx = 0;
  c.exitRouted = true;
  return true;
}

/** 是否已走到门口（更新末尾据此把顾客摘出场景） */
export function reachedDoor(pos) {
  if (!pos) return false;
  return pos.z >= POS.doorOut.z - 0.5
    || Math.hypot(pos.x - POS.doorOut.x, pos.z - POS.doorOut.z) <= DOOR_REACH;
}

export function createCustomers(scene, opts = {}) {
  /** 常客识别钩子（模块 4 注入；缺省 null = 不识别熟客）。
   *  返回 { regular, name, emoji, tag }；调用即登记"该脸今夜到店"。 */
  const regularJudge = typeof opts.regularJudge === 'function' ? opts.regularJudge : null;
  /** 稳定脸谱池大小（见 config.REGULARS.rosterSize 注释）：保证同一张脸跨夜反复出现 */
  const rosterSize = Math.max(4, opts.regularRosterSize ?? REGULARS.rosterSize);

  /** 预定今日到达时刻（按夜段权重分布） */
  function buildSchedule(total) {
    const segWeightSum = SEGMENTS.reduce((a, s) => a + s.weight * 2, 0); // 每段 2 游戏小时
    const times = [];
    for (const seg of SEGMENTS) {
      const n = Math.max(0, Math.round((total * (seg.weight * 2)) / segWeightSum));
      for (let k = 0; k < n; k++) {
        const t = (seg.from + Math.random() * (seg.to - seg.from)) / GAME_HOURS; // 0..1
        times.push(t);
      }
    }
    return times.sort((a, b) => a - b);
  }

  let schedule = [];
  let schedIdx = 0;
  let rushSpawnAcc = 0; // RUSH 期间额外到店的累计计时
  let promoAcc = 0;     // 限时促销期间额外到店的累计计时

  function resetForNight() {
    for (const c of state.customers) if (c.mesh) scene.remove(c.mesh);
    if (activeDrunk && activeDrunk.mesh) scene.remove(activeDrunk.mesh);
    activeDrunk = null;
    rushSpawnAcc = 0;
    promoAcc = 0;
    state.customers = [];
    state.queue = [];
    state.spawnedTonight = 0;
    schedule = buildSchedule(state.arrivalsTarget);
    schedIdx = 0;
    notify();
  }

  /** 造一个顾客（普通 / 常客共用），进店站位与动线一致
   *  @param items       购物篮 [{skuId, qty}, ...]（块7：组合购买；无组合时长度 1）
   *  @param identityId  身份 id（块7），决定外观 / 消费倍率 / 耐心
   *  @param opts        { isRegular, faceId, regularName, regularTag } */
  function makeCustomer(items, identityId, opts = {}) {
    const id = IDENTITIES[identityId] ?? null;
    const look = (id && id.look) || {};   // 块7：身份专属外观（帽子/黑眼圈/脸红/书包/公文包）
    const char = createCharacter({ seed: Math.random(), ...look });
    const mesh = char.group;
    // 从店外广场进店
    mesh.position.set(POS.doorOut.x + (Math.random() - 0.5) * 1.0, 0, POS.doorOut.z);
    scene.add(mesh);

    // 找第一件 SKU 有货的货架格（没有就随便挑一格，到了再判失销）
    let targetIdx = state.slots.findIndex((s) => s.skuId === items[0].skuId && s.qty > 0);
    if (targetIdx < 0) targetIdx = 0;

    const c = {
      id: nextId++,
      mesh,
      char,
      skuId: items[0].skuId,   // 向后兼容：第一件（checkout / HUD 读取）
      qty: items[0].qty,
      items,                   // 块7：购物篮（组合购买）
      identityId: identityId ?? null,
      isRegular: !!opts.isRegular,
      /** 模块 4 常客：稳定脸谱 id（从固定池取，跨夜可复现）与展示信息 */
      faceId: opts.faceId ?? null,
      regularName: opts.regularName ?? null,
      regularTag: opts.regularTag ?? null,
      phase: 'toShelf', // toShelf → toQueue → leaving
      route: routeToShelf(targetIdx),
      routeIdx: 0,
      target: new THREE.Vector3(),
      patience: PATIENCE_SEC * (id?.patienceMul ?? 1), // 块7：身份耐心系数
      taken: false,
      /** 情绪反馈（需求）：'happy' 成交 / 'angry' 失销；moodT 为剩余显示秒数 */
      mood: null,
      moodT: 0,
    };
    state.customers.push(c);
    state.spawnedTonight += 1;
    notify();
    return c;
  }

  function spawn() {
    const seg = currentSegment();
    // 块7：先按夜段身份分布抽一个身份，再交给 regularJudge（常客会固化该身份）
    let identityId = pickIdentity(seg);
    let ropts = {};
    if (regularJudge) {
      const faceId = `F${Math.floor(Math.random() * rosterSize)}`;
      const r = regularJudge(faceId, identityId);
      if (r) {
        // 常客身份固化：以 regulars 返回的 identityId 为准（跨夜不变，与忠诚度共存）
        identityId = r.identityId ?? identityId;
        if (r.regular) ropts = { isRegular: true, faceId, regularName: r.name, regularTag: r.tag };
        else ropts = { faceId, regularName: r.name, regularTag: null };
      }
    }
    let items = buildCart(identityId, seg);
    if (!items) {
      // 极端兜底：偏好池全不可售且 fallback 失败 → 退化为单件随机 SKU
      const sku = pickSku(seg);
      items = [{ skuId: sku.id, qty: sku.id === 'bento' ? 1 : 1 + Math.floor(Math.random() * 3) }];
    }
    const c = makeCustomer(items, identityId, ropts);
    const idName = IDENTITIES[c.identityId]?.name ?? '';
    if (c.regularTag) toast(`⭐ ${c.regularName}（${c.regularTag}客·${idName}）来了 · 要 ${comboLabel(c.items)}`, 'ok');
    return c;
  }

  /** 常客（§4.4）：带身份 + 组合篮，量大（主件 2–3）；成交 rep+1 + 10% 小费 */
  function spawnRegular() {
    const seg = currentSegment();
    const identityId = pickIdentity(seg);
    let items = buildCart(identityId, seg);
    if (!items) {
      const sku = pickSku(seg);
      items = [{ skuId: sku.id, qty: 2 + Math.floor(Math.random() * 2) }];
    }
    return makeCustomer(items, identityId, { isRegular: true });
  }

  /** 块7 探针专用：造一个指定身份（可显式指定购物篮）的顾客，便于端到端验收
   * 身份外观 / 组合结账。不登记常客、不走随机身份分布；items 不传则按身份组合率生成。 */
  function spawnAs(identityId, opts = {}) {
    const seg = currentSegment();
    const items = (Array.isArray(opts.items) && opts.items.length)
      ? opts.items
      : (buildCart(identityId, seg) || [{ skuId: pickSku(seg).id, qty: 1 }]);
    return makeCustomer(items, identityId, opts);
  }

  /** 醉汉（§4.3）：红衣游荡 NPC 堵通道口；同一时刻只一个 */
  function spawnDrunk() {
    if (activeDrunk) return null;
    const char = createCharacter({ seed: 0.7, cloth: 0xE05A5A });
    const mesh = char.group;
    const x = AISLE_X;
    const z = SOUTH_LANE + 0.4;
    mesh.position.set(x, 0, z);
    mesh.rotation.y = Math.PI; // 面朝店里
    mesh.userData = { interact: 'drunk' }; // 供 interaction.mjs 锥选命中（HANDLE_EVENT 高优先）
    scene.add(mesh);
    activeDrunk = {
      id: nextId++,
      mesh, char,
      phase: 'loitering',
      x, z,
      spawnedAt: state.wallElapsed,
      wanderT: 0,
      targetX: x, targetZ: z,
    };
    state.events.drunk = activeDrunk;
    notify();
    return activeDrunk;
  }

  /** 移除醉汉（离店 / 超时 / 夜末清场） */
  function removeDrunk(d) {
    if (d && d.mesh) scene.remove(d.mesh);
    if (state.events.drunk === d) state.events.drunk = null;
    if (activeDrunk === d) activeDrunk = null;
    notify();
  }

  /** 顾客空手离开（失销） */
  function loseCustomer(c, reason) {
    if (c.phase === 'leaving') return;
    removeFromQueue(c.id);
    c.phase = 'leaving';
    c.mood = 'angry';      // 需求「不满冒红色生气脸」
    c.moodT = 2.6;
    c.route = routeToExit(c.mesh.position.z);
    c.routeIdx = 0;
    state.lostSales += 1;
    state.reputation = Math.max(0, state.reputation - 1);
    // §1.2 失销 → 心理 −0.4（每笔）
    if (state.clerk) state.clerk.mental = Math.max(0, Math.min(100, state.clerk.mental - 0.4));
    notify();
    void reason;
  }

  const tmp = new THREE.Vector3();

  function update(dt) {
    if (state.phase !== 'running' || state.paused) return;

    /* 情绪计时衰减（需求：结账满意/不满的头顶图标只闪一下）。
     * 纯表现字段，不参与任何玩法判定 —— 放在这里只因为它随顾客生命周期走。 */
    for (const c of state.customers) {
      if (c.moodT > 0) {
        c.moodT -= dt;
        if (c.moodT <= 0) c.mood = null;
      }
    }

    /* 到达调度：按 gameHour 比例生成 */
    while (
      schedIdx < schedule.length &&
      schedule[schedIdx] <= state.gameHour / GAME_HOURS &&
      state.spawnedTonight < state.arrivalsTarget
    ) {
      schedIdx += 1;
      spawn();
    }

    /* RUSH 修复（§4.2）：rushUntil 内存活时额外到店，整体约 ×1.8 */
    const inRush = state.rushUntil !== null && state.wallElapsed < state.rushUntil;
    if (inRush) {
      rushSpawnAcc += dt;
      const baseInterval = NIGHT_WALL_SECONDS / Math.max(1, state.arrivalsTarget);
      const rushInterval = baseInterval / Math.max(0.2, EVENTS.RUSH.mult - 1);
      while (rushSpawnAcc >= rushInterval) {
        rushSpawnAcc -= rushInterval;
        if (state.customers.length < 40) spawn();
      }
    } else {
      rushSpawnAcc = 0;
    }

    /* 限时促销（2026-10-05 重做：拉客型）：促销期内购物顾客持续额外到店。
     * 只读 state.promoUntil（pricing.mjs 写入），开促销立刻送一波（wave 在 main 的
     * spawnWave 处理），这一节负责"持续引流"，倍率来自 PRICING.promo.trafficMul。 */
    const inPromo = state.promoUntil !== null && state.promoUntil !== undefined && state.wallElapsed < state.promoUntil;
    if (inPromo) {
      promoAcc += dt;
      const baseInterval = NIGHT_WALL_SECONDS / Math.max(1, state.arrivalsTarget);
      const promoInterval = baseInterval / Math.max(0.2, (PRICING?.promo?.trafficMul ?? 2.2) - 1);
      while (promoAcc >= promoInterval) {
        promoAcc -= promoInterval;
        if (state.customers.length < 40) spawn();
      }
    } else {
      promoAcc = 0;
    }

    for (const c of state.customers) {
      const p = c.mesh.position;

      // 排队中：队列位会随前面的人结账而前移，直接动态赋值
      if (c.phase === 'toQueue') {
        const qi = state.queue.indexOf(c.id);
        if (qi >= 0) {
          c.route = [queuePos(qi)]; // 已从通道进入，直线微调即可
          c.routeIdx = 0;
        }
      }

      // leaving 的离店路线统一在这里兜底（详见 ensureLeavingRoute 的注释）
      ensureLeavingRoute(c);

      /* 沿路点移动 */
      let moving = false;
      const wp = c.route[c.routeIdx];
      if (wp) {
        tmp.set(wp.x - p.x, 0, wp.z - p.z);
        const dist = tmp.length();
        if (dist > WP_R) {
          tmp.normalize();
          p.x += tmp.x * CUSTOMER_SPEED * dt;
          p.z += tmp.z * CUSTOMER_SPEED * dt;
          c.char.update(dt, true, Math.atan2(tmp.x, tmp.z));
          moving = true;
        } else {
          c.routeIdx += 1;
        }
      }
      if (!moving) c.char.update(dt, false, null);

      const arrived = c.routeIdx >= c.route.length;

      if (c.phase === 'toShelf' && arrived) {
        // 到货架：逐件核对在架库存，只保留能买到的（搭配件缺货就丢弃，不强制失销）
        const buyable = (c.items || [{ skuId: c.skuId, qty: c.qty }])
          .filter((it) => sellable(it.skuId) >= it.qty);
        if (buyable.length === 0) {
          loseCustomer(c, 'out-of-stock');
        } else {
          c.taken = true;
          c.items = buyable;
          c.skuId = buyable[0].skuId;   // 同步第一件（向后兼容）
          c.qty = buyable[0].qty;
          if (state.queue.length >= QUEUE_MAX) {
            loseCustomer(c, 'queue-full');
          } else {
            c.phase = 'toQueue';
            state.queue.push(c.id);
            c.route = routeToQueue(p.z);
            c.routeIdx = 0;
            notify();
          }
        }
      } else if (c.phase === 'toQueue') {
        // 排队耐心（停电时加速流失，SYS-03 §2）
        const blackout = state.blackoutUntil !== null && state.wallElapsed < state.blackoutUntil;
        c.patience -= dt * (blackout ? 2 : 1);
        if (c.patience <= 0) loseCustomer(c, 'impatient');
      }
    }

    /* 醉汉游荡（§4.3）：在通道口附近随机游走，堵通道 */
    const dk = state.events?.drunk;
    if (dk && dk.phase === 'loitering') {
      dk.wanderT -= dt;
      if (dk.wanderT <= 0) {
        dk.wanderT = 1.2 + Math.random() * 1.6;
        dk.targetX = AISLE_X + (Math.random() - 0.5) * 1.2;
        dk.targetZ = SOUTH_LANE + 0.2 + Math.random() * 1.0;
      }
      const ddx = dk.targetX - dk.x;
      const ddz = dk.targetZ - dk.z;
      const dd = Math.hypot(ddx, ddz);
      if (dd > 0.05) {
        const step = Math.min(dd, 0.8 * dt);
        dk.x += (ddx / dd) * step;
        dk.z += (ddz / dd) * step;
        dk.mesh.position.set(dk.x, 0, dk.z);
        dk.char.update(dt, true, Math.atan2(ddx, ddz));
      } else {
        dk.char.update(dt, false, null);
      }

      // 超时未处理（§4.3 / §8.3）：rep−5、mental−5、醉汉离店
      if (state.wallElapsed - dk.spawnedAt > EVENTS.DRUNK.timeout) {
        resolveDrunkOutcome(state, false);
        removeDrunk(dk);
        toast('🍺 醉汉闹事太久，离店（口碑 −5 · 心理 −5）', 'bad');
      }
    }

    /* 清理已离店的顾客：走到门口就摘 mesh + 出列。
     * 判据用"到 doorOut 的距离"而不是只比 z —— 顾客可能在广场外侧偏着走
     * （z 已过线但 x 还偏），只看 z 会留下半只脚在店里的人。 */
    for (let i = state.customers.length - 1; i >= 0; i--) {
      const c = state.customers[i];
      if (c.phase === 'leaving' && reachedDoor(c.mesh.position)) {
        scene.remove(c.mesh);
        state.customers.splice(i, 1);
      }
    }
  }

  return { update, resetForNight, currentSegment, spawn, spawnDrunk, spawnRegular, spawnAs, removeDrunk };
}
