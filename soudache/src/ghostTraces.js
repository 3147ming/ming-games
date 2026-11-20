/**
 * 幽灵痕迹（Ghost Traces）—— 搜打撤的"有人先来过"氛围系统 · 纯数据层
 * ---------------------------------------------------------------------------
 * 设计目标（对应盘点「零玩家对抗」的最大空白）：
 *   在单人局里用**环境叙事**制造"别的拾荒者刚来过"的紧张感 —— 脚印通向被撬开的
 *   容器、地上残留的血迹。它不引入真实 PVP，却给玩家"我可能不是第一个"的压迫感。
 *
 * 纪律：
 *   1. 纯函数：输入 map + 确定性 rand，输出可序列化的痕迹点列表；不碰 three / DOM。
 *   2. **只读 map**：不改 containers / grid / loot 任何数据，纯视觉，零玩法影响。
 *   3. rand 是 [0,1) 函数；调用方用独立 fork 子流，绝不扰动地图/装饰随机序列。
 *
 * 痕迹类型：
 *   · footprints  一串脚印（沿房间内一条短直线，暗示有人走过）
 *   · scuff       撬痕/血迹团（单个贴片，暗示搜索或冲突）
 * 坐标用逻辑世界坐标 (x, y)，场景层映射到 (x, height, y)。
 */

/** 在房间内挑一个不与墙/掩体强冲突的起点（用房间内缩边界，保守即可）。 */
function pickPoint(room, rand) {
  const mx = room.tw * 0.32;
  const my = room.th * 0.32;
  const x = (room.cx || room.tx + room.tw / 2) + (rand() * 2 - 1) * mx;
  const y = (room.cy || room.ty + room.th / 2) + (rand() * 2 - 1) * my;
  return { x, y };
}

/**
 * 生成幽灵痕迹列表。
 * @param {object} map   generateMap 输出（只用 rooms / containers，不改）
 * @param {function} rand [0,1) 随机源（独立子流）
 * @param {object} opts  密度配置 { groups, stepsPerGroup, stepLen }
 * @returns {Array<{type:string,x:number,y:number,angle:number,scale:number}>}
 */
export function generateGhostTraces(map, rand, opts = {}) {
  const groups = opts.groups ?? 4;
  const steps = opts.stepsPerGroup ?? 5;
  const stepLen = opts.stepLen ?? (map.tile ? map.tile * 0.55 : 22);
  const rooms = Array.isArray(map?.rooms) ? map.rooms : [];
  if (rooms.length === 0) return [];

  const out = [];
  const usable = rooms.slice();
  const groupCount = Math.min(groups, Math.max(1, usable.length));

  for (let g = 0; g < groupCount; g++) {
    // 从后段房间挑（远离出生点 rooms[0]），让痕迹更像"深入后留下的"
    const room = usable[usable.length - 1 - g] || usable[g];
    const start = pickPoint(room, rand);
    const angle = rand() * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    // 一串脚印：沿 angle 方向迈步，左右脚交替偏移
    for (let i = 0; i < steps; i++) {
      const d = i * stepLen;
      const lateral = (i % 2 === 0 ? 1 : -1) * stepLen * 0.22;
      out.push({
        type: 'footprint',
        x: start.x + dx * d - dy * lateral,
        y: start.y + dy * d + dx * lateral,
        angle,
        scale: 0.9 + rand() * 0.25,
      });
    }

    // 痕迹终点放一处 scuff（血迹/撬痕），暗示在此停留下手
    const endD = steps * stepLen;
    out.push({
      type: 'scuff',
      x: start.x + dx * endD,
      y: start.y + dy * endD,
      angle: rand() * Math.PI * 2,
      scale: 0.85 + rand() * 0.5,
    });
  }

  return out;
}
