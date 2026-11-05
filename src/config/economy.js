/**
 * 局外经济与任务配置（v0.4）
 *
 * - 一局结束按击杀 / 波次 / 胜负结算金币、声望与丧尸核心；
 * - 任务按存档累计战绩自动推进，领取后发放金币 / 声望 / 材料；
 * - 材料预留给后续身体觉醒、机甲与科研系统消费。
 */

/** 单局结算 */
export const RUN_REWARDS = {
  coinPerKill: 3,
  coinPerWave: 10,
  coinWin: 100,
  coinLose: 15,
  repPerKillDiv: 25,     // 每 25 击杀 +1 声望
  repPerWaveDiv: 3,      // 每 3 波 +1 声望
  repWin: 3,
  repLose: 1,
  coresPerWin: 2,
};

/** 人机队友雇佣成本（守城模式使用） */
export const BOT_HIRE = { coins: 300, reputation: 5 };

/**
 * 任务模板：progress 由存档累计战绩实时计算，不单独存进度。
 * metric: runs / kills / bestWave / bestLevel
 */
export const MISSIONS = [
  {
    id: 'first_run',
    name: '初战告捷',
    desc: '完成任意一局行动',
    metric: 'runs', target: 1,
    reward: { coins: 120, reputation: 2 },
  },
  {
    id: 'purge_100',
    name: '清剿尸潮',
    desc: '累计击杀 100 只丧尸',
    metric: 'kills', target: 100,
    reward: { coins: 180, reputation: 2, cores: 2 },
  },
  {
    id: 'hold_10',
    name: '坚守十波',
    desc: '无尽模式单局守住 10 波',
    metric: 'bestWave', target: 10,
    reward: { coins: 220, reputation: 3, materials: { awaken: 1 } },
  },
  {
    id: 'deep_3',
    name: '深入区域',
    desc: '推进到第 3 关',
    metric: 'bestLevel', target: 3,
    reward: { coins: 260, reputation: 4, materials: { mecha: 1 } },
  },
];

/** 按本局战绩计算结算奖励 */
export function calcRunRewards({ kills = 0, waves = 0, win = false } = {}) {
  const R = RUN_REWARDS;
  const coins = kills * R.coinPerKill + waves * R.coinPerWave + (win ? R.coinWin : R.coinLose);
  const reputation = Math.floor(kills / R.repPerKillDiv)
    + Math.floor(waves / R.repPerWaveDiv)
    + (win ? R.repWin : R.repLose);
  return {
    coins,
    reputation,
    cores: win ? R.coresPerWin : 0,
    // 天赋用觉醒材料，机甲用机甲材料：以波次 / 胜利为主要产出
    materials: {
      awaken: waves >= 3 ? 1 + Math.floor(waves / 3) : 0,
      mecha: win ? 1 : 0,
    },
  };
}

/** 任务当前进度（读取存档累计战绩） */
export function missionProgress(mission, stats) {
  const v = (stats && stats[mission.metric]) || 0;
  return Math.min(mission.target, v);
}
