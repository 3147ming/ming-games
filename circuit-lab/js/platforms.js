/**
 * platforms.js — 双平台几何、可连接节点与连通规则
 *
 * 平台模型（纯数据，无 DOM）：
 *   { id, label, cols, rows, nodes[], nodeMap, groupMap, boxParts[] }
 *
 * 节点 node：{ id, x, y, group, kind, label, partId }
 *   - (x, y) 为网格坐标，渲染层负责等距投影
 *   - group 相同的节点天然同网（面包板 5 孔一组、电源轨整行、插孔区整列）
 *   - 芯片插座每个引脚独立成组（待插芯片后才连通）
 *
 * 节点 / 分组的 id 一律以平台 id 作前缀，例如
 *   breadboard:12-3 / breadboard:col:t12 / exp-box:socket-u1:p1
 * 这样 getConnectedNodes(nodeId) 这类单参数 API 能自行判断归属平台。
 */

/** 面包板行布局（列数可配置，行结构固定） */
export const BREADBOARD_LAYOUT = {
  cols: 63,
  railTopPos: 0,
  railTopNeg: 1,
  topFirst: 2,
  blockRows: 5,
  groove: 7,
  botFirst: 8,
  railBotNeg: 13,
  railBotPos: 14,
  rows: 15,
};

/** 实验箱网格尺寸 */
const BOX_COLS = 36;
const BOX_ROWS = 20;

/**
 * 数字电路实验箱默认套件配置。
 * 部件的位置与数量全部由本数组驱动，改这一份即可贴合用户实拍照片。
 */
export const DEFAULT_BOX_PARTS = [
  { id: 'block-a', kind: 'holes', label: '插孔区 A', x: 1, y: 1, cols: 12, rows: 5 },
  { id: 'block-b', kind: 'holes', label: '插孔区 B', x: 1, y: 7, cols: 12, rows: 5 },
  { id: 'socket-u1', kind: 'dip', label: 'U1 插座 · 14P', x: 15, y: 1, pins: 14 },
  { id: 'socket-u2', kind: 'dip', label: 'U2 插座 · 16P', x: 15, y: 6, pins: 16 },
  { id: 'dip-sw', kind: 'dipswitch', label: '拨码开关 S1 · 8 位', x: 26, y: 1, bits: 8 },
  { id: 'led-bank', kind: 'ledbank', label: '指示灯 · 8 位', x: 26, y: 6, count: 8 },
  { id: 'seg', kind: 'segment', label: '数码管 DS1', x: 1, y: 13 },
  { id: 'power', kind: 'power', label: '电源开关', x: 9, y: 14 },
  { id: 'buzzer', kind: 'buzzer', label: '蜂鸣器', x: 14, y: 14 },
];

/** 平台缓存：同 id 只构建一次 */
const cache = new Map();

/** 从任意 id（节点 / 分组）解析所属平台 id */
function platformIdOf(key) {
  if (typeof key !== 'string') return null;
  const index = key.indexOf(':');
  if (index <= 0) return null;
  const id = key.slice(0, index);
  return cache.has(id) || id === 'breadboard' || id === 'exp-box' ? id : null;
}

/** 打包成平台对象：补 nodeMap、坐标索引、把分组数组成 Map */
function makePlatform({ id, label, cols, rows, nodes, groups, boxParts, note }) {
  const nodeMap = new Map();
  const coordMap = new Map();
  nodes.forEach((node) => {
    nodeMap.set(node.id, node);
    const key = `${node.x},${node.y}`;
    if (!coordMap.has(key)) coordMap.set(key, []);
    coordMap.get(key).push(node.id);
  });
  const groupMap = new Map();
  groups.forEach((members, groupId) => {
    groupMap.set(groupId, members);
  });
  return { id, label, cols, rows, nodes, nodeMap, coordMap, groupMap, boxParts, note };
}

/** 取某网格坐标上的节点 id 列表（拾取时按坐标就近查找） */
export function nodesAt(platformId, x, y) {
  const platform = getPlatform(platformId);
  if (!platform) return [];
  return platform.coordMap.get(`${x},${y}`) || [];
}

/* ==========================================================================
   面包板
   ========================================================================== */

/**
 * 构建面包板：
 *   顶部电源轨 2 行（+ / −）→ 上半区 5 行 → 中央沟槽（无节点）→ 下半区 5 行 → 底部电源轨 2 行（− / +）
 * 连通规则：每列上半区 5 孔一组、下半区 5 孔一组；每条电源轨整行连通。
 */
