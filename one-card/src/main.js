// 引导与场景切换
// 口径：这里只做「把 Run / Combat 的输出接到 UI 上」这一件事，不含任何规则。
// 支持 URL 参数 ?seed=XXX&arch=blade 用于复现问题与无头测试。

import { Run, PHASE } from './run.js';
import { Combat } from './combat.js';
import { Ui } from './ui.js';
import { loadMeta } from './meta.js';
import { Rng } from './rng.js';
import { Arena, rollWildReward, isWildPending, markWildHandled } from './arena.js';
import { BY_TIER } from '../config/enemies.js';
import { CONST } from '../config/constants.js';
import { resolveLogEnv, dumpJsonl } from './logger.js';

const params = new URLSearchParams(location.search);
const meta = loadMeta();

let run = null;
let combat = null;
let combatNodeUid = null;
let arena = null; // 阶段 6：荒野关实例（运行时独占，退出后清空）

const ui = new Ui({
  getMeta: () => meta,
  onStartRun,
  onAdvance: () => {
    if (!run || run.phase !== PHASE.MAP) return;
    run.advance();
    renderPhase();
  },
  onPlayCard,
  onEndTurn,
  onReward: (cid) => {
    run.takeReward(cid);
    renderPhase();
  },
  onEvent: (i) => {
    run.resolveEvent(i);
    renderPhase();
  },
  onRest: (k) => {
    run.resolveRest(k);
    renderPhase();
  },
  onRemove: (uid) => {
    run.completeRemove(uid);
    renderPhase();
  },
  onUnlock: (cid) => {
    run.takeUnlock(cid);
    renderPhase();
  },
  onContinue: () => {
    ui.renderTitle(meta);
  },
  onBack: () => {
    ui.renderTitle(meta);
  },
});

function newSeed() {
  const g = new Rng(String(Date.now()) + Math.random());
  return g.int(1e9).toString(36).toUpperCase();
}

function onStartRun(archetypeId) {
  const seed = params.get('seed') || newSeed();
  run = new Run({ archetypeId, meta, seed });
  combat = null;
  combatNodeUid = null;
  ui.renderMap(run);
}

function ensureCombat() {
  if (!run || run.phase !== PHASE.COMBAT) return;
  if (combat && combatNodeUid === run.cursor) return;
  combat = new Combat({ run, enemyDef: run.combatEnemy(), rng: run.rng });
  combatNodeUid = run.cursor;
  combat.start();
}

function onPlayCard(uid) {
  if (!combat || combat.over || ui.busy) return;
  const before = combat.state.log.length;
  const res = combat.playCard(uid);
  if (!res.ok) {
    ui.toast(res.reason === 'energy' ? '能量不够' : '现在不能出这张牌');
    return;
  }
  ui.renderCombat(run, combat);
  ui.playFxC(combat, before);
  settleIfOver();
}

function onEndTurn() {
  if (!combat || combat.over || ui.busy) return;
  const before = combat.state.log.length;
  combat.endTurn();
  ui.renderCombat(run, combat);
  ui.playFxC(combat, before);
  settleIfOver();
}

/** 战斗结束 → 停顿一拍让玩家看清最后一击，再结算 */
function settleIfOver() {
  if (!combat || !combat.over) return;
  ui.busy = true;
  ui.renderCombat(run, combat);
  setTimeout(() => {
    ui.busy = false;
    const result = combat.finish();
    run.resolveCombat(result);
    combat = null;
    combatNodeUid = null;
    renderPhase();
  }, 900);
}

/** 阶段 6 · 荒野遭遇：进入 wild 节点时先弹「可选分支」对话框（spec §2）。
 *  选「进入荒野割草」→ 启动独立实时小关；选「普通卡牌战」→ 退化为常规战斗流程。
 *  两者都是「可选分支」：wild 节点本身不强制进实时关。 */
