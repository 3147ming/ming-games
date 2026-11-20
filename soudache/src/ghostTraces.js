/**
 * 幽灵痕迹（Ghost Traces）—— 搜打撤的"有人先来过"氛围系统 · 纯数据层
 * ---------------------------------------------------------------------------
 * 从 ming-games 旧版 soudache（提交 e87a2fe）移植。纪律保持不变：
 *   1. 纯函数：输入 map + 确定性 rand，输出可序列化的痕迹点列表；不碰 three / DOM。
 *   2. **只读 map**：不改 containers / grid / loot 任何数据，纯视觉，零玩法影响。
 *   3. rand 是 [0,1) 函数；调用方用独立 fork 子流，绝不扰动地图/装饰随机序列。
 *
 * ⚠ 与旧版的一处实质修正：
 *   旧版 pickPoint 用 `room.tw * 0.32` 做内缩，但 mapgen 的 `tw/th` 是**格数**
 *   （典型值 4~10），而 `cx/cy` 是逻辑像素坐标 —— 内缩只有 1~3 像素，起点贴着
 *   房间左上角，后面 5 步 × 22px 的脚印整串戳进墙里。新版优先用 `room.w/h`
 *   （carveRoom 同时输出的像素尺寸），并在生成时逐点检查房间边界，出界即停。
 *
 * 痕迹类型：
 *   · footprints  一串脚印（沿房间内一条短直线，暗示有人走过）
 *   · scuff       撬痕/血迹团（单个贴片，暗示搜索或冲突）
 * 坐标用逻辑世界坐标 (x, y)，场景层映射到 (x, height, y)。
 */

/** 房间的像素尺寸：新版 room 同时给 w/h（px）与 tw/th（格），旧数据只有格数 */
function span(room, tile) {
  const w = room && room.w != null ? room.w : (room && room.tw ? room.tw * tile : 0);
  const h = room && room.h != null ? room.h : (room && room.th ? room.th * tile : 0);
  return { w, h };
}

/** 房间内缩后挑一个不与墙强冲突的起点（保守即可，逐点边界检查在生成时做） */
function pickPoint(room, rand, tile) {
  const { w, h } = span(room, tile);
  const mx = w * 0.30;
  const my = h * 0.30;
  const cx = room.cx != null ? room.cx : room.x + w / 2;
  const cy = room.cy != null ? room.cy : room.y + h / 2;
  return { x: cx + (rand() * 2 - 1) * mx, y: cy + (rand() * 2 - 1) * my };
}

/** 点是否仍在房间矩形内（留一点余量给脚印半径） */
function insideRoom(room, x, y, tile, pad) {
  const { w, h } = span(room, tile);
  const x0 = room.x != null ? room.x : (room.cx != null ? room.cx - w / 2 : 0);
  const y0 = room.y != null ? room.y : (room.cy != null ? room.cy - h / 2 : 0);
  return x >= x0 + pad && x <= x0 + w - pad && y >= y0 + pad && y <= y0 + h - pad;
}

/**
 * 生成幽灵痕迹列表。
 * @param {object} map   generateMap 输出（只用 tile / rooms，不改）
 * @param {function} rand [0,1) 随机源（独立子流）
 * @param {object} opts  密度配置 { groups, stepsPerGroup, stepLen }
 * @returns {Array<{type:string,x:number,y:number,angle:number,scale:number}>}
 */
export function generateGhostTraces(map, randSrc, opts = {}) {
  // 数据层只认 [0,1) 函数；新版 createRng/fork 返回的是带 .float() 的对象，
  // 这里做一层薄适配，让纯函数契约和项目随机源两边都不用改。
  const rand = typeof randSrc === 'function'
    ? randSrc
    : (randSrc && typeof randSrc.float === 'function' ? () => randSrc.float() : null);
  if (!rand) return [];
  const groups = opts.groups ?? 4;
  const steps = opts.stepsPerGroup ?? 5;
  const tile = map && map.tile ? map.tile : 40;
  const stepLen = opts.stepLen ?? tile * 0.55;
  const rooms = Array.isArray(map?.rooms) ? map.rooms : [];
  if (rooms.length === 0) return [];

  const out = [];
  const usable = rooms.slice();
  const groupCount = Math.min(groups, Math.max(1, usable.length));

  for (let g = 0; g < groupCount; g++) {
    // 从后段房间挑（远离出生点 rooms[0]），让痕迹更像"深入后留下的"
    const room = usable[usable.length - 1 - g] || usable[g];
    const start = pickPoint(room, rand, tile);
    const angle = rand() * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    // 一串脚印：沿 angle 方向迈步，左右脚交替偏移。出房间即停，绝不穿墙。
    let last = start;
    let laid = 0;
    for (let i = 0; i < steps; i++) {
      const d = i * stepLen;
      const lateral = (i % 2 === 0 ? 1 : -1) * stepLen * 0.22;
      const x = start.x + dx * d - dy * lateral;
      const y = start.y + dy * d + dx * lateral;
      if (!insideRoom(room, x, y, tile, stepLen * 0.3)) break;
      out.push({ type: 'footprint', x, y, angle, scale: 0.9 + rand() * 0.25 });
      last = { x, y };
      laid += 1;
    }
    // 没有任何脚印（房间太小）就跳过这组，不留孤立 scuff
    if (!laid) continue;

    // 痕迹终点放一处 scuff（血迹/撬痕），暗示在此停留下手
    out.push({
      type: 'scuff',
      x: last.x + dx * stepLen * 0.5,
      y: last.y + dy * stepLen * 0.5,
      angle: rand() * Math.PI * 2,
      scale: 0.85 + rand() * 0.5,
    });
  }

  return out;
}
