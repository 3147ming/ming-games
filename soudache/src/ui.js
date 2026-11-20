import { hudLayout } from './ui-hud.js';
export { hudLayout };
import { EXTRACT_TUNING } from './extract.js';
// 位图图标：HUD 画在 canvas 上（位图优先 + 矢量回退），物品/DOM 侧懒加载。
import { drawGlyph } from './glyphs.js';
import { drawHudIcon, itemIconEl, prefetchItemIcons } from './icon-bitmap.js';

// M-03：拉闸点即使到点开放也仍是"条件未满足"，不能画成绿色误导玩家。
const extractReady = (ex) => Boolean(ex && ex.open) && (!ex.requiresSwitch || ex.switchPulledAt != null);
// P1 拆分：纯 helper 抽到 ui-kit.js；门面 re-export 保持外部 import 零改动。
import { liveObjectiveRows, clipText, MONO, SANS, roundRect, cutPath, drawBrackets, tacticalPanel, segBar, ringProgress, iconEl, el, money, HUB_GLYPHS, hubGlyph } from './ui-kit.js';
export { liveObjectiveRows, clipText, MONO, SANS, roundRect, cutPath, drawBrackets, tacticalPanel, segBar, ringProgress, iconEl, el, money, HUB_GLYPHS, hubGlyph };

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



/**
 * DOM 覆盖层 UI：主菜单 / 仓库 / 商店 / 战前配置 / 结算 / 暂停 / 战利品面板 / 背包
 *
 * 战斗画面由 Canvas 渲染，UI 全部走 DOM —— 交互与排版都更省心，也更好看。
 */

import {
  ITEMS, WEAPONS, ARMORS, SHOP, RARITY, RARITY_ORDER, CONTAINERS, ENEMY_TYPES, PLAYER, MATCH, SCORING,
  COLORS, DF, dfAlpha, MINIMAP_LAYERS, TILE, COMBAT, KILLFEED, VIEW3D,
  INSURANCE, REP, SHOP_TIER, ITEM_IDS, ITEMS_BY_RARITY, HITDIR, MAPS, DEFAULT_MAP_ID,
  HUD, POI_NAMES, SQUAD_STANDBY, HUB, ABILITY,
  WEAPON_MOD_SLOTS, WEAPON_MODS, CALIBERS, AMMO_IDS, HELMET_IDS, CAREER,
  MELEE, BACKPACKS, RIGS,
} from './config.js';
import { OPERATORS, getOperator, resolveSquadIds } from './operators.js';
import { BOSS_PHASES, PHASE_RATIOS } from './boss.js';
import { dangerLabel } from './areas.js';
import {
  totalWeight, totalValue, itemCount, weightLimitFor, weightTier,
  displayUnits, itemWeight, itemValue, weightSpeedMultiplier,
} from './inventory.js';
// P14：改枪台侧视线稿（纯逻辑，零 three / 零 DOM，与 3D 枪模共用 vmparams.js 尺寸）
import { sketchSvg } from './gunsketch.js';
import { EnemyState } from './enemy.js';
import {
  PRESENTATION, streakLabel, staggerDelay, countUpText, transitionCopy, heartbeatDue,
} from './presentation.js';
import { sortTasksByPriority } from './contracts.js';
import { dailySeed, repLevel } from './storage.js';
import { rollListings, MARKET } from './market.js';
import {
  achievementView, questView, repRewardView, orderView, quoteForStashItem,
  todayIndex, shopRemaining, pendingRewardCount,
} from './economy.js';
import { gearReadout, seasonProgress } from './gear.js';
import {
  BRANCHES, getBranchLevel, checkBuy, weightLimitBonus, MAX_LEVEL,
} from './upgrades.js';
import { reloadProgress, reloadStage } from './reload.js';
import {
  attachmentOptions, loadoutModWeight, benchStatRows,
} from './gunbench.js';
import {
  ammoIdsForWeapon, loadoutAmmoBoxes, ammoBoxSize, loadoutAmmoWeight,
  resolveAmmoGrade, ammoLabel,
} from './ammo.js';
// P18：双栏搜刮界面（独立 DOM 控制器），与仓库/背包旧网格互不干扰。
import { createLootUI } from './lootui.js';
import { CREDITS, CREDITS_NOTE } from './icons.js';
// P22：玩家压制暗角强度（纯函数，数值在 COMBAT.playerSuppression）
import { suppressionVignette } from './suppression.js';





/**
 * 创建 UI 控制器。
 * @param {HTMLElement} root UI 根节点
 * @param {object} handlers 动作处理函数表
 * @returns {object} UI 控制器
 */