function showWildChoice() {
  if (document.getElementById('wild-choice')) return; // 防止重复挂载
  const stage = document.getElementById('stage');
  const overlay = document.createElement('div');
  overlay.className = 'wild-choice';
  overlay.id = 'wild-choice';
  overlay.innerHTML = `
    <div class="wc-box">
      <div class="wc-title">荒野遭遇</div>
      <div class="wc-sub">这个节点前，你要先做个选择：</div>
      <button class="wc-btn wc-wild">进入荒野割草<small>高风险 · 共用主游戏 HP · 75 秒实时割草</small></button>
      <button class="wc-btn wc-battle">普通卡牌战<small>稳妥 · 走常规战斗流程，不掉荒野牌</small></button>
    </div>`;
  stage.appendChild(overlay);
  overlay.querySelector('.wc-wild').onclick = () => { overlay.remove(); startArena(); };
  overlay.querySelector('.wc-battle').onclick = () => { overlay.remove(); startWildAsBattle(); };
}

/** 阶段 6 · 退化为普通战斗（spec §2）。wild 节点本无 enemyId，这里给它补一个常规敌人，
 *  把节点临时当作 battle 处理并直接进入 COMBAT —— 不碰 run.js 一行代码。 */
function startWildAsBattle() {
  markWildHandled(run); // 阶段 6.1：消费标记（否则回地图时会再次弹出选择框，见 isWildPending）
  const node = run.currentNode;
  if (!node.enemyId) {
    const normals = BY_TIER.normal;
    node.enemyId = normals[run.cursor % normals.length].id;
  }
  node.type = 'battle';
  run.phase = PHASE.COMBAT;
  renderPhase();
}

/** 阶段 6 · 荒野遭遇：启动独立实时小关（自有 rAF，与主循环解耦）。
 *  进入即暂停主游戏（主游戏是事件驱动，无连续循环；此处 arena 独占 #stage 顶层）。
 *  退出时把结果接回回合制：存活 → 给 1 张荒野牌（按割草数据三选一）+ 2 张常规池牌；死亡 → 走死亡结算。 */
function startArena() {
  if (arena) return;
  markWildHandled(run); // 阶段 6.1：消费标记（否则取完奖励回地图时会再次弹出选择框）
  const stage = document.getElementById('stage');
  // 子流隔离：荒野关只用 run.rng.sub('wild')，绝不调用主 run.rng → 后续卡牌关 seed 可复现。
  const wildRng = run.rng.sub('wild');
  arena = new Arena({
    stage,
    run,
    rng: wildRng,
    reducedMotion: ui.fx.reduced,
    onDone: (won, core) => {
      arena = null;
      if (won) {
        // 固定 1 张荒野牌（按割草数据映射）+ 2 张常规池牌；主 rng 仅消耗 rollRewardCards(...,2) 那 2 抽。
        run.rewardCards = rollWildReward(run, core);
        run.phase = PHASE.REWARD;
      } else {
        run.finish('dead'); // → OVER / UNLOCK，由 renderPhase 接手
      }
      renderPhase();
    },
  });
  arena.start();
}

function renderPhase() {
  if (!run) {
    ui.renderTitle(meta);
    return;
  }
  switch (run.phase) {
    case PHASE.MAP:
      // 阶段 6：荒野节点拦截。run.js 一行未改 —— run.advance() 对未识别的 wild 落到 default → phase=MAP，
      // 于是「currentNode 是待处理的 wild」就是进入荒野关的钩子（不污染回合制）。
      // 用 isWildPending 而不是 `type === 'wild'`：节点被消费后 cursor 仍停在它上面，
      // 只判 type 会让选择框在取完奖励回地图时**再弹一次**（可无限重复进入，见 arena.js 注释）。
      if (isWildPending(run)) showWildChoice();
      else ui.renderMap(run);
      break;
    case PHASE.COMBAT:
      ensureCombat();
      ui.renderCombat(run, combat);
      break;
    case PHASE.REWARD:
      ui.renderReward(run);
      break;
    case PHASE.EVENT:
      ui.renderEvent(run);
      break;
    case PHASE.REST:
      ui.renderRest(run);
      break;
    case PHASE.REMOVE:
      ui.renderRemove(run);
      break;
    case PHASE.UNLOCK:
      ui.renderUnlock(run);
      break;
    case PHASE.OVER:
      ui.renderOver(run);
      break;
    default:
      ui.renderTitle(meta);
  }
}

