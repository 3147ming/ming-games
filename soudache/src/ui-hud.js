// SOUDACHE — HUD 布局原语（从 ui.js 抽出：纯函数，同时喂给 canvas 绘制与布局体检工具）
// 为什么独立成模块：HUD 全部画在 canvas 上，DOM 查不到元素，tools/check-touch-layout.mjs
// 与 tests/ui-hud-layout.test.mjs 直接读这份布局，真值只有一处。
import { MINIMAP, KILLFEED } from './config.js';

export function hudLayout(W, H, touch = false, tasksOpen = false) {
  if (touch) {
    // 触屏横屏：视口从 667×375（iPhone SE）到 1024×768，H 极小。两个拇指要占住
    // 左右下角，于是 HUD 重排为「贴上沿的左半区 + 中列 + 贴上沿的右半区」，
    // 底部左边一行留给武器槽与移动按钮，底部中间整条空出来。
    //
    // 硬约束（与 styles.css 的触屏块一一对应，改一处必须同时改另一处）：
    //   · 右半区所有 HUD 右缘 ≤ W-104，把开火键区完整让出；
    //   · 左半区所有 HUD 底缘 ≤ 246，把左下角 118px 摇杆 + 两行按钮让出；
    //   · 背包/暂停固定在**移动按钮行右侧**（x = 11.5vw + 328px），这条带
    //     在所有分辨率下都恒定空闲 —— 早先放在"顶部正中、计时与武器卡之间"
    //     的空档里，窄屏（844/740）实测直接压进武器卡。
    //   · 中列（计时 / 击杀流 / 罗盘）三者**共用同一段 [midX, midX+midW]**，
    //     宽度由左右两半区倒推，绝不写死 —— 写死 240/300 时 667 宽的
    //     iPhone SE 上罗盘右缘会到 393，压进武器卡左缘 355
    //     （tests/ui-hud-layout.test.mjs 锁住这条）。
    //   · 体检与扫描工具直接读本函数，不另写百分比：
    //     tools/check-touch-layout.mjs、tools/scan-layout.mjs。
    const RIGHT = W - 104;       // 开火键区左缘
    const STICK_CX = W * 0.115;  // 摇杆圆心（styles.css 的 left: 11.5vw）
    const missionW = Math.min(214, Math.round(W * 0.29));  // 左半区统一宽度
    const weaponW = Math.max(150, Math.min(208, RIGHT - (missionW + 28) - 130));
    const midL = missionW + 28;                 // 中列左缘（左半区右缘 + 14）
    const midR = RIGHT - weaponW - 10;          // 中列右缘（武器卡左缘 - 10）
    const midW = Math.max(110, Math.min(300, midR - midL));
    const midX = Math.round((midL + midR) / 2 - midW / 2);
    const timerW = Math.max(96, Math.min(112, midW));
    const slots = {
      x: Math.round(STICK_CX) + 68, slotW: 88, slotH: 38,
      y: H - 108, gap: 6, align: 'left', compact: true,
    };
    // 顶层读数条：两行（击杀+搜刮 / 负重），比原先 5 行矮一半。
    const STRIP_H = 44;
    // 中层任务面板：折叠 = 一条 24px 标题；展开 = 标题 + 目标行 + 2 条合约。
    // ⚠ 展开态是 3 行不是 2 行：目标概览（终端/空投）独占第一行，
    // 它是"下一步去哪"的唯一指引，不能挤进合约行里。
    const TASK_HEAD_H = 24;
    const TASK_ROW_H = 22;
    const TASK_ROWS_OPEN = 4; // 目标行 + 3 条合约（contractCount 已为 3）
    const tasksY = 12 + STRIP_H + 6;                       // 紧贴读数条下方
    const tasksH = tasksOpen ? TASK_HEAD_H + TASK_ROWS_OPEN * TASK_ROW_H : TASK_HEAD_H;
    return {
      touch: true,
      // 顶层读数条：击杀 / 搜刮 / 负重（随身估值已移入背包页）
      stateStrip: {
        x: 14, y: 12, w: missionW, h: STRIP_H,
        rowY: [18, 36], col2: Math.round(missionW * 0.46), compact: true,
      },
      // 中层任务面板：折叠时只画标题（完成计数 + 展开提示）
      tasks: {
        x: 14, y: tasksY, w: missionW, h: tasksH,
        headH: TASK_HEAD_H, rowH: TASK_ROW_H, rowsOpen: TASK_ROWS_OPEN,
        open: tasksOpen, compact: true,
      },
      // 血条：压成三条扁条（每条 20px）。底缘必须 ≤246 —— 摇杆要能塞进左下角。
      // 位置随 tasks 面板高度浮动，折叠时自动上移，把空间还给视野。
      bars: {
        x: 14, y: tasksY + tasksH + 6, w: missionW, h: 68,
        barX: 26, barW: missionW - 36, rowH: 20, barH: 8,
        firstY: tasksY + tasksH + 6 + 14,
      },
      // 计时：中列正中，宽度不超中列；h=52 才容得下 timeY=38 / labelY=50 两行
      timer: {
        x: Math.round((midL + midR) / 2 - timerW / 2), y: 10,
        w: timerW, h: 52, timeY: 38, labelY: 50, compact: true,
      },
      // 武器卡：右对齐到 RIGHT，整块让开开火键区。宽度随视口收窄，
      // 内部各锚点按比例跟随之（否则窄屏下弹药数会跑出卡外）
      // P1-5 紧凑化：卡高 82→68、弹药字号 24→20、各基线整体上收。
      weapon: {
        x: RIGHT - weaponW, y: 10, w: weaponW, h: 68,
        nameY: 20, subY: 33, ammoY: 44, footY: 56,
        ammoX: RIGHT - Math.round(weaponW * 0.28),
        reserveX: RIGHT - 16,
        barX: RIGHT - Math.round(weaponW * 0.38),
        barW: Math.round(weaponW * 0.3),
        barY: 60, compact: true,
      },
      // P1-5：小地图压到 120×88，贴在武器卡下方（10+68+8=86）
      minimap: {
        x: RIGHT - Math.min(120, weaponW), y: 86,
        w: Math.min(120, weaponW), h: 88,
      },
      // 击杀流：贴中列，限 2 条（横屏没有竖向空间给 5 条）
      killfeed: { x: midX, y: 100, w: midW, rowH: 20, max: 2, compact: true },
      // 罗盘：与计时/击杀流**共用中列**，因此永不与右半区相撞
      // P0-3：紧贴大号计时下方，压到 28px 高（原 24）
      compass: { x: midX, w: midW, y: 62, h: 28 },
      // 武器槽：横排在移动按钮行正上方。x 与按钮行起点对齐（11.5vw + 66px + 2）
      slots,
      medHintY: H - 118,
      // P1 新增：三人小队折叠成一条（横屏没有竖向空间放三张卡）。
      // 塞在血条下方 6px、任务折叠时底缘 206 < 246 的摇杆禁区线；任务展开则整体隐藏。
      squad: {
        x: 14, y: tasksY + tasksH + 80, w: missionW, h: 40,
        hidden: tasksOpen, compact: true,
      },
      exfilBar: null, // 横屏把撤离倒计时并入罗盘右侧芯片，不再另占一行
      tactical: { mode: 'compact', x: RIGHT - 120, y: slots.y - 14, w: 120, h: 12 },
      // 交互提示：准星正下方 44px；H 极小时自动上移，不撞武器槽顶
      prompt: {
        x: Math.round(W / 2) - 100,
        y: Math.min(Math.round(H / 2) + 44, slots.y - 52),
        w: 200, h: 46, titleDY: 18, subDY: 34, compact: true,
      },
    };
  }
  // ---- 桌面端 ----
  // 任务面板从 5 行 116px 压成两行读数条；合约移到独立的中层 tasks 面板。
  const STRIP_H = 62;
  const TASK_HEAD_H = 30;
  const TASK_ROW_H = 30;
  const TASK_ROWS_OPEN = 4; // 目标行 + 3 条合约（contractCount 已为 3）
  const tasksY = 16 + STRIP_H + 8;
  const tasksH = tasksOpen ? TASK_HEAD_H + TASK_ROWS_OPEN * TASK_ROW_H : TASK_HEAD_H;

  /* ---- 窄桌面降级档（W < 1240）----
   * 底部这一排是按 1280 调的：4 格快捷栏 4×132+3×8=552 居中、技能环在 ±306、
   * 血条面板 268 宽、小地图 244 宽。把这三样代入不等式就知道临界点：
   *   · 左环左缘 W/2-323 要避开血条右缘 284  → W ≥ 1230
   *   · 右环（含就绪金圈 r+4）右缘 W/2+327 要避开小地图左缘 W-256 → W ≥ 1182
   * 也就是说 1240 以下必然相撞 —— 960×540 实测截图里环正压在血条与小地图上，
   * 快捷栏右端还钻进小地图底下（P5 给环填了真内容后才显形）。
   * ≥1240 的所有字段一个都不动：tests/p1-hud.test.mjs 与 check-touch-layout.mjs
   * 把 1280/2560 当真值源，那里挪一个像素就是回归。
   * 这一档只做三件事：快捷栏收窄、小地图缩小、技能环挪到小地图正上方并排。 */
  const NARROW = W < 1240;
  const slotW = NARROW ? 96 : 132;
  const slotGap = NARROW ? 6 : 8;
  const slotH = NARROW ? 40 : 44;
  const slotY = NARROW ? H - 58 : H - 62;
  // 血条：窄档收到 236，与左上读数条/任务面板同宽（268 会压住 960 下居中的快捷栏）
  const vitalsW = NARROW ? 236 : 268;
  const mmW = NARROW ? 176 : MINIMAP.width;
  const mmH = NARROW ? 132 : MINIMAP.height;
  const mmPad = NARROW ? 10 : MINIMAP.padding;
  const mmX = W - mmW - mmPad;
  const mmY = H - mmH - mmPad;
  const RING_R = NARROW ? 15 : 17;
  // 窄档：两环并排贴在小地图正上方 —— 小地图已占住最右下角，这块象限恒空。
  // cy 留 mmY-58 而不是贴着走：小地图上沿还有一行右对齐的「MAP · SEED n」标签
  // （基线 mmY-6），环的副标（基线 cy+r+10）必须让开它，否则两行小字挤成一坨。
  // 宽档：沿用 ±306 的护翼位（= 快捷栏半宽 276 + r 17 + 13 呼吸，别改成别的常数）。
  const tactical = NARROW
    ? {
      mode: 'rings',
      left: { cx: Math.round(mmX + mmW / 2 - 19), cy: mmY - 58, r: RING_R },
      right: { cx: Math.round(mmX + mmW / 2 + 19), cy: mmY - 58, r: RING_R },
    }
    : {
      mode: 'rings',
      left: { cx: W / 2 - 306, cy: H - 40, r: RING_R },
      right: { cx: W / 2 + 306, cy: H - 40, r: RING_R },
    };
  return {
    touch: false,
    stateStrip: {
      x: 16, y: 16, w: 236, h: STRIP_H,
      rowY: [22, 46], col2: 110, compact: false,
    },
    tasks: {
      x: 16, y: tasksY, w: 236, h: tasksH,
      headH: TASK_HEAD_H, rowH: TASK_ROW_H, rowsOpen: TASK_ROWS_OPEN,
      open: tasksOpen, compact: false,
    },
    bars: {
      x: 16, y: H - 118, w: vitalsW, h: 102,
      barX: 30, barW: vitalsW - 28, rowH: 30, barH: 12, firstY: H - 96,
    },
    timer: { x: W / 2 - 92, y: 14, w: 184, h: 52, timeY: 48, labelY: 60, compact: false },
    weapon: {
      x: W - 246, y: 16, w: 230, h: 92,
      nameY: 22, subY: 38, ammoY: 46, footY: 66,
      ammoX: W - 86, reserveX: W - 30, barX: W - 170, barW: 110, barY: 72, compact: false,
    },
    killfeed: { x: W - 16 - KILLFEED.width, y: 124, w: KILLFEED.width, rowH: KILLFEED.rowH, max: KILLFEED.max, compact: false },
    minimap: { x: mmX, y: mmY, w: mmW, h: mmH },
    compass: { x: W / 2 - 180, w: 360, y: 72, h: 24 },
    slots: { slotW, slotH, y: slotY, gap: slotGap, align: 'center', compact: NARROW },
    medHintY: H - 68,
    prompt: { x: W / 2 - 110, y: H - 150, w: 220, h: 50, titleDY: 22, subDY: 40, compact: false },
    // ---- P1 新增区块。上面既有字段的坐标一个都没动：check-touch-layout.mjs 与
    // tests/ui-hud-layout.test.mjs 把它们当真值源，挪一个像素就会误报回归。 ----
    squad: { x: 16, y: tasksY + tasksH + 8, w: 236, h: 96, hidden: false, compact: false },
    // 罗盘下方独立撤离条：y = 72+24+4 = 100~116，击杀流从 124 起，留 8px 呼吸
    exfilBar: { x: W / 2 - 76, y: 100, w: 152, h: 16 },
    // 按 4 槽的最宽情形定位，武器只有 3 把时两侧护翼对称留白，不压快捷栏。
    // 窄桌面档改挂在小地图正上方（见上方 NARROW 段）。
    tactical,
  };
}