export function createUI(root, handlers, opts) {
  // 无障碍（P1-7）：系统开启「减少动态效果」时，HUD 关掉闪烁、抖动类动态，只保留信息
  const reducedMotion = !!(opts && opts.reducedMotion);
  // UI 点击音：由 main.js 注入音频总线。没有时静默（单测/无音频环境不报错）。
  const sfx = (opts && opts.audio) || null;
  /** 播一声 UI 点击。减少动态效果时仍然给声音（声音不是"动态效果"），静音由 audio 自己处理。 */
  const clickSfx = () => { if (sfx && typeof sfx.click === 'function') sfx.click(); };

  // 地图选择卡：地图名 / 一句定位 / 风险收益描述全部来自 config.MAPS，
  // 不在这里另写一份文案 —— 否则生成参数改了，选图界面上的承诺会悄悄过期。
  // 卡片用 <button> 而非 <div>：键盘可聚焦、可回车选择，读屏会报成按钮。
  // P2：卡片上补程序化 POI 图钉、风险徽标与撤离点读数，位置是展示用的固定百分比，
  // 不参与地图生成，也不改 seed 结果。
  const mapCards = Object.values(MAPS).map((m) => {
    const pois = (POI_NAMES[m.id] || []).slice(0, 3);
    const pins = pois.map((p, i) => {
      const left = [24, 56, 76][i] ?? 40;
      const top = [62, 34, 70][i] ?? 50;
      return `<span class="map-card-pin" style="left:${left}%;top:${top}%"><i></i>${p}</span>`;
    }).join('');
    return `
    <button type="button" class="map-card${m.id === DEFAULT_MAP_ID ? ' active' : ''}"
      data-action="select-map" data-map="${m.id}"
      aria-pressed="${m.id === DEFAULT_MAP_ID ? 'true' : 'false'}">
      <span class="map-card-head">
        <span class="map-card-name">${m.name}</span>
        <span class="map-card-risk">${HUB.riskLevels[0].label}</span>
      </span>
      <span class="map-card-tag">${m.tagline}</span>
      <span class="map-card-topo">${pins}</span>
      <span class="map-card-desc">${m.desc}</span>
      <span class="map-card-foot">撤离点 ${MATCH.extractTotal} · 命名区域 ${(POI_NAMES[m.id] || []).length}</span>
    </button>`;
  }).join('');

  // P15：三档全部可玩。选中态由 renderLoadout(save) 同步 —— createUI 时还读不到存档，
  // 不能在这里写死 active，否则旧档读的是「机密」也会显示常规高亮。
  // 倍率标签只在非基准档显示：常规档挂个 ×1 只是噪声。
  const riskPick = HUB.riskLevels.map((r) => `
      <button type="button" class="risk-opt" data-action="set-risk" data-risk="${r.id}"
        aria-pressed="false" title="${r.desc}">
        ${r.label}<small>${r.en}</small>${r.tier > 0 ? `<em>×${r.scoreMul}</em>` : ''}
      </button>`).join('');

  // 左侧 64px 图标导航：每项都指向 main.js 里真实存在的 data-action。
  // `locked` 分支是**兜底机制**（当前 7 项全部已开放，没有命中它）：以后再加新入口时，
  // 宁可显示成带阶段标注的 disabled，也不要放一个点不动的假按钮骗玩家。
  const hubNav = HUB.nav.map((n) => `
      <button type="button" class="hub-nav-item${n.locked ? ' locked' : ''}" data-nav="${n.id}"
        ${n.locked ? 'disabled aria-disabled="true"' : `data-action="${n.action}"`}
        title="${n.label} ${n.en}${n.locked ? ` · ${n.locked} 未开放` : ''}">
        <span class="hub-nav-glyph">${hubGlyph(n.glyph)}</span>
        <span class="hub-nav-label">${n.label}</span>
        <span class="hub-nav-en">${n.en}</span>
        ${n.locked ? `<span class="hub-nav-phase">${n.locked}</span>` : ''}
      </button>`).join('');

  const squadSlots = '<span class="hub-squad-slot player">01 · 玩家</span>'
    + SQUAD_STANDBY.map((s) => `<span class="hub-squad-slot standby">${s.slot} · ${s.role}</span>`).join('');

  // 致谢屏：CC BY 3.0 的图标要求在游戏内可见署名，所以这不是装饰页，是授权义务的落点。
  // 数据来自 icons.js 的 CREDITS，和图标映射同源 —— 换图标不会漏改署名。
  const creditsSections = CREDITS.map((sec) => `
          <section>
            <h3>${sec.title}</h3>
            <ul class="credits-list">
              ${sec.items.map((it) => `<li>
                <span class="credits-name">${it.name}</span>
                <span class="credits-lic">${it.license}</span>
                ${it.note ? `<span class="credits-note">${it.note}</span>` : ''}
              </li>`).join('')}
            </ul>
          </section>`).join('');

  root.innerHTML = `
    <div class="df-hub" data-role="hub">
      <header class="hub-top">
        <div class="hub-brand">
          <span class="hub-brand-mark"></span>
          <span class="hub-brand-cn">${HUB.brand.name}</span>
          <span class="hub-brand-en">${HUB.brand.en}</span>
        </div>
        <div class="hub-top-metrics">
          <div class="hub-metric"><span class="hub-metric-k">资金 / FUNDS</span><span class="hub-metric-v" data-role="hub-currency">—</span></div>
          <div class="hub-metric"><span class="hub-metric-k">军需商 / REP</span><span class="hub-metric-v" data-role="hub-level">—</span></div>
          <div class="hub-metric"><span class="hub-metric-k">行动场次 / RAIDS</span><span class="hub-metric-v" data-role="hub-raids">—</span></div>
        </div>
        <div class="hub-season">
          <span class="hub-season-id">${HUB.season.id}</span>
          <span>${HUB.season.name}</span>
          <span class="hub-mode">${HUB.season.mode} / ${HUB.season.modeEn}</span>
          <div class="hub-season-track" title="行动等级进度（真实声望经验）"><i data-role="hub-season-fill"></i></div>
          <span class="hub-season-xp" data-role="hub-season-xp">—</span>
        </div>
      </header>
      <nav class="hub-nav" aria-label="战术终端导航">${hubNav}
      </nav>
      <footer class="hub-action">
        <div class="hub-squad" data-role="hub-squad"><span class="hub-label">小队 / SQUAD</span>${squadSlots}</div>
        <div class="hub-loadout-readout">
          <span data-role="hub-gear">装备价值 —</span>
          <span data-role="hub-weight">负重 —</span>
          <span data-role="hub-mobility">机动 —</span>
          <span class="hub-offline">本地单机 · 无联网</span>
        </div>
        <button class="btn primary hub-deploy" data-action="goto-loadout" data-role="hub-deploy">配置并部署</button>
      </footer>
    </div>

    <div class="screen" data-screen="menu">
      <div class="menu">
        <div class="menu-main">
          <div class="menu-brand">
            <div class="logo">搜打撤</div>
            <div class="tagline">SEARCH · STRIKE · EXTRACT</div>
            <div class="menu-sub">搜刮物资 → 交火突围 → 活着撤离，带出去的才算你的。</div>
          </div>
          <div class="menu-stats" data-role="menu-stats"></div>
          <div class="menu-actions">
            <button class="btn primary" data-action="goto-loadout">开始战局</button>
            <button class="btn" data-action="daily-raid">每日突袭</button>
            <button class="btn" data-action="goto-stash">仓库</button>
            <button class="btn" data-action="goto-shop">商店</button>
            <button class="btn" data-action="goto-upgrades">改装</button>
            <button class="btn" data-action="goto-codex">图鉴</button>
            <button class="btn" data-action="goto-howto">玩法说明</button>
          </div>
          <div class="menu-foot">
            <button class="link" data-action="toggle-mute">音效开关</button>
            <button class="link danger" data-action="reset-save">清空存档</button>
          </div>
        </div>
        <aside class="menu-brief" data-role="menu-brief"></aside>
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
            <div class="loadout-col">
              <!-- W2：装备配置板提到最顶部 —— 它是这一屏的主任务（环 3）。
                   实测 1280×720 下，把它排在干员/小队之后会让第 4 行槽位（背包/胸挂）
                   掉到底栏下面，8 个槽位得滚动才能看全；提前 200px 后整块一次看齐。
                   干员卡不再承担"这一局带谁"的唯一入口：角色台本身就印着干员码/名。 -->
              <section class="equip-bay" data-role="equip-bay">
                <div class="bay-head">
                  <h3>装备配置 / LOADOUT</h3>
                  <span class="hint">拖入物品，或先点物品再点槽位</span>
                </div>
                <div class="bay-body">
                  <div class="bay-char">
                    <div class="bay-char-3d preview3d-host" data-role="char-preview"></div>
                    <div class="bay-char-sheet" data-role="char-sheet"></div>
                  </div>
                  <div class="equip-slots" data-role="equip-slots"></div>
                </div>
                <div class="equip-tray" data-role="equip-tray"></div>
              </section>
              <!-- P5：干员选择紧跟装备板。第一屏照样看得见"这一局带谁"，
                   塞进底部的 options 容器会掉到滚动区外（上一版就是这样被截图抓到的）。 -->
              <section class="operator-pick" data-role="operator-pick"></section>
              <!-- P15：小队编成紧随其后 —— 先选自己，再选两名 AI 队友。
                   两席各三个候选（排除玩家当前干员），点一下即换。 -->
              <section class="squad-pick" data-role="squad-pick"></section>
              <!-- P6 改枪台：紧贴装备槽下方（选完枪就地改枪）。绝不塞进底部的
                   loadout-options —— 那一片在滚动区外，P5 的干员卡已经栽过一次。 -->
              <section class="gun-bench-section" data-role="gun-bench"></section>
              <!-- P7 弹药与医疗：弹种选择 + 各弹种盒数 + 头盔/药品。紧贴改枪台，
                   选完枪就地决定"这一局带什么弹、带几盒"。 -->
              <section class="ammo-config" data-role="ammo-config"></section>
              <!-- P2 视觉复核：地图卡原先塞在 300px 侧栏里、两列各 120px，
                   POI 图钉与描述挤成一团。移到主区后每张约 400px，图钉才读得清。 -->
              <section class="mission-pick">
                <h3>作战地图 / OPERATION AREA</h3>
                <div class="map-pick" data-role="map-pick">${mapCards}</div>
              </section>
              <div data-role="loadout-options"></div>
            </div>
            <aside class="loadout-side">
              <div class="side-block">
                <h3>负重估算</h3>
                <div data-role="loadout-weight"></div>
              </div>
              <div class="side-block">
                <h3>行动经济性 / ECONOMY</h3>
                <div data-role="loadout-economy"></div>
              </div>
              <div class="side-block">
                <h3>风险等级</h3>
                <div class="risk-pick" data-role="risk-pick">${riskPick}</div>
                <p class="hint" data-role="risk-hint">风险越高，敌人更多更硬，稀有物资概率与结算评分也越高。倍率只作用于本局。</p>
              </div>
              <div class="side-block">
                <h3>地图种子</h3>
                <input class="seed-input" data-role="seed" placeholder="留空则随机" inputmode="numeric" />
                <p class="hint">同一种子会生成完全相同的地图、战利品与敌人分布。</p>
              </div>
              <div class="side-block">
                <h3>装备保险</h3>
                <button class="btn toggle" data-action="toggle-insurance" data-role="insurance-toggle">装备保险：关</button>
                <div class="hint" data-role="insurance-hint">投保后阵亡只赔带入的武器与护甲，随身物资照旧丢失。</div>
              </div>
              <div class="side-block">
                <h3>局外改装</h3>
                <div class="hint" data-role="loadout-upgrades-progress"></div>
                <button class="btn" data-action="goto-upgrades">打开改装树</button>
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
        <div class="df-toolbar" data-role="stash-toolbar">
          <div class="tool-group" data-role="stash-filters">
            <span class="tool-label">分类</span>
            <button type="button" class="tool-chip active" data-action="stash-filter" data-filter="all">全部</button>
            <button type="button" class="tool-chip" data-action="stash-filter" data-filter="weapon">武器</button>
            <button type="button" class="tool-chip" data-action="stash-filter" data-filter="armor">护甲</button>
            <button type="button" class="tool-chip" data-action="stash-filter" data-filter="ammo">弹药</button>
            <button type="button" class="tool-chip" data-action="stash-filter" data-filter="consumable">医疗</button>
            <button type="button" class="tool-chip" data-action="stash-filter" data-filter="material">材料</button>
            <button type="button" class="tool-chip" data-action="stash-filter" data-filter="valuable">贵重</button>
          </div>
          <div class="tool-group" data-role="stash-sorts">
            <span class="tool-label">排序</span>
            <button type="button" class="tool-chip active" data-action="stash-sort" data-sort="default">默认</button>
            <button type="button" class="tool-chip" data-action="stash-sort" data-sort="value">价值</button>
            <button type="button" class="tool-chip" data-action="stash-sort" data-sort="weight">重量</button>
            <button type="button" class="tool-chip" data-action="stash-sort" data-sort="rarity">稀有度</button>
          </div>
          <span class="tool-hint" data-role="stash-view-count"></span>
        </div>
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
              <button class="btn" data-action="goto-codex">物资图鉴</button>
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
        <div class="df-tabs" data-role="market-tabs">
          <button type="button" class="df-tab active" data-action="market-tab" data-tab="supply" aria-current="page">军需处 <small>SUPPLY</small></button>
          <button type="button" class="df-tab" data-action="market-tab" data-tab="market">交易行 <small>MARKET</small></button>
          <button type="button" class="df-tab" data-action="market-tab" data-tab="sell">委托出售 <small>CONSIGN</small></button>
        </div>
        <div class="panel-body shop-body" data-role="shop-supply">
          <section class="shop-col">
            <h3>购买</h3>
            <div class="shop-list" data-role="shop-buy"></div>
          </section>
          <section class="shop-col">
            <h3>出售（仓库）</h3>
            <div class="shop-list" data-role="shop-sell"></div>
          </section>
        </div>
        <div class="panel-body market-body hidden" data-role="shop-market">
          <div class="market-head">
            <div>
              <h3>本地物资报价 / LOCAL LISTINGS</h3>
              <p class="hint">NPC 挂单仅用于购买物资。报价由本地种子生成，刷新只重掷种子；没有共享物资总数，也不写入存档。</p>
            </div>
            <button type="button" class="btn small" data-action="market-refresh">刷新报价</button>
          </div>
          <div class="market-list" data-role="market-list"></div>
          <div class="market-foot">
            <span>本地单机 · 报价由种子生成</span>
            <span>无共享库存 · 不与其它存档共享</span>
            <span>报价仅本次刷新有效</span>
          </div>
        </div>
        <div class="panel-body consign-body hidden" data-role="shop-consign">
          <div class="market-head">
            <div>
              <h3>本地收购商 / CONSIGNMENT</h3>
              <p class="hint">把物资交给本地收购商，到点按当日指数结算；撤单可退回仓库。指数由本地日期种子生成，零联网。</p>
            </div>
            <span class="market-index" data-role="consign-index"></span>
          </div>
          <div class="consign-grid">
            <section class="shop-col">
              <h3>可委托物资（仓库）</h3>
              <div class="shop-list" data-role="consign-stock"></div>
            </section>
            <section class="shop-col">
              <h3>我的委托单</h3>
              <div class="shop-list" data-role="consign-orders"></div>
            </section>
          </div>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="career">
      <div class="panel wide">
        <header class="panel-head">
          <h2>生涯档案 CAREER <span class="career-badge" data-role="career-badge"></span></h2>
          <div class="head-right">
            <span class="coin" data-role="career-currency"></span>
            <button class="btn ghost" data-action="goto-menu">返回</button>
          </div>
        </header>
        <div class="panel-body career-body">
          <section class="career-col">
            <h3>今日任务 / DAILY</h3>
            <div class="career-list" data-role="career-quests"></div>
          </section>
          <section class="career-col">
            <h3>成就 / ACHIEVEMENTS</h3>
            <div class="career-list" data-role="career-achievements"></div>
          </section>
          <section class="career-col">
            <h3>声望补给 / REPUTATION</h3>
            <div class="career-list" data-role="career-rep"></div>
          </section>
        </div>
        <div class="panel-foot">
          <span class="hint">奖励需手动领取；重复领取不会重复入账。任务与商店额度每日刷新。</span>
          <button class="btn small" data-action="claim-all-career">一键领取全部</button>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="upgrades">
      <div class="panel wide">
        <header class="panel-head">
          <h2>改装 WORKSHOP</h2>
          <div class="head-right">
            <span class="coin" data-role="upgrades-currency"></span>
            <button class="btn ghost" data-action="goto-menu">返回</button>
          </div>
        </header>
        <div class="panel-body upgrades-body">
          <p class="hint upgrades-intro">
            用成功撤离赚来的资金解锁永久强化。每支必须按顺序点满三级，价格逐级递增。
          </p>
          <div class="upgrade-summary" data-role="upgrade-summary"></div>
          <div class="upgrade-grid" data-role="upgrade-branches"></div>
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
              <li class="touch-only">双击左摇杆 蹲行（更安静、更难被发现）</li>
              <li><kbd>Shift</kbd> 冲刺（消耗体力，体力耗尽无法冲刺，静止快速恢复）</li>
              <li><kbd>1</kbd><kbd>2</kbd> 切换武器 · <kbd>Tab</kbd> 背包 · <kbd>Esc</kbd> 暂停</li>
              <li><kbd>V</kbd> 绳索速降（从高地快速下滑）</li>
              <li><kbd>F</kbd> 上车 / 下车</li>
              <li><kbd>G</kbd> 投掷战术道具 · <kbd>X</kbd> 终结技（干员技能见战前配置）</li>
            </ul>
          </section>
          <section>
            <h3>生存要点</h3>
            <ul class="tips">
              <li>敌人有视野锥，被墙挡住就看不见你；他们也会听枪声和脚步。</li>
              <li>保险箱价值最高，但搜索时间最长 —— 记得先清场再开。</li>
              <li>超重会明显减速并拖慢体力恢复，别什么都往包里塞。</li>
              <li>单局 ${Math.round(MATCH.duration / 60)} 分钟，撤离点依次开放：免费点 ${Math.floor(MATCH.extractFirstOpen / 60)}:${String(MATCH.extractFirstOpen % 60).padStart(2, '0')} 先开，其余剩余 ${MATCH.extractOpenAt / 60}:00 全部开放，站定 ${MATCH.extractChannel} 秒即可撤离。</li>
              <li>地图固定 ${MATCH.extractTotal} 个撤离点（灰色未开放、绿色已开启），撤离成功带走全部物资，阵亡则尽数丢失。</li>
              <li>敌人被击杀后会留下可搜索的尸体。</li>
            </ul>
          </section>
        </div>
      </div>
    </div>

    <!-- 致谢 / 授权：CC BY 3.0 图标要求游戏内可见署名，缺失即违约。
         内容由 icons.js 的 CREDITS 渲染，与图标映射表同源。 -->
    <div class="screen" data-screen="credits">
      <div class="panel">
        <header class="panel-head">
          <h2>致谢与授权</h2>
          <div class="head-right"><button class="btn ghost" data-action="goto-menu">返回</button></div>
        </header>
        <div class="panel-body howto-body credits-body">
          <p class="credits-note-top">${CREDITS_NOTE}</p>
          ${creditsSections}
        </div>
      </div>
    </div>

    <!-- P15：干员档案屏。原先 nav 里这一项是 locked / P5 的诚实占位，
         现在指向真实屏幕：四名干员的被动 / 战术道具 / 终结技全部可读、可切换。 -->
    <div class="screen" data-screen="operators">
      <div class="panel wide">
        <header class="panel-head">
          <h2>干员 OPERATORS</h2>
          <div class="head-right">
            <span class="hint" data-role="operator-current"></span>
            <button class="btn ghost" data-action="goto-menu">返回</button>
          </div>
        </header>
        <div class="panel-body">
          <p class="hint operators-intro">
            干员决定这一局的被动加成、战术道具与终结技。点击卡片即切换，下一局部署时生效。
          </p>
          <div class="opdex-grid" data-role="operator-grid"></div>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="codex">
      <div class="panel wide">
        <header class="panel-head">
          <h2>图鉴 CODEX</h2>
          <div class="head-right">
            <span class="coin" data-role="codex-progress"></span>
            <button class="btn ghost" data-action="goto-menu">返回</button>
          </div>
        </header>
        <div class="panel-body">
          <div class="codex-body" data-role="codex-body"></div>
        </div>
      </div>
    </div>

    <div class="screen" data-screen="result">
      <div class="panel wide">
        <div class="result-head" data-role="result-head"></div>
        <div class="panel-body result-body">
          <div class="result-season" data-role="result-season"></div>
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
          <button class="btn toggle" data-action="toggle-invert-y" data-role="invert-y-toggle">视角Y轴：正常</button>
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
          <!-- P3 调色：曝光 / 对比 / 饱和。数值经 grade3d.clampGrade 钳制后写存档。 -->
          <div class="grade-block">
            <div class="grade-head">画质调色 <span>本地生效 · 不影响帧率</span></div>
            <div class="setting-row">
              <label>曝光</label>
              <input type="range" min="1.10" max="2.20" step="0.05" value="1.70" data-role="grade-exposure">
              <span class="setting-val" data-role="grade-exposure-val">1.70</span>
            </div>
            <div class="setting-row">
              <label>对比</label>
              <input type="range" min="0.80" max="1.15" step="0.01" value="0.96" data-role="grade-contrast">
              <span class="setting-val" data-role="grade-contrast-val">0.96</span>
            </div>
            <div class="setting-row">
              <label>饱和</label>
              <input type="range" min="0.60" max="1.10" step="0.02" value="0.88" data-role="grade-saturation">
              <span class="setting-val" data-role="grade-saturation-val">0.88</span>
            </div>
            <button class="btn ghost grade-reset" data-action="reset-grade">恢复默认调色</button>
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

    <!-- 手机端任务面板命中区：canvas 是 pointer-events:none，用这块透明 DOM 接收点击。
         矩形由 renderHud 每帧从 L.tasks 同步，绝不另写坐标。 -->
    <div class="hud-tap hidden" data-role="tasks-tap" aria-hidden="true"></div>

    <!-- P2 交互：买入 / 出售二次确认，与仓库右键（触屏长按）菜单。
         两者都不是 .screen，不参与 show() 的显隐，避免踩 .screen.hidden 铁律。 -->
    <div class="df-modal hidden" data-role="confirm-modal" role="dialog" aria-modal="true">
      <div class="df-modal-card">
        <div class="df-modal-head" data-role="confirm-title">确认操作</div>
        <p class="df-modal-text" data-role="confirm-text"></p>
        <div class="df-modal-note">本地单机 · 无联网交易</div>
        <div class="df-modal-actions">
          <button type="button" class="btn ghost" data-action="confirm-cancel">返回</button>
          <button type="button" class="btn primary" data-action="confirm-yes">确认</button>
        </div>
      </div>
    </div>
    <div class="df-ctx-menu hidden" data-role="stash-menu" role="menu"></div>

    <div class="streak-banner" data-role="streak-banner" aria-live="polite"></div>
    <div class="raid-transition" data-role="raid-transition" data-tone="ok" aria-hidden="true">
      <div class="raid-transition-inner">
        <div class="raid-transition-tag" data-role="raid-transition-tag"></div>
        <div class="raid-transition-cn" data-role="raid-transition-cn"></div>
        <div class="raid-transition-score" data-role="raid-transition-score"></div>
      </div>
    </div>
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
  // 「交易行」与「商店」暂时都落到 shop 屏，靠最近点击的导航项区分高亮；
  // 从菜单按钮进 shop 时不匹配，回落到按 screen 查表。
  let hubNavId = 'operation';

  /* ---------------- P2 交互：纯 UI 状态（全部只在内存，不写存档） ---------------- */
  let lastSave = null;
  const stashView = { filter: 'all', sort: 'default' };
  // 交易行只保存「本次刷新的一张报价单」。没有共享物资总数、没有跨局库存账本，
  // sold 只是当前页面里已成交的报价 key，刷新或离屏即失效，绝不落 localStorage。
  const marketState = { seed: 0, refresh: 0, listings: [], sold: new Set(), tab: 'supply' };
  let selectedEquip = null;
  let pendingConfirm = null;
  let longPressTimer = 0;
  const CONFIRM_ACTIONS = new Set(['buy', 'sell', 'sell-all', 'buy-listing', 'list-item']);
  /**
   * 8 个装备槽（W2）。
   * 顺序按「先枪后甲再装具」的穿戴直觉排，而不是按数据字段名的字母序 ——
   * 玩家从上往下扫一眼就能确认"这一局带什么"。
   * `allowed` 是拖放/点选落槽的合法 id 白名单，越界一律拒绝（equipToSlot 会 toast 说明）。
   */
  const EQUIP_SLOTS = [
    { slot: 'primary', label: '主武器', allowed: ['rifle', 'smg', 'carbine', 'lmg', 'dmr', 'battle', 'shotgun'] },
    { slot: 'secondary', label: '副武器', allowed: ['smg', 'pdw', 'shotgun'] },
    { slot: 'sidearm', label: '手枪', allowed: ['pistol', 'pdw'] },
    { slot: 'melee', label: '匕首', allowed: ['knife', 'knife_heavy'] },
    { slot: 'helmet', label: '头盔', allowed: ['helmet_lv2', 'helmet_lv3'] },
    { slot: 'armor', label: '护甲', allowed: ['lv2', 'lv3'] },
    { slot: 'backpack', label: '背包', allowed: ['bp_lv1', 'bp_lv2', 'bp_lv3'] },
    { slot: 'rig', label: '胸挂', allowed: ['rig_lv1', 'rig_lv2'] },
  ];

  /** 槽位 id → 展示名（负重/etc. 提示里复用，避免各处再写一份）。 */
  const SLOT_LABEL = EQUIP_SLOTS.reduce((acc, s) => { acc[s.slot] = s.label; return acc; }, {});

  /**
   * 同步局外外壳的读数。各 render*(save) 开头统一调用，不在 main.js 里另接一路 ——
   * 存档在任何局外操作后都会重绘对应屏，顶栏自然跟着更新，没有第二套刷新时机。
   */
  function syncHub(save) {
    if (!save) return;
    lastSave = save;
    const put = (role, text) => {
      const node = q(role);
      if (node) node.textContent = text;
    };
    put('hub-currency', money(save.currency));
    put('hub-raids', String((save.stats && save.stats.raids) || 0));
    const lo = save.loadout || {};
    const est = estimateWeight(lo, save);
    // P2 数值：所有读数都从 gear.js 的真实推导结果取，不在 UI 里另算第二份。
    const readout = gearReadout(save, est);
    put('hub-level', `Lv.${readout.season.level}`);
    put('hub-gear', `装备价值 ${money(readout.gearValue)}`);
    put('hub-weight', `负重 ${est.total.toFixed(1)} / ${est.limit} kg`);
    put('hub-mobility', `机动 ${readout.speedMul.toFixed(2)}×`);
    const weightNode = q('hub-weight');
    if (weightNode) weightNode.classList.toggle('over', est.over);
    const fill = q('hub-season-fill');
    if (fill) fill.style.width = `${Math.round(readout.season.ratio * 100)}%`;
    put('hub-season-xp', readout.season.nextNeed === null
      ? `${readout.season.xp} XP · 满级`
      : `${readout.season.xp} / ${readout.season.nextNeed} XP`);

    // P5：底栏小队第一席跟随当前干员。外壳是常驻 DOM（只建一次），
    // 所以换人后必须在这里重写，否则会一直显示建壳那一刻的名字。
    // P15：后两席改读真实编成 —— 不再是 STANDBY 占位。
    const squadNode = q('hub-squad');
    if (squadNode) {
      const op = getOperator(save.operator);
      const mates = resolveSquadIds(save.squad, save.operator);
      const mateHtml = mates.map((m, i) => `<span class="hub-squad-slot ai" style="--op-color:${m.color}">0${i + 2} · ${m.callsign}</span>`).join('');
      squadNode.innerHTML = '<span class="hub-label">小队 / SQUAD</span>'
        + `<span class="hub-squad-slot player">01 · ${op.callsign}</span>`
        + (mateHtml || SQUAD_STANDBY.map((s) => `<span class="hub-squad-slot standby">${s.slot} · ${s.role}</span>`).join(''));
    }
  }

  let transitionTimer = null;

  function show(name) {
    current = name;
    for (const [key, node] of Object.entries(screens)) {
      node.classList.toggle('hidden', key !== name);
    }
    root.classList.toggle('in-battle', name === 'battle');
    // 局内 HUD / 暂停 / 结算演出都自己占满全屏，外壳必须让开。
    root.classList.toggle('hub-off', HUB.hubOffScreens.includes(name));
    const last = HUB.nav.find((n) => n.id === hubNavId && n.screen === name);
    const active = last || HUB.nav.find((n) => !n.locked && n.screen === name);
    for (const node of root.querySelectorAll('[data-nav]')) {
      const on = Boolean(active && node.dataset.nav === active.id);
      node.classList.toggle('active', on);
      node.setAttribute('aria-current', on ? 'page' : 'false');
    }
    // 底栏主按钮只在战前配置屏才是真部署，其余屏先进配置，避免跳过校验。
    const deploy = q('hub-deploy');
    if (deploy) {
      const onLoadout = name === 'loadout';
      deploy.dataset.action = onLoadout ? 'deploy' : 'goto-loadout';
      deploy.textContent = onLoadout ? '部署进入战区' : '配置并部署';
    }
    // P11：屏切换淡入。只叠装饰类，不动 .screen.hidden{display:none !important} 铁律，
    // 也不改任何 data-screen / class 真值；局内没有可见 screen，跳过。
    if (!reducedMotion && name !== 'battle' && screens[name]) {
      const node = screens[name];
      node.classList.remove('screen-enter');
      if (typeof node.offsetWidth === 'number') void node.offsetWidth;
      node.classList.add('screen-enter');
    }
  }

  /**
   * P11：撤离 / 阵亡过场层。纯视觉覆盖，不引入异步状态机 —— 结果屏仍在同一帧同步就位，
   * 探针读 result DOM 不受影响。动画结束自动摘 on，覆盖层 pointer-events:none 不抢输入。
   * 只报「结果 + 评分」，按用户边界不做死亡回放 / 伤害来源 / 击杀者 / 存活时长的演出。
   * @param {string} kind 'success' | 'failure'
   * @param {number} score 本局评分，用于横幅上的数值滚动
   * @param {object} [opts] 只为截图取证放宽窗口：{ holdMs, countMs }，默认都走 PRESENTATION
   */
  function playTransition(kind, score, opts) {
    const layer = q('raid-transition');
    if (!layer) return;
    const opt = opts && typeof opts === 'object' ? opts : {};
    const hold = Number(opt.holdMs) > 0 ? Number(opt.holdMs) : PRESENTATION.transitionHoldMs;
    const countMs = Number(opt.countMs) > 0 ? Number(opt.countMs) : hold;
    const copy = transitionCopy(kind);
    const finalScore = String(Number(score) || 0);
    const tag = q('raid-transition-tag');
    const cn = q('raid-transition-cn');
    const num = q('raid-transition-score');
    if (tag) tag.textContent = copy.tag;
    if (cn) cn.textContent = copy.cn;
    if (num) num.textContent = countUpText(finalScore, 0);
    layer.dataset.tone = copy.tone;
    layer.dataset.finalScore = finalScore;
    layer.classList.remove('on');
    if (typeof layer.offsetWidth === 'number') void layer.offsetWidth;
    layer.classList.add('on');
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => layer.classList.remove('on'),
      reducedMotion ? 0 : hold + PRESENTATION.transitionFadeMs);
    if (reducedMotion || typeof requestAnimationFrame !== 'function' || !num) return;
    const now0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const tick = (now) => {
      const p = Math.min(1, Math.max(0, (now - now0) / countMs));
      num.textContent = countUpText(finalScore, p);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // 记录最近一次导航点击，供 show() 区分落在同一屏的多个入口。
  root.addEventListener('click', (ev) => {
    const nav = ev.target.closest('[data-nav]');
    if (nav && !nav.disabled) hubNavId = nav.dataset.nav;
  });

  function toast(message, type = 'info') {
    const box = q('toasts');
    // 连续操作（刷新报价、连续装配）容易刷出一叠一模一样的提示；同文本只保留最新一条。
    for (const old of [...box.children]) {
      if (old.dataset.msg === message) old.remove();
    }
    const node = el('div', `toast ${type}`, message);
    node.dataset.msg = message;
    box.appendChild(node);
    window.setTimeout(() => {
      node.classList.add('out');
      window.setTimeout(() => node.remove(), 280);
    }, 1600);
    while (box.children.length > 2) box.firstChild.remove();
  }

  // P18 双栏搜刮：独立 DOM 控制器挂在 ui-root 之外（fixed 覆盖层），
  // 生命周期由 createUI 统一管理；hooks 把副作用交回 main（音效/图鉴/丢弃/指针锁）。
  const lootUI = createLootUI(document.body, {
    toast,
    sound(kind) {
      if (kind === 'error' && handlers['loot-sound']) handlers['loot-sound']('error');
      else if (handlers['loot-sound']) handlers['loot-sound'](kind);
    },
    onChange() { if (handlers['loot-change']) handlers['loot-change'](); },
    onDiscard(uid, item) { if (handlers['loot-discard']) handlers['loot-discard']({ uid, item }); },
    onClose() { if (handlers['loot-close']) handlers['loot-close'](); },
  });

  /* ---------------- 网格渲染 ---------------- */

  function renderGrid(host, inv, onSelect, view) {
    host.innerHTML = '';
    host.style.setProperty('--cols', inv.cols);
    host.style.setProperty('--rows', inv.rows);
    // 网格线由 CSS 背景绘制，这里只放物品，避免与自动排布的占位格冲突。
    // view 只影响展示序（仓库分类/排序），绝不改仓库数据本体。
    const items = view ? viewItems(inv.items, view) : inv.items;
    for (const item of items) {
      const node = el('div', `grid-item rar-${item.rarity}`);
      node.style.gridColumn = `${item.col + 1} / span ${item.w}`;
      node.style.gridRow = `${item.row + 1} / span ${item.h}`;
      node.dataset.uid = item.uid;
      const iconSize = Math.min(30, 15 * Math.min(item.w, item.h) + 12);
      node.appendChild(itemIconEl(item.id, iconSize,
        () => iconEl(item.icon, RARITY[item.rarity].color, iconSize)));
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
    row.appendChild(itemIconEl(item.id, 24,
      () => iconEl(item.icon, RARITY[item.rarity].color, 24)));
    const disp = displayUnits(item);
    const main = el('div', 'item-main');
    main.appendChild(el('div', 'item-name', item.qty > 1 ? `${item.name} ×${disp.count}${disp.unit}` : item.name));
    // 价值密度放最后：丢东西时能逐件比较"同样占一格，谁更值钱"
    const density = Math.round(itemValue(item) / Math.max(0.1, itemWeight(item)));
    main.appendChild(el('div', 'item-meta',
      `${item.w}×${item.h} 格 · ${itemWeight(item).toFixed(1)}kg · ${RARITY[item.rarity].name} · ${money(density)}/kg`));
    row.appendChild(main);
    if (extra) row.appendChild(extra);
    return row;
  }

  /* ---------------- 主菜单 ---------------- */

  function renderMenu(save) {
    syncHub(save);
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
    // 今日突袭状态：让玩家在菜单上就看得见"今天打过没有"
    const daily = save.daily || {};
    const isToday = daily.date === String(dailySeed());
    entries.push(['今日突袭', isToday ? (daily.extracted ? '已通关' : `最高 ${daily.bestScore} 分`) : '未开始']);
    for (const [k, v] of entries) {
      const node = el('div', 'stat');
      node.appendChild(el('span', 'k', k));
      node.appendChild(el('span', 'v', v));
      host.appendChild(node);
    }

    // P2 行动简报：地图 / 时长 / 撤离点 / POI / 编队全部读真实配置与存档，
    // 不编造赛季进度。小屏会整块隐藏（见 styles.css 的 P2 降级段）。
    const brief = q('menu-brief');
    if (brief) {
      brief.innerHTML = '';
      const activeCard = root.querySelector('[data-map].active');
      const mapId = (activeCard && activeCard.dataset.map) || DEFAULT_MAP_ID;
      const map = MAPS[mapId] || MAPS[DEFAULT_MAP_ID];
      brief.appendChild(el('div', 'brief-head', '行动简报 / BRIEFING'));
      brief.appendChild(el('div', 'brief-map', map.name));
      brief.appendChild(el('div', 'brief-tag', map.tagline));
      const grid = el('div', 'brief-grid');
      const row = (k, v, cls) => {
        const node = el('div', `brief-row${cls ? ` ${cls}` : ''}`);
        node.appendChild(el('span', 'k', k));
        node.appendChild(el('span', 'v', v));
        grid.appendChild(node);
      };
      row('风险等级', (HUB.riskLevels.find((r) => r.id === save.risk) || HUB.riskLevels[0]).label, 'ok');
      row('作战时长', `${Math.round(MATCH.duration / 60)} 分钟`);
      row('撤离点', String(MATCH.extractTotal));
      row('成功撤离', String(stats.extracts || 0));
      brief.appendChild(grid);
      brief.appendChild(el('div', 'brief-label', '命名区域 / POI'));
      const pois = el('div', 'brief-pois');
      for (const name of (POI_NAMES[mapId] || []).slice(0, 6)) pois.appendChild(el('span', 'brief-poi', name));
      brief.appendChild(pois);
      brief.appendChild(el('div', 'brief-label', '编队 / SQUAD'));
      const squad = el('div', 'brief-squad');
      const op = getOperator(save.operator);
      squad.appendChild(el('span', 'brief-slot on', `01 · ${op.callsign}（${op.roleName}）`));
      // P15：显示真实编成（战前可选），不再写死 STANDBY。
      resolveSquadIds(save.squad, save.operator).forEach((m, i) => {
        squad.appendChild(el('span', 'brief-slot', `0${i + 2} · ${m.callsign}（${m.roleName}）`));
      });
      brief.appendChild(squad);
      brief.appendChild(el('p', 'hint', `干员 ${op.code} · ${op.tacticalLine} · 终结技「${op.ultimate.name}」。小队两席可在左侧「小队编成」里更换，部署时入场。`));
    }
  }

  /* ---------------- 战前配置 ---------------- */

  /**
   * P7 弹药与医疗区块：主/副武器各选弹种 + 该口径三型弹药的盒数。
   * 弹药按「盒」计量，但**每盒发数按弹种走**（`ammoBoxSize`：12ga 是 24，
   * 其余 60），与仓库/负重/估值同一口径。全局 `AMMO_STACK` 只用于 5.56/9mm/7.62。
   * @param {object} save 存档
   * @returns {void}
   */
  function renderAmmoConfig(save) {
    const host = q('ammo-config');
    if (!host) return;
    host.innerHTML = '';
    const lo = save.loadout || {};
    const block = el('div', 'opt-block ammo-block');
    const head = el('div', 'ammo-block-head');
    head.appendChild(el('h3', null, '弹药与医疗 / AMMO & MEDICAL'));
    head.appendChild(el('span', 'hint', '弹种按武器口径绑定 · 按盒携带（不同口径每盒发数不同）'));
    block.appendChild(head);

    let anyWeapon = false;
    for (const [role, label] of [['primary', '主武器'], ['secondary', '副武器']]) {
      const wid = lo[role];
      const w = WEAPONS[wid];
      if (!w) continue;
      const list = ammoIdsForWeapon(wid);
      if (!list.length) continue;
      anyWeapon = true;
      const grade = resolveAmmoGrade(lo, role);
      const wrap = el('div', 'ammo-weapon');
      wrap.dataset.role = role;

      const top = el('div', 'ammo-weapon-head');
      top.appendChild(el('span', 'ammo-weapon-name', `${label} · ${w.name}`));
      top.appendChild(el('span', 'ammo-weapon-grade', ammoLabel(grade)));
      wrap.appendChild(top);

      const chips = el('div', 'ammo-grades');
      for (const id of list) {
        const def = ITEMS[id];
        if (!def) continue;
        const btn = el('button', `ammo-grade-chip${id === grade ? ' active' : ''}`);
        btn.dataset.action = 'set-loadout';
        btn.dataset.slot = role === 'primary' ? 'ammoPrimary' : 'ammoSecondary';
        btn.dataset.value = id;
        btn.title = def.desc || '';
        btn.appendChild(el('span', 'g-name', def.gradeName || def.name));
        btn.appendChild(el('span', 'g-pen', `PEN ${def.pen}`));
        chips.appendChild(btn);
      }
      wrap.appendChild(chips);

      const grid = el('div', 'ammo-grid');
      for (const id of list) {
        const def = ITEMS[id];
        if (!def) continue;
        const boxes = loadoutAmmoBoxes(lo, id);
        const cell = el('div', 'ammo-cell');
        cell.dataset.ammoId = id;
        const info = el('div', 'ammo-cell-info');
        info.appendChild(el('span', 'ammo-cell-name', def.name.replace(/^.*?mm\s*/, '')));
        const cellSize = ammoBoxSize(id);
        info.appendChild(el('span', 'ammo-cell-warehouse', `仓 ${Math.floor(countIn(save, id) / cellSize)} 盒 · 每盒 ${cellSize} 发`));
        cell.appendChild(info);
        const ctrl = el('div', 'ammo-cell-ctrl');
        const minus = el('button', 'step', '−');
        minus.dataset.action = 'step-loadout';
        minus.dataset.kind = `ammo:${id}`;
        minus.dataset.delta = '-1';
        minus.disabled = boxes <= 0;
        const val = el('b', 'ammo-cell-count', String(boxes));
        const plus = el('button', 'step', '+');
        plus.dataset.action = 'step-loadout';
        plus.dataset.kind = `ammo:${id}`;
        plus.dataset.delta = '1';
        plus.disabled = boxes >= 6;
        ctrl.appendChild(minus);
        ctrl.appendChild(val);
        ctrl.appendChild(plus);
        cell.appendChild(ctrl);
        grid.appendChild(cell);
      }
      wrap.appendChild(grid);
      block.appendChild(wrap);
    }
    if (!anyWeapon) {
      block.appendChild(el('p', 'hint', '先装备一把武器，才能选择对应口径的弹种。'));
    }

    // 头盔与弹种同区：三档，零/二级/三级；只覆盖爆头，不占胸甲耐久。
    const helmRow = el('div', 'ammo-helmet-row');
    helmRow.appendChild(el('span', 'ammo-helmet-label', '头盔'));
    const hchips = el('div', 'ammo-grades');
    for (const id of HELMET_IDS) {
      const def = id === 'none' ? ARMORS.none : ARMORS[id];
      if (!def) continue;
      const active = (lo.helmet || 'none') === id;
      const btn = el('button', `ammo-grade-chip helmet-chip${active ? ' active' : ''}`);
      btn.dataset.action = 'set-loadout';
      btn.dataset.slot = 'helmet';
      btn.dataset.value = id;
      btn.title = def.desc || '';
      btn.appendChild(el('span', 'g-name', id === 'none' ? '不戴' : def.name));
      btn.appendChild(el('span', 'g-pen', id === 'none' ? '无防护' : `护甲 ${def.armor} · T${def.level}`));
      hchips.appendChild(btn);
    }
    helmRow.appendChild(hchips);
    block.appendChild(helmRow);

    block.appendChild(el(
      'p', 'ammo-med-line',
      `医疗：医疗包 ×${lo.medkits || 0} · 绷带 ×${lo.bandages || 0} · 手术包 ×${lo.surgeries || 0} · 护甲包 ×${lo.armorKits || 0}`,
    ));
    host.appendChild(block);
  }

  function renderLoadout(save) {
    syncHub(save);
    // P15 风险分级：**存档是唯一真值**，这里只把 DOM 同步成它。
    // 不能靠点击时手改 class —— 那会让「返回再进战前」「读旧档」两条路径的选中态漂移。
    const curRisk = HUB.riskLevels.find((r) => r.id === save.risk) || HUB.riskLevels[0];
    const riskHost = q('risk-pick');
    if (riskHost) {
      for (const btn of riskHost.querySelectorAll('.risk-opt')) {
        const on = btn.dataset.risk === curRisk.id;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    const riskHint = q('risk-hint');
    if (riskHint) riskHint.textContent = `${curRisk.label} · ${curRisk.desc}`;
    // 地图卡右上角的风险徽标跟着当前档走（卡是 createUI 时生成的，不能重写 innerHTML）。
    for (const badge of root.querySelectorAll('.map-card-risk')) badge.textContent = curRisk.label;
    q('loadout-currency').textContent = money(save.currency);
    const upProg = q('loadout-upgrades-progress');
    if (upProg) {
      const done = BRANCHES.reduce((sum, b) => sum + getBranchLevel(save, b.id), 0);
      upProg.textContent = `已解锁 ${done}/${BRANCHES.length * MAX_LEVEL} 级永久强化。`;
    }
    const host = q('loadout-options');
    host.innerHTML = '';
    const lo = save.loadout;

    // 装备保险开关：显示当前状态与本次保费（保费按当前配置的武器+护甲价值算）
    const insured = Boolean(save.insurance && save.insurance.enabled && INSURANCE.enabled);
    const insBtn = q('insurance-toggle');
    if (insBtn) {
      insBtn.textContent = insured ? '装备保险：开' : '装备保险：关';
      insBtn.classList.toggle('on', insured);
    }
    const insHint = q('insurance-hint');
    if (insHint) {
      const gearValue = [lo.primary, lo.secondary]
        .filter((id) => id && WEAPONS[id])
        .reduce((s, id) => s + WEAPONS[id].value, 0)
        + (lo.armor && lo.armor !== 'none' && ARMORS[lo.armor] ? ARMORS[lo.armor].value : 0)
        + (lo.helmet && lo.helmet !== 'none' && ARMORS[lo.helmet] ? ARMORS[lo.helmet].value : 0);
      insHint.textContent = insured
        ? `本次保费 ${money(Math.round(gearValue * INSURANCE.rate))} —— 阵亡只赔带入的武器与护甲，随身物资照旧丢失。`
        : '投保后阵亡只赔带入的武器与护甲，随身物资照旧丢失。';
    }

    const optionGroup = (title, options, currentValue, slot, renderLabel, renderMissing) => {
      const block = el('div', 'opt-block');
      block.appendChild(el('h3', null, title));
      const row = el('div', 'opt-row');
      for (const opt of options) {
        const btn = el('button', `opt ${opt.value === currentValue ? 'active' : ''}`);
        btn.dataset.action = 'set-loadout';
        btn.dataset.slot = slot;
        btn.dataset.value = String(opt.value);
        btn.appendChild(iconEl(opt.icon || 'bolt', opt.color || DF.rarity.white, 20));
        btn.appendChild(el('span', null, renderLabel ? renderLabel(opt) : opt.label));
        if (renderMissing && renderMissing(opt)) btn.classList.add('missing');
        row.appendChild(btn);
      }
      block.appendChild(row);
      host.appendChild(block);
    };

    // 干员（P5）：四张档案卡，点一下即换人。选择只写存档，部署时才定格成本局配置。
    // 卡片上直接印战术道具与终结技的效果 —— 不在别处再写一份说明，避免两处文案漂移。
    // 注意渲染目标是左侧干员区（W2 起位于装备板之后），不是底部的 loadout-options（那里在滚动区外）。
    const opHost = q('operator-pick');
    const opBlock = el('div', 'opt-block operator-block');
    opBlock.appendChild(el('h3', null, '干员 / OPERATOR'));
    const opRow = el('div', 'operator-row');
    const currentOp = getOperator(save.operator);
    for (const op of OPERATORS) {
      const card = el('button', `operator-card${op.id === currentOp.id ? ' active' : ''}`);
      card.dataset.action = 'set-operator';
      card.dataset.operator = op.id;
      card.style.setProperty('--op-color', op.color);
      card.appendChild(el('span', 'op-code', op.code));
      card.appendChild(el('span', 'op-name', `${op.callsign} · ${op.roleName}`));
      card.appendChild(el('span', 'op-tactical', op.tacticalLine));
      card.appendChild(el('span', 'op-ult', op.ultimateLine));
      opRow.appendChild(card);
    }
    opBlock.appendChild(opRow);
    opBlock.appendChild(el(
      'p', 'hint',
      `被动「${currentOp.perk.name}」${currentOp.perk.desc} —— ${currentOp.bio}`,
    ));
    if (opHost) {
      opHost.innerHTML = '';
      opHost.appendChild(opBlock);
    }

    // P15 小队编成：两席 × 候选干员（排除玩家自己，避免局内出现同代号单位）。
    // 与干员选择一样，只写存档；真正的生成在 startRaid 里由 resolveSquadIds 定格。
    const squadHost = q('squad-pick');
    if (squadHost) {
      squadHost.innerHTML = '';
      const block = el('div', 'opt-block squad-block');
      const head = el('div', 'squad-head');
      head.appendChild(el('h3', null, '小队编成 / SQUAD'));
      head.appendChild(el('span', 'hint', '两名 AI 队友 · 部署时入场'));
      block.appendChild(head);
      const cur = resolveSquadIds(save.squad, save.operator);
      const row = el('div', 'squad-row');
      for (let i = 0; i < 2; i += 1) {
        const picked = cur[i];
        const seat = el('div', 'squad-seat');
        if (picked) seat.style.setProperty('--op-color', picked.color);
        const label = el('div', 'squad-seat-head');
        label.appendChild(el('span', 'squad-slot', `0${i + 2}`));
        label.appendChild(el('span', 'squad-name', picked ? `${picked.callsign} · ${picked.roleName}` : '空缺'));
        seat.appendChild(label);
        const opts = el('div', 'squad-opts');
        for (const op of OPERATORS) {
          if (op.id === save.operator) continue;
          const on = Boolean(picked && op.id === picked.id);
          const btn = el('button', `squad-opt${on ? ' active' : ''}`, op.callsign);
          btn.dataset.action = 'set-squad';
          btn.dataset.slot = String(i);
          btn.dataset.operator = op.id;
          btn.title = `${op.code} · ${op.roleName} · 被动「${op.perk.name}」`;
          btn.style.setProperty('--op-color', op.color);
          opts.appendChild(btn);
        }
        seat.appendChild(opts);
        row.appendChild(seat);
      }
      block.appendChild(row);
      squadHost.appendChild(block);
    }

    optionGroup('主武器', [
      { value: '', label: '不带', icon: 'bolt' },
      { value: 'rifle', label: WEAPONS.rifle.name, icon: 'wpn_rifle', color: DF.accent },
      { value: 'smg', label: WEAPONS.smg.name, icon: 'wpn_smg', color: DF.rarity.blue },
      { value: 'carbine', label: WEAPONS.carbine.name, icon: 'wpn_rifle', color: DF.rarity.purple },
      { value: 'lmg', label: WEAPONS.lmg.name, icon: 'wpn_rifle', color: DF.rarity.gold },
      { value: 'dmr', label: WEAPONS.dmr.name, icon: 'wpn_rifle', color: DF.rarity.purple },
      { value: 'battle', label: WEAPONS.battle.name, icon: 'wpn_rifle', color: DF.rarity.blue },
      { value: 'shotgun', label: WEAPONS.shotgun.name, icon: 'wpn_rifle', color: DF.rarity.gold },
    ], lo.primary || '', 'primary', (o) => o.label, (o) => o.value && countIn(save, o.value) < 1);

    optionGroup('副武器', [
      { value: '', label: '不带', icon: 'bolt' },
      { value: 'smg', label: WEAPONS.smg.name, icon: 'wpn_smg', color: DF.rarity.blue },
      { value: 'pdw', label: WEAPONS.pdw.name, icon: 'wpn_smg', color: DF.rarity.purple },
      { value: 'shotgun', label: WEAPONS.shotgun.name, icon: 'wpn_rifle', color: DF.rarity.gold },
    ], lo.secondary || '', 'secondary', (o) => o.label, (o) => o.value && countIn(save, o.value) < 1);

    // W2：手枪独立成槽（快捷栏 3）。手枪是"主/副都打空之后还留着一发"的保险，
    // 与副武器分槽之后不会再出现"带了两把枪、其实第二把是手枪"这种糊涂配置。
    optionGroup('手枪', [
      { value: '', label: '不带', icon: 'bolt' },
      { value: 'pistol', label: WEAPONS.pistol.name, icon: 'wpn_pistol', color: DF.rarity.white },
      { value: 'pdw', label: WEAPONS.pdw.name, icon: 'wpn_smg', color: DF.rarity.purple },
    ], lo.sidearm || '', 'sidearm', (o) => o.label, (o) => o.value && countIn(save, o.value) < 1);

    // W2：匕首。静默手段 —— 不消耗弹药、不把整张图的人引过来（见 combat.meleeAttack）。
    optionGroup('匕首', [
      { value: 'none', label: '不带', icon: 'bolt' },
      { value: 'knife', label: MELEE.knife.name, icon: 'bayonet', color: DF.rarity.white },
      { value: 'knife_heavy', label: MELEE.knife_heavy.name, icon: 'bayonet', color: DF.rarity.blue },
    ], lo.melee || 'none', 'melee', (o) => o.label, (o) => o.value !== 'none' && countIn(save, o.value) < 1);

    // P6 改枪台：在战前配置屏渲染两把已装备武器的附件改装面板（装配/卸下走 set-mod）。
    renderGunBench(save);

    optionGroup('护甲', [
      { value: 'none', label: ARMORS.none.name, icon: 'armor' },
      { value: 'lv2', label: ARMORS.lv2.name, icon: 'armor', color: DF.rarity.blue },
      { value: 'lv3', label: ARMORS.lv3.name, icon: 'armor', color: DF.rarity.purple },
    ], lo.armor || 'none', 'armor', (o) => o.label, (o) => o.value !== 'none' && countIn(save, o.value) < 1);

    // W2：背包只买「负重上限」，胸挂只买「快速取用位」——两者互不替代，
    // 文案里把收益写死成数字，玩家不用猜哪件更值。
    optionGroup('背包（负重上限）', [
      { value: 'none', label: BACKPACKS.none.name, icon: 'crate' },
      { value: 'bp_lv1', label: `${BACKPACKS.bp_lv1.name} +${BACKPACKS.bp_lv1.packBonus}kg`, icon: 'crate', color: DF.rarity.white },
      { value: 'bp_lv2', label: `${BACKPACKS.bp_lv2.name} +${BACKPACKS.bp_lv2.packBonus}kg`, icon: 'crate', color: DF.rarity.blue },
      { value: 'bp_lv3', label: `${BACKPACKS.bp_lv3.name} +${BACKPACKS.bp_lv3.packBonus}kg`, icon: 'crate', color: DF.rarity.purple },
    ], lo.backpack || 'none', 'backpack', (o) => o.label, (o) => o.value !== 'none' && countIn(save, o.value) < 1);

    optionGroup('胸挂（取用位）', [
      { value: 'none', label: `${RIGS.none.name} ${RIGS.none.cols}×${RIGS.none.rows}`, icon: 'armor' },
      { value: 'rig_lv1', label: `${RIGS.rig_lv1.name} ${RIGS.rig_lv1.cols}×${RIGS.rig_lv1.rows}`, icon: 'armor', color: DF.rarity.white },
      { value: 'rig_lv2', label: `${RIGS.rig_lv2.name} ${RIGS.rig_lv2.cols}×${RIGS.rig_lv2.rows}`, icon: 'armor', color: DF.rarity.blue },
    ], lo.rig || 'rig_lv1', 'rig', (o) => o.label, (o) => o.value !== 'none' && countIn(save, o.value) < 1);

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

    // P7：弹药不再塞在底部两个固定计数器里，改到改枪台下方的「弹药与医疗」区块
    // （弹种 + 盒数 + 头盔 + 药品集中在一处，避免玩家在长页面上下往返）。
    renderAmmoConfig(save);
    counter('医疗包', 'medkits', lo.medkits || 0, 0, 4, `个（仓库 ${countIn(save, 'medkit')}）`);
    counter('绷带', 'bandages', lo.bandages || 0, 0, 4, `个（仓库 ${countIn(save, 'bandage')}）`);
    counter('手术包', 'surgeries', lo.surgeries || 0, 0, 2, `个（仓库 ${countIn(save, 'surgery')}）`);
    counter('护甲维修包', 'armorKits', lo.armorKits || 0, 0, 2, `个（仓库 ${countIn(save, 'armorKit')}）`);

    // 负重估算
    const weightHost = q('loadout-weight');
    weightHost.innerHTML = '';
    const est = estimateWeight(lo, save);
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
    const bonus = weightLimitBonus(save);
    const bonusText = bonus > 0 ? ` + 改装 ${bonus}kg` : '';
    weightHost.appendChild(el(
      'p', est.over ? 'hint warn-text' : 'hint',
      est.over
        ? `已超重：移速下降但仍可奔跑（上限 ${est.limit} kg = 基础 ${PLAYER.weightBaseLimit} + ${armorName}加成${bonusText}）。带得越少跑得越快。`
        : `负重上限 ${est.limit} kg（基础 ${PLAYER.weightBaseLimit} + ${armorName}加成${bonusText}）。超过即减速，但仍可奔跑。`,
    ));

    // P2 数值：行动经济性全部读 gear.js 的推导结果，保费口径与 main.deploy() 一致。
    const econ = q('loadout-economy');
    if (econ) {
      econ.innerHTML = '';
      const r = gearReadout(save, est);
      const rows = [
        ['装备价值', money(r.gearValue)],
        ['携带物资', money(r.consumableValue)],
        ['本次保费', r.insured ? money(r.premium) : '未投保'],
        ['仓库估值', money(r.stashValue)],
        ['机动倍率', `${r.speedMul.toFixed(2)}×`],
      ];
      for (const [k, v] of rows) {
        const node = el('div', 'econ-row');
        node.appendChild(el('span', 'k', k));
        node.appendChild(el('span', 'v', v));
        econ.appendChild(node);
      }
      const season = el('div', 'econ-season');
      season.appendChild(el('span', null, `行动等级 Lv.${r.season.level} · ${r.season.label}`));
      const bar = el('div', 'econ-bar');
      const fill = el('i');
      fill.style.width = `${Math.round(r.season.ratio * 100)}%`;
      bar.appendChild(fill);
      season.appendChild(bar);
      econ.appendChild(season);
    }

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
    // P2 交互：装备槽与托盘读同一份存档，落槽后由 main 的 set-loadout 重绘本屏。
    renderEquipBay(save);
  }

  /**
   * P6 改枪台：在战前配置屏渲染两把已装备武器的附件改装面板。
   * 每把武器一张卡片：列出六个槽位的兼容附件芯片（含「空」），激活项高亮；
   * 下方给出「基础 → 改装」数值预览。点击芯片经 data-action="set-mod" 委托 main 处理。
   * @param {object} save 存档对象
   * @returns {void}
   */
  function renderGunBench(save) {
    const host = q('gun-bench');
    if (!host) return;
    const lo = save.loadout;
    const fmtNum = (v) => Number(Number(v).toFixed(3)).toString();
    const roles = [
      { role: 'primary', id: lo.primary, label: '主武器' },
      { role: 'secondary', id: lo.secondary, label: '副武器' },
    ];
    const block = el('div', 'opt-block gun-bench');
    block.appendChild(el('h3', null, '改枪台 · GUN BENCH'));

    for (const { role, id, label } of roles) {
      if (!id || !WEAPONS[id]) {
        block.appendChild(el('p', 'hint', `${label}：未装备武器，无法改装。`));
        continue;
      }
      const baseDef = WEAPONS[id];
      const modsMap = (lo.mods && lo.mods[role]) || {};
      const card = el('div', 'gun-bench-card');
      const head = el('div', 'gun-bench-head');
      head.appendChild(el('span', 'gun-bench-name', baseDef.name));
      head.appendChild(el('span', 'gun-bench-tag', label));
      card.appendChild(head);

      // P14：侧视线稿 —— 装了什么，这里立刻看得到。
      // 尺寸来自 vmparams.js（与 3D 枪模同一份真值），所以预览不会与局内枪模走形。
      // W1：线稿保留为**回退层**（无 WebGL / 预览创建失败时显示），3D 就位后由
      // main.js 给容器加 .has3d，CSS 把线稿隐藏。两层同一份 vmparams 真值，不会走形。
      const modList = WEAPON_MOD_SLOTS.map((sl) => modsMap[sl.id]).filter(Boolean);
      const sketchBox = el('div', 'gun-bench-preview');
      const prev3d = el('div', 'preview3d-host gun-bench-3d');
      prev3d.dataset.role = 'gun-preview-3d';
      prev3d.dataset.weapon = id;
      prev3d.dataset.slotRole = role;
      sketchBox.appendChild(prev3d);
      const sketchFallback = el('div', 'gun-bench-sketch');
      sketchFallback.innerHTML = sketchSvg(id, modList, {
        colors: { body: DF.text, dark: DF.dim, accent: DF.accent },
        width: 320,
        height: 112,
      });
      sketchBox.appendChild(sketchFallback);
      const modWeight = modList.reduce(
        (sum, mid) => sum + (((WEAPON_MODS[mid] || {}).weight) || 0), 0,
      );
      sketchBox.appendChild(el('span', 'gun-bench-preview-tag',
        modList.length
          ? `已装 ${modList.length} 件 · 增重 ${modWeight > 0 ? '+' : ''}${modWeight.toFixed(2)} kg`
          : '裸枪状态 · 未装任何附件'));
      card.appendChild(sketchBox);

      // 六个槽位：每行 = 槽名 + 兼容附件芯片（含「空」）
      const slots = el('div', 'gun-bench-slots');
      for (const slotDef of WEAPON_MOD_SLOTS) {
        const slotRow = el('div', 'slot-row');
        slotRow.appendChild(el('span', 'slot-name', slotDef.name));
        const chips = el('div', 'slot-chips');
        const options = attachmentOptions(slotDef.id, id);
        const current = modsMap[slotDef.id] || null;
        for (const opt of options) {
          const chip = el('button', `mod-chip${(opt.id || null) === current ? ' active' : ''}`);
          chip.dataset.action = 'set-mod';
          chip.dataset.role = role;
          chip.dataset.slot = slotDef.id;
          chip.dataset.modId = opt.id == null ? '' : opt.id;
          chip.title = opt.desc || '';
          chip.appendChild(el('span', 'mod-name', opt.name));
          if (typeof opt.weight === 'number' && opt.weight !== 0) {
            chip.appendChild(el('span', 'mod-weight', `${opt.weight > 0 ? '+' : ''}${opt.weight}kg`));
          }
          chips.appendChild(chip);
        }
        slotRow.appendChild(chips);
        slots.appendChild(slotRow);
      }
      card.appendChild(slots);

      // 数值预览：W1 起用 13 项面板（对标视频字段），基础 → 改装逐项对比。
      // 8 项原始字段的算子在 gunbench.effectiveStatsPreview，13 项的口径在 benchStatRows。
      const preview = benchStatRows(baseDef, modsMap);
      const changed = preview.some((r) => r.better !== null);
      const stats = el('div', 'gun-bench-stats');
      for (const r of preview) {
        const cell = el('div', 'stat-cell');
        cell.appendChild(el('span', 'stat-label', r.label));
        const val = el('span', 'stat-val');
        const fmt = (v) => (typeof v === 'number' ? fmtNum(v) : String(v));
        if (r.kind === 'text') {
          val.appendChild(el('span', 'stat-text', fmt(r.after)));
        } else if (r.better === null) {
          val.appendChild(el('span', null, fmt(r.after)));
        } else {
          val.appendChild(el('span', 'stat-base', fmt(r.base)));
          val.appendChild(el('span', `stat-arrow ${r.better ? 'better' : 'worse'}`, ' → '));
          val.appendChild(el('span', `stat-after ${r.better ? 'better' : 'worse'}`, fmt(r.after)));
        }
        if (r.unit) val.appendChild(el('span', 'stat-unit', r.unit));
        cell.appendChild(val);
        stats.appendChild(cell);
      }
      card.appendChild(stats);
      if (!changed) card.appendChild(el('p', 'hint', '当前未装配任何影响数值的附件。'));

      block.appendChild(card);
    }
    host.innerHTML = '';
    host.appendChild(block);
    // W1：3D 预览的挂载由 main.js 负责（它持有渲染器生命周期），ui.js 只发一个事件，
    // 不 import three。CustomEvent 在 Node 单测里可能不存在，做能力判断即可。
    if (typeof CustomEvent === 'function' && typeof host.dispatchEvent === 'function') {
      host.dispatchEvent(new CustomEvent('gunbench:rendered', { bubbles: true }));
    }
  }

  function countIn(save, id) {
    return save.stash.items
      .filter((it) => it.id === id)
      .reduce((s, it) => s + Math.max(1, it.qty || 1), 0);
  }

  /**
   * 估算装备配置的总重量与负重上限。
   * 上限随所选护甲与局外改装变化，所以这一屏不能写死。
   * @param {object} lo 装备配置
   * @param {object} [save] 存档（用于读取改装提供的额外负重）
   * @returns {{base: number, items: number, total: number, limit: number, over: boolean}} 重量明细
   */
  function estimateWeight(lo, save) {
    let base = 0;
    if (lo.primary && WEAPONS[lo.primary]) base += WEAPONS[lo.primary].weight;
    if (lo.secondary && WEAPONS[lo.secondary]) base += WEAPONS[lo.secondary].weight;
    if (lo.sidearm && WEAPONS[lo.sidearm]) base += WEAPONS[lo.sidearm].weight;
    // W2 装具：匕首 / 背包 / 胸挂的自重同样计入「装备合计」（局内 Player.weight 用同一份口径）。
    if (lo.melee && MELEE[lo.melee]) base += MELEE[lo.melee].weight;
    if (lo.backpack && BACKPACKS[lo.backpack]) base += BACKPACKS[lo.backpack].weight;
    if (lo.rig && RIGS[lo.rig]) base += RIGS[lo.rig].weight;
    if (lo.armor && ARMORS[lo.armor]) base += ARMORS[lo.armor].weight;
    if (lo.helmet && ARMORS[lo.helmet]) base += ARMORS[lo.helmet].weight;
    // P6 改枪台：附件重量计入装备合计（可为负，如短枪管减重）
    base += loadoutModWeight(lo);
    let items = loadoutAmmoWeight(lo);
    items += (lo.medkits || 0) * ITEMS.medkit.weight;
    items += (lo.bandages || 0) * ITEMS.bandage.weight;
    items += (lo.surgeries || 0) * ITEMS.surgery.weight;
    items += (lo.armorKits || 0) * ITEMS.armorKit.weight;
    const total = Math.round((base + items) * 10) / 10;
    const limit = weightLimitFor(lo.armor || 'none', lo.backpack || 'none')
      + (save ? weightLimitBonus(save) : 0);
    const packBonus = (BACKPACKS[lo.backpack] && BACKPACKS[lo.backpack].packBonus) || 0;
    return { base, items, total, limit, over: total > limit, packBonus };
  }

  /**
   * 校验装备配置是否可行。
   * @param {object} save 存档
   * @returns {Array<string>} 问题列表
   */
  function validateLoadout(save) {
    const lo = save.loadout;
    const problems = [];
    // W2：三把枪都能独立满足「至少带一件武器」，手枪不再是副武器的影子。
    const weapons = [lo.primary, lo.secondary, lo.sidearm].filter((id) => id && WEAPONS[id]);
    if (!weapons.length) problems.push('至少要带一把武器（仓库里没有可用武器时会提示）');
    for (const id of weapons) {
      if (countIn(save, id) < 1) problems.push(`仓库中没有 ${WEAPONS[id].name}，请先去商店购买`);
    }
    // W2 装具：同样按「仓库里有货才能带走」校验 —— 与 deploy 的扣仓列表一一对应。
    for (const [slot, table] of [['melee', MELEE], ['backpack', BACKPACKS], ['rig', RIGS]]) {
      const id = lo[slot];
      if (!id || id === 'none' || !table[id]) continue;
      if (countIn(save, id) < 1) problems.push(`仓库中没有 ${table[id].name}（${SLOT_LABEL[slot]}）`);
    }
    if (lo.armor && lo.armor !== 'none' && ARMORS[lo.armor] && countIn(save, lo.armor) < 1) {
      problems.push(`仓库中没有 ${ARMORS[lo.armor].name}`);
    }
    if (lo.helmet && lo.helmet !== 'none' && ARMORS[lo.helmet] && countIn(save, lo.helmet) < 1) {
      problems.push(`仓库中没有 ${ARMORS[lo.helmet].name}`);
    }
    // P7：每个弹种单独校验，AP/亚音速/空尖不再搭标准弹的便车
    for (const id of AMMO_IDS) {
      const boxes = loadoutAmmoBoxes(lo, id);
      if (boxes * ammoBoxSize(id) > countIn(save, id)) {
        const def = ITEMS[id];
        problems.push(`${def ? def.name : id} 数量超过仓库库存`);
      }
    }
    if ((lo.medkits || 0) > countIn(save, 'medkit')) problems.push('医疗包数量超过仓库库存');
    if ((lo.bandages || 0) > countIn(save, 'bandage')) problems.push('绷带数量超过仓库库存');
    if ((lo.surgeries || 0) > countIn(save, 'surgery')) problems.push('手术包数量超过仓库库存');
    if ((lo.armorKits || 0) > countIn(save, 'armorKit')) problems.push('护甲维修包数量超过仓库库存');
    const cells = AMMO_IDS.reduce((s, id) => s + loadoutAmmoBoxes(lo, id), 0)
      + (lo.medkits || 0) + (lo.bandages || 0) + (lo.surgeries || 0) + (lo.armorKits || 0);
    if (cells > PLAYER.backpack.cols * PLAYER.backpack.rows) problems.push('携带物资超过背包容量');
    return problems;
  }

  /* ---------------- 局外改装 ---------------- */

  /**
   * 渲染改装树（三支 × 三级）。
   *
   * 这里**不重复计算**价格与前置条件：能不能买一律问 upgrades.js 的 checkBuy，
   * UI 只负责把 ok/reason 翻译成按钮状态与一行提示。两套判定必然会漂移。
   * @param {object} save 存档
   * @returns {void}
   */
  function renderUpgrades(save) {
    syncHub(save);
    const coin = q('upgrades-currency');
    if (coin) coin.textContent = money(save.currency);
    const host = q('upgrade-branches');
    if (!host) return;
    host.innerHTML = '';

    const total = BRANCHES.length * MAX_LEVEL;
    const done = BRANCHES.reduce((sum, b) => sum + getBranchLevel(save, b.id), 0);
    const summaryHost = q('upgrade-summary');
    if (summaryHost) {
      summaryHost.innerHTML = '';
      summaryHost.appendChild(el('span', 'k', `总进度 ${done}/${total}`));
      summaryHost.appendChild(el('span', 'v', done >= total ? '已全部解锁' : '继续撤离以赚取改装资金'));
    }

    for (const branch of BRANCHES) {
      const level = getBranchLevel(save, branch.id);
      const section = el('section', 'upgrade-branch');
      // 分支色来自数据层（config 之外的一处真值），用 CSS 自定义属性传给样式表，
      // 避免在 styles.css 里再抄一份三支的色值。
      section.style.setProperty('--branch-color', branch.color);

      const head = el('header', 'upgrade-branch-head');
      const titleWrap = el('div', 'upgrade-branch-title');
      const title = el('h3');
      title.appendChild(el('span', null, `${branch.name}支`));
      title.appendChild(el('span', 'upgrade-branch-en', branch.short));
      titleWrap.appendChild(title);
      titleWrap.appendChild(el('p', 'hint', branch.desc));
      head.appendChild(titleWrap);
      head.appendChild(el('div', `upgrade-level${level >= MAX_LEVEL ? ' max' : ''}`,
        `Lv.${level} / ${MAX_LEVEL}`));
      section.appendChild(head);

      // 三级进度点：比纯文字更直观地显示“下一级还差几格”
      const dots = el('div', 'upgrade-dots');
      for (let i = 0; i < MAX_LEVEL; i += 1) {
        dots.appendChild(el('span', i < level ? 'upgrade-dot on' : 'upgrade-dot'));
      }
      section.appendChild(dots);

      const nodes = el('div', 'upgrade-nodes');
      branch.nodes.forEach((node, index) => {
        const owned = level >= node.tier;
        const check = checkBuy(save, node.id);
        const card = el('div', `upgrade-node${owned ? ' owned' : ''}${!owned && !check.ok ? ' locked' : ''}`);
        const top = el('div', 'upgrade-node-top');
        top.appendChild(el('span', 'upgrade-tier', `第 ${node.tier} 级`));
        if (owned) top.appendChild(el('span', 'upgrade-owned', '✓ 已解锁'));
        else if (index > 0 && level < node.tier - 1) top.appendChild(el('span', 'upgrade-lock-tag', '前置未解锁'));
        card.appendChild(top);
        card.appendChild(el('div', 'upgrade-name', node.name));
        card.appendChild(el('div', 'upgrade-effect', node.effectText));

        const foot = el('div', 'upgrade-node-foot');
        foot.appendChild(el('span', 'upgrade-price', money(node.price)));
        const btn = el('button', 'btn small', owned ? '已解锁' : '解锁');
        btn.dataset.action = 'buy-upgrade';
        btn.dataset.id = node.id;
        if (!check.ok) btn.disabled = true;
        foot.appendChild(btn);
        card.appendChild(foot);

        if (!owned && !check.ok) card.appendChild(el('div', 'upgrade-reason', check.reason));
        nodes.appendChild(card);
      });
      section.appendChild(nodes);
      host.appendChild(section);
    }
  }

  /* ---------------- 仓库 ---------------- */

  function renderStash(save) {
    syncHub(save);
    // 物品位图懒加载：只有真的打开仓库才拉图，不占开局带宽
    prefetchItemIcons(save.stash.items.map((it) => it.id));
    q('stash-currency').textContent = money(save.currency);
    renderGrid(q('stash-grid'), save.stash, renderStashDetail, stashView);
    syncStashToolbar(viewItems(save.stash.items, stashView).length, save.stash.items.length);
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
    const sell = el('button', 'btn small', `出售 ${money(itemValue(item) * SHOP.sellRatio)}`);
    sell.dataset.action = 'sell';
    sell.dataset.uid = item.uid;
    sell.dataset.label = `出售 ${item.name} → ${money(Math.round(itemValue(item) * SHOP.sellRatio))}`;
    row.appendChild(sell);
    host.appendChild(row);
    void save;
  }

  /* ---------------- P10 生涯档案 / 委托出售 ---------------- */

  /** 三类奖励共用一行版式：名称、进度条、幂等领取按钮。 */
  function careerRow(spec) {
    const row = el('div', `career-row ${spec.state}`);
    const main = el('div', 'career-main');
    main.appendChild(el('div', 'career-name', spec.title));
    main.appendChild(el('div', 'career-desc', spec.desc));
    const bar = el('div', 'career-bar');
    const fill = el('i', 'career-fill');
    const ratio = spec.goal > 0 ? Math.max(0, Math.min(1, spec.value / spec.goal)) : 0;
    fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.appendChild(fill);
    main.appendChild(bar);
    main.appendChild(el('div', 'career-progress', `${spec.value} / ${spec.goal} · 奖励 ${money(spec.reward)}`));
    row.appendChild(main);
    const btn = el('button', spec.state === 'claimable' ? 'btn small primary' : 'btn small',
      spec.state === 'claimed' ? '已领取' : (spec.state === 'claimable' ? '领取' : '未达成'));
    if (spec.state === 'claimable') {
      btn.dataset.action = spec.action;
      btn.dataset[spec.dataKey || 'id'] = String(spec.id);
      btn.dataset.label = `${spec.title} · ${money(spec.reward)}`;
    } else {
      btn.disabled = true;
    }
    row.appendChild(btn);
    return row;
  }

  /** 生涯档案：今日任务 / 成就 / 声望补给，全部读 economy.js 的只读视图。 */
  function renderCareer(save) {
    if (!save) save = lastSave;
    if (!save) return;
    syncHub(save);
    const cur = q('career-currency');
    if (cur) cur.textContent = money(save.currency);
    const today = String(dailySeed());
    const badge = q('career-badge');
    if (badge) {
      const n = pendingRewardCount(save, today);
      badge.textContent = n ? `可领 ${n}` : '';
      badge.classList.toggle('on', n > 0);
    }
    const questHost = q('career-quests');
    if (questHost) {
      questHost.innerHTML = '';
      for (const item of questView(save, today)) {
        questHost.appendChild(careerRow({
          title: item.name, desc: item.desc, value: item.done, goal: item.goal, reward: item.reward,
          state: item.claimed ? 'claimed' : (item.complete ? 'claimable' : 'locked'),
          action: 'claim-quest', id: item.id, dataKey: 'id',
        }));
      }
    }
    const achHost = q('career-achievements');
    if (achHost) {
      achHost.innerHTML = '';
      for (const item of achievementView(save)) {
        achHost.appendChild(careerRow({
          title: item.name, desc: item.desc, value: item.value, goal: item.goal, reward: item.reward,
          state: item.claimed ? 'claimed' : (item.reached ? 'claimable' : 'locked'),
          action: 'claim-achievement', id: item.id, dataKey: 'id',
        }));
      }
    }
    const repHost = q('career-rep');
    if (repHost) {
      repHost.innerHTML = '';
      for (const item of repRewardView(save)) {
        repHost.appendChild(careerRow({
          title: item.name, desc: `需声望 Lv.${item.level}`, value: item.unlocked ? 1 : 0, goal: 1,
          reward: item.reward,
          state: item.claimed ? 'claimed' : (item.unlocked ? 'claimable' : 'locked'),
          action: 'claim-rep', id: item.level, dataKey: 'level',
        }));
      }
    }
  }

  /** 委托出售页签：左边仓库可挂单，右边个人委托单与撤单入口。 */
  function renderConsign(save) {
    if (!save) save = lastSave;
    if (!save) return;
    const today = String(dailySeed());
    const idx = q('consign-index');
    if (idx) idx.textContent = `收购指数 ${Math.round(todayIndex(today) * 100)}%`;
    const stockHost = q('consign-stock');
    if (stockHost) {
      stockHost.innerHTML = '';
      const items = ((save.stash && save.stash.items) || []).slice()
        .sort((a, b) => itemValue(b) - itemValue(a));
      if (!items.length) stockHost.appendChild(el('p', 'hint', '仓库里没有可委托的物资。'));
      const full = ((save.career && save.career.orders) || []).length >= CAREER.consign.maxOrders;
      for (const item of items) {
        const found = quoteForStashItem(save, item.uid, today);
        if (!found) continue;
        const disp = displayUnits(item);
        const row = el('div', 'item-row');
        const rarity = RARITY[found.def.rarity] || RARITY.common;
        row.appendChild(iconEl(found.def.icon || 'bolt', rarity.color, 24));
        const main = el('div', 'item-main');
        main.appendChild(el('div', 'item-name',
          item.qty > 1 ? `${item.name} ×${disp.count}${disp.unit}` : item.name));
        main.appendChild(el('div', 'item-meta',
          `直售 ${money(Math.round(itemValue(item) * SHOP.sellRatio))} · 委托到手 ${money(found.quote.net)} · ${Math.round(CAREER.consign.settleMs / 1000)}s`));
        row.appendChild(main);
        const btn = el('button', 'btn small', money(found.quote.net));
        btn.dataset.action = 'list-item';
        btn.dataset.uid = String(item.uid);
        btn.dataset.label = `${item.name} · 预计 ${money(found.quote.net)}`;
        if (full) btn.disabled = true;
        row.appendChild(btn);
        stockHost.appendChild(row);
      }
    }
    const ordersHost = q('consign-orders');
    if (ordersHost) {
      ordersHost.innerHTML = '';
      const orders = orderView(save, Date.now());
      if (!orders.length) {
        ordersHost.appendChild(el('p', 'hint', '还没有委托单。从左侧挑一件物资挂出，到点自动结算。'));
      }
      for (const o of orders) {
        const row = el('div', 'item-row');
        const main = el('div', 'item-main');
        main.appendChild(el('div', 'item-name', `${o.name}${o.qty > 1 ? ` ×${o.qty}` : ''}`));
        main.appendChild(el('div', 'item-meta', o.due
          ? '已到点 · 进入大厅即结算'
          : `${Math.ceil(o.leftMs / 1000)}s 后成交 · 指数 ${Math.round(o.index * 100)}%`));
        row.appendChild(main);
        const btn = el('button', 'btn small ghost', '撤单');
        btn.dataset.action = 'cancel-order';
        btn.dataset.key = o.key;
        row.appendChild(btn);
        ordersHost.appendChild(row);
      }
    }
  }

  /* ---------------- 商店 ---------------- */

  function renderShop(save) {
    syncHub(save);
    // 商店位图同样按面板懒加载，和仓库/战利品共用一份缓存
    prefetchItemIcons(SHOP.items);
    q('shop-currency').textContent = money(save.currency);
    // 声望等级：决定哪些货架上锁（真正判定在 main.js 的 buy()，这里只负责显示）
    const lv = repLevel((save.rep && save.rep.xp) || 0);
    const lvDef = REP.levels.find((l) => l.level === lv) || REP.levels[0];
    const nextLv = REP.levels.find((l) => l.level === lv + 1);
    const buyHost = q('shop-buy');
    buyHost.innerHTML = '';
    // 声望条：让玩家知道"离下一级还差多少"
    const repRow = el('div', 'shop-rep');
    repRow.appendChild(el('span', 'k', `军械商 Lv.${lv} · ${lvDef.label}`));
    repRow.appendChild(el('span', 'v', nextLv
      ? `${Math.round((save.rep && save.rep.xp) || 0)}/${nextLv.need} XP`
      : '已满级'));
    buyHost.appendChild(repRow);

    for (const id of SHOP.items) {
      const def = ITEMS[id];
      if (!def) continue;
      const needLv = SHOP_TIER[id] || 1;
      const locked = lv < needLv;
      const row = el('div', locked ? 'item-row locked' : 'item-row');
      row.appendChild(iconEl(def.icon, RARITY[def.rarity].color, 24));
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-name', locked ? `${def.name}（需声望 Lv.${needLv}）` : def.name));
      const meta = [];
      if (def.category === 'weapon') meta.push(`伤害 ${WEAPONS[id].damage} · 射速 ${WEAPONS[id].rpm}RPM · 弹匣 ${WEAPONS[id].magSize}`);
      else if (def.category === 'armor') meta.push(`护甲 ${def.armor} · ${def.weight}kg`);
      else if (def.category === 'ammo') meta.push(`${def.ammoQty} 发 · ${def.weight}kg`);
      else if (def.cureFracture) meta.push(`修复骨折 · 回血 ${def.heal} · ${def.useTime}s`);
      else if (def.repairArmor) meta.push(`修护甲 ${Math.round(def.repairArmor * 100)}% · ${def.useTime}s`);
      else if (def.heal) meta.push(`恢复 ${def.heal} 生命 · ${def.useTime}s`);
      meta.push(`${def.size.w}×${def.size.h} 格`);
      // P10 每日额度：只展示，真正的判定仍在 main.js 的 buy() 里。
      const left = shopRemaining(save, id, String(dailySeed()));
      if (Number.isFinite(left)) meta.push(`今日 ${left}/${SHOP.restock[id]}`);
      main.appendChild(el('div', 'item-meta', meta.join(' · ')));
      row.appendChild(main);
      const soldOut = left < 1;
      const buy = el('button', locked || soldOut ? 'btn small lock' : 'btn small',
        locked ? `Lv.${needLv}` : (soldOut ? '售罄' : money(def.value)));
      buy.dataset.action = 'buy';
      buy.dataset.id = id;
      buy.dataset.label = `${def.name} · ${money(def.value)}`;
      if (locked || soldOut || save.currency < def.value) buy.disabled = true;
      row.appendChild(buy);
      buyHost.appendChild(row);
    }

    const sellHost = q('shop-sell');
    sellHost.innerHTML = '';
    const sellable = save.stash.items.slice().sort((a, b) => itemValue(b) - itemValue(a));
    if (!sellable.length) {
      sellHost.appendChild(el('p', 'hint', '仓库空空如也，去战局里搜点东西回来。'));
    }
    for (const item of sellable) {
      const row = el('div', 'item-row');
      row.appendChild(itemIconEl(item.id, 24,
      () => iconEl(item.icon, RARITY[item.rarity].color, 24)));
      const disp = displayUnits(item);
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-name', item.qty > 1 ? `${item.name} ×${disp.count}${disp.unit}` : item.name));
      main.appendChild(el('div', 'item-meta', `${itemWeight(item).toFixed(1)}kg · 单价 ${money(item.value)}`));
      row.appendChild(main);
      const sell = el('button', 'btn small', money(itemValue(item) * SHOP.sellRatio));
      sell.dataset.action = 'sell';
      sell.dataset.uid = item.uid;
      sell.dataset.label = `出售 ${item.name} → ${money(Math.round(itemValue(item) * SHOP.sellRatio))}`;
      row.appendChild(sell);
      sellHost.appendChild(row);
    }
    if (marketState.tab === 'market') renderMarket(save);
    if (marketState.tab === 'sell') renderConsign(save);
  }

  /* ---------------- 干员档案（P15） ---------------- */

  /**
   * 渲染干员档案屏：四名干员的被动 / 战术道具 / 终结技 + 当前出战标记。
   *
   * 数据全部来自 `operators.js`（单一真值），这里只排版 —— 不在 UI 里另写一份
   * 数值或效果说明，否则改了技能数值、档案页会悄悄过期。
   * @param {object} save 存档
   * @returns {void}
   */
  function renderOperators(save) {
    const host = q('operator-grid');
    if (!host) return;
    host.innerHTML = '';
    const current = getOperator(save.operator);
    const tag = q('operator-current');
    if (tag) tag.textContent = `当前出战 · ${current.code} ${current.callsign}`;

    for (const op of OPERATORS) {
      const on = op.id === current.id;
      const card = el('div', `opdex-card${on ? ' active' : ''}`);
      card.style.setProperty('--op-color', op.color);

      const head = el('div', 'opdex-head');
      head.appendChild(el('div', 'opdex-code', op.code));
      const names = el('div', 'opdex-names');
      names.appendChild(el('div', 'opdex-callsign', op.callsign));
      names.appendChild(el('div', 'opdex-role', `${op.role} · ${op.roleName}`));
      head.appendChild(names);
      if (on) head.appendChild(el('span', 'opdex-badge', '出战'));
      card.appendChild(head);

      card.appendChild(el('p', 'opdex-bio', op.bio));

      const stats = el('div', 'opdex-stats');
      const row = (k, v) => {
        const node = el('div', 'opdex-row');
        node.appendChild(el('span', 'k', k));
        node.appendChild(el('span', 'v', v));
        stats.appendChild(node);
      };
      row('被动', `${op.perk.name} · ${op.perk.desc}`);
      row('战术道具', op.tacticalLine);
      row('终结技', `${op.ultimate.name} · ${op.ultimateLine}`);
      card.appendChild(stats);

      const btn = el('button', on ? 'btn small primary' : 'btn small', on ? '当前出战' : '选择该干员');
      btn.dataset.action = 'set-operator';
      btn.dataset.operator = op.id;
      btn.dataset.label = `切换干员 → ${op.code} ${op.callsign}`;
      if (on) btn.disabled = true;
      card.appendChild(btn);

      host.appendChild(card);
    }
  }

  /* ---------------- 图鉴 ---------------- */

  /**
   * 渲染战利品图鉴（三态：未发现 / 已见过 / 已带出）。
   * 分母用 ITEM_IDS.length（现在是 19，含 lv2/lv3，不要写死 17）。
   * @param {object} save 存档
   * @returns {void}
   */
  function renderCodex(save) {
    syncHub(save);
    const codex = save.codex || {};
    const seen = codex.seen || {};
    const brought = codex.brought || {};
    const seenCount = ITEM_IDS.filter((id) => seen[id]).length;
    const broughtCount = ITEM_IDS.filter((id) => brought[id]).length;
    const prog = q('codex-progress');
    if (prog) prog.textContent = `已见 ${seenCount} · 带出 ${broughtCount} / ${ITEM_IDS.length}`;

    const host = q('codex-body');
    host.innerHTML = '';
    for (const rarity of RARITY_ORDER) {
      const ids = ITEMS_BY_RARITY[rarity] || [];
      if (!ids.length) continue;
      const block = el('section', 'codex-group');
      const head = el('h3', 'codex-head',
        `${RARITY[rarity].name} ${ids.filter((id) => seen[id]).length}/${ids.length}`);
      head.style.color = RARITY[rarity].color;
      block.appendChild(head);
      const grid = el('div', 'codex-grid');
      for (const id of ids) {
        const def = ITEMS[id];
        if (!def) continue;
        const hasSeen = Boolean(seen[id]);
        const hasBrought = Boolean(brought[id]);
        const cell = el('div', `codex-cell${hasSeen ? '' : ' unknown'}${hasBrought ? ' brought' : ''}`);
        cell.appendChild(iconEl(def.icon, RARITY[def.rarity].color, 30));
        cell.appendChild(el('div', 'codex-name', hasSeen ? def.name : '？？？'));
        cell.appendChild(el('div', 'codex-meta',
          hasBrought ? `已带出 · ${money(def.value)}` : (hasSeen ? '已见过' : '未发现')));
        grid.appendChild(cell);
      }
      block.appendChild(grid);
      host.appendChild(block);
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
    const copy = el('div', 'result-copy');
    copy.appendChild(el('div', 'result-title', result.title));
    copy.appendChild(el('div', 'result-sub', result.subtitle));
    head.appendChild(copy);
    // P2 大印章：把评级从一行文字升级成结算页的视觉锚点，数据仍是原 result.grade。
    const stamp = el('div', 'result-stamp');
    stamp.appendChild(el('div', 'result-stamp-en', result.success ? 'EXTRACTED' : 'KIA'));
    stamp.appendChild(el('div', 'result-grade', result.grade));
    stamp.appendChild(el('div', 'result-stamp-cn', result.success ? '撤离成功' : '行动失败'));
    head.appendChild(stamp);

    // P2 数值：结算补一条真实行动等级进度（读存档声望经验）。
    // 按用户边界，这里不做死亡回放 / 伤害来源 / 击杀者 / 存活时长的演出。
    const seasonHost = q('result-season');
    if (seasonHost) {
      seasonHost.innerHTML = '';
      if (lastSave) {
        const sp = seasonProgress(lastSave);
        seasonHost.appendChild(el('span', 'rs-label', '行动等级 / SEASON PROGRESS'));
        seasonHost.appendChild(el('span', 'rs-value', `Lv.${sp.level} ${sp.label} · ${sp.xp} XP`));
        const bar = el('div', 'rs-track');
        const fill = el('i');
        fill.style.width = `${Math.round(sp.ratio * 100)}%`;
        bar.appendChild(fill);
        seasonHost.appendChild(bar);
      }
    }

    const statsHost = q('result-stats');
    statsHost.innerHTML = '';
    // P11：逐条入场只加 animationDelay，不改文本、不插子节点 ——
    // probe-batch3 锁 .result-stats > * 行数，probe-p2-interact 读 .rs-value 文本，均不受影响。
    for (const [i, pair] of result.stats.entries()) {
      const node = el('div', 'stat big');
      node.style.animationDelay = `${staggerDelay(i)}ms`;
      node.appendChild(el('span', 'k', pair[0]));
      node.appendChild(el('span', 'v', pair[1]));
      statsHost.appendChild(node);
    }

    q('result-loot-title').textContent = result.lootTitle;
    const lootHost = q('result-loot');
    lootHost.innerHTML = '';
    if (!result.items.length) {
      lootHost.appendChild(el('p', 'hint', result.emptyText));
      return;
    }
    for (const [j, item] of result.items.entries()) {
      const row = el('div', 'item-row');
      row.style.animationDelay = `${staggerDelay(result.stats.length + j)}ms`;
      row.appendChild(itemIconEl(item.id, 22,
        () => iconEl(item.icon, RARITY[item.rarity].color, 22)));
      const disp = displayUnits(item);
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-name', item.qty > 1 ? `${item.name} ×${disp.count}${disp.unit}` : item.name));
      main.appendChild(el('div', 'item-meta', `${RARITY[item.rarity].name} · ${itemWeight(item).toFixed(1)}kg`));
      row.appendChild(main);
      row.appendChild(el('div', 'item-value', money(itemValue(item))));
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
    prefetchItemIcons(items.map((it) => it.id));
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
      row.appendChild(itemIconEl(item.id, 22,
        () => iconEl(item.icon, RARITY[item.rarity].color, 22)));
      const disp = displayUnits(item);
      const main = el('div', 'item-main');
      main.appendChild(el('div', 'item-name', item.qty > 1 ? `${item.name} ×${disp.count}${disp.unit}` : item.name));
      main.appendChild(el('div', 'item-meta', `${item.w}×${item.h}格 · ${itemWeight(item).toFixed(1)}kg · ${RARITY[item.rarity].name}`));
      row.appendChild(main);
      row.appendChild(el('div', 'item-value', money(itemValue(item))));
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
    // 页脚把"超重"翻译成玩家能感知的后果。
    // ⚠ 超重**仍可奔跑**（ed4a181 已改），这里绝不能写"无法奔跑"——那是当场说谎。
    const tier = weightTier(w, weightLimit);
    q('backpack-info').textContent = tier > 0
      ? `超重：移速 ×${weightSpeedMultiplier(w, weightLimit, PLAYER.weightOverSpeedFloor).toFixed(2)}（仍可奔跑，冲刺更费体力）`
      : '点击医疗物资直接使用，点击其他丢弃';

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
      // 第四行：价值密度。背包满时的唯一取舍依据 —— 同样占一格，谁更值钱。
      const density = Math.round(value / Math.max(0.1, w));
      entries.push(['价值密度', `${money(density)}/kg`, over ? 'over' : '']);
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

  /* ---------------- P2 交互：交易行 / 仓库工具栏 / 装备槽 / 二次确认 ---------------- */

  /** 分类与排序只改展示序：返回新数组，绝不改 stash.items 的 uid / col / row。 */
  function viewItems(items, view) {
    const filter = (view && view.filter) || 'all';
    const out = filter === 'all' ? items.slice() : items.filter((i) => i.category === filter);
    const rank = { common: 0, rare: 1, epic: 2, legendary: 3 };
    if (view && view.sort === 'value') out.sort((a, b) => itemValue(b) - itemValue(a));
    else if (view && view.sort === 'weight') out.sort((a, b) => itemWeight(b) - itemWeight(a));
    else if (view && view.sort === 'rarity') {
      out.sort((a, b) => (rank[b.rarity] || 0) - (rank[a.rarity] || 0));
    }
    return out;
  }

  function syncStashToolbar(count, total) {
    for (const node of root.querySelectorAll('[data-action="stash-filter"]')) {
      node.classList.toggle('active', node.dataset.filter === stashView.filter);
    }
    for (const node of root.querySelectorAll('[data-action="stash-sort"]')) {
      node.classList.toggle('active', node.dataset.sort === stashView.sort);
    }
    const hint = q('stash-view-count');
    if (hint) hint.textContent = `显示 ${count} / ${total} 件 · 右键或长按物品可操作`;
  }

  /** 报价种子只来自本地日期与刷新序号；刷新重掷，不落存档、不取网络。 */
  function ensureMarketSeed(force) {
    if (force || !marketState.seed) {
      marketState.seed = ((dailySeed() * 31 + marketState.refresh) >>> 0) || 1;
      marketState.listings = rollListings(marketState.seed, MARKET.listingCount);
      marketState.sold.clear();
    }
  }

  function renderMarket(save) {
    ensureMarketSeed(false);
    const host = q('market-list');
    if (!host) return;
    host.innerHTML = '';
    const lv = save ? repLevel((save.rep && save.rep.xp) || 0) : 1;
    const funds = save ? save.currency : 0;
    for (const l of marketState.listings) {
      const def = ITEMS[l.id];
      if (!def) continue;
      const sold = marketState.sold.has(l.key);
      const locked = lv < l.tier;
      const card = el('div', `market-card${sold ? ' sold' : ''}`);
      card.appendChild(iconEl(def.icon || 'bolt', RARITY[l.rarity].color, 28));
      const main = el('div', 'market-main');
      main.appendChild(el('div', 'market-name', l.name));
      main.appendChild(el('div', 'market-meta', `${l.seller} · 基准 ${money(l.base)} · ${def.category}`));
      main.appendChild(el('div', 'market-desc', (def.desc || '军需物资 · 可用于战前配置或局内携带').slice(0, 36)));
      const price = el('div', 'market-price');
      price.appendChild(el('span', 'market-price-v', money(l.price)));
      const trendText = l.trend === 'up' ? `▲ +${l.delta}%`
        : (l.trend === 'down' ? `▼ ${l.delta}%` : '— 持平');
      price.appendChild(el('span', `market-trend ${l.trend}`, trendText));
      main.appendChild(price);
      card.appendChild(main);
      const buy = el('button', 'btn small market-buy', sold ? '已成交' : (locked ? `Lv.${l.tier}` : '买入'));
      buy.dataset.action = 'buy-listing';
      buy.dataset.seed = String(marketState.seed);
      buy.dataset.key = l.key;
      buy.dataset.label = `${l.name} · ${money(l.price)}（${l.seller} 报价）`;
      if (sold || locked || funds < l.price) buy.disabled = true;
      card.appendChild(buy);
      host.appendChild(card);
    }
  }

  function setMarketTab(tab) {
    marketState.tab = tab === 'sell' ? 'sell' : (tab === 'market' ? 'market' : 'supply');
    const sup = q('shop-supply');
    const mkt = q('shop-market');
    const csg = q('shop-consign');
    if (sup) sup.classList.toggle('hidden', marketState.tab !== 'supply');
    if (mkt) mkt.classList.toggle('hidden', marketState.tab !== 'market');
    if (csg) csg.classList.toggle('hidden', marketState.tab !== 'sell');
    for (const node of root.querySelectorAll('[data-action="market-tab"]')) {
      const on = node.dataset.tab === marketState.tab;
      node.classList.toggle('active', on);
      node.setAttribute('aria-current', on ? 'page' : 'false');
    }
    if (marketState.tab === 'market') renderMarket(lastSave);
    if (marketState.tab === 'sell') renderConsign(lastSave);
  }

  function refreshMarket() {
    marketState.refresh += 1;
    ensureMarketSeed(true);
    renderMarket(lastSave);
  }

  /** 三槽装备台：拖放与「先选中再点槽」共用同一条落槽路径，键鼠/触屏结果一致。 */
  /**
   * 装备配置板（W2 重写）。
   *
   * 三块内容：
   * 1. 左侧角色 3D —— DOM 占位由 main.js 的 preview3d 挂载（本函数只保证容器存在）；
   * 2. 右侧 8 个槽位 —— 每格显示「槽位名 + 装了什么 + 该件重量」，空槽明确写"空"，
   *    不让玩家猜"这一格是没装还是加载失败"；
   * 3. 角色铭牌 —— 干员 / 负重 `kg/kg` 大字 / 装备价值，是三角洲装备屏的信息密度落点。
   *
   * @param {object} save 存档对象
   * @returns {void}
   */
  function renderEquipBay(save) {
    const slotsHost = q('equip-slots');
    const trayHost = q('equip-tray');
    if (!slotsHost || !trayHost) return;
    slotsHost.innerHTML = '';
    trayHost.innerHTML = '';
    const lo = (save && save.loadout) || {};
    const lookup = (id) => WEAPONS[id] || ARMORS[id] || ITEMS[id] || null;
    for (const def of EQUIP_SLOTS) {
      const id = lo[def.slot];
      const filled = Boolean(id && id !== 'none');
      const item = filled ? lookup(id) : null;
      const node = el('button', `equip-slot${filled ? ' filled' : ''}`);
      node.type = 'button';
      node.dataset.action = 'equip-slot';
      node.dataset.slot = def.slot;
      // 槽位图标：空槽用暗色占位，装满用物品自己的图标 + 稀有度色，一眼分出"这格有没有东西"
      node.appendChild(iconEl(
        (item && item.icon) || 'bolt',
        item ? (RARITY[item.rarity] ? RARITY[item.rarity].color : DF.rarity.white) : dfAlpha(DF.dim, 0.45),
        20,
      ));
      const body = el('span', 'es-body');
      body.appendChild(el('span', 'es-label', def.label));
      body.appendChild(el('span', 'es-value', item ? item.name : '空'));
      node.appendChild(body);
      // 该件自重：负重是这一屏的核心决策变量，重量必须落到每一格上，
      // 而不是让玩家去别处做减法。
      const w = item && Number.isFinite(item.weight) ? item.weight : 0;
      node.appendChild(el('span', 'es-w', filled ? `${w.toFixed(1)}` : '—'));
      slotsHost.appendChild(node);
    }

    const counts = {};
    // W2：托盘要能看见匕首 / 背包 / 胸挂，否则 8 个槽里有 3 个永远没有可拖的东西。
    const equippable = ['weapon', 'armor', 'melee', 'gear'];
    for (const item of (save && save.stash ? save.stash.items : [])) {
      if (equippable.includes(item.category)) {
        counts[item.id] = (counts[item.id] || 0) + 1;
      }
    }
    const ids = Object.keys(counts);
    for (const id of ids) {
      const def = lookup(id);
      if (!def) continue;
      const chip = el('button', 'equip-chip');
      chip.type = 'button';
      chip.draggable = true;
      chip.dataset.action = 'equip-select';
      chip.dataset.id = id;
      if (selectedEquip === id) chip.classList.add('selected');
      chip.appendChild(iconEl(def.icon || 'bolt', RARITY[def.rarity] ? RARITY[def.rarity].color : DF.rarity.white, 18));
      chip.appendChild(el('span', 'ec-name', def.name));
      chip.appendChild(el('span', 'ec-count', `×${counts[id]}`));
      trayHost.appendChild(chip);
    }
    if (!ids.length) {
      trayHost.appendChild(el('span', 'hint', '仓库里暂无可装备的武器 / 装具，可在军需处购买。'));
    }

    renderCharSheet(save, lo);

    // W2：角色 3D 的挂载同样由 main.js 负责（它持有渲染器生命周期）。
    // ui.js 只广播一个事件，不 import three —— 与改枪台的 gunbench:rendered 同一套约定。
    if (typeof CustomEvent === 'function' && typeof slotsHost.dispatchEvent === 'function') {
      slotsHost.dispatchEvent(new CustomEvent('equip:rendered', { bubbles: true }));
    }
  }

  /**
   * 角色铭牌：干员 + 负重 `kg/kg` + 装备价值 + 携行物资。
   *
   * 负重读数与右侧栏 `loadout-weight` 共用同一份 `estimateWeight`，
   * 两处绝不各算一遍 —— 那样一旦口径漂移，玩家会看到两个不同的上限。
   * @param {object} save 存档
   * @param {object} lo 装备配置
   * @returns {void}
   */
  function renderCharSheet(save, lo) {
    const host = q('char-sheet');
    if (!host) return;
    host.innerHTML = '';
    const op = getOperator(save && save.operator);
    host.style.setProperty('--op-color', op.color);

    const head = el('div', 'cs-head');
    head.appendChild(el('span', 'cs-code', op.code));
    head.appendChild(el('span', 'cs-name', `${op.callsign} · ${op.roleName}`));
    host.appendChild(head);

    // 负重大字：`已载 / 上限`，超重时整串转橙红（与全站警示色一致）
    const est = estimateWeight(lo, save);
    const wRow = el('div', `cs-weight${est.over ? ' over' : ''}`);
    const num = el('span', 'cs-w-num');
    num.appendChild(el('span', null, est.total.toFixed(1)));
    num.appendChild(el('span', 'cs-w-sep', '/'));
    num.appendChild(el('span', 'cs-w-lim', `${est.limit}`));
    num.appendChild(el('span', 'cs-w-unit', 'kg'));
    wRow.appendChild(num);
    const bar = el('div', 'cs-w-bar');
    const fill = el('i');
    // 分母取上限的 1.6 倍：超重区间（1.0~1.6×）仍看得见进度，与侧栏进度条同一口径
    fill.style.width = `${Math.min(100, (est.total / (est.limit * 1.6)) * 100)}%`;
    bar.appendChild(fill);
    wRow.appendChild(bar);
    host.appendChild(wRow);

    const rows = [
      ['装备合计', `${est.base.toFixed(1)} kg`],
      ['携行物资', `${est.items.toFixed(1)} kg`],
      ['装备价值', money(gearReadout(save, est).gearValue)],
    ];
    for (const [k, v] of rows) {
      const node = el('div', 'cs-kv');
      node.appendChild(el('span', 'k', k));
      node.appendChild(el('span', 'v', v));
      host.appendChild(node);
    }
  }

  function equipToSlot(slot, id) {
    const def = EQUIP_SLOTS.find((s) => s.slot === slot);
    if (!def || !id) { toast('先在下方托盘选中一件装备'); return; }
    if (!def.allowed.includes(id)) { toast('这件装备不能放进该槽位'); return; }
    if (!lastSave || countIn(lastSave, id) < 1) { toast('仓库里没有这件装备'); return; }
    if (!handlers['set-loadout']) return;
    handlers['set-loadout']({ slot, value: id });
    selectedEquip = null;
    toast(`已装配到${def.label}`);
  }

  function closeStashMenu() {
    const menu = q('stash-menu');
    if (menu) menu.classList.add('hidden');
  }

  function openStashMenu(node, x, y) {
    const menu = q('stash-menu');
    if (!menu || !lastSave) return;
    const item = lastSave.stash.items.find((i) => String(i.uid) === String(node.dataset.uid));
    if (!item) return;
    menu.innerHTML = '';
    menu.appendChild(el('div', 'ctx-head', item.name));
    const add = (label, action, data) => {
      const btn = el('button', 'ctx-item', label);
      btn.type = 'button';
      btn.dataset.action = action;
      for (const [k, v] of Object.entries(data)) btn.dataset[k] = v;
      menu.appendChild(btn);
    };
    add('查看详情', 'stash-detail', { uid: item.uid });
    const price = Math.round(itemValue(item) * SHOP.sellRatio);
    add(`出售 ${money(price)}`, 'sell', { uid: item.uid, label: `出售 ${item.name} → ${money(price)}` });
    if (item.category === 'weapon' || item.category === 'armor' || item.category === 'melee' || item.category === 'gear') {
      // W2：按物品自己声明的槽位给入口，不再固定三条（那会让匕首/背包/胸挂没有"装到哪里"的路径）。
      // `slot` 字段是各表里的权威声明：WEAPONS 的 wclass 之外，ARMORS/MELEE/BACKPACKS/RIGS 都带 slot。
      const homes = EQUIP_SLOTS.filter((s) => s.allowed.includes(item.id));
      for (const home of homes) {
        add(`装备到${home.label}`, 'equip-item', { uid: item.uid, slot: home.slot });
      }
    }
    // 先显示再量真实高度：667×375 上菜单若贴着底栏展开会被切掉两行，
    // 因此以「底栏上沿」为下界做一次翻转，键鼠右键与触屏长按共用这段定位。
    menu.classList.remove('hidden');
    const mw = menu.offsetWidth || 178;
    const mh = menu.offsetHeight || 176;
    const act = document.querySelector('.hub-action');
    const bar = document.querySelector('.hub-top');
    const bottom = act && getComputedStyle(act).display !== 'none'
      ? act.getBoundingClientRect().y - 6 : window.innerHeight - 8;
    const topEdge = bar ? bar.getBoundingClientRect().bottom + 6 : 8;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - mw - 8))}px`;
    menu.style.top = `${Math.max(topEdge, Math.min(y, bottom - mh))}px`;
  }

  function closeConfirm() {
    pendingConfirm = null;
    const modal = q('confirm-modal');
    if (modal) modal.classList.add('hidden');
  }

  function openConfirm(action, data, target, fn) {
    const modal = q('confirm-modal');
    if (!modal) { fn(data, target); return; }
    const titles = {
      buy: '确认购买', sell: '确认出售', 'sell-all': '确认一键出售', 'buy-listing': '确认本地报价',
      'list-item': '确认委托出售',
    };
    const texts = {
      buy: `按军需处标价买入 1 件物资${data.label ? ` · ${data.label}` : ''}？`,
      sell: `${data.label || '出售该物资'}？出售后不可撤销。`,
      'sell-all': '一键出售仓库里的全部物资？该操作不可撤销。',
      'buy-listing': `按本地 NPC 报价买入 ${data.label || '该物资'}？该报价只在本次刷新内有效。`,
      'list-item': `确认委托 ${data.label || '该物资'}？物资会先从仓库取出，到点自动结算，期间可撤单退回。`,
    };
    const title = q('confirm-title');
    const text = q('confirm-text');
    if (title) title.textContent = titles[action] || '确认操作';
    if (text) text.textContent = texts[action] || '确认执行该操作？';
    pendingConfirm = { action, data, target, fn };
    modal.classList.remove('hidden');
    const yes = root.querySelector('[data-action="confirm-yes"]');
    if (yes) yes.focus();
  }

  function runConfirmed() {
    if (!pendingConfirm) return;
    const { action, data, target, fn } = pendingConfirm;
    pendingConfirm = null;
    closeConfirm();
    const ok = fn(data, target);
    if (action === 'buy-listing' && ok === true && data.key) {
      // 成交标记只存在于当前页面内存：报价单不是共享库存，刷新即重掷。
      marketState.sold.add(data.key);
      renderMarket(lastSave);
    }
  }

  /** 纯 UI 状态动作在委托层就地消化，不打扰 main.js 的状态机。 */
  function handleLocalAction(action, data, target) {
    switch (action) {
      case 'market-tab': setMarketTab(data.tab); return true;
      // 报价卡整体换一批就是反馈，不再叠一条 toast 糊住地图卡 / 确认框。
      case 'market-refresh': refreshMarket(); return true;
      case 'stash-filter': stashView.filter = data.filter || 'all'; if (lastSave) renderStash(lastSave); return true;
      case 'stash-sort': stashView.sort = data.sort || 'default'; if (lastSave) renderStash(lastSave); return true;
      case 'confirm-cancel': closeConfirm(); return true;
      case 'confirm-yes': runConfirmed(); return true;
      case 'equip-select':
        selectedEquip = data.id;
        for (const chip of root.querySelectorAll('.equip-chip')) {
          chip.classList.toggle('selected', chip.dataset.id === selectedEquip);
        }
        return true;
      case 'equip-slot': equipToSlot(data.slot, selectedEquip); return true;
      case 'equip-item': {
        const item = lastSave && lastSave.stash.items.find((i) => String(i.uid) === String(data.uid));
        closeStashMenu();
        if (item) equipToSlot(data.slot, item.id);
        return true;
      }
      case 'stash-detail': {
        const item = lastSave && lastSave.stash.items.find((i) => String(i.uid) === String(data.uid));
        closeStashMenu();
        if (item) renderStashDetail(item, lastSave);
        return true;
      }
      default: void target; return false;
    }
  }

  // 拖放：托盘是 draggable 源，三槽是 drop 目标。真实 DragEvent 与触屏点选两条路都走 equipToSlot。
  const trayHostEl = q('equip-tray');
  const slotsHostEl = q('equip-slots');
  if (trayHostEl) {
    trayHostEl.addEventListener('dragstart', (ev) => {
      const chip = ev.target.closest && ev.target.closest('.equip-chip');
      if (!chip) return;
      if (ev.dataTransfer) {
        ev.dataTransfer.setData('text/plain', chip.dataset.id);
        ev.dataTransfer.effectAllowed = 'copy';
      }
      selectedEquip = chip.dataset.id;
    });
  }
  if (slotsHostEl) {
    slotsHostEl.addEventListener('dragover', (ev) => {
      const slot = ev.target.closest && ev.target.closest('.equip-slot');
      if (!slot) return;
      ev.preventDefault();
      slot.classList.add('dropping');
    });
    slotsHostEl.addEventListener('dragleave', (ev) => {
      const slot = ev.target.closest && ev.target.closest('.equip-slot');
      if (slot) slot.classList.remove('dropping');
    });
    slotsHostEl.addEventListener('drop', (ev) => {
      const slot = ev.target.closest && ev.target.closest('.equip-slot');
      if (!slot) return;
      ev.preventDefault();
      slot.classList.remove('dropping');
      const id = (ev.dataTransfer && ev.dataTransfer.getData('text/plain')) || selectedEquip;
      equipToSlot(slot.dataset.slot, id);
    });
  }

  // 仓库右键菜单；触屏没有 contextmenu，用 520ms 长按等价触发。
  const stashGridEl = q('stash-grid');
  if (stashGridEl) {
    stashGridEl.addEventListener('contextmenu', (ev) => {
      const node = ev.target.closest && ev.target.closest('.grid-item');
      if (!node) return;
      ev.preventDefault();
      openStashMenu(node, ev.clientX, ev.clientY);
    });
    stashGridEl.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType !== 'touch') return;
      const node = ev.target.closest && ev.target.closest('.grid-item');
      if (!node) return;
      window.clearTimeout(longPressTimer);
      longPressTimer = window.setTimeout(() => {
        const r = node.getBoundingClientRect();
        openStashMenu(node, r.left, Math.min(r.bottom, window.innerHeight - 10));
      }, 520);
    });
    for (const type of ['pointerup', 'pointermove', 'pointercancel']) {
      stashGridEl.addEventListener(type, () => window.clearTimeout(longPressTimer));
    }
  }
  document.addEventListener('pointerdown', (ev) => {
    const menu = q('stash-menu');
    if (menu && !menu.classList.contains('hidden')
      && !(ev.target.closest && ev.target.closest('[data-role="stash-menu"]'))) closeStashMenu();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    closeStashMenu();
    if (pendingConfirm) closeConfirm();
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
    clickSfx();
    const action = target.dataset.action;
    // P2 交互：页签 / 分类 / 排序 / 槽位 / 确认框等纯 UI 状态在委托层就地消化。
    if (handleLocalAction(action, target.dataset, target)) return;
    const fn = handlers[action];
    if (typeof fn !== 'function') return;
    // 买入、出售、一键出售、本地报价成交一律二次确认；旧的 abandon 两击门闸保持独立。
    if (CONFIRM_ACTIONS.has(action)) {
      closeStashMenu();
      openConfirm(action, target.dataset, target, fn);
      return;
    }
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
  // P3 调色三滑条：只经 handlers['set-grade'] 落存档 + 灌 uniform，UI 不持有真值。
  for (const key of ['exposure', 'contrast', 'saturation']) {
    const slider = q(`grade-${key}`);
    if (!slider) continue;
    const commit = (ev) => {
      if (handlers['set-grade']) handlers['set-grade']({ key, value: ev.target.value });
    };
    slider.addEventListener('input', commit);
    slider.addEventListener('change', commit);
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
  // B2：静态装饰层离屏画布（读数条 / 武器卡 / 血条底），按布局签名烘焙一次、逐帧贴回。
  let hudStatic = null;
  let hudStaticSig = '';
  // P22：压制暗角渐变按画布尺寸缓存一次（每帧重建 CanvasGradient 是纯浪费）
  let hudSupGrad = null;
  let hudSupGradKey = '';
  const hudState = {
    mm: null, mmCtx: null, mmImage: null, mmCache: null,
    // B3：小地图底图（面板底 + 迷雾 + 网格）离屏烘焙，最多 12Hz 重画；动态标记仍每帧叠加。
    mmBase: null, mmBaseCtx: null, mmBaseAt: 0, mmBaseKey: '',
    // B3：稳定的 HUD DOM 节点缓存 + 写入签名，避免每帧 querySelector / style 赋值。
    hudNodes: {}, tapSig: '',
    perf: { tapWrites: 0, mmBakes: 0 },
    // P7：最近一帧的玩家引用，供 hudDebug 读弹种 / 医疗状态（不复制状态，只读）
    lastPlayer: null,
    // P20：HUD 上一帧的战局引用（hudDebug 读目标进度用，只读不复制状态）
    lastWorld: null,
  };
  // P1：小地图缩放档、最近一次布局（供 window 级滚轮/点击命中判定）、低血量跨阈值标记
  hudState.mmZoom = 0;
  hudState.lastLayout = null;
  let lastLowHp = null;
  // B3：HUD 层节点由本模块模板创建后不再替换；用 isConnected 兜底，防止将来改模板拿到游离节点。
  const hudNode = (role) => {
    let el = hudState.hudNodes[role];
    if (!el || !el.isConnected) {
      el = q(role);
      hudState.hudNodes[role] = el;
    }
    return el;
  };

  // P1：小地图缩放（滚轮 + 侧栏 +/−）。hudCanvas 是 pointer-events:none，命中判定
  // 只能挂在 window 上；命中侧栏时截断冒泡，免得点个缩放顺手开一枪。
  const adjustMmZoom = (dir) => {
    const last = HUD.minimap.zoomSteps.length - 1;
    hudState.mmZoom = Math.max(0, Math.min(last, hudState.mmZoom + dir));
  };
  window.addEventListener('wheel', (e) => {
    if (current !== 'battle') return;
    const r = hudState.lastLayout && hudState.lastLayout.minimap;
    if (!r || e.clientX < r.x || e.clientX > r.x + r.w || e.clientY < r.y || e.clientY > r.y + r.h) return;
    adjustMmZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: true });
  window.addEventListener('pointerdown', (e) => {
    if (current !== 'battle') return;
    const hit = hudState.mmHit;
    if (!hit) return;
    const inside = (b) => b && e.clientX >= b.x && e.clientX <= b.x + b.w
      && e.clientY >= b.y && e.clientY <= b.y + b.h;
    let dir = 0;
    if (inside(hit.zoomIn)) dir = 1;
    else if (inside(hit.zoomOut)) dir = -1;
    if (!dir) return;
    adjustMmZoom(dir);
    e.stopPropagation();
    e.preventDefault();
  }, true);

  function clearHud() {
    if (!hudCtx) return;
    // 复位变换再清整屏：renderHud 结束后 ctx 仍带着 DPR 缩放，不清变换会只擦掉左上角。
    if (typeof hudCtx.setTransform === 'function') hudCtx.setTransform(1, 0, 0, 1, 0, 0);
    const w = hudCanvas.width || window.innerWidth || 1280;
    const h = hudCanvas.height || window.innerHeight || 720;
    hudCtx.clearRect(0, 0, w, h);
  }

  /**
   * 顶部战术罗盘（P1 重做）。
   *
   * 旧版只有 N/E/S/W 四个字母，转头时几乎不滚动，读不出角度也读不出"目标在偏哪边"。
   * 现在是一条 0~360° 刻度带：每 15° 短刻度、每 45° 长刻度 + 方位字母，
   * pxPerDeg 由罗盘宽度反推，桌面 360px 与横屏 110px 显示同样的角度窗口。
   * 撤离点 / 终端 / 空投 / 队友的方位针贴在底缘，与刻度共用同一套投影，不各算各的。
   */
  function drawCompass(world, W, L) {
    const ctx = hudCtx;
    const p = world.player;
    const { w: cw, y: y0, h: ch } = L.compass;
    const x0 = L.compass.x;
    const E = L.exfilBar; // 桌面 = 罗盘下方独立条；横屏 = null，倒计时并入右侧芯片
    const chipW = E ? 0 : Math.min(74, Math.max(56, Math.round(cw * 0.30)));
    const chipGap = 6;
    const usableRight = x0 + cw - chipW - chipGap - 4;
    const cx = x0 + cw / 2;
    const C = HUD.compass;

    tacticalPanel(ctx, x0, y0, cw, ch, {
      cut: 5, bracket: cw > 150, bracketColor: dfAlpha(DF.accent, 0.55),
    });
    const yawDeg = ((p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const pxPerDeg = cw / C.spanDeg;
    const letters = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    const from = Math.floor((yawDeg - C.spanDeg / 2) / C.stepDeg) * C.stepDeg;
    const to = yawDeg + C.spanDeg / 2;
    ctx.textAlign = 'center';
    for (let d = from; d <= to; d += C.stepDeg) {
      const deg = ((d % 360) + 360) % 360;
      const off = ((deg - yawDeg + 540) % 360) - 180;
      const px = cx + off * pxPerDeg;
      if (px < x0 + 5 || px > usableRight) continue;
      const major = deg % C.majorDeg === 0;
      ctx.fillStyle = major ? DF.text : dfAlpha(DF.dim, 0.68);
      ctx.fillRect(px - 0.5, y0 + ch - (major ? 11 : 7), major ? 1.2 : 1, major ? 7 : 4);
      if (!major) continue;
      const cardinal = deg % 90 === 0;
      ctx.fillStyle = deg === 0 ? DF.accent : (cardinal ? COLORS.text : dfAlpha(DF.text, 0.75));
      ctx.font = `${cardinal ? 700 : 600} ${cardinal ? 12 : 9}px ${MONO}`;
      ctx.fillText(letters[deg], px, y0 + 12);
    }
    // 当前朝向的中线：没有它，刻度带在暗场里读不出"哪一格是我正对的"
    ctx.strokeStyle = dfAlpha(DF.accent, 0.5); ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, y0 + 14); ctx.lineTo(cx + 0.5, y0 + ch - 4);
    ctx.stroke();

    // 方位针：3 撤离 + 1 闸刀 + 3 终端 + 1 空投 + 3 队友，不遍历 containers / enemies。
    const marks = [];
    for (const ex of (world.map.extracts || [])) {
      const ready = extractReady(ex);
      marks.push({ x: ex.x, y: ex.y,
        color: ready ? DF.ok : (ex.requiresSwitch ? DF.rarity.gold : DF.dim), size: ready ? 7 : 4 });
    }
    for (const sw of (world.map.switches || [])) {
      if (!sw.pulled) marks.push({ x: sw.x, y: sw.y, color: DF.rarity.gold, size: 5 });
    }
    for (const t of (world.map.terminals || [])) {
      if (!t.hacked) marks.push({ x: t.x, y: t.y, color: DF.accent, size: 4 });
    }
    const air = world.map.airdrop;
    if (air && !air.landed) marks.push({ x: air.x, y: air.y, color: DF.rarity.gold, size: 6 });
    // P5 接入本地 AI 队友后，只要 world.squad[i] 带 x/y，方位针自动出现，绘制层不用改。
    for (const m of (world.squad || [])) {
      if (m && !m.isPlayer && Number.isFinite(m.x) && Number.isFinite(m.y)) {
        marks.push({ x: m.x, y: m.y, color: DF.text, size: 4 });
      }
    }
    for (const m of marks) {
      const off = ((Math.atan2(m.y - p.y, m.x - p.x) - p.yaw) * 180 / Math.PI + 540) % 360 - 180;
      if (Math.abs(off) > 90) continue;
      const px = cx + off * pxPerDeg;
      if (px < x0 + 5 || px > usableRight) continue;
      ctx.fillStyle = m.color;
      ctx.fillRect(px - m.size / 2, y0 + ch - 3, m.size, 2.5);
    }

    // 中心指示三角（当前朝向）
    ctx.fillStyle = DF.accent;
    ctx.beginPath();
    ctx.moveTo(cx, y0 - 3);
    ctx.lineTo(cx - 5, y0 - 9);
    ctx.lineTo(cx + 5, y0 - 9);
    ctx.closePath(); ctx.fill();

    // 撤离倒计时（P20：改读状态机，不再自己按 openAt 猜）
    // 优先级：有可用出口 → OPEN；否则报最近一处未开放点的倒计时；再否则报条件未满足/无出口。
    const ov = world.extractOverview ? world.extractOverview() : null;
    let exLabel;
    let exColor;
    let exRatio = 1;
    if (ov) {
      if (ov.switchLeft > 0) {
        // M-03：闸刀已拉 —— 全图都能读到窗口剩余，逼玩家在"暴露后的 3 分钟"内做决定。
        exLabel = `闸口 T-${ov.switchLeft}s`;
        exColor = DF.rarity.gold;
        exRatio = Math.max(0, Math.min(1, ov.switchLeft / EXTRACT_TUNING.switchDelay));
      } else if (ov.open > 0) {
        exLabel = ov.total > 1 ? `EXFIL  OPEN ×${ov.open}` : 'EXFIL  OPEN';
        exColor = DF.ok;
      } else if (ov.nextAt > 0) {
        exLabel = `EXFIL  T-${ov.nextAt}s`;
        exColor = DF.accent;
        const span = Math.max(1, MATCH.duration || 480);
        exRatio = Math.max(0, Math.min(1, 1 - ov.nextAt / span));
      } else if (ov.blocked > 0) {
        // 条件未满足用橙色（HUD 段禁信息蓝，见 tests/p1-hud.test.mjs 的色板收口）
        exLabel = `EXFIL  需条件 ${ov.blocked}/${ov.total}`; exColor = DF.accent;
      } else {
        exLabel = 'EXFIL  —'; exColor = DF.dim;
      }
    } else {
      const exs = world.map.extracts || [];
      let nextOpen = null;
      for (const e of exs) {
        if (e.open) continue;
        const t = (e.openAt || 0) - world.time;
        if (t > 0 && (nextOpen == null || t < nextOpen)) nextOpen = t;
      }
      if (nextOpen != null) {
        exLabel = `EXFIL  T-${Math.ceil(nextOpen)}s`;
        exColor = DF.accent;
        const span = Math.max(1, MATCH.duration || 480);
        exRatio = Math.max(0, Math.min(1, 1 - nextOpen / span));
      } else if (exs.some((e) => e.open)) {
        exLabel = 'EXFIL  OPEN'; exColor = DF.ok;
      } else {
        exLabel = 'EXFIL  —'; exColor = DF.dim;
      }
    }
    if (E) {
      // 桌面：罗盘下方独立条，顶部信息一眼读完（不再挤在罗盘右端）
      tacticalPanel(ctx, E.x, E.y, E.w, E.h, {
        cut: 4, bracket: false, fill: dfAlpha(DF.bg, 0.9), line: dfAlpha(exColor, 0.5),
      });
      ctx.textAlign = 'center'; ctx.font = `700 9px ${MONO}`; ctx.fillStyle = exColor;
      ctx.fillText(exLabel, E.x + E.w / 2, E.y + 11);
      ctx.fillStyle = dfAlpha(DF.dim, 0.25);
      ctx.fillRect(E.x + 6, E.y + E.h - 3, E.w - 12, 1.5);
      ctx.fillStyle = exColor;
      ctx.fillRect(E.x + 6, E.y + E.h - 3, (E.w - 12) * exRatio, 1.5);
    } else {
      // 横屏：仍把倒计时压进罗盘右侧芯片，不额外占一行
      const chipX = x0 + cw - chipW - chipGap;
      const chipY = y0 + 4;
      const chipH = ch - 8;
      cutPath(ctx, chipX, chipY, chipW, chipH, 4);
      ctx.fillStyle = dfAlpha(DF.bg, 0.94); ctx.fill();
      ctx.strokeStyle = dfAlpha(exColor, 0.45); ctx.lineWidth = 1; ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = exColor; ctx.font = `700 ${chipH < 20 ? 9 : 10}px ${MONO}`;
      ctx.fillText(exLabel, chipX + chipW / 2, chipY + chipH / 2 + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }

  /**
   * 左上三人小队面板（P1）。
   *
   * 数据契约：world.squad 是 P5 本地 AI 队友的入口，当前为 null，额外两席
   * 明确画成 STANDBY 暗槽 —— 只做视觉与数据结构，不伪造队友、不虚报功能。
   * 真血量只来自 world.player，其余席位读到数据才点亮。
   */
  function drawSquadPanel(world, L) {
    const S = L.squad;
    if (!S || S.hidden) return;
    const ctx = hudCtx;
    const p = world.player;
    const live = (world.squad || []).filter((m) => m && !m.isPlayer).slice(0, HUD.squadSize - 1);
    const members = [{
      slot: '01', callsign: p.callsign || '你 / PLAYER',
      role: (world.operator && world.operator.roleName) || 'ASSAULT',
      hp: p.hp, maxHp: p.maxHp, armor: p.armor, maxArmor: p.maxArmor,
      state: p.dead ? 'KIA' : 'ACTIVE', isPlayer: true,
    }];
    live.forEach((m, i) => members.push({
      slot: `0${i + 2}`,
      callsign: m.callsign || `队友 ${i + 2}`,
      role: m.role || 'ALLY',
      hp: m.hp || 0, maxHp: m.maxHp || 1,
      armor: m.armor || 0, maxArmor: m.maxArmor || 1,
      state: m.state || 'ACTIVE',
    }));
    while (members.length < HUD.squadSize) {
      const st = SQUAD_STANDBY[members.length - 1] || { slot: `0${members.length + 1}`, role: 'STANDBY' };
      members.push({ ...st, callsign: st.callsign || '待命席位', empty: true });
    }
    // panel 是 renderHud 内的局部闭包，这里用模块级的 tacticalPanel 直接画
    tacticalPanel(ctx, S.x, S.y, S.w, S.h, { bracketColor: dfAlpha(DF.accent, 0.8) });
    if (S.compact) {
      // 横屏：三格并排，只留编号 + 双条，高度 40 内全部放下
      const cw = (S.w - 16) / HUD.squadSize;
      ctx.textAlign = 'left';
      members.forEach((m, i) => {
        const x = S.x + 8 + i * cw;
        ctx.fillStyle = m.empty ? dfAlpha(DF.dim, 0.10)
          : (m.isPlayer ? dfAlpha(DF.accent, 0.20) : dfAlpha(DF.bg, 0.9));
        ctx.fillRect(x, S.y + 5, 14, 14);
        ctx.strokeStyle = m.empty ? dfAlpha(DF.dim, 0.25) : (m.isPlayer ? DF.accent : dfAlpha(DF.dim, 0.5));
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, S.y + 5.5, 13, 13);
        ctx.fillStyle = m.empty ? dfAlpha(DF.dim, 0.4) : COLORS.text;
        ctx.font = `700 9px ${MONO}`;
        ctx.fillText(m.slot, x + 2, S.y + 16);
        ctx.font = `8px ${MONO}`;
        ctx.fillStyle = m.empty ? dfAlpha(DF.dim, 0.5) : COLORS.dim;
        ctx.fillText(m.empty ? 'STANDBY' : (m.state || 'ACTIVE'), x + 18, S.y + 15);
        segBar(ctx, x, S.y + 24, cw - 6, 4,
          m.empty ? 0 : m.hp / Math.max(1, m.maxHp), m.empty ? DF.dim : DF.ok, 6, 1);
        segBar(ctx, x, S.y + 31, cw - 6, 3,
          m.empty ? 0 : m.armor / Math.max(1, m.maxArmor), DF.text, 6, 1);
      });
      return;
    }
    // 桌面：三行档案卡
    ctx.textAlign = 'left'; ctx.fillStyle = COLORS.dim; ctx.font = `600 9px ${MONO}`;
    ctx.fillText('SQUAD / 小队', S.x + 12, S.y + 14);
    ctx.textAlign = 'right'; ctx.fillStyle = dfAlpha(DF.accent, 0.85);
    ctx.fillText(`SIM · ${members.filter((m) => !m.empty).length}/${HUD.squadSize}`, S.x + S.w - 12, S.y + 14);
    const rowH = (S.h - 20) / HUD.squadSize;
    members.forEach((m, i) => {
      const y = S.y + 20 + i * rowH;
      const ax = S.x + 12;
      ctx.fillStyle = m.empty ? dfAlpha(DF.dim, 0.08)
        : (m.isPlayer ? dfAlpha(DF.accent, 0.18) : dfAlpha(DF.bg, 0.9));
      ctx.fillRect(ax, y + 1, 18, 18);
      ctx.strokeStyle = m.empty ? dfAlpha(DF.dim, 0.25) : (m.isPlayer ? DF.accent : dfAlpha(DF.dim, 0.5));
      ctx.lineWidth = 1;
      ctx.strokeRect(ax + 0.5, y + 1.5, 17, 17);
      ctx.textAlign = 'left';
      ctx.fillStyle = m.empty ? dfAlpha(DF.dim, 0.45) : COLORS.text;
      ctx.font = `700 9px ${MONO}`;
      ctx.fillText(m.slot, ax + 3, y + 14);
      ctx.font = `600 10px ${SANS}`;
      ctx.fillStyle = m.empty ? dfAlpha(DF.dim, 0.55) : COLORS.text;
      ctx.fillText(m.callsign, ax + 25, y + 11);
      ctx.textAlign = 'right';
      ctx.font = `8px ${MONO}`;
      ctx.fillStyle = m.empty ? dfAlpha(DF.dim, 0.45) : (m.state === 'KIA' ? COLORS.danger : COLORS.dim);
      ctx.fillText(m.empty ? 'STANDBY' : (m.state || m.role), S.x + S.w - 12, y + 11);
      segBar(ctx, ax + 25, y + 14, S.w - 49, 3,
        m.empty ? 0 : m.hp / Math.max(1, m.maxHp), m.empty ? DF.dim : DF.ok, 10, 1);
      segBar(ctx, ax + 25, y + 19, S.w - 49, 2,
        m.empty ? 0 : m.armor / Math.max(1, m.maxArmor), DF.text, 10, 1);
    });
  }

  /**
   * 战术道具 / 大招冷却（P1 视觉骨架）。
   * world.abilities 为 null 时明确画 LOCK，等 P5 干员系统写入
   * { tactical:{cd,cdMax}, ultimate:{cd,cdMax} } 即可点亮，绘制层不用改。
   */
  function drawTactical(world, L) {
    const T = L.tactical;
    if (!T) return;
    const ctx = hudCtx;
    const ab = world.abilities || {};
    const items = [
      { key: 'tactical', label: 'T', color: DF.accent },
      { key: 'ultimate', label: 'U', color: DF.rarity.gold },
    ];
    if (T.mode === 'compact') {
      ctx.fillStyle = dfAlpha(DF.bg, 0.88);
      ctx.fillRect(T.x, T.y, T.w, T.h);
      ctx.strokeStyle = dfAlpha(DF.dim, 0.32); ctx.lineWidth = 1;
      ctx.strokeRect(T.x + 0.5, T.y + 0.5, T.w - 1, T.h - 1);
      const segW = (T.w - 6) / 2;
      items.forEach((it, i) => {
        const a = ab[it.key];
        const isUlt = it.key === 'ultimate';
        const x = T.x + 2 + i * (segW + 2);
        ctx.fillStyle = dfAlpha(DF.dim, 0.20);
        ctx.fillRect(x, T.y + 2, segW, T.h - 4);
        ctx.fillStyle = a ? it.color : dfAlpha(DF.dim, 0.35);
        const ratio = a ? Math.max(0, Math.min(1, a.cdMax ? 1 - a.cd / a.cdMax : 1)) : 0;
        ctx.fillRect(x, T.y + 2, segW * ratio, T.h - 4);
        ctx.textAlign = 'center'; ctx.font = `700 8px ${MONO}`;
        ctx.fillStyle = a ? DF.text : dfAlpha(DF.dim, 0.7);
        // 触屏横屏只有 12px 高，一行塞不下"名字 + 读数"，所以把读数压成紧凑记号：
        // 战术 = T×格数（没格则倒计时），大招 = 能量百分比 / X（就绪）。
        let mark = it.label;
        if (a) {
          if (isUlt) mark = a.ready ? 'X' : `${Math.round(a.charge)}`;
          else mark = a.charges > 0 ? `T${a.charges}` : `${Math.ceil(a.cd || 0)}`;
        }
        ctx.fillText(mark, x + segW / 2, T.y + T.h - 2);
      });
      return;
    }
    items.forEach((it, i) => {
      const c = i === 0 ? T.left : T.right;
      const a = ab[it.key];
      const isUlt = it.key === 'ultimate';
      const ratio = a ? Math.max(0, Math.min(1, a.cdMax ? 1 - a.cd / a.cdMax : 1)) : 0;
      // 大招满能量时环换成金色并加一圈外环 —— 颜色是次要提示，外环才是"现在能按"的形状信号。
      const color = a && a.ready ? DF.rarity.gold : (a ? it.color : dfAlpha(DF.dim, 0.45));
      ringProgress(ctx, c.cx, c.cy, c.r, HUD.ring.w, ratio, color);
      if (a && a.ready) {
        ctx.beginPath();
        ctx.arc(c.cx, c.cy, c.r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = dfAlpha(DF.rarity.gold, 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = dfAlpha(DF.bg, 0.9);
      ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r - 4, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = a ? COLORS.text : dfAlpha(DF.dim, 0.7);
      ctx.font = `700 12px ${MONO}`;
      let center = it.label;
      if (a) {
        if (isUlt) center = a.ready ? 'X' : `${Math.round(a.charge)}`;
        else center = a.charges > 0 ? `${a.charges}` : `${Math.ceil(a.cd || 0)}`;
      }
      ctx.fillText(center, c.cx, c.cy + 4);
      ctx.font = `8px ${MONO}`;
      let sub = 'LOCK';
      if (a) {
        if (isUlt) sub = a.ready ? 'READY' : 'CHARGE';
        else sub = a.charges > 0 ? `×${a.charges}` : `${Math.ceil(a.cd || 0)}s`;
      }
      ctx.fillStyle = !a ? dfAlpha(DF.dim, 0.6) : (a.ready ? DF.rarity.gold : COLORS.dim);
      ctx.fillText(sub, c.cx, c.cy + c.r + 10);
    });
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

    // P1：在既有矩形内切出**方形主图** + 右侧控制栏，矩形本身不动
    // （L.minimap 是布局体检工具的真值源，改尺寸会误报回归）。
    const side = mw < 160 ? 22 : HUD.minimap.sideW;
    const boxW = Math.max(40, Math.min(mw - side - 10, mh - 8));
    const boxH = boxW;
    const boxX = x0 + 4;
    const boxY = y0 + Math.round((mh - boxH) / 2);
    const sideX = boxX + boxW + 6;
    const zoom = HUD.minimap.zoomSteps[hudState.mmZoom] || 1;
    const viewCols = map.cols / zoom;
    const viewRows = map.rows / zoom;
    const clampV = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const ox = clampV(world.player.x / TILE - viewCols / 2, 0, map.cols - viewCols);
    const oy = clampV(world.player.y / TILE - viewRows / 2, 0, map.rows - viewRows);
    hudState.mmHit = {
      zoomIn: { x: sideX, y: boxY + 20, w: Math.max(16, side - 4), h: 16 },
      zoomOut: { x: sideX, y: boxY + 40, w: Math.max(16, side - 4), h: 16 },
    };

    tacticalPanel(ctx, x0, y0, mw, mh, { cut: 6, bracketColor: dfAlpha(DF.accent, 0.7) });

    // B3：小地图底图（背景 + 迷雾 + 战术网格）烘焙到离屏画布，最多 12Hz 重画。
    // 玩家/敌人/撤离环/空投脉动仍逐帧叠加，所以移动标记和脉动不会变卡；
    // 底图滞后 ≤83ms（最多几像素），换取每帧少一次大 drawImage + 网格描边。
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.ceil(boxW * dpr));
    const bh = Math.max(1, Math.ceil(boxH * dpr));
    if (!hudState.mmBase || hudState.mmBase.width !== bw || hudState.mmBase.height !== bh) {
      hudState.mmBase = document.createElement('canvas');
      hudState.mmBase.width = bw;
      hudState.mmBase.height = bh;
      hudState.mmBaseCtx = hudState.mmBase.getContext('2d');
      hudState.mmBaseAt = 0;
      hudState.mmBaseKey = '';
    }
    const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const baseKey = `${bw}x${bh}|${zoom}`;
    const bctx = hudState.mmBaseCtx;
    if (bctx && (hudState.mmBaseKey !== baseKey || nowMs - hudState.mmBaseAt >= 83)) {
      hudState.mmBaseKey = baseKey;
      hudState.mmBaseAt = nowMs;
      hudState.perf.mmBakes += 1;
      if (typeof bctx.setTransform === 'function') bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, boxW, boxH);
      bctx.fillStyle = dfAlpha(DF.bg, 0.92);
      bctx.fillRect(0, 0, boxW, boxH);
      bctx.imageSmoothingEnabled = false;
      bctx.drawImage(hudState.mm, ox, oy, viewCols, viewRows, 0, 0, boxW, boxH);
      bctx.strokeStyle = dfAlpha(DF.text, 0.075); bctx.lineWidth = 1;
      for (let i = 1; i < HUD.minimap.gridLines; i += 1) {
        const gx = boxW * i / HUD.minimap.gridLines;
        const gy = boxH * i / HUD.minimap.gridLines;
        bctx.beginPath();
        bctx.moveTo(gx, 0); bctx.lineTo(gx, boxH);
        bctx.moveTo(0, gy); bctx.lineTo(boxW, gy);
        bctx.stroke();
      }
    }

    ctx.save();
    cutPath(ctx, boxX, boxY, boxW, boxH, 4); ctx.clip();
    if (hudState.mmBase) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(hudState.mmBase, boxX, boxY, boxW, boxH);
    }
    const toMap = (wx, wy) => ({
      x: boxX + ((wx / TILE - ox) / viewCols) * boxW,
      y: boxY + ((wy / TILE - oy) / viewRows) * boxH,
    });

    for (const point of world.map.extracts) {
      if (!MINIMAP_LAYERS.showExtracts) break;
      const p = toMap(point.x, point.y);
      const ready = extractReady(point);
      const needsSwitch = point.requiresSwitch && !point.switchPulledAt;
      ctx.fillStyle = ready ? COLORS.ok
        : (needsSwitch ? DF.rarity.gold : dfAlpha(DF.dim, 0.7));
      ctx.beginPath(); ctx.arc(p.x, p.y, ready ? 4 : 3, 0, Math.PI * 2); ctx.fill();
      if (ready) {
        // 基础脉动环（free 维持绿色脉动）
        ctx.strokeStyle = dfAlpha(DF.ok, 0.5); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, 7 + Math.sin(world.time * 3) * 1.5, 0, Math.PI * 2); ctx.stroke();
        // 类型外环：付费→琥珀，守点→红；free 不额外加环
        const kind = point.kind || 'free';
        let ringColor = null;
        if (kind === 'paid') ringColor = DF.rarity.gold;
        else if (kind === 'guarded') ringColor = COLORS.danger;
        if (ringColor) {
          ctx.strokeStyle = ringColor; ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 11 + Math.sin(world.time * 3 + 1) * 1.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (needsSwitch) {
        // 未拉闸的出口：琥珀静止环，和"已经能走"的绿脉动明确区分。
        ctx.strokeStyle = dfAlpha(DF.rarity.gold, 0.55); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // 数据终端：菱形标记（未破解青色 / 已破解转绿并压暗）
    for (const t of (MINIMAP_LAYERS.showTerminals ? (world.map.terminals || []) : [])) {
      const p = toMap(t.x, t.y);
      const s = 3.2;
      if (t.hacked) {
        ctx.fillStyle = DF.ok;
        ctx.globalAlpha = 0.55;
      } else {
        ctx.fillStyle = DF.accent; // 未破解终端 = 橙色任务目标（P1 色板收口，去掉信息蓝）
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
    // M-03：闸刀 POI —— 未拉=琥珀方块，拉开后转绿压暗（复用终端图层开关）。
    if (MINIMAP_LAYERS.showTerminals) {
      for (const sw of (world.map.switches || [])) {
        const p = toMap(sw.x, sw.y);
        const s = 3.4;
        ctx.fillStyle = sw.pulled ? DF.ok : DF.rarity.gold;
        ctx.globalAlpha = sw.pulled ? 0.5 : 1;
        ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
        ctx.globalAlpha = 1;
      }
    }
    // 空投信标：未着陆时在落点画脉动橙色标记（“即将到达”）
    const airdrop = world.map.airdrop;
    if (airdrop && !airdrop.landed && MINIMAP_LAYERS.showAirdrop) {
      const p = toMap(airdrop.x, airdrop.y);
      ctx.fillStyle = DF.accent;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
      const pulse = (world.time * 0.8) % 1; // 0..1 循环扩散
      ctx.strokeStyle = DF.accent;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7 * (1 - pulse);
      ctx.beginPath(); ctx.arc(p.x, p.y, 4 + pulse * 16, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const c of (MINIMAP_LAYERS.showContainers ? world.map.containers : [])) {
      if (!world.explored[Math.floor(c.y / TILE) * map.cols + Math.floor(c.x / TILE)]) continue;
      const p = toMap(c.x, c.y);
      if (c.searched) {
        ctx.fillStyle = dfAlpha(DF.dim, 0.6);
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
    // 敌人：默认**只显示已交火且在感知范围内**的目标，不是免费全图雷达。
    // "被发现"的语义 = 双方已经互相暴露（COMBAT）；巡逻/怀疑中的敌人仍然只能靠听与看。
    // 想看全部把 showEnemies 改 true（调试用），着色与逻辑都还在。
    if (MINIMAP_LAYERS.showEnemies || MINIMAP_LAYERS.showSpottedEnemies) {
      for (const e of world.enemies) {
        if (e.dead) continue;
        // P5 鹰眼：被标记的敌人无条件上小地图（这才是"鹰眼"的价值 —— 穿墙的信息）
        const marked = (e.marked || 0) > 0;
        if (!marked) {
          if (MINIMAP_LAYERS.showEnemies) {
            if (e.state !== EnemyState.COMBAT && e.state !== EnemyState.SUSPICIOUS) continue;
          } else if (e.state !== EnemyState.COMBAT
            || Math.hypot(e.x - world.player.x, e.y - world.player.y) > 500) continue;
        }
        const p = toMap(e.x, e.y);
        ctx.fillStyle = marked ? DF.rarity.gold : (e.state === EnemyState.COMBAT ? COLORS.danger : COLORS.accent);
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = marked ? dfAlpha(DF.rarity.gold, 0.75) : dfAlpha(DF.danger, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, marked ? 6.5 : 5.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // POI 代号：取面积最大的前 N 个房间，稳定贴自制战术代号（不改动地图生成、不影响 seed）。
    // 小屏方图 <100px 时整体折叠不画 —— 66px 里塞 4 个英文代号只会糊成一团。
    const poiCap = boxW < 100 ? 0 : Math.min(HUD.minimap.poiMax, Math.floor(boxW / 42));
    const poiRooms = (map.rooms || []).slice()
      .sort((a, b) => (b.tw * b.th) - (a.tw * a.th))
      .slice(0, poiCap);
    const poiNames = POI_NAMES[map.id] || POI_NAMES.depot;
    ctx.textAlign = 'center'; ctx.font = `600 8px ${MONO}`;
    poiRooms.forEach((r, i) => {
      const p = toMap(r.cx, r.cy);
      if (p.x < boxX + 18 || p.x > boxX + boxW - 18 || p.y < boxY + 10 || p.y > boxY + boxH - 4) return;
      const label = poiNames[i] || `R${i + 1}`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = dfAlpha(DF.bg, 0.82);
      ctx.fillRect(p.x - tw / 2 - 2, p.y - 13, tw + 4, 10);
      ctx.fillStyle = dfAlpha(DF.text, 0.72);
      ctx.fillText(label, p.x, p.y - 5);
    });
    const pp = toMap(world.player.x, world.player.y);
    ctx.save();
    ctx.translate(pp.x, pp.y); ctx.rotate(world.player.angle);
    ctx.fillStyle = DF.text;
    ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = DF.accent; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();

    // 当前区域：取离玩家最近的命名 POI（与最小图代号同源，保证 HUD 与小地图一致）。
    // 不随缩放跳动、也不依赖战争迷雾：它读的是 map.pois 真值，不在视野内也照样报。
    const pois = map.pois || [];
    if (pois.length) {
      let best = pois[0]; let bd = Infinity;
      for (const p of pois) {
        const dd = (p.x - world.player.x) ** 2 + (p.y - world.player.y) ** 2;
        if (dd < bd) { bd = dd; best = p; }
      }
      const areaLabel = `区域 ${best.name}`;
      ctx.font = `700 9px ${MONO}`;
      ctx.textAlign = 'left';
      const aw = ctx.measureText(areaLabel).width;
      ctx.fillStyle = dfAlpha(DF.bg, 0.82);
      ctx.fillRect(boxX + 4, boxY + 4, aw + 10, 14);
      ctx.fillStyle = DF.text;
      ctx.fillText(areaLabel, boxX + 9, boxY + 14);
    }
    ctx.restore();

    // 视野框：随缩放一起换算，Zoom 时仍是同一段真实距离
    const vr = (60 / TILE / viewCols) * boxW;
    ctx.strokeStyle = dfAlpha(DF.accent, 0.20); ctx.lineWidth = 1;
    ctx.strokeRect(pp.x - vr, pp.y - vr, vr * 2, vr * 2);

    // 右侧控制栏：北向 + 缩放档 + / − 命中区（window 级监听读 hudState.mmHit）
    ctx.textAlign = 'left'; ctx.font = `700 10px ${MONO}`; ctx.fillStyle = DF.accent;
    ctx.fillText('N', sideX + 2, boxY + 10);
    for (const [key, label] of [['zoomIn', '+'], ['zoomOut', '−']]) {
      const b = hudState.mmHit[key];
      ctx.fillStyle = dfAlpha(DF.bg, 0.92);
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = dfAlpha(DF.dim, 0.42); ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      ctx.fillStyle = COLORS.text; ctx.font = `700 11px ${MONO}`; ctx.textAlign = 'center';
      ctx.fillText(label, b.x + b.w / 2, b.y + b.h - 4);
    }
    if (side >= 40) {
      ctx.textAlign = 'left'; ctx.fillStyle = COLORS.dim; ctx.font = `9px ${MONO}`;
      ctx.fillText(`${zoom.toFixed(1)}×`, sideX + 2, boxY + boxH - 3);
    }
    ctx.textAlign = 'right'; ctx.fillStyle = COLORS.dim; ctx.font = `9px ${MONO}`;
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
  // 首领血条：顶部居中，独立于普通敌人的世界空间血条（P9）。
  function drawBossBar(ctx, world, W, L) {
    const boss = world.boss;
    if (!boss || boss.dead) return;
    const name = boss.name || '首领';
    const ratio = Math.max(0, Math.min(1, boss.hp / Math.max(1, boss.maxHp)));
    const armorRatio = Math.max(0, Math.min(1, (boss.armor || 0) / Math.max(1, boss.maxArmor || 1)));
    const bw = Math.min(520, Math.max(280, W * 0.5));
    const bx = (W - bw) / 2;
    // 压在罗盘（72~96）+ 撤离倒计时条（100~116）下方，留足标签行高，避免文字压到倒计时。
    // 横屏/桌面布局都从 L 读真值；touch 横屏没有独立 exfilBar，罗盘底 90 也够放。
    const by = L && L.compass ? L.compass.y + L.compass.h + 48 : 132;
    const bh = 16;
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(bx - 4, by - 4, bw + 8, bh + 12);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(bx, by, bw, bh);
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    grad.addColorStop(0, '#ff3b30');
    grad.addColorStop(1, '#ff9f1c');
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, bw * ratio, bh);
    // 护甲读数：Boss 破甲前血条会掉得很慢，单独一条让玩家看懂"打的是甲"
    // P16：破甲后这条不再是"还差一点"的蓝条，而是明确的失效标记 ——
    // 否则玩家会继续对着已经没甲的目标省子弹。
    if (boss.armorBroken) {
      ctx.fillStyle = 'rgba(255,110,80,0.30)';
      ctx.fillRect(bx, by + bh + 2, bw, 3);
      ctx.font = `700 9px ${SANS}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,150,110,0.95)';
      ctx.fillText('装甲击穿 · 承伤 +15%', bx + bw, by + bh + 15);
      ctx.textAlign = 'center';
    } else {
      ctx.fillStyle = '#9fd0ff';
      ctx.fillRect(bx, by + bh + 2, bw * armorRatio, 3);
    }
    // P16：阶段刻度 —— 让"还剩几次变身"可见，血条加速才不会被当成错觉。
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.lineWidth = 1;
    for (const at of PHASE_RATIOS.slice(1)) {
      const px = bx + bw * at;
      ctx.beginPath();
      ctx.moveTo(px, by);
      ctx.lineTo(px, by + bh);
      ctx.stroke();
    }
    ctx.strokeStyle = dfAlpha(DF.danger, 0.9);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `700 12px ${SANS}`;
    // P16：标题带上当前阶段，与血条刻度同一份数据（boss.bossPhaseIndex 由 boss.js 维护）。
    const phase = BOSS_PHASES[boss.bossPhaseIndex || 0] || BOSS_PHASES[0];
    const phaseTag = (boss.bossPhaseIndex || 0) > 0 ? `  ·  ${phase.label}` : '';
    ctx.fillText(`首领 · ${name}  ·  ${boss.def.theme || ''}${phaseTag}`, W / 2, by - 8);
    ctx.font = `600 10px ${SANS}`;
    ctx.fillStyle = dfAlpha(DF.text, 0.75);
    ctx.fillText(`${Math.ceil(boss.hp)} / ${boss.maxHp}`, W / 2, by + bh - 4);
    ctx.textAlign = 'left';

    // P16：阶段切换横幅（2.6s，最后 0.4s 淡出）。放在罗盘上方顶部公告位，
    // 不与下方 EXFIL 倒计时横幅（100~116）重叠 —— 旧版 py=by-58 会压在撤离倒计时上。
    const bnr = world.bossPhaseBanner;
    if (bnr && bnr.t > 0) {
      const a = Math.min(1, bnr.t / 0.4);
      const text = `${bnr.label} · ${bnr.name}`;
      ctx.font = `800 17px ${SANS}`;
      const tw = ctx.measureText(text).width;
      const pw = tw + 40;
      const px = (W - pw) / 2;
      const py = (L.compass ? L.compass.y : 72) - 40;
      ctx.fillStyle = `rgba(26,4,2,${0.78 * a})`;
      ctx.fillRect(px, py, pw, 32);
      ctx.fillStyle = `rgba(255,70,54,${0.92 * a})`;
      ctx.fillRect(px, py, 3, 32);
      ctx.fillRect(px + pw - 3, py, 3, 32);
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(255,238,232,${a})`;
      ctx.fillText(text, W / 2, py + 22);
      ctx.textAlign = 'left';
    }
  }

  function renderHud(world, dt, paused) {
    if (!hudCtx) return;
    // B1：高分屏 DPR 适配。画布背衬按 DPR 放大（cap 2），绘制坐标仍用 CSS 像素，
    // 与图标层（iconEl 已走 DPR）一致，战术文字不再发虚。布局/命中区全部基于 CSS px，不改。
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.floor(window.innerWidth || hudCanvas.clientWidth || 1280));
    const H = Math.max(1, Math.floor(window.innerHeight || hudCanvas.clientHeight || 720));
    const PW = Math.max(1, Math.floor(W * dpr));
    const PH = Math.max(1, Math.floor(H * dpr));
    if (hudCanvas.width !== PW || hudCanvas.height !== PH) {
      hudCanvas.width = PW; hudCanvas.height = PH;
      if (hudCanvas.style) { hudCanvas.style.width = `${W}px`; hudCanvas.style.height = `${H}px`; }
    }
    const touch = document.body.classList.contains('touch-mode');
    const L = hudLayout(W, H, touch, tasksOpen);
    const ctx = hudCtx;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const player = world.player;
    hudState.lastPlayer = player;
    hudState.lastWorld = world;
    ctx.clearRect(0, 0, W, H);
    // B2：静态装饰层（读数条 / 武器卡 / 血条底，纯切角+四角括号）按布局只烘焙一次，
    // 逐帧贴回，省去每帧重画这三块面板；动态内容（文字/读数条/罗盘指针/小地图点）
    // 仍逐帧绘制于其上，视觉效果与改造前完全一致。
    const sig = `${PW}x${PH}:${touch}:${tasksOpen}`;
    if (hudStaticSig !== sig) {
      if (!hudStatic) hudStatic = document.createElement('canvas');
      hudStatic.width = PW; hudStatic.height = PH;
      if (hudStatic.style) { hudStatic.style.width = `${W}px`; hudStatic.style.height = `${H}px`; }
      const octx = hudStatic.getContext('2d');
      if (octx) {
        if (typeof octx.setTransform === 'function') octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.clearRect(0, 0, W, H);
        tacticalPanel(octx, L.stateStrip.x, L.stateStrip.y, L.stateStrip.w, L.stateStrip.h);
        tacticalPanel(octx, L.weapon.x, L.weapon.y, L.weapon.w, L.weapon.h, { bracketColor: dfAlpha(DF.accent, 0.8) });
        tacticalPanel(octx, L.bars.x, L.bars.y, L.bars.w, L.bars.h, { bracketColor: dfAlpha(DF.accent, 0.8) });
        hudStaticSig = sig;
      }
    }
    if (hudStatic) ctx.drawImage(hudStatic, 0, 0, W, H);
    hudState.lastLayout = L;

    // P1：低血量去饱和 + 暗角 + 心跳。3D 去饱和交给 CSS 类（只在跨阈值时改 DOM，
    // 不每帧写 class）；暗角画在 HUD 层，不新增全屏后处理 pass。
    const hpLow = player.hp / Math.max(1, player.maxHp) <= HUD.vitals.lowHp;
    if (lastLowHp !== hpLow) {
      lastLowHp = hpLow;
      const gc = document.getElementById('game-canvas');
      if (gc) gc.classList.toggle('low-hp', hpLow);
    }
    if (hpLow && !world.over) {
      const pulse = reducedMotion
        ? 0.30
        : 0.24 + 0.14 * Math.sin(world.time * Math.PI * 2 * HUD.vitals.heartbeatHz);
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.72);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, dfAlpha(DF.danger, pulse));
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = dfAlpha(DF.danger, pulse * 1.4);
      ctx.lineWidth = 2;
      ctx.strokeRect(2, 2, W - 4, H - 4);
      // P11：心跳音与视觉脉动同源（HUD.vitals.heartbeatHz），只在跨周期时触发一次，
      // 不每帧调音频；减少动态效果时跳过，避免持续重复刺激；静音由 audio 自身处理。
      // world.time 回退说明换了新局，重置节拍基准，否则第二局会一直不响。
      if (hudState.lastBeat === undefined || world.time < hudState.lastBeat) hudState.lastBeat = world.time;
      if (!reducedMotion && world.audio && typeof world.audio.heartbeat === 'function'
        && heartbeatDue(world.time, HUD.vitals.heartbeatHz, hudState.lastBeat)) {
        hudState.lastBeat = world.time;
        world.audio.heartbeat();
      }
    }

    // P11：连杀横幅走 DOM 层（不占 2D HUD 坐标，避免动 hudLayout 的布局真值）。
    // 只在文案变化时写 DOM，不每帧重排；world.over 后一律隐藏，结算屏不留残影。
    const banner = hudNode('streak-banner');
    if (banner) {
      const count = world.killStreak ? world.killStreak.count : 0;
      const alive = (world.streakT || 0) > 0 && count >= 2 && !world.over;
      const label = alive ? `${streakLabel(count)} ×${count}` : '';
      if (hudState.lastStreak !== label) {
        hudState.lastStreak = label;
        banner.textContent = label;
        banner.classList.toggle('on', alive);
        if (alive && !reducedMotion && typeof banner.animate === 'function') {
          banner.animate(
            [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }],
            { duration: PRESENTATION.resultRowDurMs, easing: 'ease-out' },
          );
        }
      }
    }

    // 任务面板命中区：折叠态把 24px 标题上下各撑到 44px 触控高度（≥44px 的手游惯例）。
    // 矩形来自 L.tasks，与体检工具同源，绝不另写坐标（写死会在 667 宽屏压到别的东西）。
    const tap = hudNode('tasks-tap');
    if (tap) {
      const C = L.tasks;
      const h = Math.max(44, C.headH);
      // B3：布局只在切屏/缩放/暂停状态变化时写 DOM；旧实现每帧 4 次 style + 1 次 classList。
      const sig = `${C.x}|${C.y}|${C.w}|${h}|${L.touch ? 1 : 0}|${paused ? 1 : 0}|${world.over ? 1 : 0}`;
      if (hudState.tapSig !== sig) {
        hudState.tapSig = sig;
        hudState.perf.tapWrites += 1;
        tap.style.left = `${C.x}px`;
        tap.style.top = `${C.y - (h - C.headH) / 2}px`;
        tap.style.width = `${C.w}px`;
        tap.style.height = `${h}px`;
        tap.classList.toggle('hidden', !L.touch || paused || world.over);
      }
    }

    // P1：所有 HUD 卡片统一走切角 + 四角括号。这里保留 `panel` 这个名字，
    // 是为了不改动下面十几处调用点；换皮只发生在一处。
    const panel = (x, y, w, h, o) => tacticalPanel(ctx, x, y, w, h, o);

    // 顶层（常驻）：读数条 —— 击杀 / 搜刮 / 负重。
    // 随身估值已移入背包页（第三层），它属于资产信息不是战况信息。
    const M = L.stateStrip;
    // 面板底（stateStrip）已在 B2 静态层烘焙并贴回，这里只画动态读数。
    const tx = M.x + 14;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text; ctx.font = `600 ${M.compact ? 12 : 13}px ${SANS}`;
    ctx.fillText(`击杀 ${world.kills}`, tx, M.y + M.rowY[0]);
    ctx.fillText(`搜刮 ${world.searchedCount}`, tx + M.col2, M.y + M.rowY[0]);
    // 读数条第 1 行右端：蹲伏状态优先（只在蹲着时出现），否则显示最近已开放撤离点的距离。
    // 两者共用同一格并互斥，永不重叠。
    if (player.crouching) {
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.ok; ctx.font = `600 ${M.compact ? 10 : 11}px ${SANS}`;
      ctx.fillText('蹲伏', M.x + M.w - 8, M.y + M.rowY[0]);
    } else {
      // 只遍历 map.extracts（2 个），绝不顺手遍历 map.containers。
      let nearest = Infinity;
      for (const ex of (world.map.extracts || [])) {
        if (ex.open) nearest = Math.min(nearest, Math.hypot(ex.x - player.x, ex.y - player.y));
      }
      if (Number.isFinite(nearest)) {
        const esz = M.compact ? 12 : 16;
        drawHudIcon(ctx, 'hud-extract', M.x + M.w - (M.compact ? 72 : 84), M.y + M.rowY[0] - esz + 2,
          esz, COLORS.ok, drawGlyph);
        ctx.textAlign = 'right';
        ctx.fillStyle = COLORS.ok;
        ctx.font = `${M.compact ? 9 : 10}px ${MONO}`;
        ctx.fillText(`撤离 ${Math.round(nearest)}m`, M.x + M.w - 8, M.y + M.rowY[0]);
      }
    }
    const weight = player.weight;
    const wLimit = player.weightLimit;
    const over = weight > wLimit;
    const bsz = M.compact ? 12 : 16;
    drawHudIcon(ctx, 'hud-backpack', tx - bsz + 2, M.y + M.rowY[1] - bsz + 2, bsz,
      over ? COLORS.danger : COLORS.dim, drawGlyph);
    ctx.fillStyle = over ? COLORS.danger : COLORS.dim;
    ctx.font = `600 ${M.compact ? 11 : 12}px ${MONO}`;
    // 超重时直接写出后果，不让玩家猜为什么"跑不动了"
    ctx.fillText(
      over ? `负重 ${weight.toFixed(1)}/${wLimit}kg · 减速` : `负重 ${weight.toFixed(1)}/${wLimit}kg`,
      tx, M.y + M.rowY[1],
    );
    // 超重警示条：把读数条右半边的空档用起来，红底让"禁跑"无法被忽略
    if (over) {
      const bw = Math.round(M.w * 0.34);
      const bx = M.x + M.w - bw - 8;
      const by = M.y + M.h - Math.round(M.h * 0.42) - 6;
      ctx.fillStyle = dfAlpha(DF.danger, 0.22);
      roundRect(ctx, bx, by, bw, Math.round(M.h * 0.42), 4); ctx.fill();
      ctx.strokeStyle = dfAlpha(DF.danger, 0.7); ctx.lineWidth = 1;
      roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, Math.round(M.h * 0.42) - 1, 4); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.danger; ctx.font = `700 ${M.compact ? 10 : 11}px ${SANS}`;
      ctx.fillText('超重 · 减速', bx + bw / 2, by + Math.round(M.h * 0.42) * 0.68);
    } else if (world._inHotspot) {
      // P20：热点常驻提示（只在没超重时用这块空档）——
      // 进圈 toast 只活几秒，玩家在里面待久了就忘了自己在高危区，所以这里常亮。
      const danger = Number(world.hotspotDanger) || 1;
      const label = clipText(ctx, `${world.hotspotName || '热点'} · ${dangerLabel(danger)}`,
        Math.round(M.w * 0.42));
      ctx.textAlign = 'right';
      ctx.fillStyle = danger >= 3 ? COLORS.danger : COLORS.accent;
      ctx.font = `600 ${M.compact ? 10 : 11}px ${SANS}`;
      ctx.fillText(label, M.x + M.w - 8, M.y + M.rowY[1]);
    }

    // 顶部中央：倒计时
    const timeLeft = Math.max(0, world.timeLeft);
    const mm = Math.floor(timeLeft / 60);
    const ss = Math.floor(timeLeft % 60);
    const urgent = timeLeft <= MATCH.warnTime;
    // 减少动态效果时不闪（改恒亮红），避免光敏/晕屏玩家被 2Hz 闪烁刺激
    const blink = urgent && !reducedMotion && Math.floor(world.time * 2) % 2 === 0;
    const urgentColor = reducedMotion ? COLORS.danger : (blink ? COLORS.danger : COLORS.accent);
    ctx.textAlign = 'center';
    const T = L.timer;
    cutPath(ctx, T.x, T.y, T.w, T.h, 6);
    ctx.fillStyle = dfAlpha(DF.bg, 0.88); ctx.fill();
    ctx.strokeStyle = urgent ? dfAlpha(DF.danger, 0.7) : dfAlpha(DF.accent, 0.3);
    ctx.lineWidth = 1.4; ctx.stroke();
    drawBrackets(ctx, T.x + 1, T.y + 1, T.w - 2, T.h - 2,
      urgent ? dfAlpha(DF.danger, 0.9) : dfAlpha(DF.accent, 0.65), 9, 1.2);
    ctx.fillStyle = urgent ? urgentColor : COLORS.text;
    // P0-3：大号居中时间（触屏 24→28）
    ctx.font = `700 ${T.compact ? 28 : 30}px ${MONO}`;
    const tCx = T.x + T.w / 2; // 触屏中列并不在屏幕正中，写 W/2 会把时间推到武器卡底下
    ctx.fillText(`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, tCx, T.timeY);
    // 计时器位图：贴在读数左侧；图标不进 hudLayout，布局真值不变
    const tsz = T.compact ? 12 : 18;
    drawHudIcon(ctx, 'hud-timer', T.x + 8, T.y + 8, tsz,
      urgent ? urgentColor : COLORS.dim, drawGlyph);
    ctx.font = `11px ${SANS}`; ctx.fillStyle = COLORS.dim;
    ctx.fillText('剩余时间', tCx, T.labelY);
    if (urgent && !world.over) {
      ctx.fillStyle = urgentColor; ctx.font = `700 ${T.compact ? 12 : 15}px ${SANS}`;
      // 触屏横屏顶部没有空隙了，紧急提示改挂在计时条下方 6px 处（不越出 h）
      ctx.fillText('撤离点即将关闭', tCx, T.compact ? T.y + T.h + 14 : T.y + T.h + 38);
    }
    // 战术状态图标带：剩余 HUD 位图集中在这里。位置与 killfeed/紧急提示错开，
    // 且不进 hudLayout —— 布局体检读的真值一个字节都没动。
    {
      const chips = T.compact
        ? ['hud-vision', 'hud-radio', 'hud-sneak', 'hud-plate', 'hud-helmet', 'hud-crosshair']
        : ['hud-vision', 'hud-radio', 'hud-sneak', 'hud-plate', 'hud-helmet',
          'hud-medkit', 'hud-grenade', 'hud-crosshair'];
      const sz = T.compact ? 12 : 18;
      const gap = T.compact ? 3 : 5;
      const total = chips.length * (sz + gap) - gap;
      const sx = T.x + Math.max(0, (T.w - total) / 2);
      const sy = T.y + T.h + (T.compact ? 22 : 10);
      chips.forEach((key, i) => {
        drawHudIcon(ctx, key, sx + i * (sz + gap), sy, sz, COLORS.dim, drawGlyph);
      });
    }

    // 顶部中央罗盘（仿三角洲）
    drawCompass(world, W, L);
    // 首领血条（P9）：压在罗盘 / 撤离倒计时下方
    drawBossBar(ctx, world, W, L);

    // 右上：武器与弹药（P1 战术读数：枪名 / 模式 / 口径 / 穿透 / 倍率 / 弹格 / 消耗品）
    const weapon = player.currentWeapon;
    const G = L.weapon;
    // 武器卡底已在 B2 静态层烘焙并贴回，这里只画动态弹药/状态。
    const gx = G.x + 14;
    ctx.textAlign = 'left';
    if (weapon) {
      // P7：HUD 显示的是**弹匣里实际装的弹种**（战前选择），不是武器出厂默认弹。
      const loadedAmmo = ITEMS[weapon.ammoId] || ITEMS[weapon.def.ammoItem] || null;
      const calShort = loadedAmmo && CALIBERS[loadedAmmo.caliber]
        ? CALIBERS[loadedAmmo.caliber].short : weapon.def.ammoType;
      const gradeTxt = loadedAmmo
        ? `${calShort} ${loadedAmmo.gradeName || ''}`.trim()
        : weapon.def.ammoType;
      const penTxt = loadedAmmo && loadedAmmo.pen != null ? loadedAmmo.pen : '—';
      const ammoColor = weapon.ammo === 0 ? COLORS.danger
        : (weapon.ammo <= weapon.def.magSize * 0.25 ? COLORS.accent : COLORS.text);
      ctx.fillStyle = COLORS.text; ctx.font = `600 ${G.compact ? 11 : 13}px ${SANS}`;
      ctx.fillText(weapon.def.name, gx, G.y + G.nameY);
      // 射击模式短码
      ctx.textAlign = 'right'; ctx.font = `8px ${MONO}`; ctx.fillStyle = dfAlpha(DF.accent, 0.9);
      ctx.fillText(weapon.def.auto ? 'AUTO' : 'SEMI', G.x + G.w - 12, G.y + G.nameY);
      ctx.textAlign = 'left';
      if (G.compact) {
        ctx.fillStyle = COLORS.dim; ctx.font = `9px ${MONO}`;
        ctx.fillText(`${weapon.def.auto ? '全自动' : '半自动'} · ${gradeTxt}`, gx, G.y + G.subY);
      } else {
        // 倍率由真实 FOV 反推（不是写死的"4×"），ADS 收窄多少就显示多少
        const f = VIEW3D.fov || 75;
        const fa = VIEW3D.fovAds || f;
        const scope = Math.tan(f * Math.PI / 360) / Math.max(0.001, Math.tan(fa * Math.PI / 360));
        ctx.fillStyle = COLORS.dim; ctx.font = `9px ${MONO}`;
        ctx.fillText(
          `${gradeTxt} · PEN ${penTxt} · ${scope.toFixed(1)}×`,
          gx, G.y + G.subY,
        );
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = ammoColor; ctx.font = `700 ${G.compact ? 20 : 28}px ${MONO}`;
      ctx.fillText(String(weapon.ammo), G.ammoX, G.y + G.ammoY);
      // 弹药位图贴在读数左侧；没预取到时 drawHudIcon 回退矢量 'ammo'
      const asz = G.compact ? 12 : 18;
      drawHudIcon(ctx, 'hud-ammo', G.ammoX - (G.compact ? 34 : 42), G.y + G.ammoY - asz + 2,
        asz, ammoColor, drawGlyph);
      ctx.fillStyle = COLORS.dim; ctx.font = `600 ${G.compact ? 12 : 14}px ${MONO}`;
      ctx.fillText(`/ ${player.reserveAmmo(weapon.ammoId || weapon.def.ammoItem)}`, G.reserveX, G.y + G.ammoY);
      // 弹格：把弹匣余量画成可数的格，比一条进度条更"弹匣"
      const cells = G.compact ? 6 : 8;
      segBar(ctx, G.barX, G.y + G.barY, G.barW, 6,
        weapon.ammo / Math.max(1, weapon.def.magSize), ammoColor, cells, 2);
      ctx.textAlign = 'left'; ctx.font = `9px ${MONO}`;
      if (weapon.reloading) {
        // 进度与分段名都取自 reload.js（与枪模姿态同一份真值），HUD 不会出现
        // "枪已经在拉机柄、文字还写着退弹匣"的错位。
        const stage = reloadStage(reloadProgress(weapon.reloadTimer, weapon.reloadTotal));
        const pct = Math.round(stage.p * 100);
        const label = (HUD.reload && HUD.reload[stage.key]) || '换弹';
        ctx.fillStyle = COLORS.accent;
        ctx.fillText(`${label} ${pct}%`, gx, G.y + G.footY);
      } else if (G.compact) {
        ctx.fillStyle = COLORS.dim;
        ctx.fillText('弹匣 / 备用', gx, G.y + G.footY);
      } else {
        const meds = player.inventory.items
          .filter((it) => it.category === 'consumable')
          .reduce((s, it) => s + it.qty, 0);
        ctx.fillStyle = meds ? COLORS.text : COLORS.danger;
        ctx.fillText(`MED ×${meds}   GRENADE —`, gx, G.y + G.footY);
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
        cutPath(ctx, x0, fy, rowW, rowH - 4, 4);
        ctx.fillStyle = k.ofPlayer ? dfAlpha(DF.danger, 0.16) : dfAlpha(DF.bg, 0.86);
        ctx.fill();
        ctx.strokeStyle = k.ofPlayer ? dfAlpha(DF.danger, 0.55) : dfAlpha(DF.dim, 0.30);
        ctx.lineWidth = 1; ctx.stroke();
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
      const cap = C.open ? Math.min(shown.length, 3) : 0;
      panel(C.x, y0, cw, C.headH + cap * C.rowH);
      // 标题行：左「任务 N/M」；右——展开时是收起提示，折叠时直接显示「任务 1 摘要」（P1-4）。
      // 折叠态常驻一条最关键的任务，玩家不必展开就知道下一步做什么。
      const doneCount = contracts.filter((c) => c.done).length;
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.dim; ctx.font = `600 ${C.compact ? 11 : 12}px ${SANS}`;
      ctx.fillText(`任务 ${doneCount}/${contracts.length}`, C.x + 14, y0 + C.headH * 0.66);
      ctx.textAlign = 'right';
      if (C.open) {
        ctx.fillStyle = COLORS.accent;
        ctx.font = `${C.compact ? 10 : 11}px ${MONO}`;
        // 手机上没有 J 键：触屏分支改写成"点击"，与 DOM 命中区（tasks-tap）同一语义。
        ctx.fillText(
          document.body.classList.contains('touch-mode') ? '▾ 点击收起' : '▾ J 收起',
          C.x + cw - 14, y0 + C.headH * 0.66,
        );
      } else {
        const top = sortTasksByPriority(contracts)[0];
        if (top) {
          ctx.fillStyle = top.done ? COLORS.ok : COLORS.accent;
          ctx.font = `600 ${C.compact ? 10 : 11}px ${SANS}`;
          const prog = top.done ? '✓' : `${Math.floor(top.progress)}/${top.target}`;
          ctx.fillText(`${top.name} ${prog}`, C.x + cw - 14, y0 + C.headH * 0.66);
        }
      }

      if (C.open) {
        // 目标概览独占合约区第一行（数据终端 / 空投倒计时）——
        // 它是"下一步去哪"的唯一指引，不能藏在弹窗里。
        // P20：这一行改成「局内目标进度 + 当前最该做的那条」，终端/空投读数右对齐挤在同一行 ——
        // 行高不变（rowH 是布局真值，加行会顶到血条与触屏摇杆禁区）。
        const goalY = y0 + C.headH + 10;
        const objs = liveObjectiveRows(world);
        const objDone = objs.filter((o) => o.state && o.state.done).length;
        const current = objs.find((o) => !(o.state && o.state.done)) || objs[objs.length - 1] || null;
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.dim; ctx.font = `${C.compact ? 9 : 10}px ${MONO}`;
        let goalText;
        if (objs.length) {
          const cur = current
            ? `${current.name} ${current.state ? current.state.text : ''}`
            : '全部达成';
          goalText = `目标 ${objDone}/${objs.length} · ${cur}`;
        } else {
          const airdrop = world.map.airdrop;
          let airdropInfo = '空投 —';
          if (airdrop && !airdrop.landed) {
            const remain = Math.max(0, Math.ceil(airdrop.delay - world.time));
            airdropInfo = `空投 T-${remain}s`;
          } else if (airdrop && airdrop.landed) {
            airdropInfo = '空投已着陆';
          }
          goalText = `目标 · 终端 ${world.terminalsHacked}/${MATCH.terminalCount} · ${airdropInfo}`;
        }
        ctx.fillText(clipText(ctx, goalText, cw - 28 - 76), C.x + 14, goalY);
        // 右端保留终端读数：它是"还差几处终端"的唯一常驻来源，不能被目标行挤掉。
        ctx.textAlign = 'right';
        ctx.fillStyle = COLORS.dim;
        ctx.fillText(`终端 ${world.terminalsHacked}/${MATCH.terminalCount}`, C.x + cw - 14, goalY);
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
    // 用 L.touch 而不是 B.compact：hudLayout 的触屏 bars 块历史上没有写 compact 字段，
    // 读它会让 68px 高的触屏面板塞进桌面三行 + 身体简图，直接溢出压住下方小队条。
    const compactBars = !!L.touch;
    const rowH = 20;
    const segH = compactBars ? 6 : 8;
    // 桌面三条压到 20px 行距：给底部"身体简图 + 状态图标"留出 10px，
    // 否则图标会被第三条分段条挤到面板外只剩半截（P1 截图复核发现）。
    const firstY = B.y + (compactBars ? 14 : 24);
    // 血条底已在 B2 静态层烘焙并贴回，这里只画动态血/甲条。
    if (!compactBars) {
      ctx.textAlign = 'left'; ctx.fillStyle = COLORS.dim; ctx.font = `600 9px ${MONO}`;
      ctx.fillText('VITALS / 体征', B.x + 12, B.y + 15);
    }
    const hpRatio = Math.max(0, Math.min(1, player.hp / player.maxHp));
    const armorRatio = player.maxArmor ? Math.max(0, Math.min(1, player.armor / player.maxArmor)) : 0;
    const staRatio = Math.max(0, Math.min(1, player.stamina / player.maxStamina));
    // 头盔耐久拼在护甲行右侧（只在真的戴了头盔时出现，避免无甲玩家看到一串 0）
    const helmetTxt = (player.maxHelmet || 0) > 0 && player.helmet > 0
      ? ` · 盔${Math.ceil(player.helmet)}` : '';
    const rows = [
      ['生命', hpRatio, hpRatio > HUD.vitals.lowHp ? COLORS.ok : COLORS.danger,
        `${Math.max(0, Math.ceil(player.hp))}/${player.maxHp}`],
      ['护甲', armorRatio, DF.text, `${Math.ceil(player.armor)}/${player.maxArmor}${helmetTxt}`],
      [player.exhausted ? '体力·疲惫' : '体力', staRatio,
        player.exhausted ? COLORS.danger : COLORS.accent,
        `${Math.ceil(player.stamina)}/${player.maxStamina}`],
    ];
    rows.forEach(([label, ratio, color, valueText], i) => {
      const y = firstY + i * rowH;
      // 位图状态图标：画在标签左侧的小空档，不进 hudLayout（布局真值保持不变）
      const rowIcon = ['hud-health', 'hud-armor', 'hud-footstep'][i];
      const isz = L.touch ? 12 : 18;
      drawHudIcon(ctx, rowIcon, barX - 2, y - isz + 1, isz, color, drawGlyph);
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.dim; ctx.font = `600 ${compactBars ? 9 : 10}px ${MONO}`;
      ctx.fillText(label, barX + 16, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = color;
      ctx.fillText(valueText, barX + barW, y);
      segBar(ctx, barX, y + 4, barW, segH, ratio, color, compactBars ? 8 : HUD.segCount, compactBars ? 1 : HUD.segGap);
    });
    if (!compactBars) {
      // 身体部位简图（头 / 胸 / 腹 / 双腿）：纯几何，零素材。
      // 头部随血量染色，低于阈值转红 —— 比一串数字更快被余光捕捉。
      const bx = B.x + 14;
      const by = B.y + B.h - 16;
      const bodyColor = hpRatio > HUD.vitals.lowHp ? dfAlpha(DF.dim, 0.55) : dfAlpha(DF.danger, 0.85);
      ctx.fillStyle = bodyColor;
      ctx.beginPath(); ctx.arc(bx + 7, by + 3, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(bx + 2, by + 7, 10, 4);
      ctx.fillRect(bx + 3, by + 12, 8, 3);
      ctx.fillStyle = dfAlpha(DF.dim, 0.4);
      ctx.fillRect(bx + 3, by + 16, 3, 4);
      ctx.fillRect(bx + 8, by + 16, 3, 4);
      // 状态图标槽：只点亮**真实存在**的状态。P7 起后两格接上流血与骨折。
      const cond = player.conditions || { bleed: 0, fracture: 0 };
      const statuses = [
        { on: hpRatio <= HUD.vitals.lowHp, label: '!', color: DF.danger, tip: '重伤' },
        { on: !!player.exhausted, label: '×', color: DF.danger, tip: '疲惫' },
        { on: !!over, label: '▲', color: DF.accent, tip: '超重' },
        { on: !!player.crouching, label: '⌄', color: DF.ok, tip: '蹲伏' },
        { on: cond.bleed > 0, label: '血', color: DF.danger, tip: `流血 ×${cond.bleed}` },
        { on: !!cond.fracture, label: '骨', color: DF.rarity.gold, tip: '骨折' },
      ];
      let sx = B.x + 36;
      for (const s of statuses) {
        ctx.fillStyle = s.on ? dfAlpha(s.color, 0.20) : dfAlpha(DF.bg, 0.9);
        ctx.fillRect(sx, by + 2, 15, 15);
        ctx.strokeStyle = s.on ? dfAlpha(s.color, 0.8) : dfAlpha(DF.dim, 0.28);
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, by + 2.5, 14, 14);
        ctx.fillStyle = s.on ? s.color : dfAlpha(DF.dim, 0.45);
        ctx.font = `600 10px ${MONO}`; ctx.textAlign = 'center';
        ctx.fillText(s.label, sx + 7.5, by + 13);
        sx += 19;
      }
    }

    // 底部：快捷栏。桌面端居中；触屏横屏固定 x（挪到移动按钮行上方，让开开火键区）
    const SL = L.slots;
    const slotW = SL.slotW;
    const slotH = SL.slotH;
    const total = 4; // 固定 1-4：武器按实际数量排，空位明写"空槽"，第 4 格固定医疗
    const rowW = total * slotW + (total - 1) * SL.gap;
    const startX = SL.align === 'left' ? SL.x : Math.round(W / 2 - rowW / 2);
    const medCount = player.inventory.items
      .filter((it) => it.category === 'consumable')
      .reduce((s, it) => s + it.qty, 0);
    // 卡内三行文本随卡高缩放（触屏 slotH=38，桌面 44）
    const t1 = Math.round(slotH * 0.34);
    const t2 = Math.round(slotH * 0.36) + 2;
    const t3 = Math.round(slotH * 0.77);
    for (let i = 0; i < total; i += 1) {
      const wpn = player.weapons[i];
      const isMed = i === 3;
      const isEmpty = !wpn && !isMed;
      const active = i === player.weaponIndex;
      const x = startX + i * (slotW + SL.gap);
      const y = SL.y;
      cutPath(ctx, x, y, slotW, slotH, 6);
      ctx.fillStyle = active ? dfAlpha(DF.accent, 0.18) : dfAlpha(DF.bg, 0.86);
      ctx.fill();
      ctx.strokeStyle = active ? DF.accent : dfAlpha(DF.dim, 0.32);
      ctx.lineWidth = active ? 1.6 : 1; ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = active ? DF.accent : COLORS.dim;
      ctx.font = `700 9px ${MONO}`;
      ctx.fillText(`${i + 1}`, x + 6, y + t1);
      ctx.fillStyle = active ? COLORS.text : COLORS.dim;
      ctx.font = `600 ${SL.compact ? 10 : 12}px ${SANS}`;
      ctx.fillText(isMed ? '医疗 / MED' : (isEmpty ? '— 空槽' : (wpn.def.short || wpn.def.name)), x + 18, y + t2);
      ctx.font = `10px ${MONO}`;
      if (isMed) {
        ctx.fillStyle = medCount ? DF.ok : COLORS.danger;
        ctx.fillText(`Q · ×${medCount}`, x + 6, y + t3);
      } else if (isEmpty) {
        ctx.fillStyle = dfAlpha(DF.dim, 0.5);
        ctx.fillText('—', x + 6, y + t3);
      } else {
        ctx.fillStyle = wpn.ammo === 0 ? COLORS.danger : COLORS.dim;
        ctx.fillText(`${wpn.ammo}/${player.reserveAmmo(wpn.ammoId || wpn.def.ammoItem)}`, x + 6, y + t3);
      }
    }
    ctx.textAlign = 'center'; ctx.fillStyle = medCount ? COLORS.accent : COLORS.danger; ctx.font = `600 12px ${MONO}`;
    ctx.fillText(`[Q] 医疗 ${medCount}`, W / 2, L.medHintY);

    // 右下（触屏时右上）：小地图（战争迷雾 + 战术网格 + POI + 缩放）
    drawMinimapHUD(world, L.minimap);
    // P1 新增：三人小队面板 / 战术道具与大招冷却环
    drawSquadPanel(world, L);
    drawTactical(world, L);

    // 交互提示（优先级与 player.interact 一致：终端 → 撤离 → 地面物品 → 容器）
    let prompt = null;
    if (player.search) {
      const pr = player.search.progress / Math.max(0.001, player.search.total);
      prompt = { title: `搜索中 ${Math.round(pr * 100)}%`, sub: '按 E 取消', ratio: pr };
    } else if (player.extract) {
      const pr = player.extract.progress / Math.max(0.001, MATCH.extractChannel);
      prompt = { title: `撤离中 ${Math.round(pr * 100)}%`, sub: '按 E 取消', ratio: pr };
    } else if (player.hack) {
      const pr = player.hack.progress / Math.max(0.001, player.hack.total);
      prompt = { title: `破解中 ${Math.round(pr * 100)}%`, sub: '按 E 取消', ratio: pr };
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
        const disp = displayUnits(ni);
        const qty = ni.qty > 1 ? ` ×${disp.count}${disp.unit}` : '';
        prompt = { title: `按 E 拾取 ${ni.name}${qty}`, sub: `${money(itemValue(ni))} · ${itemWeight(ni).toFixed(1)}kg` };
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
      const ringed = Number.isFinite(prompt.ratio);
      const shift = ringed ? 18 : 0;
      const cxP = P.x + P.w / 2 + shift;
      ctx.textAlign = 'center';
      panel(P.x, P.y, P.w, P.h, { bracketColor: dfAlpha(DF.accent, 0.7) });
      if (ringed) {
        // 搜刮 / 破解 / 撤离读条：环形进度 + 中央百分比，文字右让，一眼读出还要站多久
        const rc = P.x + (P.compact ? 20 : 24);
        const rr = Math.min(15, P.h / 2 - 4);
        ringProgress(ctx, rc, P.y + P.h / 2, rr, HUD.ring.w, prompt.ratio, DF.accent);
        ctx.fillStyle = COLORS.text; ctx.font = `700 9px ${MONO}`;
        ctx.fillText(`${Math.round(prompt.ratio * 100)}`, rc, P.y + P.h / 2 + 3);
        ctx.strokeStyle = dfAlpha(DF.accent, 0.5); ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(P.x + 44, P.y + 8); ctx.lineTo(P.x + 44, P.y + P.h - 8);
        ctx.stroke();
      }
      ctx.fillStyle = COLORS.text; ctx.font = `600 ${P.compact ? 13 : 15}px ${SANS}`;
      ctx.fillText(prompt.title, cxP, P.y + P.titleDY);
      if (prompt.sub) {
        ctx.fillStyle = COLORS.dim; ctx.font = `10px ${SANS}`;
        ctx.fillText(prompt.sub, cxP, P.y + P.subDY);
      }
    }

    // 准星（随 ADS 收窄）
    const cy = H / 2;
    // 后坐的水平漂移必须如实画进准星：弹道 yaw = angle + recoilOffset，而相机 yaw 只取 angle。
    // 这个差值不画出来，就成了「准星没动、子弹却飘」的隐形惩罚。
    // 竖直方向无需处理 —— recoilPitch 已计入相机 pitch（aim punch），视线与弹道本就同步。
    const roRad = player.recoilOffset || 0;
    // 开镜进度：FOV / 准星基础宽度 / 扩散放大全部走同一个 adsT（P4-C2），
    // 否则开镜瞬间准星会先跳一下再跟着枪模渐变，观感割裂。
    const adsT = Math.max(0, Math.min(1,
      player.adsT != null ? player.adsT : (player.ads ? 1 : 0)));
    const fovNow = VIEW3D.fov + (VIEW3D.fovAds - VIEW3D.fov) * adsT;
    const halfV = (fovNow * Math.PI) / 360;
    const tanHalfH = Math.tan(halfV) * (W / Math.max(1, H)); // 水平半视角正切
    const roPx = roRad && tanHalfH > 1e-6 ? (Math.tan(roRad) / tanHalfH) * (W / 2) : 0;
    const cx = W / 2 + roPx;
    // 准星：随武器实际扩散 / 连射累积而张开（命中率反馈），ADS 时收紧、
    // 开火与连射时明显外扩，抬枪期间也略微张开。
    const wpn = player.currentWeapon;
    let spread = 9 + (4 - 9) * adsT;
    if (wpn && wpn.def) {
      const maxSpread = wpn.def.spreadMax || 0;
      const cur = Math.min(maxSpread, (wpn.def.spread || 0) + (wpn.spread || 0));
      const bloom = maxSpread > 0 ? cur / maxSpread : 0;
      spread += bloom * (COMBAT.crosshairBloom + (COMBAT.crosshairBloomAds - COMBAT.crosshairBloom) * adsT);
    }
    // 命中强度（0~1）：命中标记与准星染红共用，避免两套计时
    const hitA = world.hitMarker > 0 ? Math.min(1, world.hitMarker / 0.12) : 0;

    // 准星（P1-11）：先铺一层深色描边再画前景。
    // 夜战整体提亮后（hemi 26 / ambient 17），纯白准星在亮雾、天空、头灯亮区会"融"进背景，
    // 而瞄准极度依赖准星，所以必须保证任意背景都可读。
    ctx.beginPath();
    ctx.moveTo(cx - spread - 8, cy); ctx.lineTo(cx - spread, cy);
    ctx.moveTo(cx + spread, cy); ctx.lineTo(cx + spread + 8, cy);
    ctx.moveTo(cx, cy - spread - 8); ctx.lineTo(cx, cy - spread);
    ctx.moveTo(cx, cy + spread); ctx.lineTo(cx, cy + spread + 8);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 4.5;
    ctx.stroke();
    // 命中瞬间准星由白转红（与红 X 叠加），强化"这一枪进了"
    const cg = Math.round(255 - 178 * hitA);
    ctx.strokeStyle = hitA > 0 ? `rgba(255,${cg},${cg},0.95)` : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineCap = 'butt';

    // 命中标记（P1 分级 + P4-C3 形态分级 + V-02 穿透分级）：先描黑边，再按档位上色 + 短码标签。
    // 形态也分级，而不只是换颜色：颜色在烟雾/血迹/夜战里会被吞掉，形状不会。
    //   普通 = X；护甲 = X + 四角框；弹开 = 方框 + 横杠；半穿 = 上下短横；
    //   击穿 = 菱形；爆头 = 圆环 + 小 X；击杀 = 大 X + 外扩环。
    if (hitA > 0) {
      const kind = (world.hitKindT || 0) > 0 ? world.hitKind : '';
      const HITC = {
        normal: { c: DF.text, t: HUD.hit.labels.normal },
        armor: { c: DF.dim, t: HUD.hit.labels.armor },
        blocked: { c: DF.text, t: HUD.hit.labels.blocked },
        partial: { c: DF.dim, t: HUD.hit.labels.partial },
        penetrated: { c: DF.accent, t: HUD.hit.labels.penetrated },
        head: { c: DF.accent, t: HUD.hit.labels.head },
        kill: { c: DF.danger, t: HUD.hit.labels.kill },
      };
      const hk = HITC[kind] || HITC.normal;
      const kt = Math.min(1, (world.hitKindT || 0) / HUD.hit.life); // 1 → 0 淡出
      const s = kind === 'kill' ? 9 : 7;
      ctx.beginPath();
      ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
      ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = dfAlpha(hk.c, hitA); ctx.lineWidth = 2.5;
      ctx.stroke();

      if (kind === 'armor') {
        // 四角框：与矩形准星"护甲条"同一套视觉语言，靠形状说明"打的是壳"
        const q = 11;
        ctx.beginPath();
        ctx.moveTo(cx - q, cy - q + 4); ctx.lineTo(cx - q, cy - q); ctx.lineTo(cx - q + 4, cy - q);
        ctx.moveTo(cx + q - 4, cy - q); ctx.lineTo(cx + q, cy - q); ctx.lineTo(cx + q, cy - q + 4);
        ctx.moveTo(cx + q, cy + q - 4); ctx.lineTo(cx + q, cy + q); ctx.lineTo(cx + q - 4, cy + q);
        ctx.moveTo(cx - q + 4, cy + q); ctx.lineTo(cx - q, cy + q); ctx.lineTo(cx - q, cy + q - 4);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3.5; ctx.stroke();
        ctx.strokeStyle = dfAlpha(hk.c, hitA); ctx.lineWidth = 1.5; ctx.stroke();
      } else if (kind === 'blocked') {
        // 弹开：实心方框 + 中央横杠，读作"被板子挡住了"
        const q = 12;
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4;
        ctx.strokeRect(cx - q, cy - q, q * 2, q * 2);
        ctx.strokeStyle = dfAlpha(hk.c, hitA); ctx.lineWidth = 1.6;
        ctx.strokeRect(cx - q, cy - q, q * 2, q * 2);
        ctx.beginPath(); ctx.moveTo(cx - 7, cy); ctx.lineTo(cx + 7, cy);
        ctx.lineWidth = 2.4; ctx.stroke();
      } else if (kind === 'partial') {
        // 半穿：上下两道短横，读作"进去了一半"
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy - 11); ctx.lineTo(cx + 9, cy - 11);
        ctx.moveTo(cx - 9, cy + 11); ctx.lineTo(cx + 9, cy + 11);
        ctx.stroke();
        ctx.strokeStyle = dfAlpha(hk.c, hitA); ctx.lineWidth = 1.8; ctx.stroke();
      } else if (kind === 'penetrated') {
        // 击穿：菱形，读作"穿过去了"
        const q = 12;
        ctx.beginPath();
        ctx.moveTo(cx, cy - q); ctx.lineTo(cx + q, cy); ctx.lineTo(cx, cy + q); ctx.lineTo(cx - q, cy);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4; ctx.stroke();
        ctx.strokeStyle = dfAlpha(hk.c, hitA); ctx.lineWidth = 1.8; ctx.stroke();
      } else if (kind === 'head') {
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4; ctx.stroke();
        ctx.strokeStyle = dfAlpha(hk.c, hitA); ctx.lineWidth = 2; ctx.stroke();
      } else if (kind === 'kill') {
        // 外扩环：半径随剩余寿命从 13 扩到 27 并淡出 —— 只有击杀才有"向外炸开"的动作
        const grow = 1 - kt;
        const r = 13 + grow * 14;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = dfAlpha(hk.c, Math.max(0, kt * 0.9));
        ctx.lineWidth = Math.max(1, 3 * kt);
        ctx.stroke();
      }

      if (kind) {
        const a = Math.min(1, (world.hitKindT || 0) / HUD.hit.life);
        ctx.globalAlpha = a;
        ctx.textAlign = 'center'; ctx.font = `700 10px ${MONO}`;
        ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 3;
        ctx.strokeText(`▸ ${hk.t}`, cx, cy - spread - 18);
        ctx.fillStyle = hk.c;
        ctx.fillText(`▸ ${hk.t}`, cx, cy - spread - 18);
        ctx.globalAlpha = 1;
      }
    }

    // 受击红色晕影
    if (player.hurtFlash > 0) {
      const a = Math.min(0.5, (player.hurtFlash / 0.3) * 0.5);
      const g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.3, cx, cy, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, `rgba(255,0,0,${a})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    // 流血脉冲（P7）：持续掉血不能只靠血条数字，边缘要一直“心跳”提醒玩家止血。
    // 用 world.time 驱动，不额外维护计时器；层数越高越明显。
    const bleedStacks = (player.conditions && player.conditions.bleed) || 0;
    if (bleedStacks > 0) {
      const pulse = 0.62 + 0.38 * Math.sin((world.time || 0) * 4.2);
      const a = Math.min(0.34, (0.08 + bleedStacks * 0.07) * pulse);
      const bg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.34, cx, cy, Math.max(W, H) * 0.72);
      bg.addColorStop(0, 'rgba(180,0,0,0)');
      bg.addColorStop(1, `rgba(190,10,10,${a})`);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }

    // 受击方向提示（P1-6）：全屏红晕只说明"掉血了"，这里补上"从哪边打的"。
    // 把「玩家 → 伤害来源」的方位角投影到屏幕边缘：0 = 正前方（顶边）、±π = 背后（底边）、
    // 正值偏右。与红晕叠加、0.6s 线性淡出。
    if (world.hitDirT > 0) {
      let off = (world.hitDir || 0) - (player.yaw || 0);
      while (off > Math.PI) off -= Math.PI * 2;
      while (off < -Math.PI) off += Math.PI * 2;
      const a = Math.min(1, world.hitDirT / HITDIR.life);
      const rx = W * HITDIR.radiusX;
      const ry = H * HITDIR.radiusY;
      // 椭圆参数角：点 (rx*sin(off), -ry*cos(off)) 对应的中心角
      const ang = Math.atan2(-Math.cos(off), Math.sin(off));
      ctx.save();
      ctx.beginPath();
      if (typeof ctx.ellipse === 'function') {
        ctx.ellipse(cx, cy, rx, ry, 0, ang - HITDIR.span, ang + HITDIR.span);
      } else {
        ctx.arc(cx, cy, Math.min(rx, ry), ang - HITDIR.span, ang + HITDIR.span);
      }
      ctx.lineCap = 'round';
      // 外层柔光 + 内层实心：暗场里也能一眼看到方向
      ctx.strokeStyle = `rgba(255,60,60,${0.32 * a})`;
      ctx.lineWidth = HITDIR.width * 2.1;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,120,110,${0.95 * a})`;
      ctx.lineWidth = HITDIR.width;
      ctx.stroke();
      ctx.restore();
    }

    // 震撼弹白屏（P5）：整屏过曝 + 一圈向内收的暗边，读起来是"眼睛被打懵了"，
    // 而不是普通受击红晕。alpha 直接跟剩余时间走，不做缓动 —— 白屏要"硬"，缓出会显得温柔。
    if (world.flashT > 0) {
      const a = Math.min(1, world.flashT / ABILITY.flashScreen);
      ctx.fillStyle = `rgba(255,253,246,${0.86 * a})`;
      ctx.fillRect(0, 0, W, H);
      const rg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.2, cx, cy, Math.max(W, H) * 0.62);
      rg.addColorStop(0, 'rgba(255,255,255,0)');
      rg.addColorStop(1, `rgba(20,24,32,${0.55 * a})`);
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }

    // 首领阶段切换闪光（P17）：红橙过曝 + 收束暗边，读起来是"首领暴怒/变身"，
    // 与震撼弹白屏区分开。alpha 跟剩余时间走（不缓动，要"硬"）。bossFlashT 由 main 置位。
    if (world.bossFlashT > 0) {
      const a = Math.min(1, world.bossFlashT / 0.55);
      ctx.fillStyle = `rgba(255,176,92,${0.5 * a})`;
      ctx.fillRect(0, 0, W, H);
      const rg = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.18, cx, cy, Math.max(W, H) * 0.66);
      rg.addColorStop(0, 'rgba(255,120,40,0)');
      rg.addColorStop(1, `rgba(120,8,0,${0.5 * a})`);
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }

    // P22 玩家压制：被火力压住时四周收紧的血色暗角。
    // 只读 player.suppression（0 = 完全不画），所以未接火时视觉与旧版逐像素一致。
    const sup = player.suppression || 0;
    if (sup > 0.01) {
      const gkey = `${W}x${H}`;
      if (!hudSupGrad || hudSupGradKey !== gkey) {
        const g = ctx.createRadialGradient(
          cx, cy, Math.min(W, H) * 0.26,
          cx, cy, Math.max(W, H) * 0.62,
        );
        g.addColorStop(0, 'rgba(120,10,12,0)');
        g.addColorStop(0.72, 'rgba(120,10,12,0.55)');
        g.addColorStop(1, 'rgba(152,14,16,1)');
        hudSupGrad = g;
        hudSupGradKey = gkey;
      }
      // 呼吸感：alpha 随压制值轻微起伏，读起来是"心跳顶着眼眶"而不是静态滤镜
      const breathe = 1 + Math.sin((world.time || 0) * (COMBAT.playerSuppression?.breatheHz || 1.7) * Math.PI * 2) * 0.12;
      ctx.save();
      ctx.globalAlpha = Math.min(1, suppressionVignette(sup) * breathe);
      ctx.fillStyle = hudSupGrad;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    if (paused) {
      ctx.fillStyle = dfAlpha(DF.bg, 0.55); ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center'; ctx.fillStyle = COLORS.text; ctx.font = `700 24px ${SANS}`;
      ctx.fillText('已暂停', W / 2, H / 2);
    }
  }

  return {
    show,
    /** P11 视觉层入口：撤离 / 阵亡过场。纯展示，不写存档与统计，供探针/调试重放取证。 */
    playTransition,
    renderHud,
    clearHud,
    /** B3 探针读口：HUD 缓存命中真值（tap 写入次数 / 小地图底图烘焙次数） */
    hudPerf() {
      return {
        tapWrites: hudState.perf.tapWrites,
        mmBakes: hudState.perf.mmBakes,
        mmBase: !!hudState.mmBase,
        cachedNodes: Object.keys(hudState.hudNodes).length,
      };
    },
    /** P1 探针读口：小地图缩放档、命中区、低血量状态（只读，不写游戏状态） */
    hudDebug() {
      const p = hudState.lastPlayer;
      const w = p && p.currentWeapon;
      const ammo = w ? ITEMS[w.ammoId] || ITEMS[w.def.ammoItem] : null;
      return {
        zoom: HUD.minimap.zoomSteps[hudState.mmZoom],
        zoomIndex: hudState.mmZoom,
        mmHit: hudState.mmHit,
        lowHp: lastLowHp,
        // P7 只读快照：探针要验证 HUD 真的拿到了弹种/医疗状态，而不是只改了逻辑层
        ammoId: w ? (w.ammoId || w.def.ammoItem) : null,
        ammoPen: ammo && ammo.pen != null ? ammo.pen : null,
        ammoGrade: ammo ? ammo.gradeName : null,
        bleed: p && p.conditions ? p.conditions.bleed : 0,
        fracture: p && p.conditions ? p.conditions.fracture : 0,
        helmet: p ? Math.ceil(p.helmet || 0) : 0,
        maxHelmet: p ? Math.ceil(p.maxHelmet || 0) : 0,
        // P19：动作状态机快照（探针用它验证「冲刺后不能立刻精准开火」等规则真的生效）。
        combat: p ? p.combatState : null,
        sprintLock: p ? p.sprintLock : 0,
        switchTimer: p ? p.switchTimer : 0,
        leanT: p ? p.leanT : 0,
        // P20：HUD 侧读到的局内目标进度（探针要验证 HUD 与结算同源，不是各算一套）。
        objectives: liveObjectiveRows(hudState.lastWorld).map((o) => ({
          id: o.id, tier: o.tier, kind: o.kind,
          progress: o.state ? o.state.progress : 0,
          target: o.state ? o.state.target : o.target,
          done: Boolean(o.state && o.state.done),
        })),
      };
    },
    toast,
    toggleTasks,
    isTasksOpen,
    renderCodex,
    renderOperators,
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
    /** P3：把钳制后的调色值同步回三根滑条与读数（存档恢复 / 重置后调用） */
    updateGradeLabels(grade) {
      if (!grade || typeof grade !== 'object') return;
      for (const key of ['exposure', 'contrast', 'saturation']) {
        const v = Number(grade[key]);
        if (!Number.isFinite(v)) continue;
        const el = q(`grade-${key}-val`);
        if (el) el.textContent = v.toFixed(2);
        const slider = q(`grade-${key}`);
        if (slider && Math.abs(Number(slider.value) - v) > 1e-6) slider.value = String(v);
      }
    },
    renderMenu,
    renderLoadout,
    renderUpgrades,
    renderStash,
    renderShop,
    renderCareer,
    renderConsign,
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
    /**
     * 当前选中的地图 id。
     *
     * 以 UI 的 active 卡片为唯一真值源（而不是让 main 再存一份）：
     * 选图是纯 UI 状态，刷新/重建 UI 后不会出现"main 记着 A、界面高亮 B"的错位。
     * 找不到 active（旧 DOM / 测试桩）时回落到默认图，保证部署永远有合法地图。
     * @returns {string} 地图 id
     */
    getMap() {
      const active = root.querySelector('[data-map].active');
      return (active && active.dataset.map) || DEFAULT_MAP_ID;
    },
    /**
     * 切换选图高亮。只改 class 与 aria-pressed，不触发生成 ——
     * 生成发生在点"部署"时，避免每次点卡片都白算一张图。
     * @param {string} id 地图 id
     * @returns {void}
     */
    setMap(id) {
      const cards = root.querySelectorAll('[data-map]');
      for (const card of cards) {
        const on = card.dataset.map === id;
        card.classList.toggle('active', on);
        card.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
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
      if (lootUI.isOpen()) lootUI.close();
    },
    /* ---------------- P18 双栏搜刮 ---------------- */
    /** 打开双栏搜刮界面（main 构造好 LootableEntity 与 player gear 后调用）。 */
    openLootGrid(entity, gear, opts) { lootUI.open(entity, gear, opts); },
    closeLootGrid() { lootUI.close(); },
    isLootGridOpen() { return lootUI.isOpen(); },
    /** 转发键盘事件；返回 true 表示已被搜刮面板消费。 */
    lootGridKey(key, ev) { return lootUI.onKey(key, ev); },
    /** 供探针读取当前双栏上下文（不改变数据）。 */
    lootGridContext() { return lootUI.getContext(); },
    lootGridRender() { lootUI.render(); },
  };
}

/** 供外部复用的敌人类型展示名 */
export const ENEMY_LABELS = Object.values(ENEMY_TYPES).map((t) => t.name);
/** 评分等级表 */
export const RATING_TABLE = SCORING.ratings;
