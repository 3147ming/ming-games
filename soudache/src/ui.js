/**
 * 战斗 HUD 布局：**纯函数**，同时喂给 canvas 绘制与布局体检工具。
 *
 * 为什么必须抽出来：HUD 全部画在 canvas 上，DOM 里查不到任何元素，
 * 以前 tools/check-touch-layout.mjs 只能按"实拍量取百分比"硬编码禁区，
 * 结果漏掉了小地图（[676,234→920,418]，被整个开火键区盖住）与击杀流。
 * 现在绘制与体检读同一份 L，真值只有一处。
 *
 * 手机横屏（触屏）另有一套坐标：拇指要占住左右两个下角，
 * 所以血条上移到左上任务面板下方，小地图缩到右上角让开开火键。
 *
 * ## 三层信息架构（第四轮重构）
 *
 * 玩家反馈"左侧信息密度过高，移动端看不清"。原先 5 行全堆在左上：
 *   任务状态 / 击杀+搜刮 / 随身估值 / 负重 / 目标·终端·空投
 * 拆成三层，每层只回答一个问题：
 *
 *   · **顶层（常驻）** — 我现在什么状态？血/甲/体力/弹药/小地图/倒计时，
 *     加上 stateStrip 这一条：击杀、搜刮、负重。**这一层永远可见、绝不折叠**，
 *     因为它是"读数"，不看就会死。
 *   · **中层（可展开收起）** — 我该做什么？tasks 面板。默认**折叠成一条标题**，
 *     按 J / 点"任务"钮展开完整合约清单。原因：合约是"待办"，不是"读数"，
 *     折叠后把 216px 宽 × 116px 高让出来给视野。
 *   · **底层（弹窗）** — 我身上有什么？背包 / 地图 / 合约详情。
 *     随身估值 ¥98,220 从常驻 HUD **移入背包页** —— 它是资产信息，
 *     不是战况信息，盯着一串不断变长的数字只会让人分心。
 *
 * tasksOpen 会改变 tasks 面板高度，因此它是 hudLayout 的**入参**而不是内部状态：
 * 布局函数保持纯粹，展开/收起两套坐标都能被 tests 与体检工具直接验证。
 *
 * @param {number} W 视口宽
 * @param {number} H 视口高
 * @param {boolean} touch 是否触屏（手机横屏布局）
 * @param {boolean} tasksOpen 中层任务面板是否展开
 * @returns {object} 各 HUD 区块的矩形与文本基线
 */
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
      weapon: {
        x: RIGHT - weaponW, y: 10, w: weaponW, h: 82,
        nameY: 30, subY: 46, ammoY: 58, footY: 76,
        ammoX: RIGHT - Math.round(weaponW * 0.28),
        reserveX: RIGHT - 16,
        barX: RIGHT - Math.round(weaponW * 0.38),
        barW: Math.round(weaponW * 0.3),
        barY: 66, compact: true,
      },
      minimap: {
        x: RIGHT - Math.min(128, weaponW), y: 100,
        w: Math.min(128, weaponW), h: 96,
      },
      // 击杀流：贴中列，限 2 条（横屏没有竖向空间给 5 条）
      killfeed: { x: midX, y: 100, w: midW, rowH: 20, max: 2, compact: true },
      // 罗盘：与计时/击杀流**共用中列**，因此永不与右半区相撞
      compass: { x: midX, w: midW, y: 62, h: 24 },
      // 武器槽：横排在移动按钮行正上方。x 与按钮行起点对齐（11.5vw + 66px + 2）
      slots,
      medHintY: H - 118,
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
      x: 16, y: H - 118, w: 268, h: 102,
      barX: 30, barW: 240, rowH: 30, barH: 12, firstY: H - 96,
    },
    timer: { x: W / 2 - 92, y: 14, w: 184, h: 52, timeY: 48, labelY: 60, compact: false },
    weapon: {
      x: W - 246, y: 16, w: 230, h: 92,
      nameY: 22, subY: 38, ammoY: 46, footY: 66,
      ammoX: W - 86, reserveX: W - 30, barX: W - 170, barW: 110, barY: 72, compact: false,
    },
    killfeed: { x: W - 16 - KILLFEED.width, y: 124, w: KILLFEED.width, rowH: KILLFEED.rowH, max: KILLFEED.max, compact: false },
    minimap: {
      x: W - MINIMAP.width - MINIMAP.padding,
      y: H - MINIMAP.height - MINIMAP.padding,
      w: MINIMAP.width,
      h: MINIMAP.height,
    },
    compass: { x: W / 2 - 180, w: 360, y: 72, h: 24 },
    slots: { slotW: 132, slotH: 44, y: H - 62, gap: 8, align: 'center', compact: false },
    medHintY: H - 68,
    prompt: { x: W / 2 - 110, y: H - 150, w: 220, h: 50, titleDY: 22, subDY: 40, compact: false },
  };
}

/**
 * DOM 覆盖层 UI：主菜单 / 仓库 / 商店 / 战前配置 / 结算 / 暂停 / 战利品面板 / 背包
 *
 * 战斗画面由 Canvas 渲染，UI 全部走 DOM —— 交互与排版都更省心，也更好看。
 */

import {
  ITEMS, WEAPONS, ARMORS, SHOP, RARITY, RARITY_ORDER, CONTAINERS, ENEMY_TYPES, PLAYER, MATCH, AMMO_STACK, SCORING,
  COLORS, MINIMAP, MINIMAP_LAYERS, TILE, WORLD_W, WORLD_H, COMBAT, KILLFEED,
} from './config.js';
import { totalWeight, totalValue, itemCount, weightLimitFor, weightTier } from './inventory.js';
import { drawGlyph } from './glyphs.js';
import { EnemyState } from './enemy.js';
import { sortTasksByPriority } from './contracts.js';

