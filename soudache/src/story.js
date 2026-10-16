/**
 * 剧情线（纯数据模块）。
 *
 * 按累计撤离次数推进：每阶段满足 req 即推进并发放奖励，
 * 正文在结算后写入 done，图鉴/剧情页展示。
 */

export const STORY_STAGES = [
  {
    id: 's1',
    req: { extracts: 1 },
    reward: 500,
    title: '首次委托',
    text: '“听好了，菜鸟。战区里到处都是值钱的东西，但命只有一条。' +
      '搜刮、交火、撤离——活下来，把东西带回来，这就是全部规矩。”',
  },
  {
    id: 's2',
    req: { extracts: 3 },
    reward: 800,
    title: '线人情报',
    text: '“你上次带回的情报很有用。雇主说：老兵营地西南角的保险箱里，' +
      '可能锁着一批加密芯片。那地方巡逻很密，自己看着办。”',
  },
  {
    id: 's3',
    req: { extracts: 5, kills: 15 },
    reward: 1200,
    title: '名声渐起',
    text: '“现在道上有人叫你的代号了。记住：名声越大，盯着你的人越多。' +
      '据说有个叫『收割机』的家伙也在那片战区活动——别跟他撞上。”',
  },
  {
    id: 's4',
    req: { extracts: 8, kills: 30 },
    reward: 1800,
    title: '高危委托',
    text: '“雇主点名要你：实验室门卡。那东西在 BOSS 手里，而且那家伙从不离开控制室。' +
      '如果你真有本事，就把它带回来——报酬足够你退役。”',
  },
  {
    id: 's5',
    req: { extracts: 12, bossKills: 1 },
    reward: 3000,
    title: '终局',
    text: '“你做到了。门卡、情报、那条从战区活着走出来的路——' +
      '你已经不是新手了。战区还有别的故事，等你回来。”',
  },
];

/** 检查存档是否满足当前阶段要求（达标则推进） */
export function checkStoryProgress(save) {
  const story = save.story || { stage: 0, done: [] };
  const stage = STORY_STAGES[story.stage];
  if (!stage) return null; // 全部完成
  const stats = save.stats || {};
  const extracts = stats.extracts || 0;
  const kills = stats.kills || 0;
  const bossKills = stats.bossKills || 0;
  const r = stage.req;
  if (extracts >= r.extracts && kills >= (r.kills || 0) && bossKills >= (r.bossKills || 0)) {
    return stage;
  }
  return null;
}

/**
 * 推进剧情：只要当前阶段达标就连续结算（一局可能连过两关），发奖励并写入 done。
 * 幂等 —— 已完成的阶段不会重复发放。
 * @param {object} save 存档对象（原地修改）
 * @returns {object[]} 本次新完成的阶段列表
 */
export function advanceStory(save) {
  if (!save.story) save.story = { stage: 0, done: [] };
  if (!Array.isArray(save.story.done)) save.story.done = [];
  const done = [];
  for (let guard = 0; guard < STORY_STAGES.length + 1; guard += 1) {
    const stage = checkStoryProgress(save);
    if (!stage) break;
    if (!save.story.done.includes(stage.id)) {
      save.story.done.push(stage.id);
      save.currency += stage.reward;
    }
    save.story.stage += 1;
    done.push(stage);
  }
  return done;
}

/** 当前阶段（未完成则为下一个待达成的阶段） */
export function currentStage(save) {
  const story = save.story || { stage: 0 };
  return STORY_STAGES[story.stage] || null;
}