export function buildBreadboard(overrides = {}) {
  const layout = { ...BREADBOARD_LAYOUT, ...overrides };
  const nodes = [];
  const groups = new Map();

  const push = (x, y, group, kind, label, partId) => {
    const id = `breadboard:${x}-${y}`;
    nodes.push({ id, x, y, group, kind, label, partId });
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(id);
    return id;
  };

  for (let x = 0; x < layout.cols; x += 1) {
    push(x, layout.railTopPos, 'breadboard:rail:tp', 'rail', '+', 'rail-top');
    push(x, layout.railTopNeg, 'breadboard:rail:tn', 'rail', '−', 'rail-top');

    for (let i = 0; i < layout.blockRows; i += 1) {
      push(x, layout.topFirst + i, `breadboard:col:t${x}`, 'hole', '', `block-top-${x}`);
      push(x, layout.botFirst + i, `breadboard:col:b${x}`, 'hole', '', `block-bot-${x}`);
    }

    push(x, layout.railBotNeg, 'breadboard:rail:bn', 'rail', '−', 'rail-bot');
    push(x, layout.railBotPos, 'breadboard:rail:bp', 'rail', '+', 'rail-bot');
  }

  const boxParts = [
    {
      id: 'rail-top', kind: 'rail', label: '＋／－ 电源轨',
      x: 0, y: layout.railTopPos, w: layout.cols, h: 2, polarity: 'top',
    },
    {
      id: 'rail-bot', kind: 'rail', label: '－／＋ 电源轨',
      x: 0, y: layout.railBotNeg, w: layout.cols, h: 2, polarity: 'bottom',
    },
    {
      id: 'body-top', kind: 'block', label: '',
      x: 0, y: layout.topFirst, w: layout.cols, h: layout.blockRows,
    },
    {
      id: 'body-bot', kind: 'block', label: '',
      x: 0, y: layout.botFirst, w: layout.cols, h: layout.blockRows,
    },
    {
      id: 'groove', kind: 'groove', label: '',
      x: 0, y: layout.groove, w: layout.cols, h: 1,
    },
  ];

  return makePlatform({
    id: 'breadboard',
    label: '面包板',
    cols: layout.cols,
    rows: layout.rows,
    nodes,
    groups,
    boxParts,
    note: '63 列 × 10 孔，上下各 5 孔一组横向连通，电源轨整行连通',
  });
}

/* ==========================================================================
   数字电路实验箱
   ========================================================================== */

/** 往容器里加一个节点 */
function addNode(nodes, groups, node, group) {
  nodes.push({ ...node, group });
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(node.id);
}

/** 各部件 → 节点集合。返回该部件的 nodeId 列表，供渲染层标注 */
function buildBoxPart(part, nodes, groups) {
  const ids = [];
  const { id: partId, x, y } = part;

  if (part.kind === 'holes') {
    // 插孔区：每列一整组（与面包板同规则）
    for (let col = 0; col < part.cols; col += 1) {
      for (let row = 0; row < part.rows; row += 1) {
        const nodeId = `exp-box:${partId}:${col}-${row}`;
        addNode(nodes, groups, {
          id: nodeId, x: x + col, y: y + row, kind: 'hole',
          label: '', partId,
        }, `exp-box:${partId}:c${col}`);
        ids.push(nodeId);
      }
    }
    return ids;
  }

  if (part.kind === 'dip') {
    const half = part.pins / 2;
    for (let pin = 1; pin <= part.pins; pin += 1) {
      const isTop = pin <= half;
      // 顶排 1..half 自左向右；底排 pin = half+1..n 自右向左（DIP 逆时针编号）
      const col = isTop ? pin - 1 : part.pins - pin;
      const nodeId = `exp-box:${partId}:p${pin}`;
      addNode(nodes, groups, {
        id: nodeId,
        x: x + col,
        y: y + (isTop ? 0 : 2),
        kind: 'pin',
        label: String(pin),
        partId,
        pin,
      }, `exp-box:${partId}:p${pin}`);
      ids.push(nodeId);
    }
    return ids;
  }

  if (part.kind === 'dipswitch') {
    for (let bit = 0; bit < part.bits; bit += 1) {
      const comId = `exp-box:${partId}:s${bit}-com`;
      const noId = `exp-box:${partId}:s${bit}-no`;
      addNode(nodes, groups, {
        id: comId, x: x + bit, y, kind: 'switch', label: String(bit + 1), partId, bit, role: 'com',
      }, `exp-box:${partId}:s${bit}`);
      addNode(nodes, groups, {
        id: noId, x: x + bit, y: y + 2, kind: 'switch', label: String(bit + 1), partId, bit, role: 'no',
      }, `exp-box:${partId}:s${bit}-no`);
      ids.push(comId, noId);
    }
    return ids;
  }

  if (part.kind === 'ledbank') {
    for (let i = 0; i < part.count; i += 1) {
      const aId = `exp-box:${partId}:a${i}`;
      const kId = `exp-box:${partId}:k${i}`;
      addNode(nodes, groups, {
        id: aId, x: x + i, y, kind: 'led', label: `D${i + 1}`, partId, index: i, role: 'a',
      }, `exp-box:${partId}:a${i}`);
      addNode(nodes, groups, {
        id: kId, x: x + i, y: y + 2, kind: 'led', label: `D${i + 1}`, partId, index: i, role: 'k',
      }, `exp-box:${partId}:k${i}`);
      ids.push(aId, kId);
    }
    return ids;
  }

  if (part.kind === 'segment') {
    // 七段 + 公共端，按数码管字形摆位
    const layout = [
      { seg: 'a', dx: 1, dy: 0 },
      { seg: 'b', dx: 2, dy: 1 },
      { seg: 'c', dx: 2, dy: 3 },
      { seg: 'd', dx: 1, dy: 4 },
      { seg: 'e', dx: 0, dy: 3 },
      { seg: 'f', dx: 0, dy: 1 },
      { seg: 'g', dx: 1, dy: 2 },
    ];
    layout.forEach((item) => {
      const nodeId = `exp-box:${partId}:${item.seg}`;
      addNode(nodes, groups, {
        id: nodeId, x: x + item.dx, y: y + item.dy, kind: 'seg', label: item.seg, partId, seg: item.seg,
      }, `exp-box:${partId}:${item.seg}`);
      ids.push(nodeId);
    });
    const comId = `exp-box:${partId}:com`;
    addNode(nodes, groups, {
      id: comId, x: x + 3, y: y + 2, kind: 'seg', label: 'COM', partId, seg: 'com',
    }, `exp-box:${partId}:com`);
    ids.push(comId);
    return ids;
  }

  if (part.kind === 'power') {
    const aId = `exp-box:${partId}:in`;
    const bId = `exp-box:${partId}:out`;
    addNode(nodes, groups, {
      id: aId, x, y, kind: 'power', label: 'IN', partId, role: 'in',
    }, `exp-box:${partId}:in`);
    addNode(nodes, groups, {
      id: bId, x: x + 2, y, kind: 'power', label: 'OUT', partId, role: 'out',
    }, `exp-box:${partId}:out`);
    ids.push(aId, bId);
    return ids;
  }

  if (part.kind === 'buzzer') {
    const pId = `exp-box:${partId}:p`;
    const nId = `exp-box:${partId}:n`;
    addNode(nodes, groups, {
      id: pId, x, y, kind: 'buzzer', label: '+', partId, role: 'p',
    }, `exp-box:${partId}:p`);
    addNode(nodes, groups, {
      id: nId, x: x + 2, y, kind: 'buzzer', label: '−', partId, role: 'n',
    }, `exp-box:${partId}:n`);
    ids.push(pId, nId);
    return ids;
  }

  return ids;
}

