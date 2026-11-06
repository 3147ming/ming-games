/**
 * 《山海拾遗》战斗核心 —— 纯函数，不碰 DOM、不读 localStorage。
 *
 * 为什么所有规则都放在这里：
 *   界面层只负责“把状态画出来 / 把手势翻译成动作”，这样 node:test 可以
 *   直接验证伤害、走位、克制、AI 和胜负，不需要开浏览器。
 *
 * 文件加载方式说明：
 *   浏览器在 file:// 下会以 CORS 拦截 type="module" 的本地脚本（Chrome/Edge
 *   的既有安全策略），而本作要求“双击 index.html 也能玩”。因此浏览器端用
 *   普通 <script defer> 加载这个 .mjs，并挂到 globalThis.ShanhaiCore；Node
 *   测试则用 import 执行同一份文件。仍然没有构建、没有依赖、没有网络。
 */
(function attachCore(root) {
  'use strict';

  /** 地形规则。code 与 src/maps.mjs 的地图字符一一对应。 */
  const TERRAIN = Object.freeze({
    plain: Object.freeze({
      code: '.', name: '平地', passable: true, moveCost: 1, defense: 1,
      blurb: '无遮无拦，行军最快，也最容易被集火。',
    }),
    forest: Object.freeze({
      code: 'F', name: '林地', passable: true, moveCost: 1, defense: 1.35,
      blurb: '林叶障目，守方防御按 1.35 倍结算。',
    }),
    mountain: Object.freeze({
      code: 'M', name: '山地', passable: true, moveCost: 2, defense: 1.2,
      blurb: '每格消耗 2 点移动力；居高临下，防御按 1.2 倍结算。',
    }),
    water: Object.freeze({
      code: 'W', name: '水泽', passable: false, moveCost: Infinity, defense: 1,
      blurb: '水泽不可通行，也是天然的战场分割线。',
    }),
  });

  const TERRAIN_BY_CODE = Object.freeze({
    '.': TERRAIN.plain,
    F: TERRAIN.forest,
    M: TERRAIN.mountain,
    W: TERRAIN.water,
  });

  /**
   * 三方克制环：剑 → 弓 → 术 → 剑。
   * 用“环”而不是三组手写系数，保证每一方恰好克一方、被一方克，不会漏项。
   */
  const CLASS_CYCLE = Object.freeze({
    sword: 'bow',
    bow: 'mystic',
    mystic: 'sword',
  });

  const COEFFICIENTS = Object.freeze({
    // 克制方 +30%：足够让玩家愿意绕后换目标，又不至于一刀秒杀。
    advantage: 1.3,
    // 被克方 -20%：不是严格的 1/1.3，是刻意给劣势方留一点反打空间。
    disadvantage: 0.8,
    // 术士溅射只造成一半伤害：范围收益必须用单体伤害来换。
    splash: 0.5,
  });

  const RATING_ORDER = Object.freeze({ C: 0, B: 1, A: 2, S: 3 });

  function keyOf(cell) {
    return `${cell.x},${cell.y}`;
  }

  function mapWidth(map) {
    return map && Array.isArray(map.grid) && map.grid[0] ? map.grid[0].length : 0;
  }

  function mapHeight(map) {
    return map && Array.isArray(map.grid) ? map.grid.length : 0;
  }

  function inBounds(map, x, y) {
    return Number.isInteger(x) && Number.isInteger(y)
      && x >= 0 && y >= 0 && x < mapWidth(map) && y < mapHeight(map);
  }

  function terrainAt(map, x, y) {
    if (!inBounds(map, x, y)) return null;
    return TERRAIN_BY_CODE[map.grid[y][x]] || TERRAIN.plain;
  }

  function terrainFrom(value) {
    if (!value) return TERRAIN.plain;
    if (typeof value === 'string') return TERRAIN_BY_CODE[value] || TERRAIN.plain;
    return value.defense == null ? TERRAIN.plain : value;
  }

  function unitAt(units, x, y) {
    return (units || []).find((u) => u.alive && u.x === x && u.y === y) || null;
  }

  function distance(a, b) {
    // 四方向移动的战棋用曼哈顿距离：斜线走一步要绕两格，射程也应如此。
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  function typeMultiplier(attackerClass, defenderClass) {
    if (attackerClass === defenderClass) return 1;
    if (CLASS_CYCLE[attackerClass] === defenderClass) return COEFFICIENTS.advantage;
    if (CLASS_CYCLE[defenderClass] === attackerClass) return COEFFICIENTS.disadvantage;
    return 1;
  }

  /**
   * 核心伤害式（所有参数都可解释）：
   *
   *   伤害 = max(1, round(
   *      攻击 × 克制系数 − 防御 × 地形防御系数
   *   ) × 溅射系数)
   *
   * 系数为什么这样定：
   *   - 攻击先乘克制：兵种优势要能击穿高防，否则“剑克弓”只是文案；
   *   - 防御再乘地形：林地 1.35 / 山地 1.2，让“站哪里”与“带什么兵”同等重要；
   *   - 结果四舍五入：HP 保持整数，玩家能心算，不会出现 6.999 的模糊感；
   *   - 最低 1 点：高防单位可以被压制但不能完全免疫，避免回合拖死；
   *   - 术士溅射在最后乘 0.5：先算完整单体伤害再折半，规则顺序固定可测试。
   *
   * 克制系数：剑 1.3 ↔ 弓 0.8；弓 1.3 ↔ 术 0.8；术 1.3 ↔ 剑 0.8。
   * 同兵种为 1.0。被克方的 0.8 是刻意不取 1/1.3，避免一次兵种误判直接崩盘。
   */
  function computeDamage(attacker, defender, terrain, options) {
    if (!attacker || !defender) throw new Error('computeDamage 需要攻守双方');
    const opts = options || {};
    const terrainRules = terrainFrom(terrain);
    const multiplier = typeMultiplier(attacker.classId, defender.classId);
    const splashMultiplier = opts.splash ? COEFFICIENTS.splash : 1;
    const raw = attacker.atk * multiplier - defender.def * terrainRules.defense;
    return Math.max(1, Math.round(raw * splashMultiplier));
  }

  /**
   * 可移动格：Dijkstra / 最小堆的简化版。
   * 规则：
   *   - 只能上下左右走；
   *   - 林地耗 1，山地耗 2，水泽不可进入；
   *   - 所有存活单位（无论敌我）都占据格子，既不能停在上面，也不能穿过去。
   *     这样可以避免“从友军身体里穿过去”的歧义，也让前排卡位有意义。
   * 返回包含起点（cost 0, path []），界面渲染高亮时排除起点即可。
   */
  function computeMoveRange(map, units, unit) {
    if (!map || !unit || unit.alive === false || unit.hp <= 0) return [];
    const width = mapWidth(map);
    const height = mapHeight(map);
    if (!width || !height || !inBounds(map, unit.x, unit.y)) return [];

    const occupied = new Set(
      (units || [])
        .filter((u) => u.alive && u.id !== unit.id)
        .map((u) => keyOf(u)),
    );

    const start = { x: unit.x, y: unit.y, cost: 0, path: [] };
    const best = new Map([[keyOf(start), start]]);
    const queue = [start];
    const steps = [
      { dx: 0, dy: -1 },
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: -1, dy: 0 },
    ];

    while (queue.length) {
      // 格子最多 48 个，直接排序比手写堆更可读，性能完全够用。
      queue.sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x);
      const current = queue.shift();
      const recorded = best.get(keyOf(current));
      if (!recorded || recorded.cost !== current.cost) continue;

      for (const step of steps) {
        const nx = current.x + step.dx;
        const ny = current.y + step.dy;
        if (!inBounds(map, nx, ny)) continue;

        const terrain = terrainAt(map, nx, ny);
        if (!terrain.passable) continue;
        if (occupied.has(`${nx},${ny}`)) continue;

        const nextCost = current.cost + terrain.moveCost;
        if (nextCost > unit.move) continue;

        const nextKey = `${nx},${ny}`;
        const old = best.get(nextKey);
        if (old && old.cost <= nextCost) continue;

        const next = {
          x: nx,
          y: ny,
          cost: nextCost,
          path: current.path.concat([{ x: nx, y: ny }]),
        };
        best.set(nextKey, next);
        queue.push(next);
      }
    }

    return Array.from(best.values()).sort(
      (a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x,
    );
  }

  /**
   * 攻击目标。射程用曼哈顿距离，和移动一致；不设“最小射程”，
   * 弓手贴脸也能射，减少新手理解成本。
   */
  function getAttackTargets(units, attacker, from) {
    if (!attacker || !attacker.alive) return [];
    const origin = from || { x: attacker.x, y: attacker.y };
    const range = Number.isFinite(attacker.range) ? attacker.range : 1;
    return (units || []).filter((u) => (
      u.alive
      && u.team !== attacker.team
      && distance(origin, u) <= range
    ));
  }

  /**
   * 结算一次攻击，返回纯数据，不直接改单位数组。
   * 术士的“范围伤害”：主目标打满，目标相邻（曼哈顿 1）的其他敌人吃一半。
   * 不在术士自身周围，而是在“被命中目标周围”溅射，鼓励优先点站位密集的敌人。
   */
  function resolveAttack(state, attackerId, targetId) {
    const units = state.units;
    const attacker = units.find((u) => u.id === attackerId);
    const target = units.find((u) => u.id === targetId);
    if (!attacker || !target) throw new Error('攻击双方必须存在');
    if (!attacker.alive || !target.alive) throw new Error('不能攻击已倒下的单位');
    if (attacker.team === target.team) throw new Error('不能攻击友军');
    if (!getAttackTargets(units, attacker).some((u) => u.id === targetId)) {
      throw new Error('目标不在攻击范围内');
    }

    const targetTerrain = terrainAt(state.map, target.x, target.y) || TERRAIN.plain;
    const hits = [{
      unitId: target.id,
      damage: computeDamage(attacker, target, targetTerrain),
      splash: false,
      terrain: targetTerrain.name,
    }];

    if (attacker.splash) {
      const adjacent = units
        .filter((u) => (
          u.alive
          && u.team !== attacker.team
          && u.id !== target.id
          && distance(u, target) <= 1
        ))
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const other of adjacent) {
        const otherTerrain = terrainAt(state.map, other.x, other.y) || TERRAIN.plain;
        hits.push({
          unitId: other.id,
          damage: computeDamage(attacker, other, otherTerrain, { splash: true }),
          splash: true,
          terrain: otherTerrain.name,
        });
      }
    }

    return {
      attackerId,
      targetId,
      hits,
      totalDamage: hits.reduce((sum, hit) => sum + hit.damage, 0),
    };
  }

  /** 把结算结果落到一份新的单位数组上，保证核心可测试、游戏层无隐式修改。 */
  function applyAttackResult(units, result) {
    const damageByUnit = new Map(result.hits.map((hit) => [hit.unitId, hit.damage]));
    return units.map((unit) => {
      const damage = damageByUnit.get(unit.id);
      if (!damage) return unit;
      const hp = Math.max(0, unit.hp - damage);
      return { ...unit, hp, alive: hp > 0 };
    });
  }

  /** 只按存活数判断；双方同时全灭的极端情况判负，避免“幽灵胜利”。 */
  function checkBattleOutcome(units) {
    const players = units.filter((u) => u.team === 'player' && u.alive);
    const enemies = units.filter((u) => u.team === 'enemy' && u.alive);
    if (players.length === 0) return 'lose';
    if (enemies.length === 0) return 'win';
    return null;
  }

  function totalHp(units, team) {
    return units
      .filter((u) => u.team === team && u.alive)
      .reduce((sum, u) => sum + u.hp, 0);
  }

  /**
   * 评级：
   *   S —— 5 回合内且剩余血量 ≥65%，说明换位和集火都很干净；
   *   A —— 7 回合内且剩 ≥40%，稳扎稳打；
   *   B —— 其余胜利；C 只用于失败，不写入最高评分。
   * 回合阈值来自地图跨度：两队接敌约需 2 回合，正常解决战斗 4~6 回合。
   */
  function rateBattle(summary) {
    if (!summary || !summary.won) return 'C';
    const ratio = summary.hpTotal > 0 ? summary.hpRemaining / summary.hpTotal : 0;
    if (summary.rounds <= 5 && ratio >= 0.65) return 'S';
    if (summary.rounds <= 7 && ratio >= 0.4) return 'A';
    return 'B';
  }

  function ratingAtLeast(candidate, current) {
    const a = RATING_ORDER[candidate];
    const b = RATING_ORDER[current];
    if (a == null) return false;
    if (b == null) return true;
    return a > b;
  }

  function terrainDefenseAt(map, cell) {
    return (terrainAt(map, cell.x, cell.y) || TERRAIN.plain).defense;
  }

  /**
   * AI 选行动。排序理由（从高到低）：
   *   1. 能击杀的目标优先：少一个敌人行动，等于本回合多赚一次行动权；
   *   2. 击杀之外选当前 HP 最低的：同样一刀，压低血线比“打高血”更快形成击杀；
   *   3. 同目标比预计伤害：让克制和地形都参与决策；
   *   4. 同伤害时站在防御更高的格，且少走一格，保持阵型。
   * 不能攻击时：
   *   - 朝最近的我方单位靠；距离相同则优先站林地/山地，其次是少走路。
   * 这个 AI 不做多步搜索，但每一步都合理，且规则完全可单测。
   */
  function chooseAIPlan(state, unitId) {
    const unit = state.units.find((u) => u.id === unitId);
    if (!unit || !unit.alive) return null;

    const moveCells = computeMoveRange(state.map, state.units, unit);
    let best = null;

    for (const cell of moveCells) {
      const targets = getAttackTargets(state.units, unit, cell);
      for (const target of targets) {
        const targetTerrain = terrainAt(state.map, target.x, target.y) || TERRAIN.plain;
        const damage = computeDamage(unit, target, targetTerrain);
        const kills = damage >= target.hp;
        const candidate = {
          unitId: unit.id,
          targetId: target.id,
          targetName: target.name,
          targetHp: target.hp,
          damage,
          kills,
          moveTo: { x: cell.x, y: cell.y },
          path: cell.path,
          moveCost: cell.cost,
          cover: terrainDefenseAt(state.map, cell),
          reason: kills ? `可击杀 ${target.name}` : `压制残血 ${target.name}`,
        };

        if (!best || compareAttackCandidates(candidate, best) < 0) best = candidate;
      }
    }

    if (best) return best;

    const foes = state.units.filter((u) => u.team !== unit.team && u.alive);
    if (foes.length === 0) return null;

    let advance = null;
    for (const cell of moveCells) {
      const nearest = Math.min(...foes.map((foe) => distance(cell, foe)));
      const candidate = {
        unitId: unit.id,
        targetId: null,
        targetName: null,
        targetHp: null,
        damage: 0,
        kills: false,
        moveTo: { x: cell.x, y: cell.y },
        path: cell.path,
        moveCost: cell.cost,
        cover: terrainDefenseAt(state.map, cell),
        nearest,
        reason: '向最近的我方单位逼近',
      };
      if (!advance || compareAdvanceCandidates(candidate, advance) < 0) {
        advance = candidate;
      }
    }
    return advance;
  }

  function compareAttackCandidates(a, b) {
    if (a.kills !== b.kills) return a.kills ? -1 : 1;
    if (a.targetHp !== b.targetHp) return a.targetHp - b.targetHp;
    if (a.damage !== b.damage) return b.damage - a.damage;
    if (a.cover !== b.cover) return b.cover - a.cover;
    if (a.moveCost !== b.moveCost) return a.moveCost - b.moveCost;
    if (a.targetId !== b.targetId) return a.targetId.localeCompare(b.targetId);
    return a.moveTo.y - b.moveTo.y || a.moveTo.x - b.moveTo.x;
  }

  function compareAdvanceCandidates(a, b) {
    if (a.nearest !== b.nearest) return a.nearest - b.nearest;
    if (a.cover !== b.cover) return b.cover - a.cover;
    if (a.moveCost !== b.moveCost) return a.moveCost - b.moveCost;
    return a.moveTo.y - b.moveTo.y || a.moveTo.x - b.moveTo.x;
  }

  const api = {
    TERRAIN,
    TERRAIN_BY_CODE,
    CLASS_CYCLE,
    COEFFICIENTS,
    RATING_ORDER,
    keyOf,
    mapWidth,
    mapHeight,
    inBounds,
    terrainAt,
    terrainFrom,
    unitAt,
    distance,
    typeMultiplier,
    computeDamage,
    computeMoveRange,
    getAttackTargets,
    resolveAttack,
    applyAttackResult,
    checkBattleOutcome,
    totalHp,
    rateBattle,
    ratingAtLeast,
    chooseAIPlan,
    compareAttackCandidates,
    compareAdvanceCandidates,
  };

  Object.defineProperty(root, 'ShanhaiCore', {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
