/**
 * 交互系统（SYS-06）
 * hover 提示 + E 触发 + 前置校验 + 动作时长锁定（BUSY）
 *
 * 选取方式：视野锥 + 距离（config.PICK），不用单条射线。
 * 原因：单射线要求准星像素级命中盒体，玩家稍偏一点就打不中，
 * 表现为"明明站在货架前却提示要靠近"。锥选只需大致对着即可。
 */
import * as THREE from 'three';
import { REACH, ACTION_DURATIONS, SKU_BY_ID, SLOT_CAP, PICK_BATCH, PICK, SNACK, CLERK, EVENTS } from './config.mjs';
import { state, notify } from './state.mjs';
import { take, place, checkout, purchaseSnack, returnHeld, clearanceSell } from './economy.mjs';
import { FACILITY_BY_ID, facilityCost } from './facilities.mjs';
import { drunkSuccessChance, resolveDrunkOutcome, applyActionCost } from './clerk.mjs';
import { fmtYuan } from './fmt.mjs';

export function createInteraction({
  camera, anchors, onFacility, getDrunk, onDrunk,
  /* 需求④ 维修 / 需求⑤ 清洁：本模块不持有 worldstate，
     由 main 注入查询与执行回调，保持"交互只做判定与转发"的边界。 */
  getDeviceState, onRepair, onClean,
  /* QTE：玩家亲手做维修/清洁/上货时，改走迷你小游戏（更快更便宜）。
     onQteRepair(facilityId) / onQteClean(litterId) / onQteRestock(slotIndex)
     未注入时回退到原逻辑（立即完成 + BUSY），行为与扩展前完全一致。 */
  onQteRepair, onQteClean, onQteRestock,
  /* 需求I 第③条 道具：selectedItem() 取当前选中的道具定义；
     onUseItem(itemId, hover) 由 main 执行效果（成功才消耗，见 items.consume）。
     nearbyLitterCount() 用于"清洁喷雾"的提示文案。 */
  selectedItem, onUseItem, nearbyLitterCount,
  /* 需求I 第⑦条：售货机收款（无需小游戏面板，由 main 直接结算） */
  onVending,
  /* 环境互动（深夜猫 / 外卖员 / 老电视）：
     ambientHint(id) → { ok, prompt } | null（对象没出现时返回 null → 不提示）
     onAmbient(id)   → 按 E 时的执行入口（由 main 落地） */
  ambientHint, onAmbient,
  deliveryHint,   // 块5：() => delivery.panel()（由 main 注入）
  onDelivery,     // 块5：(action, arg) => {ok,...}（由 main 落地到 delivery 模块）
}) {
  const targets = [
    ...anchors.slots, anchors.counter, anchors.crate,
    ...(anchors.facilities ?? []), ...(anchors.stalls ?? []),
    /* 门口货箱（块5）：空数组也没关系（老存档/未到货时是空的）。
     * 货箱的 Group 本身是 visible=false 时，锥选靠 mesh 的可见性过滤，
     * 所以隐藏的箱子不会误触发"按 E 拾取"。 */
    ...(anchors.delivery ?? []),
  ];

  // 复用的临时对象（避免每帧分配）
  const camPos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const dir3 = new THREE.Vector3();
  const center = new THREE.Vector3();
  const box = new THREE.Box3();

  let lastNearest = null; // 诊断用：最近目标

  function targetName(ud) {
    if (!ud) return '—';
    if (ud.interact === 'place') return `货架#${ud.slotIndex}`;
    if (ud.interact === 'checkout') return '收银台';
    if (ud.interact === 'take') return '库存箱';
    if (ud.interact === 'delivery') return '货箱';   // 块5
    if (ud.interact === 'facility') return `设施#${ud.facilityId}`;
    if (ud.interact === 'litter') return `垃圾#${ud.litterId}`;
    if (ud.interact === 'ambient') return `环境#${ud.ambientId}`;
    return '?';
  }

  /** 在视野锥内挑最优目标；返回 mesh 或 null */
  function pick() {
    camera.updateMatrixWorld(); // player 刚改过姿态，必须刷新再取方向
    camPos.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(fwd);

    const cosLimit = Math.cos((PICK.maxAngleDeg * Math.PI) / 180);
    const maxDist = REACH + PICK.distPad;

    let best = null;
    let bestScore = Infinity;
    let bestDist = Infinity;

    // 动态目标：醉汉是当前活动 NPC 时一并参与锥选（HANDLE_EVENT 高优先，玩家面朝即选中）
    const list = targets.slice();
    const dk = typeof getDrunk === 'function' ? getDrunk() : null;
    if (dk && dk.mesh) list.push(dk.mesh);
    // 垃圾是运行时生成的，不能写死在 targets 里 —— 每帧从场景池取当前**可见**的那些
    if (Array.isArray(anchors.litter)) {
      for (const m of anchors.litter) if (m.visible) list.push(m);
    }
    /* 环境互动对象（猫 / 外卖员 / 电视）：判定盒挂在 group 下，
     * group.visible=false 时该对象"不在场"，必须跳过 —— 否则会隔空摸到一只不存在的猫。 */
    if (Array.isArray(anchors.ambient)) {
      for (const m of anchors.ambient) if (!m.parent || m.parent.visible) list.push(m);
    }

    for (const t of list) {
      /* 块5：隐藏的门口货箱（Group.visible=false）不参与锥选 ——
       * 否则玩家会隔空选中一个"看不见的箱子"（甚至抢走可见箱的候选）。 */
      if (t.userData?.interact === 'delivery' && !t.visible) continue;
      box.setFromObject(t);
      box.getCenter(center);
      /* 距离与锥选都按**水平**为主：低矮目标（货箱/垃圾）中心比眼高矮，
       * 平视贴脸时 3D 仰角会超过 34° 锥而被过滤 —— 表现为"走到跟前却交互不了"。
       * 水平距离 + 水平锥解决贴脸；低头看箱子时再取 3D 点积兜底（两个真实姿态都覆盖）。 */
      const centerY3d = center.y;
      center.y = camPos.y;
      const dist = center.distanceTo(camPos);
      if (dist > maxDist) continue;

      dir.copy(center).sub(camPos);
      if (dist > 1e-4) dir.divideScalar(dist);
      const dotH = dir.dot(fwd);
      dir3.copy(center).setY(centerY3d).sub(camPos);
      const d3 = dir3.length();
      if (d3 > 1e-4) dir3.divideScalar(d3);
      const dot3 = dir3.dot(fwd);
      const dot = dotH > dot3 ? dotH : dot3;
      if (dot < cosLimit) continue; // 不在视野锥内

      const score = dist - dot * PICK.aimWeight;
      if (score < bestScore) {
        bestScore = score;
        best = t;
        bestDist = dist;
      }
    }

    lastNearest = best ? { name: targetName(best.userData), dist: bestDist } : null;
    return best;
  }

  /**
   * 需求I 第③条：选中的道具**优先于**普通交互。
   * 玩家在背包里选中了道具，按 E 就是"用道具"，而不是"取货/上货" ——
   * 否则选中了维修包走到故障机前按 E，会弹出一堆无关提示，玩家不知道该看哪个。
   *
   * @param item 道具定义（CONSUMABLE_BY_ID 的条目）
   * @param ud   当前对准物的 userData（可为 null —— 喷雾/海报不需要目标）
   */
  function describeItem(item, ud) {
    if (!item) return null;
    if (item.id === 'spray') {
      const n = typeof nearbyLitterCount === 'function' ? nearbyLitterCount() : 0;
      return {
        type: 'useItem', ok: true, itemId: 'spray',
        prompt: n > 0 ? `🧴 使用清洁喷雾 · 清除附近 ${n} 件垃圾` : '🧴 附近没有垃圾 · 用了会浪费',
        ref: ud,
      };
    }
    if (item.id === 'poster') {
      return {
        type: 'useItem', ok: true, itemId: 'poster',
        prompt: `📣 张贴人气海报 · ${item.durationSec ?? 60}s 内客流提升`,
        ref: ud,
      };
    }
    if (item.id === 'repairkit') {
      // 维修包**需要目标**：必须对准一台正在故障的设备
      const fid = ud?.interact === 'facility' ? ud.facilityId : null;
      if (!fid) {
        return { type: 'useItem', ok: false, itemId: 'repairkit', prompt: '🧰 请对准一台故障设备', ref: ud };
      }
      const dev = typeof getDeviceState === 'function' ? getDeviceState(fid) : null;
      const fac = FACILITY_BY_ID[fid];
      if (!dev?.broken) {
        return {
          type: 'useItem', ok: false, itemId: 'repairkit', facilityId: fid,
          prompt: `${fac?.name ?? '这台设备'}没坏 · 不用修`, ref: ud,
        };
      }
      return {
        type: 'useItem', ok: true, itemId: 'repairkit', facilityId: fid,
        prompt: `🧰 用快速维修包修好 ${fac?.emoji ?? ''}${fac?.name ?? '设备'}`, ref: ud,
      };
    }
    return null;
  }

  /** 计算 hover 提示与是否可执行（SYS-06 §2） */
  function describe(ud) {
    if (!ud) return null;

    // 道具优先（见 describeItem 的说明）
    const item = typeof selectedItem === 'function' ? selectedItem() : null;
    if (item) {
      const h = describeItem(item, ud);
      if (h) return h;
    }

    /* 门口货箱（块5）：按 E 拾取。
     * 手里已经有箱子时不能重复拾取 —— 否则会覆盖掉手上那箱，白丢货。 */
    if (ud.interact === 'delivery') {
      const dlv = typeof deliveryHint === 'function' ? deliveryHint() : null;
      if (!dlv) return null;                     // 没有货在门口（理论上 hit 不可见时才这样）
      if (dlv.held) return { type: 'delivery', ok: false, prompt: '手里已有箱子 · 先放到库存箱', ref: ud };
      if (!dlv.crates?.length) return null;
      const total = dlv.crates[0]?.total ?? 0;
      return { type: 'delivery', ok: true, crateIndex: ud.crateIndex ?? 0,
        prompt: `拾取货箱 · 共 ${total} 件`, ref: ud };
    }

    if (ud.interact === 'take') {
      /* 手里是**到货箱**时（块5）：对库存箱按 E = 整箱入仓。
       * 放在 state.held 分支之前 —— 两者是互斥的两种"手上东西"，
       * 用不同的状态字段（delivery.held vs held），不冲突。 */
      if (typeof deliveryHint === 'function' && deliveryHint()?.held) {
        const dlv = deliveryHint();
        return { type: 'deliveryPut', ok: true, prompt: `入仓整箱 · 共 ${dlv.held.total} 件`, ref: ud };
      }
      if (state.held) {
        /* 手里有货时对库存箱 = "放回"（与取货严格对称）。
         * 这条出口是必需的：货架被顶满时 place() 会失败，没有它就只能把货攥到天亮，
         * 打烊结算时那批货既不算售出也不算报废，等于凭空消失。 */
        const hsku = SKU_BY_ID[state.held.skuId];
        return {
          type: 'returnHeld', ok: true,
          prompt: `放回库存箱 ${hsku.emoji}×${state.held.qty}`, ref: ud,
        };
      }
      const skuId = Object.keys(state.backroom).find((id) => state.backroom[id] > 0);
      if (!skuId) {
        return { type: 'take', ok: false, prompt: '库存箱已空 · 按 Tab 采购', ref: ud };
      }
      const sku = SKU_BY_ID[skuId];
      const q = Math.min(PICK_BATCH, state.backroom[skuId]);
      return { type: 'take', ok: true, prompt: `取货 ${sku.emoji}×${q}`, ref: ud };
    }

    if (ud.interact === 'place') {
      const i = ud.slotIndex;
      const slot = state.slots[i];
      /* 2026-10-05 临期货清仓：空手对准今夜到期的货架 → 半价清仓（玩家主动止损）。
       * 放在手持分支之前：清仓是空手动作，手持时保持原上货/放回逻辑。 */
      if (!state.held && slot && slot.skuId && slot.qty > 0 && slot.expiryNight <= state.night) {
        const sku = SKU_BY_ID[slot.skuId];
        const unit = state.prices?.[slot.skuId] ?? sku.price;
        const amount = Math.round(slot.qty * unit * 0.5 * 100) / 100;
        return {
          type: 'clearance', ok: true, slotIndex: i,
          prompt: `清仓 ${sku.emoji}×${slot.qty} 半价 ${fmtYuan(amount)}`, ref: ud,
        };
      }
      if (!state.held) {
        return { type: 'place', ok: false, prompt: '手上没有货物 · 先去库存箱取货', ref: ud, slotIndex: i };
      }
      if (slot && slot.skuId && slot.skuId !== state.held.skuId) {
        return { type: 'place', ok: false, prompt: '该格已有其他商品', ref: ud, slotIndex: i };
      }
      if (slot && slot.qty >= SLOT_CAP) {
        // 给明确出路（同 economy.place 的失败文案）：满格时直接告诉玩家"去库存箱放回"
        return { type: 'place', ok: false, prompt: '货架已满，对准库存箱按 E 放回', ref: ud, slotIndex: i };
      }
      const sku = SKU_BY_ID[state.held.skuId];
      return {
        type: 'place', ok: true, slotIndex: i,
        prompt: `上货 ${sku.emoji}×${state.held.qty}`, ref: ud,
      };
    }

    if (ud.interact === 'checkout') {
      const blackout = state.blackoutUntil !== null && state.wallElapsed < state.blackoutUntil;
      if (blackout) {
        return { type: 'checkout', ok: false, prompt: '⚡ 停电中，无法结账', ref: ud };
      }
      /* 手持不能收银（economy.checkout 同样会拒）：提示里直接给出解法，
       * 免得玩家拿着货对着收银台一直按 E 却不知道为什么没反应。 */
      if (state.held) {
        return { type: 'checkout', ok: false, prompt: '手上有货 · 对准库存箱按 E 放回后再结账', ref: ud };
      }
      const headId = state.queue[0];
      const head = state.customers.find((c) => c.id === headId);
      if (!head) {
        return { type: 'checkout', ok: false, prompt: '没有等待结账的顾客', ref: ud };
      }
      const sku = SKU_BY_ID[head.skuId];
      const unit = state.prices[head.skuId] ?? sku.price;
      return {
        type: 'checkout', ok: true,
        prompt: `结账 ${sku.emoji}×${head.qty} ${fmtYuan(unit * head.qty)}`, ref: ud,
      };
    }

    if (ud.interact === 'ambient') {
      const h = typeof ambientHint === 'function' ? ambientHint(ud.ambientId) : null;
      if (!h) return null;   // 对象当前不在场（猫没来 / 外卖员没上门）→ 当作没有这个东西
      return { type: 'ambient', ok: h.ok !== false, ambientId: ud.ambientId, prompt: h.prompt, ref: ud };
    }

    if (ud.interact === 'facility') {
      const fac = FACILITY_BY_ID[ud.facilityId];
      if (!fac) return null;
      if (state.held) {
        return { type: 'facility', ok: false, facilityId: fac.id, prompt: '先放下手中的货物', ref: ud };
      }

      /* 需求I 第⑥条：停电期间全部设备停工 —— 游玩/维修都不可用，
       * 但提示要说明原因，否则玩家会以为机器坏了、白跑一趟。 */
      const powerOut = state.powerOutUntil != null && state.wallElapsed < state.powerOutUntil;
      if (powerOut) {
        return {
          type: 'facility', ok: false, facilityId: fac.id,
          prompt: '⚡ 停电中 · 设备暂停工作', ref: ud,
        };
      }

      /* 需求I 第⑦条：售货机 —— 不走小游戏面板，按 E 直接收一笔货款 */
      if (fac.kind === 'vending') {
        if (state.held) {
          return { type: 'vending', ok: false, facilityId: fac.id, prompt: '先放下手中的货物', ref: ud };
        }
        const cd = state.vendingCooldown?.[fac.id] ?? 0;
        const left = cd - state.wallElapsed;
        if (left > 0) {
          return {
            type: 'vending', ok: false, facilityId: fac.id,
            prompt: `补货中 · 还需 ${Math.ceil(left)}s`, ref: ud,
          };
        }
        return {
          type: 'vending', ok: true, facilityId: fac.id,
          prompt: `${fac.emoji} 收货款`, ref: ud,
        };
      }

      /* 需求④：设备坏了就不再是"游玩"，而是"维修"。
       * 这里做**同一锚点的语义切换**而不是另加一个锚点：
       * 玩家走到机器前按 E 就对了，不需要区分"对准了机器还是对准了故障"。 */
      const dev = typeof getDeviceState === 'function' ? getDeviceState(fac.id) : null;
      if (dev?.broken) {
        const fee = dev.repairCost ?? 0;
        if (state.cash < fee) {
          return {
            type: 'repair', ok: false, facilityId: fac.id,
            prompt: `🔧 需维修 ${fmtYuan(fee)} · 现金不足`, ref: ud,
          };
        }
        return {
          type: 'repair', ok: true, facilityId: fac.id,
          prompt: dev.awaitingRepair
            ? `🔧 维修 ${fac.emoji} ${fac.name} · ${fmtYuan(fee)}`
            : `🔧 维修中 ${Math.ceil(dev.downFor ?? 0)}s · 仍需 ${fmtYuan(fee)}`,
          ref: ud,
        };
      }

      const cost = facilityCost(fac);
      if (cost > 0 && state.cash < cost) {
        return {
          type: 'facility', ok: false, facilityId: fac.id,
          prompt: `现金不足 · 需 ${fmtYuan(cost)}`, ref: ud,
        };
      }
      return {
        type: 'facility', ok: true, facilityId: fac.id,
        prompt: `游玩 ${fac.emoji} ${fac.name}${cost > 0 ? ` · ${fmtYuan(cost)}` : ' · 免费'}`,
        ref: ud,
      };
    }

    /* 需求⑤：地面垃圾 —— 走过去按 E 捡起 */
    if (ud.interact === 'litter') {
      if (state.held) {
        return { type: 'litter', ok: false, litterId: ud.litterId, prompt: '先放下手中的货物', ref: ud };
      }
      return { type: 'litter', ok: true, litterId: ud.litterId, prompt: '🧹 清理垃圾', ref: ud };
    }
    if (ud.interact === 'buySnack') {
      if (state.held) {
        return { type: 'buySnack', ok: false, prompt: '先放下手中的货物', ref: ud };
      }
      if (state.cash < SNACK.price) {
        return { type: 'buySnack', ok: false, prompt: `现金不足 · 需 ${fmtYuan(SNACK.price)}`, ref: ud };
      }
      return { type: 'buySnack', ok: true, prompt: `买宵夜 🥟 ${fmtYuan(SNACK.price)}`, ref: ud };
    }

    if (ud.interact === 'drunk') {
      const d = state.events.drunk;
      if (!d) return null;
      const busy = state.busyUntil !== null && state.wallElapsed < state.busyUntil;
      return {
        type: 'drunk',
        ok: !busy,
        prompt: busy ? '正在劝离…' : '劝离醉汉 🍺',
        ref: ud,
      };
    }

    return null;
  }

  function update() {
    if (state.phase !== 'running' || state.paused || state.minigameId) {
      state.hover = null;
      lastNearest = null;
      return;
    }
    const t = pick();
    let h = t ? describe(t.userData) : null;
    /* 需求I 第③条：**无需目标**的道具（喷雾 / 海报）即使准星没对准任何东西，
     * 也要给出"按 E 使用"的提示 —— 否则玩家选中道具后按 E 毫无反应，像是坏了。 */
    if (!h) {
      const item = typeof selectedItem === 'function' ? selectedItem() : null;
      if (item && (item.id === 'spray' || item.id === 'poster')) {
        h = describeItem(item, null);
        lastNearest = null;
      }
    }
    state.hover = h;
  }

  /** 按 E 触发（BUSY 期间忽略，SYS-06 §2） */
  function tryInteract() {
    if (state.phase !== 'running' || state.paused) return null;
    if (state.busyUntil !== null && state.wallElapsed < state.busyUntil) {
      return { ok: false, reason: '手上的活还没干完' };
    }
    const h = state.hover;
    // 关键：没对准也必须给反馈。早期这里返回 null，玩家按 E 完全没反应，像是坏了。
    if (!h) {
      const near = lastNearest ? `${lastNearest.name} ${lastNearest.dist.toFixed(1)}m` : '附近没有可交互物';
      return { ok: false, reason: `没对准 · 最近：${near}` };
    }

    let result = null;
    let duration = 0;

    // 软惩罚（§1.3）：体力<25 搬运更慢(+0.3)；疲惫>70 任何交互更慢(+0.2)
    const lowS = state.clerk && state.clerk.stamina < CLERK.thr.stamina;
    const highF = state.clerk && state.clerk.fatigue > CLERK.thr.fatigue;
    const lowM = state.clerk && state.clerk.mental < CLERK.thr.mental;
    const withPenalty = (base) => base + (lowS ? 0.3 : 0) + (highF ? 0.2 : 0);

    if (h.type === 'returnHeld' && h.ok) {
      // 手持 → 库存箱：place() 失败（货架顶满）时的唯一出口，耗时与取货对称
      result = returnHeld();
      duration = withPenalty(ACTION_DURATIONS.take);
      if (result?.ok) applyActionCost(state, 'TAKE');
    } else if (h.type === 'delivery' && h.ok) {
      /* 门口拾取（块5）：表现层做模型显隐与提示，逻辑全在 delivery 模块 */
      const r = typeof onDelivery === 'function' ? onDelivery('pickup', h.crateIndex ?? 0) : { ok: false, reason: '未接入' };
      duration = withPenalty(0.45);
      result = r;
      if (result?.ok) applyActionCost(state, 'PLACE');
    } else if (h.type === 'deliveryPut' && h.ok) {
      const r = typeof onDelivery === 'function' ? onDelivery('putaway') : { ok: false, reason: '未接入' };
      duration = withPenalty(0.5);
      result = r;
      if (result?.ok) applyActionCost(state, 'PLACE');
    } else if (h.type === 'take' && h.ok) {
      result = take();
      duration = withPenalty(ACTION_DURATIONS.take);
      if (result?.ok) applyActionCost(state, 'TAKE');
    } else if (h.type === 'place' && h.ok) {
      // QTE：上货（玩家亲手做 → 弹拖拽小游戏；未接入则回退原逻辑）
      if (typeof onQteRestock === 'function') { onQteRestock(h.slotIndex); return { ok: true, qte: 'restock' }; }
      result = place(h.slotIndex);
      duration = withPenalty(ACTION_DURATIONS.place);
      if (result?.ok) applyActionCost(state, 'PLACE');
    } else if (h.type === 'clearance' && h.ok) {
      // 2026-10-05 临期货清仓：半价清掉今夜到期的货，耗时同结账（机会成本）
      result = clearanceSell(h.slotIndex);
      duration = withPenalty(ACTION_DURATIONS.checkout);
      if (result?.ok) applyActionCost(state, 'CHECKOUT');
    } else if (h.type === 'checkout' && h.ok) {
      result = checkout();
      duration = withPenalty(ACTION_DURATIONS.checkout);
      if (result?.ok) applyActionCost(state, 'CHECKOUT');
    } else if (h.type === 'facility' && h.ok) {
      // 小游戏由 main.mjs 装配（需要 player / toast / 现金接口），这里只做转发
      if (typeof onFacility === 'function') onFacility(h.facilityId);
      return { ok: true, facility: h.facilityId };
    } else if (h.type === 'ambient' && h.ok) {
      // 环境互动（撸猫 / 接跑腿单 / 看电视）：效果全在 main，交互层只转发
      if (typeof onAmbient !== 'function') return { ok: false, reason: '环境互动未接入' };
      if (typeof onAmbient === 'function') onAmbient(h.ambientId);
      return { ok: true, ambient: h.ambientId };
    } else if (h.type === 'vending' && h.ok) {
      // 需求I 第⑦条：售货机收款（无小游戏面板，由 main 直接结算并记冷却）
      if (typeof onVending !== 'function') return { ok: false, reason: '售货机未接入' };
      result = onVending(h.facilityId);
      if (result?.ok) duration = withPenalty(0.6);
      state.busyLabel = 'vending';
    } else if (h.type === 'useItem' && h.ok) {
      // 需求I 第③条：使用道具。效果与消耗都由 main 决定（失败不吃道具）
      if (typeof onUseItem !== 'function') return { ok: false, reason: '道具系统未接入' };
      result = onUseItem(h.itemId, h);
      if (result?.ok) duration = 0;   // 道具是"花钱换时间"，不该再占用时间
      state.busyLabel = 'item';
    } else if (h.type === 'repair' && h.ok) {
      // QTE：维修（玩家亲手做 → 弹点螺丝小游戏；未接入则回退原逻辑）
      if (typeof onQteRepair === 'function') { onQteRepair(h.facilityId); return { ok: true, qte: 'repair' }; }
      if (typeof onRepair !== 'function') return { ok: false, reason: '维修系统未接入' };
      // 不在这里 return：交给下面的公共尾巴设置 BUSY，维修也要占用时间（机会成本）
      result = onRepair(h.facilityId);
      if (result?.ok) duration = withPenalty(1.2);
      state.busyLabel = 'repair';
    } else if (h.type === 'litter' && h.ok) {
      // QTE：清洁（玩家亲手做 → 弹拖抹布小游戏；未接入则回退原逻辑）
      if (typeof onQteClean === 'function') { onQteClean(h.litterId); return { ok: true, qte: 'clean' }; }
      if (typeof onClean !== 'function') return { ok: false, reason: '清洁系统未接入' };
      result = onClean(h.litterId);
      if (result?.ok) duration = withPenalty(0.8);
      state.busyLabel = 'clean';
    } else if (h.type === 'buySnack' && h.ok) {
      // R2：买宵夜 → 现金漏出换饱食度（economy.purchaseSnack 已改 clerk.satiety）
      result = purchaseSnack();
      if (result.ok) {
        duration = withPenalty(SNACK.eatBusy);
        state.busyLabel = 'eat';
      }
    } else if (h.type === 'drunk' && h.ok) {
      // §4.3 醉汉处置：按 E 劝离；成功率 mental<30 时 ×0.7；
      // 成功→rep+2/S−3、醉汉离店；失败→rep−5/M−5、醉汉同样离店（与超时路径一致）
      const dk = state.events.drunk;
      if (!dk) return { ok: false, reason: '醉汉已经走了' };
      const dur = EVENTS.DRUNK.busy + (highF ? 0.2 : 0) + (lowM ? 0.5 : 0);
      const success = Math.random() < drunkSuccessChance(state.clerk.mental);
      state.busyUntil = state.wallElapsed + dur;
      state.busyLabel = 'drunk';
      notify();
      if (typeof onDrunk === 'function') onDrunk(success);
      return { ok: true, drunk: success };
    } else {
      return { ok: false, reason: h.prompt };
    }

    // duration 为 0 表示"这个动作不占时间"（道具）—— 别去写 busyUntil，
    // 否则会把 busyUntil 写成"刚好等于当前时刻"，下一帧的 BUSY 判定虽不会误判，
    // 但 debug 面板与存档里会看到一个恒等于 wallElapsed 的脏值。
    if (result?.ok && duration > 0) {
      state.busyUntil = state.wallElapsed + duration;
      if (!state.busyLabel) state.busyLabel = h.type;
    }
    notify();
    return result;
  }

  /** F3 诊断面板用 */
  function debugInfo() {
    return {
      phase: state.phase,
      paused: state.paused,
      nearest: lastNearest,
      hover: state.hover
        ? { type: state.hover.type, ok: state.hover.ok, prompt: state.hover.prompt }
        : null,
    };
  }

  return { update, tryInteract, debugInfo };
}