/** 等宽 / 无衬线字体（与旧 2D 渲染器保持一致） */
const MONO = '"Consolas", "SFMono-Regular", "JetBrains Mono", "Courier New", monospace';
const SANS = '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/** 圆角矩形路径（不填充，需调用方自行 fill / stroke） */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 物品图标（复用 Canvas 的矢量图标，避免重复美术资源） */
function iconEl(kind, color, size = 26) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.className = 'icon';
  canvas.width = Math.floor(size * dpr);
  canvas.height = Math.floor(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  drawGlyph(ctx, kind, size / 2, size / 2, size * 0.74, color);
  return canvas;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function money(n) {
  return `¥${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * 创建 UI 控制器。
 * @param {HTMLElement} root UI 根节点
 * @param {object} handlers 动作处理函数表
 * @returns {object} UI 控制器
 */
export function createUI(root, handlers) {
  root.innerHTML = `
    <div class="screen" data-screen="menu">
      <div class="menu">
        <div class="menu-brand">
          <div class="logo">搜打撤</div>
          <div class="tagline">SEARCH · STRIKE · EXTRACT</div>
          <div class="menu-sub">搜刮物资 → 交火突围 → 活着撤离，带出去的才算你的。</div>
        </div>
        <div class="menu-stats" data-role="menu-stats"></div>
        <div class="menu-actions">
          <button class="btn primary" data-action="goto-loadout">开始战局</button>
          <button class="btn" data-action="goto-stash">仓库</button>
          <button class="btn" data-action="goto-shop">商店</button>
          <button class="btn" data-action="goto-howto">玩法说明</button>
        </div>
        <div class="menu-foot">
          <button class="link" data-action="toggle-mute">音效开关</button>
          <button class="link danger" data-action="reset-save">清空存档</button>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="loadout">
      <div class="panel wide">
        <header class="panel-head">
          <h2>战前配置</h2>
          <div class="head-right">
            <span class="coin" data-role="loadout-currency"></span>
            <button class="btn ghost" data-action="goto-menu">返回</button>
          </div>
        </header>
        <div class="panel-body">
          <div class="loadout-grid">
            <div class="loadout-col" data-role="loadout-options"></div>
            <aside class="loadout-side">
              <div class="side-block">
                <h3>负重估算</h3>
                <div data-role="loadout-weight"></div>
              </div>
              <div class="side-block">
                <h3>地图种子</h3>
                <input class="seed-input" data-role="seed" placeholder="留空则随机" inputmode="numeric" />
                <p class="hint">同一种子会生成完全相同的地图、战利品与敌人分布。</p>
              </div>
              <div class="side-block warn-block" data-role="loadout-warn"></div>
              <button class="btn primary big" data-action="deploy">部署进入战局</button>
            </aside>
          </div>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="stash">
      <div class="panel wide">
        <header class="panel-head">
          <h2>仓库 STASH</h2>
          <div class="head-right">
            <span class="coin" data-role="stash-currency"></span>
            <button class="btn ghost" data-action="goto-menu">返回</button>
          </div>
        </header>
        <div class="panel-body stash-body">
          <div class="grid-wrap">
            <div class="grid" data-role="stash-grid"></div>
          </div>
          <aside class="stash-side">
            <div class="side-block">
              <h3>仓库统计</h3>
              <div data-role="stash-stats"></div>
            </div>
            <div class="side-block">
              <h3>选中物品</h3>
              <div data-role="stash-detail"><p class="hint">点击左侧格子中的物品查看详情。</p></div>
            </div>
            <div class="side-block">
              <button class="btn" data-action="goto-shop">前往商店</button>
              <button class="btn ghost" data-action="sell-all">一键出售全部物资</button>
            </div>
          </aside>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="shop">
      <div class="panel wide">
        <header class="panel-head">
          <h2>商店 MARKET</h2>
          <div class="head-right">
            <span class="coin" data-role="shop-currency"></span>
            <button class="btn ghost" data-action="goto-menu">返回</button>
          </div>
        </header>
        <div class="panel-body shop-body">
          <section class="shop-col">
            <h3>购买</h3>
            <div class="shop-list" data-role="shop-buy"></div>
          </section>
          <section class="shop-col">
            <h3>出售（仓库）</h3>
            <div class="shop-list" data-role="shop-sell"></div>
          </section>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="howto">
      <div class="panel">
        <header class="panel-head">
          <h2>玩法说明</h2>
          <div class="head-right"><button class="btn ghost" data-action="goto-menu">返回</button></div>
        </header>
        <div class="panel-body howto-body">
          <section>
            <h3>核心循环</h3>
            <p>战前配置装备 → 部署进图 → <b>搜索</b>容器拿物资 → 与 AI <b>交火</b> → 限时内抵达<b>撤离点</b>读条撤离。</p>
            <p class="danger">撤离成功：随身物资全部入库。阵亡或超时：随身物资与带入装备全部丢失（仓库里的不动）。</p>
          </section>
          <section>
            <h3>操作</h3>
            <ul class="keys">
              <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动</li>
              <li><kbd>鼠标</kbd> 瞄准 · <kbd>左键</kbd> 射击</li>
              <li><kbd>R</kbd> 换弹 · <kbd>Q</kbd> 使用医疗物资</li>
              <li><kbd>E</kbd> 搜索 / 撤离 / 交互</li>
              <li><kbd>Ctrl</kbd> 蹲行（更安静、更难被发现）</li>
              <li><kbd>Shift</kbd> 冲刺（消耗体力，体力耗尽无法冲刺，静止快速恢复）</li>
              <li><kbd>1</kbd><kbd>2</kbd> 切换武器 · <kbd>Tab</kbd> 背包 · <kbd>Esc</kbd> 暂停</li>
              <li><kbd>V</kbd> 绳索速降（从高地快速下滑）</li>
              <li><kbd>F</kbd> 上车 / 下车</li>
            </ul>
          </section>
          <section>
            <h3>生存要点</h3>
            <ul class="tips">
              <li>敌人有视野锥，被墙挡住就看不见你；他们也会听枪声和脚步。</li>
              <li>保险箱价值最高，但搜索时间最长 —— 记得先清场再开。</li>
              <li>超重会明显减速并拖慢体力恢复，别什么都往包里塞。</li>
              <li>单局 ${Math.round(MATCH.duration / 60)} 分钟，最后 ${MATCH.extractOpenAt / 60} 分钟撤离通道才会开启，站定 ${MATCH.extractChannel} 秒即可撤离。</li>
              <li>地图固定 ${MATCH.extractTotal} 个撤离点（灰色未开放、绿色已开启），撤离成功带走全部物资，阵亡则尽数丢失。</li>
              <li>敌人被击杀后会留下可搜索的尸体。</li>
            </ul>
          </section>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="result">
      <div class="panel wide">
        <div class="result-head" data-role="result-head"></div>
        <div class="panel-body result-body">
          <div class="result-stats" data-role="result-stats"></div>
          <div class="result-loot">
            <h3 data-role="result-loot-title">带出物资</h3>
            <div class="loot-list" data-role="result-loot"></div>
          </div>
        </div>
        <footer class="panel-foot">
          <button class="btn primary" data-action="result-stash">返回仓库</button>
          <button class="btn" data-action="result-again">再来一局</button>
          <button class="btn ghost" data-action="goto-menu">主菜单</button>
        </footer>
      </div>
    </div>

    <div class="screen overlay" data-screen="pause">
      <div class="panel narrow">
        <header class="panel-head"><h2>已暂停</h2></header>
        <div class="panel-body">
          <p class="hint">战局已暂停。放弃战局将视为阵亡，随身物资全部丢失。</p>
          <button class="btn toggle" data-action="toggle-invert" data-role="invert-toggle">鼠标水平轴：反转</button>
          <button class="btn toggle" data-action="toggle-aim-assist" data-role="aim-toggle">辅助瞄准：开</button>
          <div class="setting-row">
            <label>视野 FOV</label>
            <input type="range" min="60" max="100" step="1" value="75" data-role="fov-slider">
            <span class="setting-val" data-role="fov-val">75°</span>
          </div>
          <div class="setting-row">
            <label>鼠标灵敏度</label>
            <input type="range" min="0.3" max="3" step="0.1" value="1" data-role="sens-slider">
            <span class="setting-val" data-role="sens-val">1.00×</span>
          </div>
          <div class="setting-row touch-only">
            <label>触屏灵敏度</label>
            <input type="range" min="0.3" max="2" step="0.05" value="1" data-role="touch-sens-slider">
            <span class="setting-val" data-role="touch-sens-val">1.00×</span>
          </div>
          <div class="setting-row touch-only">
            <label>按钮大小</label>
            <input type="range" min="0.8" max="1.3" step="0.05" value="1" data-role="btn-scale-slider">
            <span class="setting-val" data-role="btn-scale-val">100%</span>
          </div>
          <button class="btn touch-only" data-action="edit-layout" data-role="edit-layout-btn">编辑按钮布局</button>
          <div class="hint touch-only">编辑模式下在游戏中拖动按钮可调整位置，完成后点「完成编辑」。</div>
          <div class="hint touch-only">右侧空白处直接滑动即可转动视角，无需轮盘。</div>
        </div>
        <footer class="panel-foot">
          <button class="btn primary" data-action="resume">继续</button>
          <button class="btn danger" data-action="abandon">放弃战局</button>
        </footer>
      </div>
    </div>

    <div class="battle-panel hidden" data-role="loot">
      <header>
        <span data-role="loot-title">容器</span>
        <button class="icon-btn" data-action="loot-close">×</button>
      </header>
      <div class="loot-list" data-role="loot-list"></div>
      <footer>
        <button class="btn small primary" data-action="loot-take-all">全部拾取</button>
        <span class="hint" data-role="loot-hint"></span>
      </footer>
    </div>

    <div class="battle-panel hidden" data-role="backpack">
      <header>
        <span>背包（点击物品丢弃）</span>
        <button class="icon-btn" data-action="backpack-close">×</button>
      </header>
      <div class="bp-stats" data-role="backpack-stats"></div>
      <div class="grid small" data-role="backpack-grid"></div>
      <footer><span class="hint" data-role="backpack-info"></span></footer>
    </div>

    <div class="lock-hint hidden" data-role="lock-hint">点击画面以恢复鼠标控制</div>

    <div class="toasts" data-role="toasts"></div>
  `;

  const screens = {};
  for (const node of root.querySelectorAll('[data-screen]')) screens[node.dataset.screen] = node;
  const q = (role) => root.querySelector(`[data-role="${role}"]`);

  let current = 'menu';
  let selectedUid = null;
  let lootContainer = null;
  let lootItems = [];
  let lootSel = 0; // 键盘拾取时高亮（选中）的物品下标
  let backpackInv = null;

  function show(name) {
    current = name;
    for (const [key, node] of Object.entries(screens)) {
      node.classList.toggle('hidden', key !== name);
    }
    root.classList.toggle('in-battle', name === 'battle');
  }

  function toast(message, type = 'info') {
    const box = q('toasts');
    const node = el('div', `toast ${type}`, message);
    box.appendChild(node);
    window.setTimeout(() => {
      node.classList.add('out');
      window.setTimeout(() => node.remove(), 320);
    }, 2200);
    while (box.children.length > 5) box.firstChild.remove();
  }

  /* ---------------- 网格渲染 ---------------- */

  function renderGrid(host, inv, onSelect) {
    host.innerHTML = '';
    host.style.setProperty('--cols', inv.cols);
    host.style.setProperty('--rows', inv.rows);
    // 网格线由 CSS 背景绘制，这里只放物品，避免与自动排布的占位格冲突
    for (const item of inv.items) {
      const node = el('div', `grid-item rar-${item.rarity}`);
      node.style.gridColumn = `${item.col + 1} / span ${item.w}`;
      node.style.gridRow = `${item.row + 1} / span ${item.h}`;
      node.dataset.uid = item.uid;
      node.appendChild(iconEl(item.icon, RARITY[item.rarity].color, Math.min(30, 15 * Math.min(item.w, item.h) + 12)));
      const name = el('div', 'gi-name', item.name);
      node.appendChild(name);
      if (item.qty > 1) node.appendChild(el('div', 'gi-qty', String(item.qty)));
      if (item.uid === selectedUid) node.classList.add('selected');
      node.addEventListener('click', () => {
        selectedUid = item.uid;
        if (onSelect) onSelect(item);
      });
      host.appendChild(node);
    }
  }

  function itemRow(item, extra) {
    const row = el('div', 'item-row');
    row.appendChild(iconEl(item.icon, RARITY[item.rarity].color, 24));
    const main = el('div', 'item-main');
    main.appendChild(el('div', 'item-name', item.qty > 1 ? `${item.name} ×${item.qty}` : item.name));
    main.appendChild(el('div', 'item-meta', `${item.w}×${item.h} 格 · ${(item.weight * item.qty).toFixed(1)}kg · ${RARITY[item.rarity].name}`));
    row.appendChild(main);
    if (extra) row.appendChild(extra);
    return row;
  }

  /* ---------------- 主菜单 ---------------- */

  function renderMenu(save) {
    const host = q('menu-stats');
    host.innerHTML = '';
    const stats = save.stats;
    const rate = stats.raids ? Math.round((stats.extracts / stats.raids) * 100) : 0;
    const entries = [
      ['资金', money(save.currency)],
      ['突袭次数', String(stats.raids)],
      ['成功撤离', `${stats.extracts}（${rate}%）`],
      ['累计击杀', String(stats.kills)],
      ['最高评分', String(stats.bestScore)],
      ['仓库估值', money(totalValue(save.stash))],
    ];
    for (const [k, v] of entries) {
      const node = el('div', 'stat');
      node.appendChild(el('span', 'k', k));
      node.appendChild(el('span', 'v', v));
      host.appendChild(node);
    }
  }

  /* ---------------- 战前配置 ---------------- */

  function renderLoadout(save) {
    q('loadout-currency').textContent = money(save.currency);
    const host = q('loadout-options');
    host.innerHTML = '';
    const lo = save.loadout;

    const optionGroup = (title, options, currentValue, slot, renderLabel, renderMissing) => {
      const block = el('div', 'opt-block');
      block.appendChild(el('h3', null, title));
      const row = el('div', 'opt-row');
      for (const opt of options) {
        const btn = el('button', `opt ${opt.value === currentValue ? 'active' : ''}`);
        btn.dataset.action = 'set-loadout';
        btn.dataset.slot = slot;
        btn.dataset.value = String(opt.value);
        btn.appendChild(iconEl(opt.icon || 'bolt', opt.color || '#9aa7b8', 20));
        btn.appendChild(el('span', null, renderLabel ? renderLabel(opt) : opt.label));
        if (renderMissing && renderMissing(opt)) btn.classList.add('missing');
        row.appendChild(btn);
      }
      block.appendChild(row);
      host.appendChild(block);
    };

    optionGroup('主武器', [
      { value: '', label: '不带', icon: 'bolt' },
      { value: 'rifle', label: WEAPONS.rifle.name, icon: 'wpn_rifle', color: '#ffb020' },
      { value: 'smg', label: WEAPONS.smg.name, icon: 'wpn_smg', color: '#4fa3ff' },
    ], lo.primary || '', 'primary', (o) => o.label, (o) => o.value && countIn(save, o.value) < 1);

    optionGroup('副武器', [
      { value: '', label: '不带', icon: 'bolt' },
      { value: 'pistol', label: WEAPONS.pistol.name, icon: 'wpn_pistol', color: '#9aa7b8' },
      { value: 'smg', label: WEAPONS.smg.name, icon: 'wpn_smg', color: '#4fa3ff' },
    ], lo.secondary || '', 'secondary', (o) => o.label, (o) => o.value && countIn(save, o.value) < 1);

    optionGroup('护甲', [
      { value: 'none', label: ARMORS.none.name, icon: 'armor' },
      { value: 'lv2', label: ARMORS.lv2.name, icon: 'armor', color: '#4fa3ff' },
      { value: 'lv3', label: ARMORS.lv3.name, icon: 'armor', color: '#b45cff' },
    ], lo.armor || 'none', 'armor', (o) => o.label, (o) => o.value !== 'none' && countIn(save, o.value) < 1);

    const counter = (title, kind, value, min, max, unitLabel) => {
      const block = el('div', 'opt-block');
      block.appendChild(el('h3', null, title));
      const row = el('div', 'opt-row counter');
      const minus = el('button', 'step', '−');
      minus.dataset.action = 'step-loadout';
      minus.dataset.kind = kind;
      minus.dataset.delta = '-1';
      const plus = el('button', 'step', '+');
      plus.dataset.action = 'step-loadout';
      plus.dataset.kind = kind;
      plus.dataset.delta = '1';
      const label = el('span', 'counter-value', `${value} ${unitLabel}`);
      row.appendChild(minus);
      row.appendChild(label);
      row.appendChild(plus);
      block.appendChild(row);
      if (value <= min) minus.disabled = true;
      if (value >= max) plus.disabled = true;
      host.appendChild(block);
    };

    const haveAmmo = (id) => Math.floor(countIn(save, id) / AMMO_STACK);
    counter(`5.56mm 弹药（${AMMO_STACK}发/盒）`, 'ammo556Boxes', lo.ammo556Boxes || 0, 0, 4, `盒（仓库 ${haveAmmo('ammo556')}）`);
    counter(`9mm 弹药（${AMMO_STACK}发/盒）`, 'ammo9mmBoxes', lo.ammo9mmBoxes || 0, 0, 4, `盒（仓库 ${haveAmmo('ammo9mm')}）`);
    counter('医疗包', 'medkits', lo.medkits || 0, 0, 4, `个（仓库 ${countIn(save, 'medkit')}）`);
    counter('绷带', 'bandages', lo.bandages || 0, 0, 4, `个（仓库 ${countIn(save, 'bandage')}）`);

    // 负重估算
    const weightHost = q('loadout-weight');
    weightHost.innerHTML = '';
    const est = estimateWeight(lo);
    const rows = [
      ['装备合计', `${est.base.toFixed(1)} kg`],
      ['携带物资', `${est.items.toFixed(1)} kg`],
      ['总计', `${est.total.toFixed(1)} / ${est.limit} kg`],
    ];
    for (const [k, v] of rows) {
      const node = el('div', 'kv');
      node.appendChild(el('span', 'k', k));
      node.appendChild(el('span', 'v', v));
      weightHost.appendChild(node);
    }
    const bar = el('div', 'weight-bar');
    const fill = el('div', 'fill');
    // 进度条以"上限的 1.6 倍"为满格，100% 对应上限本身 —— 这样 1.0×~1.6× 的超重区间仍看得见进度。
    fill.style.width = `${Math.min(100, (est.total / (est.limit * 1.6)) * 100)}%`;
    if (est.over) fill.classList.add('over');
    bar.appendChild(fill);
    weightHost.appendChild(bar);
    const armorName = ARMORS[lo.armor] ? ARMORS[lo.armor].name : '无护甲';
    weightHost.appendChild(el(
      'p', est.over ? 'hint warn-text' : 'hint',
      est.over
        ? `已超重：移速下降且无法奔跑（上限 ${est.limit} kg = 基础 20 + ${armorName}加成）。带得越少跑得越快。`
        : `负重上限 ${est.limit} kg（基础 20 + ${armorName}加成）。超过即减速并无法奔跑。`,
    ));

    // 校验提示
    const warn = q('loadout-warn');
    warn.innerHTML = '';
    const problems = validateLoadout(save);
    if (problems.length) {
      warn.classList.add('active');
      for (const p of problems) warn.appendChild(el('p', 'warn-text', `· ${p}`));
    } else {
      warn.classList.remove('active');
    }
  }

  function countIn(save, id) {
    return save.stash.items
      .filter((it) => it.id === id)
      .reduce((s, it) => s + Math.max(1, it.qty || 1), 0);
  }

  /**
   * 估算装备配置的总重量与负重上限。
   * 上限随所选护甲变化（无甲 20 / 二级 23 / 三级 26 kg），所以这一屏不能写死 26。
   * @param {object} lo 装备配置
   * @returns {{base: number, items: number, total: number, limit: number, over: boolean}} 重量明细
   */
  function estimateWeight(lo) {
    let base = 0;
    if (lo.primary && WEAPONS[lo.primary]) base += WEAPONS[lo.primary].weight;
    if (lo.secondary && WEAPONS[lo.secondary]) base += WEAPONS[lo.secondary].weight;
    if (lo.armor && ARMORS[lo.armor]) base += ARMORS[lo.armor].weight;
    let items = 0;
    items += (lo.ammo556Boxes || 0) * ITEMS.ammo556.weight;
    items += (lo.ammo9mmBoxes || 0) * ITEMS.ammo9mm.weight;
    items += (lo.medkits || 0) * ITEMS.medkit.weight;
    items += (lo.bandages || 0) * ITEMS.bandage.weight;
    const total = Math.round((base + items) * 10) / 10;
    const limit = weightLimitFor(lo.armor || 'none');
    return { base, items, total, limit, over: total > limit };
  }

  /**
   * 校验装备配置是否可行。
   * @param {object} save 存档
   * @returns {Array<string>} 问题列表
   */
  function validateLoadout(save) {
    const lo = save.loadout;
    const problems = [];
    const weapons = [lo.primary, lo.secondary].filter((id) => id && WEAPONS[id]);
    if (!weapons.length) problems.push('至少要带一把武器（仓库里没有可用武器时会提示）');
    for (const id of weapons) {
      if (countIn(save, id) < 1) problems.push(`仓库中没有 ${WEAPONS[id].name}，请先去商店购买`);
    }
    if (lo.armor && lo.armor !== 'none' && ARMORS[lo.armor] && countIn(save, lo.armor) < 1) {
      problems.push(`仓库中没有 ${ARMORS[lo.armor].name}`);
    }
    if ((lo.ammo556Boxes || 0) * AMMO_STACK > countIn(save, 'ammo556')) problems.push('5.56mm 弹药数量超过仓库库存');
    if ((lo.ammo9mmBoxes || 0) * AMMO_STACK > countIn(save, 'ammo9mm')) problems.push('9mm 弹药数量超过仓库库存');
    if ((lo.medkits || 0) > countIn(save, 'medkit')) problems.push('医疗包数量超过仓库库存');
    if ((lo.bandages || 0) > countIn(save, 'bandage')) problems.push('绷带数量超过仓库库存');
    const cells = (lo.ammo556Boxes || 0) + (lo.ammo9mmBoxes || 0) + (lo.medkits || 0) + (lo.bandages || 0);
    if (cells > PLAYER.backpack.cols * PLAYER.backpack.rows) problems.push('携带物资超过背包容量');
    return problems;
  }

  /* ---------------- 仓库 ---------------- */

  function renderStash(save) {
    q('stash-currency').textContent = money(save.currency);
    renderGrid(q('stash-grid'), save.stash, renderStashDetail);
    const statsHost = q('stash-stats');
    statsHost.innerHTML = '';
    const entries = [
      ['物品件数', String(itemCount(save.stash))],
      ['占用格数', `${save.stash.items.reduce((s, i) => s + i.w * i.h, 0)} / ${save.stash.cols * save.stash.rows}`],
      ['总重量', `${totalWeight(save.stash).toFixed(1)} kg`],
      ['总估值', money(totalValue(save.stash))],
    ];
    for (const [k, v] of entries) {
      const node = el('div', 'kv');
      node.appendChild(el('span', 'k', k));
      node.appendChild(el('span', 'v', v));
      statsHost.appendChild(node);
    }
    renderStashDetail(null, save);
  }

  function renderStashDetail(item, save) {
    const host = q('stash-detail');
    host.innerHTML = '';
    if (!item) {
      host.appendChild(el('p', 'hint', '点击左侧格子中的物品查看详情。'));
      return;
    }
    host.appendChild(itemRow(item));
    host.appendChild(el('p', 'desc', item.desc || ''));
    const row = el('div', 'btn-row');
    const sell = el('button', 'btn small', `出售 ${money(item.value * item.qty * SHOP.sellRatio)}`);
    sell.dataset.action = 'sell';
    sell.dataset.uid = item.uid;
    row.appendChild(sell);
    host.appendChild(row);
    void save;
  }

  /* ---------------- 商店 ---------------- */

  function renderShop(save) {
    q('shop-currency').textContent = money(save.currency);
    const buyHost = q('shop-buy');
    buyHost.innerHTML = '';
    for (const id of SHOP.items) {
      const def = ITEMS[id];
      if (!def) continue;
      const row = el('div', 'item-row');
      row.appendChild(iconEl(def.icon, RARITY[def.rarity].color, 24));
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-name', def.name));
      const meta = [];
      if (def.category === 'weapon') meta.push(`伤害 ${WEAPONS[id].damage} · 射速 ${WEAPONS[id].rpm}RPM · 弹匣 ${WEAPONS[id].magSize}`);
      else if (def.category === 'armor') meta.push(`护甲 ${def.armor} · ${def.weight}kg`);
      else if (def.category === 'ammo') meta.push(`${def.ammoQty} 发 · ${def.weight}kg`);
      else if (def.heal) meta.push(`恢复 ${def.heal} 生命 · ${def.useTime}s`);
      meta.push(`${def.size.w}×${def.size.h} 格`);
      main.appendChild(el('div', 'item-meta', meta.join(' · ')));
      row.appendChild(main);
      const buy = el('button', 'btn small', money(def.value));
      buy.dataset.action = 'buy';
      buy.dataset.id = id;
      if (save.currency < def.value) buy.disabled = true;
      row.appendChild(buy);
      buyHost.appendChild(row);
    }

    const sellHost = q('shop-sell');
    sellHost.innerHTML = '';
    const sellable = save.stash.items.slice().sort((a, b) => b.value * b.qty - a.value * a.qty);
    if (!sellable.length) {
      sellHost.appendChild(el('p', 'hint', '仓库空空如也，去战局里搜点东西回来。'));
    }
    for (const item of sellable) {
      const row = el('div', 'item-row');
      row.appendChild(iconEl(item.icon, RARITY[item.rarity].color, 24));
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-name', item.qty > 1 ? `${item.name} ×${item.qty}` : item.name));
      main.appendChild(el('div', 'item-meta', `${(item.weight * item.qty).toFixed(1)}kg · 单价 ${money(item.value)}`));
      row.appendChild(main);
      const sell = el('button', 'btn small', money(item.value * item.qty * SHOP.sellRatio));
      sell.dataset.action = 'sell';
      sell.dataset.uid = item.uid;
      row.appendChild(sell);
      sellHost.appendChild(row);
    }
  }

  /* ---------------- 结算 ---------------- */

  /**
   * 渲染结算界面。
   * @param {object} result 结算数据
   * @returns {void}
   */
  function renderResult(result) {
    const head = q('result-head');
    head.className = `result-head ${result.success ? 'ok' : 'bad'}`;
    head.innerHTML = '';
    head.appendChild(el('div', 'result-title', result.title));
    head.appendChild(el('div', 'result-sub', result.subtitle));
    const grade = el('div', 'result-grade', result.grade);
    head.appendChild(grade);

    const statsHost = q('result-stats');
    statsHost.innerHTML = '';
    for (const [k, v] of result.stats) {
      const node = el('div', 'stat big');
      node.appendChild(el('span', 'k', k));
      node.appendChild(el('span', 'v', v));
      statsHost.appendChild(node);
    }

    q('result-loot-title').textContent = result.lootTitle;
    const lootHost = q('result-loot');
    lootHost.innerHTML = '';
    if (!result.items.length) {
      lootHost.appendChild(el('p', 'hint', result.emptyText));
      return;
    }
    for (const item of result.items) {
      const row = el('div', 'item-row');
      row.appendChild(iconEl(item.icon, RARITY[item.rarity].color, 22));
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-name', item.qty > 1 ? `${item.name} ×${item.qty}` : item.name));
      main.appendChild(el('div', 'item-meta', `${RARITY[item.rarity].name} · ${(item.weight * item.qty).toFixed(1)}kg`));
      row.appendChild(main);
      row.appendChild(el('div', 'item-value', money(item.value * item.qty)));
      lootHost.appendChild(row);
    }
  }

  /* ---------------- 战斗内面板 ---------------- */

  /**
   * 打开容器战利品面板。
   * @param {object} container 容器
   * @param {Array<object>} items 物品列表
   * @returns {void}
   */
  function openLoot(container, items) {
    lootContainer = container;
    lootItems = items;
    lootSel = 0;
    q('loot').classList.remove('hidden');
    q('loot-title').textContent = `${CONTAINERS[container.type].name} · 剩余 ${items.length} 件`;
    const hint = q('loot-hint');
    if (hint) hint.textContent = '↑↓ 选择 · 空格/回车 拾取 · G 全拾 · E 关闭';
    refreshLoot();
  }

  function refreshLoot() {
    const host = q('loot-list');
    host.innerHTML = '';
    if (!lootItems.length) {
      host.appendChild(el('p', 'hint', '已经空了。'));
      q('loot').classList.add('hidden');
      lootContainer = null;
      return;
    }
    if (lootSel >= lootItems.length) lootSel = Math.max(0, lootItems.length - 1);
    q('loot-title').textContent = `${CONTAINERS[lootContainer.type].name} · 剩余 ${lootItems.length} 件`;
    lootItems.forEach((item, i) => {
      const row = el('div', 'item-row');
      if (i === lootSel) row.classList.add('selected');
      row.appendChild(iconEl(item.icon, RARITY[item.rarity].color, 22));
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-name', item.qty > 1 ? `${item.name} ×${item.qty}` : item.name));
      main.appendChild(el('div', 'item-meta', `${item.w}×${item.h}格 · ${(item.weight * item.qty).toFixed(1)}kg · ${RARITY[item.rarity].name}`));
      row.appendChild(main);
      row.appendChild(el('div', 'item-value', money(item.value * item.qty)));
      const take = el('button', 'btn tiny', '拾取');
      take.dataset.action = 'loot-take';
      take.dataset.uid = item.uid;
      row.appendChild(take);
      host.appendChild(row);
    });
    const sel = host.querySelector('.item-row.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  /** 键盘上下移动战利品高亮 */
  function moveLootSel(delta) {
    if (!lootItems.length) return;
    lootSel = Math.max(0, Math.min(lootItems.length - 1, lootSel + delta));
    refreshLoot();
  }

  /** 当前高亮物品的 uid（供主程序键盘拾取） */
  function lootSelUid() {
    return lootItems[lootSel] ? lootItems[lootSel].uid : null;
  }

  function closeLoot() {
    q('loot').classList.add('hidden');
    lootContainer = null;
    lootItems = [];
  }

  /**
   * 打开战斗内背包面板。
   * @param {object} inventory 背包
   * @param {number} [weightLimit] 负重上限（随护甲变化，由 player.weightLimit 传入）
   * @returns {void}
   */
  function openBackpack(inventory, weightLimit = PLAYER.weightLimit) {
    const host = q('backpack');
    backpackInv = inventory;
    renderGrid(q('backpack-grid'), inventory, null);
    const w = totalWeight(inventory);
    const over = w > weightLimit;
    q('backpack-info').textContent =
      '点击医疗物资直接使用，点击其他丢弃';

    // 第三层（弹窗）承接从常驻 HUD 移下来的资产信息：
    // 随身估值与负重条在这里是"结算前的心算"，在战斗 HUD 上盯着它只会分心。
    const stats = q('backpack-stats');
    if (stats) {
      stats.innerHTML = '';
      const value = totalValue(inventory);
      const cells = inventory.items.reduce((s, it) => s + it.w * it.h, 0);
      const cellMax = inventory.cols * inventory.rows;
      const entries = [
        ['随身估值', money(value), 'value'],
        ['负重', `${w.toFixed(1)} / ${weightLimit} kg`, over ? 'over' : ''],
        ['占用格数', `${cells} / ${cellMax}`, cells >= cellMax ? 'over' : ''],
      ];
      for (const [k, v, cls] of entries) {
        const node = el('div', `bp-stat${cls ? ` ${cls}` : ''}`);
        node.appendChild(el('span', 'k', k));
        node.appendChild(el('span', 'v', v));
        stats.appendChild(node);
      }
    }
    host.classList.remove('hidden');
  }

  /** 关闭战斗内背包面板 */
  function closeBackpack() {
    q('backpack').classList.add('hidden');
  }

  // 网格中点击物品：医疗类物资直接使用，其余丢弃
  q('backpack-grid').addEventListener('click', (ev) => {
    const node = ev.target.closest('.grid-item');
    if (!node) return;
    const uid = node.dataset.uid;
    const item = backpackInv ? backpackInv.items.find((it) => it.uid === uid) : null;
    if (item && item.category === 'consumable') {
      if (handlers['use-item']) handlers['use-item']({ uid });
    } else if (handlers.drop) {
      handlers.drop({ uid });
    }
  });

  /* ---------------- 事件委托 ---------------- */

  // 放弃战局：两击确认门闸（无 modal）。第一次点击仅武装按钮并启动 3 秒倒计时，
  // 窗口内第二次点击才真正调用原 handler。超时自动复位，保证可重入安全。
  const ABANDON_RESET_MS = 3000;
  let abandonArmed = false;
  let abandonTimer = 0;
  let abandonBtnText = '放弃战局';

  root.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    const fn = handlers[action];
    if (typeof fn !== 'function') return;
    if (action === 'abandon') {
      if (!abandonArmed) {
        // 第一次点击：武装按钮，不执行原放弃逻辑
        abandonBtnText = target.textContent || '放弃战局';
        abandonArmed = true;
        target.classList.add('armed');
        target.textContent = '确认放弃？再点一次';
        if (abandonTimer) clearTimeout(abandonTimer);
        abandonTimer = setTimeout(() => {
          abandonArmed = false;
          abandonTimer = 0;
          const btn = root.querySelector('[data-action="abandon"]');
          if (btn) {
            btn.classList.remove('armed');
            btn.textContent = abandonBtnText;
          }
        }, ABANDON_RESET_MS);
        return;
      }
      // 第二次点击（窗口内）：解除武装并放行原放弃流程
      if (abandonTimer) { clearTimeout(abandonTimer); abandonTimer = 0; }
      abandonArmed = false;
      const btn = root.querySelector('[data-action="abandon"]');
      if (btn) {
        btn.classList.remove('armed');
        btn.textContent = abandonBtnText;
      }
    }
    fn(target.dataset, target, ev);
  });

  // 设置滑块（range input 用 input 事件，避免被 click 委托误触发）
  const fovSlider = q('fov-slider');
  if (fovSlider) fovSlider.addEventListener('input', (ev) => {
    if (handlers['set-fov']) handlers['set-fov']({ value: ev.target.value });
  });
  const sensSlider = q('sens-slider');
  if (sensSlider) sensSlider.addEventListener('input', (ev) => {
    if (handlers['set-sens']) handlers['set-sens']({ value: ev.target.value });
  });
  // 触屏灵敏度（手机端专用行，桌面端由 .touch-only 隐藏）
  const touchSensSlider = q('touch-sens-slider');
  if (touchSensSlider) {
    // input 事件在移动端拖动 range 时正常触发；补 touchend 保证松手时也提交一次
    const commit = (ev) => {
      if (handlers['set-touch-sens']) handlers['set-touch-sens']({ value: ev.target.value });
    };
    touchSensSlider.addEventListener('input', commit);
    touchSensSlider.addEventListener('change', commit);
  }
  // 按钮大小（位置/大小可调需求）
  const btnScaleSlider = q('btn-scale-slider');
  if (btnScaleSlider) {
    const commit = (ev) => {
      if (handlers['set-button-scale']) handlers['set-button-scale']({ value: ev.target.value });
    };
    btnScaleSlider.addEventListener('input', commit);
    btnScaleSlider.addEventListener('change', commit);
  }

  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.classList.contains('seed-input')) {
      const fn = handlers.deploy;
      if (fn) fn({}, ev.target);
    }
  });

  /* ---------- HUD 覆盖层（2D canvas，独立于 WebGL 战斗画面） ---------- */
  const hudCanvas = document.createElement('canvas');
  hudCanvas.className = 'hud-canvas';
  root.prepend(hudCanvas);
  const hudCtx = hudCanvas.getContext('2d');
  const hudState = { mm: null, mmCtx: null, mmImage: null, mmCache: null };

  function clearHud() {
    if (!hudCtx) return;
    hudCtx.clearRect(0, 0, hudCanvas.width || window.innerWidth || 1280, hudCanvas.height || window.innerHeight || 720);
  }

  /** 顶部罗盘（仿三角洲：随朝向滚动显示 N / E / S / W）。矩形来自 hudLayout，保证与体检工具同源。 */
  function drawCompass(world, W, L) {
    const ctx = hudCtx;
    const p = world.player;
    const { w: cw, y: y0, h: ch } = L.compass;
    // x 由 hudLayout 给：触屏横屏时罗盘与计时/击杀流共用中列，不是屏幕居中
    const x0 = L.compass.x;
    ctx.fillStyle = 'rgba(10,14,19,0.7)';
    roundRect(ctx, x0, y0, cw, ch, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(255,176,32,0.2)'; ctx.lineWidth = 1;
    roundRect(ctx, x0 + 0.5, y0 + 0.5, cw - 1, ch - 1, 6); ctx.stroke();
    const yawDeg = ((p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const dirs = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
    const cx = x0 + cw / 2; // 罗盘自身中心（触屏横屏时不等于屏幕中心）
    ctx.textAlign = 'center'; ctx.font = `600 12px ${MONO}`;
    for (const [lab, deg] of dirs) {
      const off = ((deg - yawDeg + 540) % 360) - 180; // 相对当前朝向的屏幕偏移 -180..180
      const px = cx + (off / 180) * (cw / 2 - 22);
      if (Math.abs(px - cx) > cw / 2 - 6) continue;
      ctx.fillStyle = lab === 'N' ? COLORS.danger : COLORS.dim;
      ctx.fillText(lab, px, y0 + 16);
    }
    // 中心指示三角
    ctx.fillStyle = COLORS.accent;
    ctx.beginPath();
    ctx.moveTo(cx, y0 - 4);
    ctx.lineTo(cx - 5, y0 - 10);
    ctx.lineTo(cx + 5, y0 - 10);
    ctx.closePath(); ctx.fill();
  }

  /** 取容器内最高稀有度（用于小地图着色，与 UI / 世界辉光配色一致）。 */
  function topContainerRarity(loot) {
    let best = 0;
    for (const it of loot || []) {
      const idx = RARITY_ORDER.indexOf(it.rarity);
      if (idx > best) best = idx;
    }
    return RARITY_ORDER[best];
  }

  /** 小地图（战争迷雾：只显示已探索区域）。矩形由 hudLayout.minimap 提供，触屏时缩小并移位。 */
  function drawMinimapHUD(world, rect) {
    const ctx = hudCtx;
    const map = world.map;
    const mw = rect.w;
    const mh = rect.h;
    const x0 = rect.x;
    const y0 = rect.y;

    if (!hudState.mm || hudState.mm.width !== map.cols || hudState.mm.height !== map.rows) {
      hudState.mm = document.createElement('canvas');
      hudState.mm.width = map.cols;
      hudState.mm.height = map.rows;
      hudState.mmCtx = hudState.mm.getContext('2d');
      hudState.mmImage = hudState.mmCtx.createImageData(map.cols, map.rows);
      hudState.mmCache = new Uint8Array(map.cols * map.rows).fill(255);
    }
    let dirty = false;
    for (let i = 0; i < map.cols * map.rows; i += 1) {
      const state = world.explored[i] ? (map.grid[i] === 0 ? 1 : 2) : 0;
      if (hudState.mmCache[i] === state) continue;
      hudState.mmCache[i] = state;
      const p = i * 4;
      if (state === 0) {
        hudState.mmImage.data[p] = 0; hudState.mmImage.data[p + 1] = 0; hudState.mmImage.data[p + 2] = 0; hudState.mmImage.data[p + 3] = 0;
      } else if (state === 1) {
        hudState.mmImage.data[p] = 44; hudState.mmImage.data[p + 1] = 56; hudState.mmImage.data[p + 2] = 72; hudState.mmImage.data[p + 3] = 235;
      } else {
        hudState.mmImage.data[p] = 18; hudState.mmImage.data[p + 1] = 24; hudState.mmImage.data[p + 2] = 33; hudState.mmImage.data[p + 3] = 220;
      }
      dirty = true;
    }
    if (dirty) hudState.mmCtx.putImageData(hudState.mmImage, 0, 0);

    ctx.fillStyle = 'rgba(8,11,16,0.9)';
    roundRect(ctx, x0, y0, mw, mh, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(255,176,32,0.25)'; ctx.lineWidth = 1;
    roundRect(ctx, x0 + 0.5, y0 + 0.5, mw - 1, mh - 1, 8); ctx.stroke();

    const sx = mw / WORLD_W;
    const sy = mh / WORLD_H;
    ctx.save();
    ctx.beginPath(); roundRect(ctx, x0 + 1, y0 + 1, mw - 2, mh - 2, 7); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(hudState.mm, x0, y0, mw, mh);

    const toMap = (wx, wy) => ({ x: x0 + wx * sx, y: y0 + wy * sy });

    for (const point of world.map.extracts) {
      if (!MINIMAP_LAYERS.showExtracts) break;
      const p = toMap(point.x, point.y);
      ctx.fillStyle = point.open ? COLORS.ok : 'rgba(124,136,153,0.7)';
      ctx.beginPath(); ctx.arc(p.x, p.y, point.open ? 4 : 3, 0, Math.PI * 2); ctx.fill();
      if (point.open) {
        // 基础脉动环（free 维持绿色脉动）
        ctx.strokeStyle = 'rgba(93,220,122,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, 7 + Math.sin(world.time * 3) * 1.5, 0, Math.PI * 2); ctx.stroke();
        // 类型外环：付费→琥珀，守点→红；free 不额外加环
        const kind = point.kind || 'free';
        let ringColor = null;
        if (kind === 'paid') ringColor = '#FBBF24';
        else if (kind === 'guarded') ringColor = COLORS.danger;
        if (ringColor) {
          ctx.strokeStyle = ringColor; ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 11 + Math.sin(world.time * 3 + 1) * 1.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    // 数据终端：菱形标记（未破解青色 / 已破解转绿并压暗）
    for (const t of (MINIMAP_LAYERS.showTerminals ? (world.map.terminals || []) : [])) {
      const p = toMap(t.x, t.y);
      const s = 3.2;
      if (t.hacked) {
        ctx.fillStyle = '#10B981';
        ctx.globalAlpha = 0.55;
      } else {
        ctx.fillStyle = '#35E0D0';
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - s);
      ctx.lineTo(p.x + s, p.y);
      ctx.lineTo(p.x, p.y + s);
      ctx.lineTo(p.x - s, p.y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // 空投信标：未着陆时在落点画脉动橙色标记（“即将到达”）
    const airdrop = world.map.airdrop;
    if (airdrop && !airdrop.landed && MINIMAP_LAYERS.showAirdrop) {
      const p = toMap(airdrop.x, airdrop.y);
      ctx.fillStyle = '#FFB020';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
      const pulse = (world.time * 0.8) % 1; // 0..1 循环扩散
      ctx.strokeStyle = '#FFB020';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7 * (1 - pulse);
      ctx.beginPath(); ctx.arc(p.x, p.y, 4 + pulse * 16, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const c of (MINIMAP_LAYERS.showContainers ? world.map.containers : [])) {
      if (!world.explored[Math.floor(c.y / TILE) * map.cols + Math.floor(c.x / TILE)]) continue;
      const p = toMap(c.x, c.y);
      if (c.searched) {
        ctx.fillStyle = 'rgba(124,136,153,0.6)';
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      } else {
        // 未搜刮容器：按内含最高稀有度着色（与 UI 物资分级、世界辉光一致），
        // 史诗/传说级额外画一圈脉动光环，远处也能锁定高价值点位。
        const top = topContainerRarity(c.loot);
        ctx.fillStyle = RARITY[top].color;
        const r = (top === 'legendary' || top === 'epic') ? 3.2 : 2.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        if (top === 'legendary' || top === 'epic') {
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = RARITY[top].color; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, r + 2 + Math.sin(world.time * 3) * 1.2, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    // 敌人：默认**不显示**。开着等于给一张免费全图雷达，
    // 搜刮时照着红点走就行，"听声辨位 / 掩体博弈 / 视野控制"这一层玩法直接作废。
    // 小地图的职责是指路（撤离点 / 任务点 / 未搜刮容器），不是透视。
    // 想看的话把 MINIMAP_LAYERS.showEnemies 改 true —— 逻辑与着色都还在。
    if (MINIMAP_LAYERS.showEnemies) {
      for (const e of world.enemies) {
        if (e.dead) continue;
        if (e.state !== EnemyState.COMBAT && e.state !== EnemyState.SUSPICIOUS) continue;
        const p = toMap(e.x, e.y);
        ctx.fillStyle = e.state === EnemyState.COMBAT ? COLORS.danger : COLORS.accent;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    const pp = toMap(world.player.x, world.player.y);
    ctx.save();
    ctx.translate(pp.x, pp.y); ctx.rotate(world.player.angle);
    ctx.fillStyle = COLORS.accent2;
    ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.restore();

    ctx.strokeStyle = 'rgba(53,224,208,0.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + world.player.x * sx - 60 * sx, y0 + world.player.y * sy - 60 * sy, 120 * sx, 120 * sy);
    ctx.textAlign = 'right'; ctx.fillStyle = COLORS.dim; ctx.font = `10px ${MONO}`;
    ctx.fillText(`MAP · SEED ${map.seed}`, x0 + mw - 8, y0 - 6);
  }

  /**
   * 中层任务面板的展开状态（模块级，跨帧保持）。
   * 放在 ui.js 而不是 world 上：它是**界面状态**不是**战局状态**，
   * 不该进存档、不该进结算、也不该被 sim 复现。
   */
  let tasksOpen = false;

  /** 展开 / 收起中层任务面板，返回切换后的状态。 */
  function toggleTasks() {
    tasksOpen = !tasksOpen;
    return tasksOpen;
  }

  /** 当前任务面板是否展开（供 main.js 与探针读取）。 */
  function isTasksOpen() {
    return tasksOpen;
  }

  /** 战斗 HUD：在独立 2D canvas 上绘制全部战斗界面元素。
   * @param {object} world 战局世界
   * @param {number} dt 帧间隔（秒）
   * @param {boolean} paused 是否暂停
   */
  function renderHud(world, dt, paused) {
    if (!hudCtx) return;
    const W = Math.max(1, Math.floor(window.innerWidth || hudCanvas.width || 1280));
    const H = Math.max(1, Math.floor(window.innerHeight || hudCanvas.height || 720));
    if (hudCanvas.width !== W || hudCanvas.height !== H) {
      hudCanvas.width = W; hudCanvas.height = H;
      if (hudCanvas.style) { hudCanvas.style.width = `${W}px`; hudCanvas.style.height = `${H}px`; }
    }
    const L = hudLayout(W, H, document.body.classList.contains('touch-mode'), tasksOpen);
    const ctx = hudCtx;
    const player = world.player;
    ctx.clearRect(0, 0, W, H);

    const panel = (x, y, w, h) => {
      ctx.fillStyle = 'rgba(10,14,19,0.82)';
      roundRect(ctx, x, y, w, h, 8); ctx.fill();
      ctx.strokeStyle = 'rgba(255,176,32,0.18)'; ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 8); ctx.stroke();
    };

    // 顶层（常驻）：读数条 —— 击杀 / 搜刮 / 负重。
    // 随身估值已移入背包页（第三层），它属于资产信息不是战况信息。
    const M = L.stateStrip;
    panel(M.x, M.y, M.w, M.h);
    const tx = M.x + 14;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text; ctx.font = `600 ${M.compact ? 12 : 13}px ${SANS}`;
    ctx.fillText(`击杀 ${world.kills}`, tx, M.y + M.rowY[0]);
    ctx.fillText(`搜刮 ${world.searchedCount}`, tx + M.col2, M.y + M.rowY[0]);
    const weight = player.weight;
    const wLimit = player.weightLimit;
    const over = weight > wLimit;
    ctx.fillStyle = over ? COLORS.danger : COLORS.dim;
    ctx.font = `600 ${M.compact ? 11 : 12}px ${MONO}`;
    // 超重时直接写出后果，不让玩家猜为什么"跑不动了"
    ctx.fillText(
      over ? `负重 ${weight.toFixed(1)}/${wLimit}kg · 禁跑` : `负重 ${weight.toFixed(1)}/${wLimit}kg`,
      tx, M.y + M.rowY[1],
    );
    // 超重警示条：把读数条右半边的空档用起来，红底让"禁跑"无法被忽略
    if (over) {
      const bw = Math.round(M.w * 0.34);
      const bx = M.x + M.w - bw - 8;
      const by = M.y + M.h - Math.round(M.h * 0.42) - 6;
      ctx.fillStyle = 'rgba(255,77,77,0.22)';
      roundRect(ctx, bx, by, bw, Math.round(M.h * 0.42), 4); ctx.fill();
      ctx.strokeStyle = 'rgba(255,77,77,0.7)'; ctx.lineWidth = 1;
      roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, Math.round(M.h * 0.42) - 1, 4); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.danger; ctx.font = `700 ${M.compact ? 10 : 11}px ${SANS}`;
      ctx.fillText('超重 · 无法奔跑', bx + bw / 2, by + Math.round(M.h * 0.42) * 0.68);
    }

    // 顶部中央：倒计时
    const timeLeft = Math.max(0, world.timeLeft);
    const mm = Math.floor(timeLeft / 60);
    const ss = Math.floor(timeLeft % 60);
    const urgent = timeLeft <= MATCH.warnTime;
    const blink = urgent && Math.floor(world.time * 2) % 2 === 0;
    ctx.textAlign = 'center';
    const T = L.timer;
    ctx.fillStyle = 'rgba(10,14,19,0.85)';
    roundRect(ctx, T.x, T.y, T.w, T.h, 8); ctx.fill();
    ctx.strokeStyle = urgent ? 'rgba(255,77,77,0.6)' : 'rgba(255,176,32,0.25)'; ctx.lineWidth = 1.4;
    roundRect(ctx, T.x, T.y, T.w, T.h, 8); ctx.stroke();
    ctx.fillStyle = urgent ? (blink ? COLORS.danger : COLORS.accent) : COLORS.text;
    ctx.font = `700 ${T.compact ? 24 : 30}px ${MONO}`;
    ctx.fillText(`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, W / 2, T.timeY);
    ctx.font = `11px ${SANS}`; ctx.fillStyle = COLORS.dim;
    ctx.fillText('剩余时间', W / 2, T.labelY);
    if (urgent && !world.over) {
      ctx.fillStyle = blink ? COLORS.danger : COLORS.accent; ctx.font = `700 ${T.compact ? 12 : 15}px ${SANS}`;
      // 触屏横屏顶部没有空隙了，紧急提示改挂在计时条下方 6px 处（不越出 h）
      ctx.fillText('撤离点即将关闭', W / 2, T.compact ? T.y + T.h + 14 : T.y + T.h + 38);
    }

    // 顶部中央罗盘（仿三角洲）
    drawCompass(world, W, L);

    // 右上：武器与弹药
    const weapon = player.currentWeapon;
    const G = L.weapon;
    panel(G.x, G.y, G.w, G.h);
    const gx = G.x + 16;
    ctx.textAlign = 'left';
    if (weapon) {
      ctx.fillStyle = COLORS.text; ctx.font = `600 ${G.compact ? 12 : 13}px ${SANS}`;
      ctx.fillText(weapon.def.name, gx, G.y + G.nameY);
      ctx.fillStyle = COLORS.dim; ctx.font = `10px ${MONO}`;
      ctx.fillText(`${weapon.def.auto ? '全自动' : '半自动'} · ${weapon.def.ammoType}`, gx, G.y + G.subY);
      ctx.textAlign = 'right';
      const ammoColor = weapon.ammo === 0 ? COLORS.danger : (weapon.ammo <= weapon.def.magSize * 0.25 ? COLORS.accent : COLORS.text);
      ctx.fillStyle = ammoColor; ctx.font = `700 ${G.compact ? 24 : 30}px ${MONO}`;
      ctx.fillText(String(weapon.ammo), G.ammoX, G.y + G.ammoY);
      ctx.fillStyle = COLORS.dim; ctx.font = `600 ${G.compact ? 13 : 16}px ${MONO}`;
      ctx.fillText(`/ ${player.reserveAmmo(weapon.def.ammoItem)}`, G.reserveX, G.y + G.ammoY);
      ctx.textAlign = 'left'; ctx.font = `10px ${MONO}`;
      if (weapon.reloading) {
        const p = 1 - weapon.reloadTimer / weapon.reloadTotal;
        ctx.fillStyle = COLORS.accent; ctx.fillText('换弹中', gx, G.y + G.footY);
        ctx.fillStyle = 'rgba(255,176,32,0.25)'; ctx.fillRect(G.barX, G.y + G.barY, G.barW, 7);
        ctx.fillStyle = COLORS.accent; ctx.fillRect(G.barX, G.y + G.barY, G.barW * p, 7);
      } else {
        ctx.fillStyle = COLORS.dim; ctx.fillText('弹匣 / 备用', gx, G.y + G.footY);
      }
    } else {
      ctx.fillStyle = COLORS.dim; ctx.font = `13px ${SANS}`;
      ctx.fillText('没有装备武器', gx, G.y + G.nameY);
    }

    // 右上（武器面板下方）：击杀信息流 —— 最新在最上，临近过期淡出
    // 触屏横屏时移到屏幕中上方居中，且只留 2 条：右上被小地图占、左下是摇杆。
    const feed = world.killFeed;
    if (feed && feed.length) {
      const KF = L.killfeed;
      const rowH = KF.rowH;
      const rowW = KF.w;
      const x0 = KF.x;
      const cap = Math.min(feed.length, KF.max || feed.length);
      let fy = KF.y;
      for (let i = feed.length - 1; i >= feed.length - cap; i -= 1) {
        const k = feed[i];
        const remain = KILLFEED.life - (k.t || 0);
        const alpha = remain < KILLFEED.fade ? Math.max(0, remain / KILLFEED.fade) : 1;
        const label = k.weapon
          ? `${k.killer}  ${k.weapon}  ▸  ${k.victim}`
          : `${k.killer}  ▸  ${k.victim}`;
        const fg = k.ofPlayer ? COLORS.danger : (k.byPlayer ? COLORS.accent : COLORS.dim);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = k.ofPlayer ? 'rgba(74,14,14,0.85)' : 'rgba(10,14,19,0.82)';
        roundRect(ctx, x0, fy, rowW, rowH - 4, 4); ctx.fill();
        ctx.strokeStyle = k.ofPlayer ? 'rgba(255,77,77,0.45)' : 'rgba(255,176,32,0.18)';
        ctx.lineWidth = 1;
        roundRect(ctx, x0 + 0.5, fy + 0.5, rowW - 1, rowH - 5, 4); ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillStyle = fg;
        ctx.font = `600 ${KF.compact ? 10 : 12}px ${MONO}`;
        ctx.fillText(label, x0 + rowW - 10, fy + (KF.compact ? 12 : 13));
        ctx.globalAlpha = 1;
        fy += rowH;
      }
    }

    // 中层（可展开收起）：任务面板。
    // 折叠时只画一条标题：目标概览（终端/空投）+ 完成计数 + 展开提示。
    // 展开时才逐条列出合约，并**按优先级排序**（见 sortTasksByPriority）。
    const contracts = world.contracts;
    if (contracts && contracts.length) {
      const C = L.tasks;
      const cw = C.w;
      const y0 = C.y;
      const shown = C.open ? sortTasksByPriority(contracts) : [];
      const cap = C.open ? Math.min(shown.length, 3) : 2;
      panel(C.x, y0, cw, C.headH + cap * C.rowH);
      // 标题行：左「任务 N/M」，右折叠/展开提示
      const doneCount = contracts.filter((c) => c.done).length;
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.dim; ctx.font = `600 ${C.compact ? 11 : 12}px ${SANS}`;
      ctx.fillText(`任务 ${doneCount}/${contracts.length}`, C.x + 14, y0 + C.headH * 0.66);
      ctx.textAlign = 'right';
      ctx.fillStyle = C.open ? COLORS.accent : COLORS.dim;
      ctx.font = `${C.compact ? 10 : 11}px ${MONO}`;
      ctx.fillText(C.open ? '▾ J 收起' : '▸ J 展开', C.x + cw - 14, y0 + C.headH * 0.66);

      if (C.open) {
        // 目标概览独占合约区第一行（数据终端 / 空投倒计时）——
        // 它是"下一步去哪"的唯一指引，不能藏在弹窗里。
        const goalY = y0 + C.headH + 10;
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.dim; ctx.font = `${C.compact ? 9 : 10}px ${MONO}`;
        const airdrop = world.map.airdrop;
        let airdropInfo = '空投 —';
        if (airdrop && !airdrop.landed) {
          const remain = Math.max(0, Math.ceil(airdrop.delay - world.time));
          airdropInfo = `空投 T-${remain}s`;
        } else if (airdrop && airdrop.landed) {
          airdropInfo = '空投已着陆';
        }
        ctx.fillText(
          `目标 · 终端 ${world.terminalsHacked}/${MATCH.terminalCount} · ${airdropInfo}`,
          C.x + 14, goalY,
        );
        shown.slice(0, cap).forEach((c, i) => {
          const nameY = y0 + C.headH + 10 + (i + 1) * C.rowH;
          ctx.textAlign = 'left';
          ctx.fillStyle = c.done ? COLORS.ok : COLORS.text;
          ctx.font = `600 ${C.compact ? 11 : 12}px ${SANS}`;
          ctx.fillText(c.name, C.x + 14, nameY);
          ctx.textAlign = 'right';
          ctx.fillStyle = c.done ? COLORS.ok : COLORS.accent;
          ctx.font = `10px ${MONO}`;
          ctx.fillText(c.done ? '✓' : `${Math.floor(c.progress)}/${c.target}`, C.x + cw - 14, nameY);
        });
      }
    }

    // 左上（合约下方）：生命 / 护甲 / 体力
    // 桌面端在左下角；触屏横屏必须让位给左摇杆（thumb zone），所以上移到左上角。
    const B = L.bars;
    const barX = B.barX;
    const barW = B.barW;
    let barY = B.firstY;
    const drawBar = (label, ratio, color, valueText) => {
      ctx.fillStyle = COLORS.dim; ctx.font = `11px ${MONO}`; ctx.textAlign = 'left';
      ctx.fillText(label, barX, barY);
      ctx.textAlign = 'right';
      ctx.fillText(valueText, barX + barW, barY);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(ctx, barX, barY + 5, barW, B.barH, 3); ctx.fill();
      ctx.fillStyle = color;
      const w = Math.max(0, Math.min(1, ratio)) * barW;
      if (w > 0) { roundRect(ctx, barX, barY + 5, w, B.barH, 3); ctx.fill(); }
      barY += B.rowH;
    };
    panel(B.x, B.y, B.w, B.h);
    drawBar('生命', player.hp / player.maxHp, player.hp / player.maxHp > 0.35 ? COLORS.ok : COLORS.danger,
      `${Math.max(0, Math.ceil(player.hp))}/${player.maxHp}`);
    drawBar('护甲', player.maxArmor ? player.armor / player.maxArmor : 0, '#6fa8ff',
      `${Math.ceil(player.armor)}/${player.maxArmor}`);
    drawBar(
      player.exhausted ? '体力·疲惫' : '体力',
      player.stamina / player.maxStamina,
      player.exhausted ? COLORS.danger : COLORS.accent2,
      `${Math.ceil(player.stamina)}/${player.maxStamina}`,
    );

    // 底部：快捷栏。桌面端居中；触屏横屏固定 x（挪到移动按钮行上方，让开开火键区）
    const SL = L.slots;
    const slotW = SL.slotW;
    const slotH = SL.slotH;
    const total = player.weapons.length;
    const rowW = total * slotW + (total - 1) * SL.gap;
    const startX = SL.align === 'left' ? SL.x : Math.round(W / 2 - rowW / 2);
    // 卡内三行文本随卡高缩放（触屏 slotH=38，桌面 44）
    const t1 = Math.round(slotH * 0.34);
    const t2 = Math.round(slotH * 0.36) + 2;
    const t3 = Math.round(slotH * 0.77);
    for (let i = 0; i < total; i += 1) {
      const wpn = player.weapons[i];
      const active = i === player.weaponIndex;
      const x = startX + i * (slotW + SL.gap);
      const y = SL.y;
      ctx.fillStyle = active ? 'rgba(255,176,32,0.16)' : 'rgba(10,14,19,0.8)';
      roundRect(ctx, x, y, slotW, slotH, 6); ctx.fill();
      ctx.strokeStyle = active ? COLORS.accent : 'rgba(255,255,255,0.12)'; ctx.lineWidth = active ? 1.6 : 1;
      roundRect(ctx, x + 0.5, y + 0.5, slotW - 1, slotH - 1, 6); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = COLORS.dim; ctx.font = `9px ${MONO}`;
      ctx.fillText(`${i + 1}`, x + 6, y + t1);
      ctx.fillStyle = active ? COLORS.text : COLORS.dim; ctx.font = `600 ${SL.compact ? 10 : 12}px ${SANS}`;
      ctx.fillText(wpn.def.short || wpn.def.name, x + 18, y + t2);
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = wpn.ammo === 0 ? COLORS.danger : COLORS.dim;
      ctx.fillText(`${wpn.ammo}/${player.reserveAmmo(wpn.def.ammoItem)}`, x + 6, y + t3);
    }
    const medCount = player.inventory.items
      .filter((it) => it.category === 'consumable')
      .reduce((s, it) => s + it.qty, 0);
    ctx.textAlign = 'center'; ctx.fillStyle = medCount ? COLORS.accent2 : COLORS.danger; ctx.font = `600 12px ${MONO}`;
    ctx.fillText(`[Q] 医疗 ${medCount}`, W / 2, L.medHintY);

    // 右下（触屏时右上）：小地图（战争迷雾）
    drawMinimapHUD(world, L.minimap);

    // 交互提示（优先级与 player.interact 一致：终端 → 撤离 → 地面物品 → 容器）
    let prompt = null;
    if (player.search) {
      prompt = { title: `搜索中 ${Math.round((player.search.progress / player.search.total) * 100)}%`, sub: '按 E 取消' };
    } else if (player.extract) {
      prompt = { title: `撤离中 ${Math.round((player.extract.progress / MATCH.extractChannel) * 100)}%`, sub: '按 E 取消' };
    } else if (player.hack) {
      prompt = { title: `破解中 ${Math.round((player.hack.progress / player.hack.total) * 100)}%`, sub: '按 E 取消' };
    } else if (player.ropelling) {
      prompt = { title: '绳索速降中…', sub: '无法开火 · 更难被命中' };
    } else if (player.vehicle) {
      prompt = { title: '驾驶中', sub: 'W/S 油门刹车 · A/D 转向 · F 下车（噪音极大）' };
    } else if (!player.busy) {
      const t = player.nearestTerminal ? player.nearestTerminal(world) : null;
      const e = player.nearestExtract(world);
      const ni = player.nearestItem ? player.nearestItem(world) : null;
      const c = player.nearestContainer(world);
      if (t) {
        prompt = { title: '按 E 破解数据终端', sub: '破解可得情报费与评分加成' };
      } else if (e) {
        // 撤离点按类型给出不同提示
        const kind = e.kind || 'free';
        let sub = '撤离点';
        if (kind === 'paid') sub = `付费撤离 · 手续费 ${money(e.cost || 0)}`;
        else if (kind === 'guarded') sub = '守点撤离 · 有精英守卫';
        prompt = { title: '按 E 撤离', sub };
      } else if (ni) {
        // 地面掉落物：排在撤离点之后、容器之前，与 player.interact 优先级一致
        const qty = ni.qty > 1 ? ` ×${ni.qty}` : '';
        prompt = { title: `按 E 拾取 ${ni.name}${qty}`, sub: `${money(ni.value * (ni.qty || 1))} · ${(ni.weight * (ni.qty || 1)).toFixed(1)}kg` };
      } else if (c) {
        prompt = { title: c.searched ? '已搜刮' : '按 E 搜索', sub: c.searched ? '' : '搜刮容器' };
      }
      if (!prompt && player.ropeLanding && player.ropeLanding(world)) {
        prompt = { title: '按 V 绳索速降', sub: '快速脱离高地 · 下滑中更难被命中' };
      } else if (player.nearestVehicle && player.nearestVehicle(world)) {
        prompt = { title: '按 F 上车', sub: '快速转移 · 但行驶噪音会暴露位置' };
      }
    }
    if (prompt) {
      const P = L.prompt;
      const cxP = P.x + P.w / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(10,14,19,0.8)';
      roundRect(ctx, P.x, P.y, P.w, P.h, 8); ctx.fill();
      ctx.strokeStyle = 'rgba(255,176,32,0.4)'; ctx.lineWidth = 1;
      roundRect(ctx, P.x + 0.5, P.y + 0.5, P.w - 1, P.h - 1, 8); ctx.stroke();
      ctx.fillStyle = COLORS.text; ctx.font = `600 ${P.compact ? 13 : 15}px ${SANS}`;
      ctx.fillText(prompt.title, cxP, P.y + P.titleDY);
      if (prompt.sub) {
        ctx.fillStyle = COLORS.dim; ctx.font = `10px ${SANS}`;
        ctx.fillText(prompt.sub, cxP, P.y + P.subDY);
      }
    }

    // 准星（随 ADS 收窄）
    const cx = W / 2;
    const cy = H / 2;
    // 准星：随武器实际扩散 / 连射累积而张开（命中率反馈），ADS 时收紧、
    // 开火与连射时明显外扩，抬枪期间也略微张开。
    const wpn = player.currentWeapon;
    let spread = player.ads ? 4 : 9;
    if (wpn && wpn.def) {
      const maxSpread = wpn.def.spreadMax || 0;
      const cur = Math.min(maxSpread, (wpn.def.spread || 0) + (wpn.spread || 0));
      const bloom = maxSpread > 0 ? cur / maxSpread : 0;
      spread += bloom * (player.ads ? COMBAT.crosshairBloomAds : COMBAT.crosshairBloom);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - spread - 8, cy); ctx.lineTo(cx - spread, cy);
    ctx.moveTo(cx + spread, cy); ctx.lineTo(cx + spread + 8, cy);
    ctx.moveTo(cx, cy - spread - 8); ctx.lineTo(cx, cy - spread);
    ctx.moveTo(cx, cy + spread); ctx.lineTo(cx, cy + spread + 8);
    ctx.stroke();

    // 命中标记
    if (world.hitMarker > 0) {
      const a = Math.min(1, world.hitMarker / 0.12);
      const s = 7;
      ctx.strokeStyle = `rgba(255,77,77,${a})`; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
      ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
      ctx.stroke();
    }

    // 受击红色晕影
    if (player.hurtFlash > 0) {
      const a = Math.min(0.5, (player.hurtFlash / 0.3) * 0.5);
      const g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.3, cx, cy, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, `rgba(255,0,0,${a})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    if (paused) {
      ctx.fillStyle = 'rgba(6,9,13,0.55)'; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center'; ctx.fillStyle = COLORS.text; ctx.font = `700 24px ${SANS}`;
      ctx.fillText('已暂停', W / 2, H / 2);
    }
  }

  return {
    show,
    renderHud,
    clearHud,
    toast,
    toggleTasks,
    isTasksOpen,
    updateFovLabel(v) {
      const el = q('fov-val');
      if (el) el.textContent = `${Math.round(v)}°`;
      const slider = q('fov-slider');
      if (slider && Number(slider.value) !== v) slider.value = String(v);
    },
    updateSensLabel(v) {
      const el = q('sens-val');
      if (el) el.textContent = `${Number(v).toFixed(2)}×`;
      const slider = q('sens-slider');
      if (slider && Number(slider.value) !== v) slider.value = String(v);
    },
    updateTouchSensLabel(v) {
      const el = q('touch-sens-val');
      if (el) el.textContent = `${Number(v).toFixed(2)}×`;
      const slider = q('touch-sens-slider');
      if (slider && Math.abs(Number(slider.value) - Number(v)) > 1e-6) slider.value = String(v);
    },
    updateButtonScaleLabel(v) {
      const el = q('btn-scale-val');
      if (el) el.textContent = `${Math.round(Number(v) * 100)}%`;
      const slider = q('btn-scale-slider');
      if (slider && Math.abs(Number(slider.value) - Number(v)) > 1e-6) slider.value = String(v);
    },
    renderMenu,
    renderLoadout,
    renderStash,
    renderShop,
    renderResult,
    openLoot,
    refreshLoot,
    closeLoot,
    moveLootSel,
    lootSelUid,
    openBackpack,
    closeBackpack,
    estimateWeight,
    validateLoadout,
    getSeed() {
      const input = q('seed');
      const value = Number.parseInt(input.value, 10);
      return Number.isFinite(value) && value > 0 ? value : 0;
    },
    setSeed(value) {
      q('seed').value = value ? String(value) : '';
    },
    getScreen() {
      return current;
    },
    isLootOpen() {
      return !q('loot').classList.contains('hidden');
    },
    isBackpackOpen() {
      return !q('backpack').classList.contains('hidden');
    },
    /**
     * 显示 / 隐藏"点击画面以恢复鼠标控制"提示。
     * 指针锁定意外丢失（Alt+Tab、Esc 限流等）时给玩家一个明确的恢复动作，
     * 避免看起来像"输入全坏了"。
     * @param {boolean} show 是否显示
     * @returns {void}
     */
    setLockHint(show) {
      const node = q('lock-hint');
      if (node) node.classList.toggle('hidden', !show);
    },
    closeBattlePanels() {
      q('loot').classList.add('hidden');
      q('backpack').classList.add('hidden');
      lootContainer = null;
      lootItems = [];
    },
  };
}

/** 供外部复用的敌人类型展示名 */
export const ENEMY_LABELS = Object.values(ENEMY_TYPES).map((t) => t.name);
/** 评分等级表 */
export const RATING_TABLE = SCORING.ratings;
