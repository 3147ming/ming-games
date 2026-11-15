// 波次模式的本地纪录：最高到达波次（含危险等级 / 角色 / 击杀）。
//
// 与 best.js 同一纪律：**只管存读 + 纯函数**，不碰 DOM、顶层不读 localStorage，
// Node 测试里给一个最小 storage shim 就能无头验证。
//
// 为什么单独一个 key：旧 `wild.best.v1` 的三条纪录是「存活秒数 / 击杀 / 等级」，
// 波次模式一局 1275 秒会按存活秒数把旧纪录顶穿；两套模式口径不同，不能混榜。
// 这里只记「走到第几波」——那才是波次模式真正的进度轴。

const KEY = 'wild.waves.best.v1';

const norm = (v) => Math.max(0, Math.floor(Number(v) || 0));

export function loadWaveBest(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    return {
      wave: norm(o.wave),
      danger: norm(o.danger),
      char: String(o.char || 'wanderer'),
      kills: norm(o.kills),
      totalMaterials: norm(o.totalMaterials),
      endless: !!o.endless,
      at: norm(o.at),
    };
  } catch {
    return null;   // 存档损坏 / 隐私模式：当作没有纪录，不影响本局
  }
}

/** 谁更好：波次高 > 危险高 > 击杀多 > 材料多。 */
export function betterWave(a, b) {
  if (!b) return true;
  if (a.wave !== b.wave) return a.wave > b.wave;
  if (a.danger !== b.danger) return a.danger > b.danger;
  if (a.kills !== b.kills) return a.kills > b.kills;
  return a.totalMaterials > b.totalMaterials;
}

/**
 * 提交一局。返回 `{ best, isNew, gap }`：
 *   · best   —— 提交后的纪录（没破纪录就是旧纪录）；
 *   · isNew  —— 是否刷新；
 *   · gap    —— 没刷新时，距纪录还差几波（已刷新为 0）。
 */
export function submitWaveBest(storage, res, now = Date.now()) {
  const prev = loadWaveBest(storage);
  const cur = {
    wave: norm(res && res.wave),
    danger: norm(res && res.danger),
    char: String((res && res.character) || 'wanderer'),
    kills: norm(res && res.kills),
    totalMaterials: norm(res && res.totalMaterials),
    endless: !!(res && res.endless),
    at: now,
  };
  const isNew = betterWave(cur, prev);
  if (isNew) {
    try {
      storage && storage.setItem(KEY, JSON.stringify(cur));
    } catch {
      // 配额满 / 隐私模式：纪录没写进去而已，结算流程不能被它打断
    }
  }
  return { best: isNew ? cur : prev, isNew, gap: prev ? Math.max(0, prev.wave - cur.wave) : 0 };
}

/** 标题页摘要行 / 结算副标题用的一行文案。 */
export function waveBestLine(best) {
  if (!best || !best.wave) return '尚无波次纪录';
  return `最高 第 ${best.wave} 波 · ${best.endless ? '无尽' : `危险 ${best.danger}`}`;
}