/** 构建实验箱：部件布局完全由 config 决定 */
export function buildExpBox(config = DEFAULT_BOX_PARTS) {
  const nodes = [];
  const groups = new Map();
  const boxParts = config.map((part) => {
    const ids = buildBoxPart(part, nodes, groups);
    return { ...part, nodeIds: ids };
  });

  return makePlatform({
    id: 'exp-box',
    label: '数字电路实验箱',
    cols: BOX_COLS,
    rows: BOX_ROWS,
    nodes,
    groups,
    boxParts,
    note: '插孔区 / 双 DIP 插座 / 8 位拨码 / 8 路指示灯 / 数码管 / 电源 / 蜂鸣器',
  });
}

/* ==========================================================================
   对外 API
   ========================================================================== */

/** 取平台对象；未知 id 返回 null */
export function getPlatform(id) {
  if (id !== 'breadboard' && id !== 'exp-box') return null;
  if (!cache.has(id)) {
    cache.set(id, id === 'breadboard' ? buildBreadboard() : buildExpBox());
  }
  return cache.get(id);
}

/** 列出全部平台（供标题栏 / 下拉使用） */
export function listPlatforms() {
  return [getPlatform('exp-box'), getPlatform('breadboard')];
}

/** 平台 id 是否合法 */
export function isPlatformId(id) {
  return id === 'exp-box' || id === 'breadboard';
}

/** 某分组内的全部节点 id */
export function getNodesOfGroup(groupId) {
  const platform = getPlatform(platformIdOf(groupId));
  if (!platform) return [];
  const members = platform.groupMap.get(groupId);
  return members ? members.slice() : [];
}

/** 与指定节点天然同网的全部节点（不含自身） */
export function getConnectedNodes(nodeId) {
  const platform = getPlatform(platformIdOf(nodeId));
  if (!platform) return [];
  const node = platform.nodeMap.get(nodeId);
  if (!node) return [];
  const members = platform.groupMap.get(node.group) || [];
  return members.filter((id) => id !== nodeId);
}

/** 按 id 取节点 */
export function getNode(nodeId) {
  const platform = getPlatform(platformIdOf(nodeId));
  if (!platform) return null;
  return platform.nodeMap.get(nodeId) || null;
}

/** 平台边界：网格尺寸 */
export function getBounds(platformId) {
  const platform = getPlatform(platformId);
  return platform ? { cols: platform.cols, rows: platform.rows } : null;
}

/** 用自定义 boxParts 重建实验箱（供"按实拍照片调整"使用），返回新平台对象 */
export function rebuildExpBox(config) {
  const platform = buildExpBox(config);
  cache.set('exp-box', platform);
  return platform;
}
