/**
 * SOUDACHE — 战局世界构造（P1 从 main.js 拆出）。
 *
 * 为什么用工厂：createWorld 的闭包原本直接读 main.js 的模块级变量
 * （audio / ui / save / money / openLootStash / endRaid / PARTICLE_CAP）。
 * 抽成独立模块后这些依赖改为显式注入，主入口的调用签名保持不变。
 *
 * save 用 getSave() 惰性读取：main.js 的 save 是 let，resetSave 会整体替换，
 * 若按值注入会让 w 的回调闭包持有旧存档引用（真 bug）。
 */
import {
  MATCH, CONTAINERS, SCORING, POI, ENEMY_TYPES, KILLFEED,
} from './config.js';
import { pickContracts } from './contracts.js';
import { searchTimeFor } from './loot-interact.js';
import { PRESENTATION, advanceStreak } from './presentation.js';
import { createRng } from './rng.js';
import { planLootWaves } from './areas.js';
import { emitTrace } from './perception.js';
import * as Storage from './storage.js';
import * as Loot from './loot.js';
import { Enemy, EnemyState } from './enemy.js';
import {
  canExtract, extractState, extractOverview, extractChannelTime,
  pullSwitch, EXTRACT_TUNING,
} from './extract.js';
import { addUltCharge, ultGain } from './operators.js';

/**
 * @param {object} deps 运行时依赖
 * @returns {function} createWorld(map, seed, rng, player, enemies)
 */