/** 开发/验收用：直接跳到第 2 层荒野节点（把上一层标记为已通过，再走正常 advance）。
 *  起因：荒野节点在 F2[0]，手动验收每次都要先打完 4 个节点，反复试玩成本太高。
 *  只动 map 节点的 done 标记 + 调 run.advance()，**不碰 run.js 一行**；不影响正常流程
 *  （仅 ?jump=wild 或 act.jumpWild() 触发）。 */
function jumpWild() {
  if (!run || run.phase === PHASE.OVER || run.phase === PHASE.UNLOCK) return false;
  const wild = run.map.find((n) => n.type === 'wild');
  if (!wild) return false;
  for (const n of run.map) if (n.floor < wild.floor) n.done = true;
  combat = null;
  combatNodeUid = null;
  arena = null;
  run.phase = PHASE.MAP;
  run.advance(); // nextNode = 第一个未完成节点 = 荒野节点 → phase=MAP ⇒ renderPhase 弹可选分支
  renderPhase();
  return true;
}

// 供无头测试与调试使用。
// act.* 是自动化入口：tools/probe-onecard.mjs 会用它把一整局在真实浏览器里跑完，
// 以验证「UI 层 + 状态机 + 战斗循环」在真实 DOM 环境下不会中途炸掉。
window.__ONECARD = {
  get run() {
    return run;
  },
  get combat() {
    return combat;
  },
  // 阶段 6：荒野关实例（含 .core 纯逻辑状态）。暴露出来是为了让诊断脚本能在真实浏览器里
  // 读到 ArenaCore 的运行时状态（帧率/坐标/异常），而不是靠读代码猜「为什么不能左右移动」。
  get arena() {
    return arena;
  },
  meta,
  renderPhase,
  params,
  // 试玩埋点（阶段 4 / T2）：默认关闭，只有 ?log=1 或 localStorage 开启时才会有数据。
  // 把导出函数挂在这里，是为了让真人测试者不用翻控制台 —— 见 docs/06 的回收步骤。
  log: {
    enabled: () => resolveLogEnv().on,
    rows: () => (typeof __ONECARD_LOGS === 'undefined' ? [] : __ONECARD_LOGS),
    dumpJsonl: () => dumpJsonl(),
  },
  act: {
    start: onStartRun,
    advance: () => {
      if (run && run.phase === PHASE.MAP) {
        run.advance();
        renderPhase();
      }
    },
    playCard: onPlayCard,
    endTurn: onEndTurn,
    reward: (cid) => {
      run.takeReward(cid);
      renderPhase();
    },
    event: (i) => {
      run.resolveEvent(i);
      renderPhase();
    },
    rest: (k) => {
      run.resolveRest(k);
      renderPhase();
    },
    remove: (uid) => {
      run.completeRemove(uid);
      renderPhase();
    },
    unlock: (cid) => {
      run.takeUnlock(cid);
      renderPhase();
    },
    // 阶段 6：探针走荒野关用 —— 直接以「存活通关」结束，同步回调 onDone（无需等动画/下一帧）。
    arenaAuto: () => {
      if (arena) arena.forceWin();
    },
    // 阶段 6：探针触发环形冲击波（透传到 ArenaCore，验证主动技能可释放）。
    arenaShock: () => {
      return arena ? arena.shock() : false;
    },
    // 开发/验收用：跳到荒野节点（等价 ?jump=wild），反复试玩不必重打第 1 层。
    jumpWild,
  },
};

// 快捷入口：?arch=blade 直接开局；?jump=wild 直接开局并跳到荒野节点（手动验收用）
if (params.get('arch') || params.get('jump')) onStartRun(params.get('arch') || 'blade');
if (params.get('jump') === 'wild') jumpWild();
if (!params.get('arch') && !params.get('jump')) ui.renderTitle(meta);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) ui.fx.resize();
});