export function makeCreateWorld(deps) {
  const { audio, ui, money, openLootStash, endRaid, PARTICLE_CAP, getSave } = deps;
  return function createWorld(map, seed, rng, player, enemies) {
    const w = {
      seed,
      map,
      rng,
      player,
      enemies,
      traces: [], // P21：玩家/敌人留下的痕迹（脚印/弹壳/血迹/尸体），AI 踩到转调查
      time: 0,
      timeLeft: MATCH.duration,
      kills: 0,
      // P11：连杀按局内时间窗口推进（纯确定性，绝不抽 rng）；streakT 是 HUD 横幅剩余时间。
      killStreak: { count: 0, lastTime: -Infinity },
      streakT: 0,
      searchedCount: 0,
      particles: [],
      damageNumbers: [],
      killFeed: [],
      tracers: [],
      shells: [],
      decals: [],
      explored: new Uint8Array(map.cols * map.rows),
      hitMarker: 0,
      // P1：分级命中反馈（normal / armor / head / kill）与 P5 单机小队的干净占位。
      // squad 在 startRaid 里由 spawnSquad 填充（两名纯逻辑 AI 队友）；此处先置空数组，
      // HUD 小队面板读到空就画 STANDBY 暗槽，不伪造队友。
      hitKind: '',
      hitKindT: 0,
      squad: [],
      abilities: null,
      // P5：投掷物 / 烟幕 / 燃烧区 / 白屏闪光 / 鹰眼标记 / 急救持续回血。
      // 数组一律预置为空，渲染层与 AI 都能无条件遍历，不必先判空。
      grenades: [],
      enemyGrenades: [], // P9：敌方爆裂雷（与玩家投掷物分开更新 / 分开渲染）
      smokes: [],
      zones: [],
      flashT: 0,
      bossFlashT: 0,
      markedT: 0,
      aegisT: 0,
      aegisAcc: 0,
      // P1-6 受击方向：hitDir = 「玩家 → 伤害来源」的方位角（弧度），hitDirT 是剩余淡出时间
      hitDir: 0,
      hitDirT: 0,
      shake: 0,
      over: false,
      result: null,
      terminalsHacked: 0,
      cratesBroken: 0,
      items: [], // 地面掉落物：{ uid, id, name, def, qty, x, y, taken }
      itemsSpawned: 0, // 仅用于生成稳定的 uid
      scoreBonus: 0,
      extractFeePaid: 0,
      // P20：局内目标与区域进度（HUD 与结算读同一份）
      objectives: (map && map.objectives) || [],
      hotspotVisits: 0,
      lootTaken: 0,
      carriedPeak: 0,
      // P20：补货波次排期，按 at（经过秒数）升序；已触发的从队首移除。
      lootWaves: planLootWaves(map, { duration: MATCH.duration }),
      // 补货专用随机流：从 seed 派生，与 world.rng 完全隔离 —— 补货不得让敌人行为/掉落漂移。
      lootRng: createRng((seed ^ 0x51ed270b) >>> 0),
      lootLuck: 1,
      contracts: pickContracts(rng),
      contractsDone: 0,
      audio,
      exploreTimer: 0,
      insured: false, // 本局是否投保（由 startRaid 的 opts 显式传入，不从存档现读）
      killedBy: null, // 死亡来源：{ type, dist }，用于结算页复盘
      get carriedValue() {
        return player.carriedValue;
      },
      toast(message) {
        ui.toast(message);
      },
      emitNoise(x, y, radius) {
        for (const e of enemies) {
          if (e.dead) continue;
          e.hearNoise(w, x, y, radius);
        }
      },
      /**
       * E-03 拉闸：拉下指定撤离点的闸刀，开启其可用窗口，并向全图广播（音效 + HUD + AI 听觉）。
       * 广播半径按 EXTRACT_TUNING.switchBroadcast 控制；单机下主要作用是让附近 AI 赶来蹲点，
       * 制造"拉闸 = 暴露自己位置"的风险/信息取舍。
       * @param {object} ex 撤离点（map.extracts 中的对象）
       * @returns {{ok:boolean, reason:string}}
       */
      pullExtractSwitch(ex) {
        const r = pullSwitch(ex, w.time);
        if (!r.ok) return r;
        // 闸刀 POI 同步标记，避免玩家反复按 E 刷广播（world 是唯一写入口）。
        for (const sw of (w.map.switches || [])) {
          if (sw.extractId === ex.id) sw.pulled = true;
        }
        // 拉闸是"提前解锁"：不必等 openAt 到点。main 的开放循环只负责未解锁的普通点。
        // 状态机读 unlockedEarly（不能只靠 ex.open，extractState 不以它判开放）。
        ex.unlockedEarly = true;
        ex.open = true;
        if (EXTRACT_TUNING.switchBroadcast && audio && audio.extract) audio.extract();
        w.emitNoise(ex.x, ex.y, EXTRACT_TUNING.switchNoiseRadius);
        if (ui && ui.toast) ui.toast('闸刀已拉下：撤离窗口开启，位置已暴露！');
        return r;
      },
      /**
       * P21：世界级痕迹出口。玩家移动/开枪/敌人死亡都会落痕，AI 踩到痕迹转调查。
       * 直接委托 perception.emitTrace（合并走网格、零随机，不碰 world.rng）。
       * @param {string} kind 'footprint'|'shell'|'blood'|'body'
       * @param {number} x 世界 x
       * @param {number} y 世界 y
       * @param {object} [opts] { strength, life }
       * @returns {?object} 痕迹记录
       */
      leaveTrace(kind, x, y, opts) {
        return emitTrace(w.traces, kind, x, y, opts);
      },
      alertNearby(source, x, y, radius) {
        for (const e of enemies) {
          if (e === source || e.dead) continue;
          if (Math.hypot(e.x - x, e.y - y) <= radius) e.onAllyAlert(w, x, y);
        }
      },
      addDamageNumber(x, y, text, color, height) {
        w.damageNumbers.push({ x, y, text: String(text), color, t: 0, life: 0.85, size: 15, h: height });
        if (w.damageNumbers.length > 70) w.damageNumbers.shift();
      },
      /**
       * 击杀信息流：由 combat.js applyDamage 在目标死亡时调用（同时持有受害者与击杀者）。
       * 玩家显示为「你」，敌人按 ENEMY_TYPES 取中文名；source 为空时归因为环境。
       */
      addKill(victim, killer) {
        // 队友倒地不是"击杀"：不进击杀信息流（避免把友军阵亡显示成被谁打死）。
        // 队友的救援提示由 onDeath 的 ally 分支负责。
        if (victim && victim.faction === 'ally') return;
        const nameOf = (e) => {
          if (!e) return '环境';
          if (e.isPlayer) return '你';
          const def = ENEMY_TYPES[e.typeId];
          return (def && def.name) || '敌人';
        };
        const wdef = killer && killer.currentWeapon ? killer.currentWeapon.def : null;
        w.killFeed.push({
          killer: nameOf(killer),
          victim: nameOf(victim),
          weapon: wdef ? (wdef.short || wdef.name || '') : '',
          byPlayer: !!(killer && killer.isPlayer),
          ofPlayer: !!(victim && victim.isPlayer),
          t: 0,
        });
        if (w.killFeed.length > KILLFEED.max) w.killFeed.shift();
        // P11：只有玩家击杀敌人（不是队友阵亡、不是玩家被击倒）才推进连杀。
        // 连杀计数走 presentation.js 纯函数，时间取 w.time，不抽 world.rng。
        if (killer && killer.isPlayer && victim && !victim.isPlayer) {
          w.killStreak = advanceStreak(w.killStreak, w.time, PRESENTATION.streakWindow);
          w.streakT = PRESENTATION.streakLife;
          if (w.killStreak.count >= 2 && w.audio && typeof w.audio.streak === 'function') {
            w.audio.streak(w.killStreak.count);
          }
        }
      },
      spawnBlood(x, y, angle, count, height) {
        for (let i = 0; i < count; i += 1) {
          const a = angle + w.rng.float(-0.9, 0.9);
          const sp = w.rng.float(40, 170);
          w.particles.push({
            x, y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            t: 0, life: w.rng.float(0.25, 0.6), size: w.rng.float(1.4, 3),
            color: 'rgba(178,32,32,ALPHA)',
            h: height,
          });
        }
        if (w.particles.length > PARTICLE_CAP) w.particles.splice(0, w.particles.length - PARTICLE_CAP);
      },
      spawnImpact(x, y, angle, height) {
        for (let i = 0; i < 5; i += 1) {
          const a = angle + Math.PI + w.rng.float(-1, 1);
          const sp = w.rng.float(30, 120);
          w.particles.push({
            x, y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            t: 0, life: w.rng.float(0.15, 0.35), size: w.rng.float(1, 2.2),
            color: 'rgba(210,200,170,ALPHA)',
            h: height,
          });
        }
        if (audio) audio.impact();
        // P3-C2：子弹打在硬表面的焦痕贴花（节流 + 上限，避免列表爆炸）
        if (w.decals.length < 200 && w.rng.float(0, 1) < 0.5) {
          w.decals.push({ x, y, r: 6 + w.rng.float(0, 4), kind: 'scorch', rot: angle, life: 1, maxLife: 1 });
        }
      },
      /**
       * 跳弹火花：子弹打在硬表面（墙 / 箱）上溅起的明亮火星。
       * 比 spawnImpact 的尘土更"炽热"——白热与橙红交替、初速更快、带向上的竖直弹跳（vh），
       * 渲染层按命中高度 h 放置，于是火星会沿墙面/箱顶真实地向上迸溅再落下。
       * @param {number} x 世界 x
       * @param {number} y 世界 y
       * @param {number} angle 子弹水平入射角（弧度）
       * @param {number} height 命中高度（场景单位）
       * @returns {void}
       */
      spawnSpark(x, y, angle, height) {
        const n = 9 + Math.floor(w.rng.float(0, 6));
        for (let i = 0; i < n; i += 1) {
          // 反弹方向以"朝射手反向"为主、带大角度散射，模拟弹道折返溅射
          const a = angle + Math.PI + w.rng.float(-1.15, 1.15);
          const sp = w.rng.float(70, 230);
          w.particles.push({
            x, y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            // 竖直弹跳（场景单位/秒）：火星向上迸起后受重力回落
            vh: w.rng.float(50, 190) * (0.35 + w.rng.float(0, 1)),
            t: 0, life: w.rng.float(0.12, 0.34), size: w.rng.float(0.5, 1.5),
            color: w.rng.float(0, 1) < 0.5 ? 'rgba(255,242,205,ALPHA)' : 'rgba(255,150,55,ALPHA)',
            h: height,
          });
        }
        // 跳弹只发生在硬表面，给金属采样；普通弹着点仍走默认的墙面材质
        if (audio) audio.impact('metal');
      },
      shakeCamera(amount) {
        w.shake = Math.min(16, w.shake + amount);
      },
      /**
       * 爆点火花 / 烟尘（P5）。投掷物系统只描述"在哪里炸、多大、什么颜色"，
       * 具体怎么变成粒子由这里决定 —— 逻辑层因此不依赖 particles 的字段形状。
       *
       * @param {number} x 世界 x
       * @param {number} y 世界 y
       * @param {number} h 高度（逻辑单位）
       * @param {number} radiusM 半径（米）
       * @param {string} color 基色
       * @param {boolean} [soft] 烟/火类：粒子更慢更大、数量更少
       * @returns {void}
       */
      spawnExplosion(x, y, h, radiusM, color, soft) {
        const n = soft ? 14 : 26;
        for (let i = 0; i < n; i += 1) {
          // 用序号做确定性分布，不抽 world.rng（那条流不能被动就动）
          const a = (i / n) * Math.PI * 2 + (i % 3) * 0.7;
          const sp = (soft ? 40 : 90) + ((i * 37) % 120);
          w.particles.push({
            x, y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            vh: soft ? 40 + (i % 5) * 18 : 120 + (i % 7) * 30,
            t: 0,
            life: soft ? 0.6 + (i % 4) * 0.15 : 0.25 + (i % 5) * 0.05,
            size: soft ? 5 + (i % 4) * 2 : 2 + (i % 3),
            color,
            h: h + (i % 3) * 4,
          });
        }
        if (w.particles.length > PARTICLE_CAP) w.particles.splice(0, w.particles.length - PARTICLE_CAP);
        if (w.decals && w.decals.length < 200) {
          w.decals.push({
            x, y, r: radiusM * 0.6, kind: 'scorch', rot: 0, life: 1, maxLife: 1,
          });
        }
      },
      /** 终结技能量入口（P5）：所有来源都从 ultGain 取点数，避免各处写死不同数值。 */
      addPlayerUlt(kind) {
        const st = w.abilities;
        if (!st) return;
        addUltCharge(st, ultGain(kind));
      },
      /** 玩家造成一次伤害后的回调：攒能量 + 命中音分级（投掷物路径用）。 */
      onPlayerHit() {
        addUltCharge(w.abilities, ultGain('hit'));
      },
      containerSearchTime(container) {
        // 秒开判定唯一真值在 loot-interact.js：普通容器 0，保险箱走配置读条。
        return searchTimeFor(container);
      },
      onSearchComplete(container) {
        container.searched = true;
        w.searchedCount += 1;
        if (audio) audio.searchDone();
        if (container.loot && container.loot.length) {
          // P18：搜索完成直接开双栏搜刮（需要鼠标拖拽，因此释放指针锁定）。
          openLootStash(container);
        } else {
          ui.toast('什么都没找到');
        }
      },
      openLootPanel(container) {
        openLootStash(container);
      },
      /** P20：撤离判定上下文。执行侧与 HUD 都从这里取，避免两套口径。 */
      extractCtx() {
        const p = w.player;
        return {
          time: w.time,
          weight: p.weight,
          weightLimit: p.weightLimit,
          itemCount: p.carriedItems ? p.carriedItems().length : 0,
          currency: getSave().currency,
        };
      },
      /** 能不能从这里撤（player.interact 与 onExtract 共用这一个判据）。 */
      canExtract(point) {
        const r = canExtract(point, w.extractCtx());
        if (!r.ok) {
          ui.toast(r.message);
          if (audio) audio.error();
        }
        return r.ok;
      },
      /** 撤离读条时长：高危点更久。 */
      extractChannelTime(point) {
        return extractChannelTime(point);
      },
      /** HUD / 地图卡读数。 */
      extractOverview() {
        return extractOverview(w.map.extracts, w.extractCtx());
      },
      /** 单点状态（HUD 画倒计时用）。 */
      extractState(point) {
        return extractState(point, w.extractCtx());
      },
      onTerminalComplete(terminal) {
        if (!terminal || terminal.hacked) return;
        terminal.hacked = true;
        w.terminalsHacked += 1;
        w.scoreBonus += SCORING.terminalBonus;
        getSave().currency += POI.terminalReward;
        Storage.saveGame(getSave());
        ui.toast(`终端破解成功 · 情报费 +${money(POI.terminalReward)}`);
        if (audio) audio.searchDone();
      },
      onExtract(point) {
        // 读条期间条件可能变了（丢弃/拾取改了负重、窗口到期）：完成时再判一次，不认旧结论。
        const r = canExtract(point, w.extractCtx());
        if (!r.ok) {
          ui.toast(`撤离中断 · ${r.message}`);
          if (audio) audio.error();
          return false;
        }
        if (point && point.kind === 'paid') {
          const cost = point.cost || MATCH.extractFee;
          getSave().currency = Math.max(0, getSave().currency - cost);
          w.extractFeePaid = cost;
        }
        w.extractKind = (point && point.kind) || 'free';
        w.extractModifier = (point && point.modifier) || 'none';
        endRaid('extract');
        return true;
      },
      onDeath(entity, source) {
        if (entity.isPlayer) {
          // 记下击杀来源：结算页要把「被什么、从多远打死」写出来，玩家下一把才知道怎么改。
          // source 可能是 null（环境伤害），必须容错。
          w.killedBy = source
            ? {
              type: source.typeId || 'unknown',
              dist: Math.round(Math.hypot(source.x - entity.x, source.y - entity.y)),
            }
            : null;
          return; // 玩家死亡由主循环统一结算
        }
        if (entity.faction === 'ally') {
          // 队友倒地：不计击杀、不掉战利品尸体。HUD 显示 DOWNED，玩家靠近读条救援。
          if (audio && audio.warn) audio.warn();
          ui.toast(`${entity.callsign || '队友'} 倒地 — 靠近即可救援（读条中）`);
          return;
        }
        w.kills += 1;
        if (audio) audio.death();
        w.decals.push({
          x: entity.x, y: entity.y, r: 15 + w.rng.float(0, 9), kind: 'blood', rot: w.rng.float(0, Math.PI * 2), life: 1, maxLife: 1,
        });
        w.spawnBlood(entity.x, entity.y, w.rng.float(0, Math.PI * 2), 16);
        // P21：尸体也是痕迹 —— 巡逻 AI 路过会停下来调查，玩家可利用这点调虎离山。
        w.leaveTrace('body', entity.x, entity.y, { strength: 1, life: 90 });
        const body = {
          id: w.map.containers.length,
          type: 'body',
          x: Math.round(entity.x),
          y: Math.round(entity.y),
          r: CONTAINERS.body.radius,
          searched: false,
        loot: Loot.rollEnemyLoot(entity.typeId, w.rng),
      };
      w.map.containers.push(body);
      // 首领阵亡：在其倒地处掉落专属高价值物资（确定性，复用容器系统）。
      if (entity.isBoss) {
        w.map.containers.push({
          id: `boss-${w.seed}`,
          type: 'boss',
          x: Math.round(entity.x),
          y: Math.round(entity.y),
          r: CONTAINERS.boss.radius,
          searched: false,
          loot: Loot.rollContainer('boss', w.rng),
        });
        ui.toast(`首领 ${entity.name} 已被击败！专属物资已掉落`);
        if (audio && audio.searchDone) audio.searchDone();
      }
    },
      // 首领呼叫增援：在指定点生成一名普通敌人并直接投入交战。
      // 用 world.rng.fork 拿确定性 id，避免与地图生成期的 fork 序列冲突。
      spawnReinforcement(x, y, typeId) {
        const id = this.enemies.length + Math.floor(this.time * 7) + 1;
        const e = new Enemy(typeId, x, y, id, this.rng.fork(id + 17));
        e.state = EnemyState.COMBAT;
        e.lastKnown = { x: this.player.x, y: this.player.y };
        this.enemies.push(e);
        return e;
      },
    };
    return w;
  }
}
