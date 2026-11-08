# LIMITS.md · P1 限制清单化（L01–L35）

> 本文件只做「清单化」：把既有源码里的体验限制逐条登记为可参数化条目，供 `src/openall/` 的声明式配置与 P3 构建期 patch 层消费。**本阶段不改任何既有源码**；`value` 是解除后目标值，`noOpenallValue` 是原版值（`--no-openall` 回退对照用）。
>
> 常量口径：`CARDS=17 / ENTRIES=17 / INDEPENDENT_LOGIC=16`。
> 其中 `circuit-lab`(`lab`) 与 `lab-sandbox` 同源、共用一份逻辑（详见 `PROVENANCE.md`），故 17 个入口只有 16 份独立逻辑；分组配置文件也按 16 份产出。
>
> 路径口径：`future-light` 的源码目前仍在外部 `D:/Projects/FUTURE-LIGHT/src/`，ROOT 下 `future-light/` 目录稍后才建；本文件统一写「未来 ROOT 相对路径」，并在每条注明当前外部等价路径。其余条目路径均为 ROOT 相对路径。
>
> `kind`：`const`（数值/结构常量上限）、`guard`（运行时门禁/解锁判定）、`ui`（隐藏/调试入口，12 条）。
>
> `anchor: null` 说明：本清单有 **2 条**在源码里找不到确切锚点，已如实标注并附原因，未编造行号；对应 `openall.json` 里 `anchor` 为 `null` 且 `manual: true`，由 P3 人工补锚点。其余 33 条 anchor 均为源码里可 Grep 到的确切字符串片段。

---

## 一、future-light（未来之光 · 脑力合集）

### L01 · future-light · 线性关卡锁 + 渐进解锁（lv 门槛）
- 限制描述：大厅点卡片只能进入「当前已解锁关」，通关后 `level + 1` 逐关解锁；没有跨关直入能力。
- 源文件相对路径:行号：`future-light/src/core/shell.js:53`、`future-light/src/core/shell.js:153`、`future-light/src/core/store.js:70`（当前外部：`D:/Projects/FUTURE-LIGHT/src/core/shell.js:53,153`、`store.js:70`）
- 当前代码证据（<=6 行）：
  ```js
  // shell.js:53
  c.onclick = () => startGame(c.dataset.id, store.getUnlocked(c.dataset.id));
  // shell.js:153
  store.setUnlocked(id, level + 1);
  // store.js:70
  getUnlocked(id) { return data.unlocked[id] || 1; },
  ```
- `kind`: `guard`
- 解除后的目标值（`value`）：`全关卡可直接进入（unlocked=999，无 lv 门槛）`
- 原版值（`noOpenallValue`）：`默认从第 1 关起，通关仅解锁 level+1`
- `anchor`: `store.setUnlocked(id, level + 1)`
- `target`: `{ file: "future-light/src/core/shell.js", symbol: "setUnlocked" }`

### L02 · future-light · 无选关 UI
- 限制描述：大厅只渲染「游戏卡片」，不存在任何关卡选择器；玩家无法主动指定 level。
- 源文件相对路径:行号：`anchor: null`（缺失性事实，源码中不存在定义「无选关」的代码行；只能由 `shell.js:38-53` 的 lobby 渲染间接推断）
- 当前代码证据（<=6 行）：
  ```js
  // future-light/src/core/shell.js:38-47（仅渲染 game-card，无 level 选择器）
  ${games.map(g => {
    const lv = store.getUnlocked(g.id);
    const lvTxt = lv > 1 ? `已解锁 第 ${lv} 关` : '点击开始';
    return `<button class="game-card" data-id="${g.id}">
  ```
- `kind`: `guard`
- 解除后的目标值（`value`）：`提供选关 UI（1..maxLevel 任意关）`
- 原版值（`noOpenallValue`）：`无选关 UI`
- `anchor`: `null` — 原因：这是「缺失」而非「常量/门禁」，源码无对应锚点行；P3 需在新增的选关面板里补锚点。
- `target`: `{ file: "future-light/src/core/shell.js", symbol: "renderLobby" }`
- `manual`: `true`

### L03 · future-light · 各游戏 maxLevel 10~30 封顶 + dual 得分封顶 500
- 限制描述：8 款小游戏 `maxLevel` 分别封顶 10/12/30；`dual` 单局得分被 `Math.min(500, …)` 钳住。
- 源文件相对路径:行号：`future-light/src/core/contract.js:11`、`src/games/connect.js:202`(30)、`conveyor.js:477`(10)、`dual.js:271`(12)、`light.js:234`(10)、`match3.js:365`(30)、`nonogram.js:118`(30)、`octagram.js:108`(30)、`stroop.js:85`(30)、`dual.js:218`(500)
- 当前代码证据（<=6 行）：
  ```js
  // contract.js:11
  //   maxLevel: number,        // 最大关卡数
  // connect.js:202 / stroop.js:85
  maxLevel: 30,
  // dual.js:2 / dual.js:218
  // 分数 = 金币×10 + 存活秒×2 + 连击奖励，上限 500
  const score = Math.min(500, (this.coins || 0) * 10 + Math.floor(this.survived) * 2 + Math.min(200, this.comboBonus));
  ```
- `kind`: `const`
- 解除后的目标值（`value`）：`maxLevel=999，得分上限取消（∞）`
- 原版值（`noOpenallValue`）：`maxLevel 10~30，dual 得分上限 500`
- `anchor`: `Math.min(500, (this.coins || 0) * 10`
- `target`: `{ file: "future-light/src/core/contract.js", symbol: "maxLevel" }`

### L04 · future-light · `window.__cv` 隐藏调试出口
- 限制描述：`conveyor` 挂载时把内部实例挂到 `window.__cv` 供无头探针读取，普通玩家不可见。
- 源文件相对路径:行号：`future-light/src/games/conveyor.js:490`
- 当前代码证据（<=6 行）：
  ```js
  mount(root, api) {
    const inst = new Conveyor(root, api);
    // 调试/自动化钩子：供无头探针读取内部状态（不影响玩法）
    if (typeof window !== 'undefined') window.__cv = inst;
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（显式暴露，默认关闭）`
- 原版值（`noOpenallValue`）：`仅隐藏全局钩子 window.__cv`
- `anchor`: `window.__cv = inst;`
- `target`: `{ file: "future-light/src/games/conveyor.js", symbol: "__cv" }`

---

## 二、brain-gym（脑力训练场，id=gym）

### L05 · gym · 12 关卡锁 + 每日 3 款
- 限制描述：所有游戏统一 12 关逐关解锁（`LEVELS_PER_GAME=12`）；每日挑战每天只从池子里抽 3 款。
- 源文件相对路径:行号：`brain-gym/index.html:1539`、`brain-gym/index.html:1548`、`brain-gym/index.html:1570`、`brain-gym/index.html:1600`、`brain-gym/index.html:1198`
- 当前代码证据（<=6 行）：
  ```js
  var LEVELS_PER_GAME=12;                                 // :1539
  function lvUnlocked(id){var v=+(S.getItem(lvKey(id))||1);...return Math.min(LEVELS_PER_GAME,v)}  // :1548
  p.appendChild(h('div','hint','🗺 选择关卡（1~'+LEVELS_PER_GAME+'）：'));   // :1600
  for(var i=0;i<3;i++){var k=Math.floor(rnd()*pool.length);out.push(pool.splice(k,1)[0])}  // :1198
  ```
- `kind`: `const`
- 解除后的目标值（`value`）：`12 关全开，每日款数不限（全池开放）`
- 原版值（`noOpenallValue`）：`12 关逐关解锁 / 每日 3 款`
- `anchor`: `var LEVELS_PER_GAME=12;`
- `target`: `{ file: "brain-gym/index.html", symbol: "LEVELS_PER_GAME" }`

### L06 · gym · 20 秒定级 + 每月一次重定级
- 限制描述：首次进入强制 20 秒定级；重新定级需距上次 ≥30 天。
- 源文件相对路径:行号：`brain-gym/index.html:4875`、`brain-gym/index.html:4893`、`brain-gym/index.html:4900`、`brain-gym/index.html:4956`、`brain-gym/index.html:7483`
- 当前代码证据（<=6 行）：
  ```js
  /* P1-8 开场 20 秒定级：六维各一项，每项约 3 秒 */   // :4875
  /* 一个月可重新定级一次 */                              // :4893
  return Math.round((c-a)/86400000)>=30;                 // :4900
  var pp=overlayPanel('🎯 20 秒定级');                   // :4956
  toast('每月只能重新定级一次，下个月再来')                // :7483
  ```
- `kind`: `guard`
- 解除后的目标值（`value`）：`定级可跳过/随时重定级，间隔 0`
- 原版值（`noOpenallValue`）：`首次 20 秒定级，重定级间隔 30 天`
- `anchor`: `Math.round((c-a)/86400000)>=30`
- `target`: `{ file: "brain-gym/index.html", symbol: "baseCanReTest" }`

### L07 · gym · 皮肤金币 120~200 + 条件解锁 + bt_resume 24h 时限
- 限制描述：6 款皮肤定价 120/120/150/160/180/200 金币；另 2 款需达成 `SKIN_UNLOCK` 条件才可用；「继续上次」快照 `bt_resume` 仅 24 小时内有效。
- 源文件相对路径:行号：`brain-gym/index.html:7762-7767`、`brain-gym/index.html:1530`、`brain-gym/index.html:7861`、`brain-gym/index.html:1158-1159`
- 当前代码证据（<=6 行）：
  ```js
  neon:{name:'⚡ 霓虹',price:120,...}      // :7762
  checker:{name:'♟️ 棋盘',price:200,...}   // :7767
  var SKIN_UNLOCK={ retro:{...}, checker:{...} };   // :1530
  if(SKIN_UNLOCK[k]){if(SKIN_UNLOCK[k].chk()){...}else{🔒 ...}}  // :7861
  if(o&&o.id===id&&Date.now()-o.t<86400000)return o               // :1159
  ```
- `kind`: `guard`
- 解除后的目标值（`value`）：`皮肤/道具免费且全解锁，条件解锁恒真，resume 无时限`
- 原版值（`noOpenallValue`）：`皮肤 120~200 金币，2 款条件解锁，bt_resume 24h`
- `anchor`: `price:120`
- `target`: `{ file: "brain-gym/index.html", symbol: "SKINS/SKIN_UNLOCK/bt_resume" }`

### L08 · gym · `?game=` 街机直达
- 限制描述：`?game=<id>` 直接启动街机，跳过首页与首次定级，属隐藏入口。
- 源文件相对路径:行号：`brain-gym/index.html:3141`、`brain-gym/index.html:7887`、`brain-gym/index.html:7889`
- 当前代码证据（<=6 行）：
  ```js
  /* 街机直达参数：?game=<id>（合法 id 见 ARCADE）；非法/缺失一律忽略 */
  var wantGame=(function(){try{return new URLSearchParams(location.search).get('game')}catch(e){return null}})();
  if(wantGame && ARCADE_SET && ARCADE_SET[wantGame] && GAMES[wantGame]){ openGame(GAMES[wantGame], true); }
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（入口显式可见）`
- 原版值（`noOpenallValue`）：`仅隐藏深链 ?game=<id>`
- `anchor`: `?game=<id>`
- `target`: `{ file: "brain-gym/index.html", symbol: "wantGame" }`

### L09 · gym · `LEVEL_EXEMPT` 关卡系统豁免
- 限制描述：`LEVEL_EXEMPT` 让指定游戏绕过 12 关体系，属硬编码调试白名单。
- 源文件相对路径:行号：`brain-gym/index.html:1554`、`brain-gym/index.html:1599`
- 当前代码证据（<=6 行）：
  ```js
  /* 第三批：明确豁免关卡系统的游戏——不显示 12 关选关面板 */
  var LEVEL_EXEMPT={tomato:1};
  if(!LEVEL_EXEMPT[g.id]){
    p.appendChild(h('div','hint','🗺 选择关卡（1~'+LEVELS_PER_GAME+'）：'));
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（豁免表可编辑）`
- 原版值（`noOpenallValue`）：`硬编码 LEVEL_EXEMPT={tomato:1}`
- `anchor`: `var LEVEL_EXEMPT={tomato:1};`
- `target`: `{ file: "brain-gym/index.html", symbol: "LEVEL_EXEMPT" }`

---

## 三、one-card（一世一牌，id=card）

### L10 · card · 23 局才全解锁（23 卡 / 18 遗物）+ 手牌 5 / 能量 3 / 3 层 × 4 节点
- 限制描述：封印卡 23 张、封印遗物 18 件，每局各解 1 个，故 `runs_to_full_unlock=23`；回合结构常量 `HAND_SIZE=5`、`MAX_ENERGY=3`、`FLOORS=3`、`NODES_PER_FLOOR=4` 固定。
- 源文件相对路径:行号：`one-card/config/balance.json:326,328,332`、`one-card/config/constants.js:7,8,40,41,49`、`one-card/config/relics.js:1`、`one-card/config/cards.js:71`
- 当前代码证据（<=6 行）：
  ```js
  HAND_SIZE: 5,            // constants.js:7
  MAX_ENERGY: 3,           // constants.js:8
  FLOORS: 3,               // constants.js:40
  NODES_PER_FLOOR: 4,      // constants.js:41
  // 封印卡 23 张 ... 封印遗物 18 件 ... 全解锁局数 = 23   // constants.js:49
  "runs_to_full_unlock": { "value": 23, ... }             // balance.json:332
  ```
- `kind`: `const`
- 解除后的目标值（`value`）：`全卡/全遗物开局解锁，手牌/能量/层数/节点数可滑杆`
- 原版值（`noOpenallValue`）：`23 局全解锁 / 手牌5 / 能量3 / 3层×4节点`
- `anchor`: `HAND_SIZE: 5,`
- `target`: `{ file: "one-card/config/constants.js", symbol: "HAND_SIZE/FLOORS/runs_to_full_unlock" }`

### L11 · card · ascension 封顶 8 + 每日局固定种子
- 限制描述：通关难度阶梯 `Math.min(8, …)` 封顶 8；每日局由日期派生固定种子 `daily-YYYY-MM-DD` 与固定流派，无法自选。
- 源文件相对路径:行号：`one-card/src/run.js:441`、`one-card/config/balance.json:239`、`one-card/src/run.js:44-45`、`one-card/src/main.js:154`
- 当前代码证据（<=6 行）：
  ```js
  this.meta.ascension = Math.min(8, (this.meta.ascension || 0) + 1);   // run.js:441
  "range": [0, 8],                                                      // balance.json:239
  const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);  // run.js:44
  return { date, arch: DAILY_ARCHS[dayOfYear % DAILY_ARCHS.length], seed: `daily-${date}` };  // run.js:45
  ```
- `kind`: `guard`
- 解除后的目标值（`value`）：`ascension 不封顶且可手动指定，每日种子/流派可改`
- 原版值（`noOpenallValue`）：`ascension 0~8，每日固定 seed= daily-YYYY-MM-DD`
- `anchor`: `Math.min(8, (this.meta.ascension || 0) + 1)`
- `target`: `{ file: "one-card/src/run.js", symbol: "ascension/dailyInfo" }`

### L12 · card · `project.json` 冻结 6 类系统 + `status:pending_user_input`
- 限制描述：`frozen_systems` 明确冻结 F1~F6 六类系统；`meta.status` 仍为 `pending_user_input`，属立项期门禁状态。
- 源文件相对路径:行号：`one-card/config/project.json:141-147`、`one-card/config/project.json:10`、`one-card/config/project.json:20`
- 当前代码证据（<=6 行）：
  ```json
  "status": "pending_user_input",                              // :10
  "frozen_systems": [                                          // :141
    { "id": "F1", "name": "联机 / 排行榜 / 云存档", ... },
    { "id": "F2", "name": "3D 视角 / Three.js 渲染", ... },
    ... F3 / F4 / F5 / F6 ...
  ],
  ```
- `kind`: `guard`
- 解除后的目标值（`value`）：`6 类系统解冻可启用，status 转 playable`
- 原版值（`noOpenallValue`）：`F1~F6 frozen，status=pending_user_input`
- `anchor`: `"frozen_systems": [`
- `target`: `{ file: "one-card/config/project.json", symbol: "frozen_systems/meta.status" }`

### L13 · card · `?seed=` 复现入口
- 限制描述：`?seed=XXX` 覆盖随机种子（优先级高于每日局），仅用于复现与无头测试。
- 源文件相对路径:行号：`one-card/src/main.js:3,141`、`wild/src/main.js:4`
- 当前代码证据（<=6 行）：
  ```js
  // 支持 URL 参数 ?seed=XXX&arch=blade 用于复现问题与无头测试。  // main.js:3
  const seed = params.get('seed') || opts.seed || newSeed();        // main.js:141
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（种子输入框）`
- 原版值（`noOpenallValue`）：`仅隐藏 ?seed= 参数`
- `anchor`: `params.get('seed')`
- `target`: `{ file: "one-card/src/main.js", symbol: "params.seed" }`

### L14 · card · `?arch=` 快捷开局
- 限制描述：`?arch=blade` 绕过标题页直接开局。
- 源文件相对路径:行号：`one-card/src/main.js:432,434`
- 当前代码证据（<=6 行）：
  ```js
  // 快捷入口：?arch=blade 直接开局；?jump=wild 直接开局并跳到荒野节点
  if (params.get('arch') || params.get('jump')) onStartRun(params.get('arch') || 'blade');
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（流派直选）`
- 原版值（`noOpenallValue`）：`仅隐藏 ?arch= 参数`
- `anchor`: `params.get('arch')`
- `target`: `{ file: "one-card/src/main.js", symbol: "params.arch" }`

### L15 · card · `?daily=1` 今日之牌深链
- 限制描述：`?daily=1` 直接进今日之牌；ROOT `index.html` 也登记该深链。
- 源文件相对路径:行号：`one-card/src/main.js:433,435`、`index.html:1129`
- 当前代码证据（<=6 行）：
  ```js
  // 内容批 P1-7：?daily=1 直接进今日之牌（可叠 ?seed= 覆盖种子）
  else if (params.get('daily')) onStartDaily();
  // index.html:1129  deep: '?daily=1'
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（每日局入口显式）`
- 原版值（`noOpenallValue`）：`仅隐藏 ?daily=1 深链`
- `anchor`: `params.get('daily')`
- `target`: `{ file: "one-card/src/main.js", symbol: "params.daily" }`

### L16 · card · `?jump=wild` 跳荒野节点
- 限制描述：`?jump=wild` 直接开局并跳到荒野节点，跳过第 1 层，供手动验收。
- 源文件相对路径:行号：`one-card/src/main.js:347,427,432,436`
- 当前代码证据（<=6 行）：
  ```js
  // 开发/验收用：跳到荒野节点（等价 ?jump=wild）
  // 快捷入口：?arch=blade 直接开局；?jump=wild 直接开局并跳到荒野节点
  if (params.get('jump') === 'wild') jumpWild();
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（任意节点跳转）`
- 原版值（`noOpenallValue`）：`仅隐藏 ?jump=wild 参数`
- `anchor`: `params.get('jump') === 'wild'`
- `target`: `{ file: "one-card/src/main.js", symbol: "params.jump" }`

### L17 · card · `?asc=` 难度阶梯调试覆盖
- 限制描述：`?asc=N` 覆盖本局 ascension，不写回 meta；`balance.json:430` 登记该调试入口。
- 源文件相对路径:行号：`one-card/src/main.js:144`、`one-card/src/run.js:57,208,297`、`one-card/config/balance.json:430`
- 当前代码证据（<=6 行）：
  ```js
  const asc = opts.asc != null ? opts.asc : (params.get('asc') != null ? Number(params.get('asc')) : null);
  this._ascOverride = asc != null ? asc : null;   // 内容批 P1-6：?asc= 调试覆盖
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（ascension 滑杆）`
- 原版值（`noOpenallValue`）：`仅隐藏 ?asc= 参数`
- `anchor`: `params.get('asc')`
- `target`: `{ file: "one-card/src/main.js", symbol: "params.asc" }`

### L18 · card · `?dbg=1` 画布诊断开关
- 限制描述：`?dbg=1` 在画布左下角打印输入/帧率/实体数读数，默认关闭。
- 源文件相对路径:行号：`one-card/src/arena.js:238,1153`、`wild/src/arena.js:1159`、`brain-gym/index.html:3140`
- 当前代码证据（<=6 行）：
  ```js
  // ?dbg=1：把输入/帧率读数画在画布上。
  const DBG = typeof location !== 'undefined' && /[?&]dbg=1\b/.test(location.search);
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（诊断面板）`
- 原版值（`noOpenallValue`）：`仅隐藏 ?dbg=1 参数`
- `anchor`: `dbg=1`
- `target`: `{ file: "one-card/src/arena.js", symbol: "DBG" }`

### L19 · card · `?log=1` 埋点开关
- 限制描述：试玩埋点默认关闭，仅 `?log=1` 或 localStorage flag 才渲染采集控件。
- 源文件相对路径:行号：`one-card/src/logger.js:4`、`one-card/src/main.js:380`、`one-card/src/ui.js:982`、`one-card/config/balance.json:14`
- 当前代码证据（<=6 行）：
  ```js
  //   ① **默认关**：必须显式 ?log=1 或 localStorage flag 才开。  // logger.js:4
  // 试玩埋点（阶段 4 / T2）：默认关闭，只有 ?log=1 或 localStorage 开启时才会有数据。
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（埋点面板）`
- 原版值（`noOpenallValue`）：`仅隐藏 ?log=1 参数`
- `anchor`: `?log=1`
- `target`: `{ file: "one-card/src/logger.js", symbol: "resolveLogEnv" }`

### L20 · card · `window.__ONECARD` 自动化出口
- 限制描述：把 `run/combat/arena/meta/act` 挂到全局，供 `tools/probe-onecard.mjs` 无头跑完整局。
- 源文件相对路径:行号：`one-card/src/main.js:365`、`one-card/src/main.js:384`、`one-card/config/balance.json:508`
- 当前代码证据（<=6 行）：
  ```js
  // 供无头测试与调试使用。
  window.__ONECARD = {
    get run() { return run; },
    get combat() { return combat; },
    get arena() { return arena; },
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（调试面板）`
- 原版值（`noOpenallValue`）：`仅隐藏全局 window.__ONECARD`
- `anchor`: `window.__ONECARD = {`
- `target`: `{ file: "one-card/src/main.js", symbol: "__ONECARD" }`

---

## 四、wild（荒野 WILD）

### L21 · wild · 四阶 0/10/25/50 门槛 + 12 类分阶解锁 + 属性树封顶 50
- 限制描述：`TIERS` 按总属性等级 0/10/25/50 分四阶；13 款皮肤（`skins.js` 12 条带 tier）、装备（`loadout.js`）、英雄（`content.js:513 HEROES`）、称号（`account.js:25 TITLES`）分阶/击杀门槛解锁；属性树 `GROWTH_LVL_CAP=50`。
- 源文件相对路径:行号：`wild/src/content.js:387,399-402`、`wild/src/skins.js:19-32`、`wild/src/loadout.js:60-89`、`wild/src/account.js:25`、`wild/src/meta.js:269`
- 当前代码证据（<=6 行）：
  ```js
  export const GROWTH_LVL_CAP = 50;                    // content.js:387
  export const TIERS = [                               // content.js:399
    { tier: 0, at: 0,  label: '一阶·荒野猎手', ... },
    { tier: 1, at: 10, label: '二阶·荒野游侠', ... },
    { tier: 2, at: 25, label: '三阶·荒野贵胄', ... },
    { tier: 3, at: 50, label: '四阶·荒野之主', ... },
  ];
  ```
- `kind`: `guard`
- 解除后的目标值（`value`）：`四阶/12 类内容全解锁，属性树等级不封顶`
- 原版值（`noOpenallValue`）：`0/10/25/50 四阶门槛，属性树封顶 50`
- `anchor`: `export const TIERS = [`
- `target`: `{ file: "wild/src/content.js", symbol: "TIERS/GROWTH_LVL_CAP" }`

### L22 · wild · 单局 600s + MAX_ENEMIES 220 / MAX_SHOTS 7 / MAX_GEMS 600
- 限制描述：一局硬编码 600_000ms；同屏敌人、弹道、未拾取宝石分别被 220 / 7 / 600 钳住。
- 源文件相对路径:行号：`wild/src/arena.js:51,148,440,450`
- 当前代码证据（<=6 行）：
  ```js
  DURATION_MS: 600_000,     // 一局 10 分钟                    // :51
  MAX_SHOTS: 7,             // 弹道上限                        // :148
  MAX_ENEMIES: 220,         // 同屏敌人上限                    // :440
  MAX_GEMS: 600,            // 未拾取宝石上限                  // :450
  ```
- `kind`: `const`
- 解除后的目标值（`value`）：`单局时长与三上限可滑杆（默认不封顶）`
- 原版值（`noOpenallValue`）：`600s / 220 / 7 / 600`
- `anchor`: `DURATION_MS: 600_000,`
- `target`: `{ file: "wild/src/arena.js", symbol: "ARENA.DURATION_MS/MAX_ENEMIES" }`

### L23 · wild · 商店仅 2/5/8 分钟
- 限制描述：局内「魂火商栈」只在第 120/300/480 秒出现三次。
- 源文件相对路径:行号：`wild/src/shop.js:7,17,18`、`wild/src/arena.js:40`
- 当前代码证据（<=6 行）：
  ```js
  // 出现：第 2 / 5 / 8 分钟各一次（SHOP_TIMES）。          // :7
  /** 商店出现的三个时间点（秒）：第 2 / 5 / 8 分钟。 */     // :17
  export const SHOP_TIMES = [120, 300, 480];                 // :18
  ```
- `kind`: `const`
- 解除后的目标值（`value`）：`商店常驻/随时可开，时间点可配`
- 原版值（`noOpenallValue`）：`仅 120/300/480 秒三次`
- `anchor`: `export const SHOP_TIMES = [120, 300, 480];`
- `target`: `{ file: "wild/src/shop.js", symbol: "SHOP_TIMES" }`

### L24 · wild · `window.WILD` 诊断出口
- 限制描述：局内把 `arena/pilot/seed/bgm` 挂到 `window.WILD`，标题页/结算页为 null。
- 源文件相对路径:行号：`wild/src/main.js:140,272,382,517`
- 当前代码证据（<=6 行）：
  ```js
  window.WILD = { arena, ARENA, pilot: pilotDriver, seed, bgm };   // :272
  // ★ 读 window.WILD 的探针必须自己判空
  window.WILD = null;                                              // :517
  ```
- `kind`: `ui`
- 解除后的目标值（`value`）：`隐藏选项可视化开关（调试面板）`
- 原版值（`noOpenallValue`）：`仅隐藏全局 window.WILD`
- `anchor`: `window.WILD = { arena, ARENA, pilot: pilotDriver, seed, bgm };`
- `target`: `{ file: "wild/src/main.js", symbol: "WILD" }`

---

## 五、其余 10 款游戏的可参数化常量

### L25 · grass-cutter · 同屏杂兵上限 45
- 源文件相对路径:行号：`grass-cutter/src/core/config.js:549`、`grass-cutter/src/game/stage.js:35`
- 当前代码证据（<=6 行）：
  ```js
  MAX_ACTIVE: 45, // ★SPEC 最大同屏杂兵总数上限（动态刷新）
  MAX_ATTACKERS: 35,   // ENEMY_AI :453
  const cap = this.cfg.MAX_ACTIVE;   // stage.js:35
  ```
- `kind`: `const` / 解除后（`value`）：`敌人数上限可滑杆（默认不封顶）` / 原版（`noOpenallValue`）：`45`
- `anchor`: `MAX_ACTIVE: 45,` / `target`: `{ file: "grass-cutter/src/core/config.js", symbol: "STAGE.MAX_ACTIVE" }`

### L26 · raid（soudache） · 单局 480s / 敌人数 8~11 / 精英率 0.26 / 空投 95s
- 源文件相对路径:行号：`soudache/src/config.js:28,38-40,44`、`soudache/src/loot.js:106`
- 当前代码证据（<=6 行）：
  ```js
  duration: 480,          // 单局 8 分钟            // :28
  enemyCountMin: 8,                                 // :38
  enemyCountMax: 11,                                // :39
  eliteChance: 0.26,                               // :40
  airdropDelay: 95,                                // :44
  if (type.lootBonus > 1 && rng.chance(0.6)) {     // loot.js:106 掉落率
  ```
- `kind`: `const` / 解除后（`value`）：`时长/敌人数/精英率/掉落率可滑杆` / 原版（`noOpenallValue`）：`480s / 8~11 / 0.26 / 0.6`
- `anchor`: `duration: 480,` / `target`: `{ file: "soudache/src/config.js", symbol: "MATCH.duration/enemyCount" }`

### L27 · sim（night-shift） · 货架 8/24、移速 3.2、小游戏 30s/60~120
- 源文件相对路径:行号：`night-shift/src/config.mjs:193,194,360,688-690`
- 当前代码证据（<=6 行）：
  ```js
  export const SLOT_COUNT = 8;      // 起始货架格      // :193
  export const SLOT_CAP = 24;       // 单格容量上限    // :194
  export const WALK_SPEED = 3.2;                       // :360
  durationSec: 30, baseSpeed: 60, maxSpeed: 120,      // :688-690
  ```
- `kind`: `const` / 解除后（`value`）：`货架/速度/时长可滑杆，上限解除` / 原版（`noOpenallValue`）：`SLOT_CAP 24 / WALK_SPEED 3.2 / 30s`
- `anchor`: `export const SLOT_CAP = 24;` / `target`: `{ file: "night-shift/src/config.mjs", symbol: "SLOT_CAP/WALK_SPEED" }`

### L28 · paper-maze · 提示冷却 90000ms
- 源文件相对路径:行号：`paper-maze/src/engine.mjs:435,444`
- 当前代码证据（<=6 行）：
  ```js
  export const HINT_STALL_MS = 90000;
  export function hintCountdown(state, now, stallMs = HINT_STALL_MS) {
  ```
- `kind`: `const` / 解除后（`value`）：`提示冷却可配（默认 0）` / 原版（`noOpenallValue`）：`90000ms`
- `anchor`: `export const HINT_STALL_MS = 90000;` / `target`: `{ file: "paper-maze/src/engine.mjs", symbol: "HINT_STALL_MS" }`

### L29 · neon-rhythm · 判定窗 45/90/140ms、难度接近速度 1.75/1.45/1.2
- 源文件相对路径:行号：`neon-rhythm/src/judge.mjs:24,27,49`、`neon-rhythm/src/chart.mjs:31`
- 当前代码证据（<=6 行）：
  ```js
  export const WINDOW_MS = { perfect: 45, great: 90, good: 140 };  // judge.mjs:24
  export const MAX_OFFSET_MS = 200;                                 // :27
  export const APPROACH_BY_DIFFICULTY = { easy: 1.75, normal: 1.45, hard: 1.2 };  // chart.mjs:31
  ```
- `kind`: `const` / 解除后（`value`）：`判定窗/接近速度/评级阈值可滑杆` / 原版（`noOpenallValue`）：`45/90/140ms`
- `anchor`: `export const WINDOW_MS = { perfect: 45, great: 90, good: 140 };` / `target`: `{ file: "neon-rhythm/src/judge.mjs", symbol: "WINDOW_MS" }`

### L30 · pixel-runner · 速度封顶 1180
- 源文件相对路径:行号：`pixel-runner/src/engine.mjs:24,25,26,84`
- 当前代码证据（<=6 行）：
  ```js
  export const BASE_SPEED = 430;        // 起始速度 px/s
  export const SPEED_MAX = 1180;
  export const SPEED_RAMP = 11;         // 每秒加速 px/s
  /** 当前速度（px/s）：随时间线性爬升，封顶 SPEED_MAX。 */
  ```
- `kind`: `const` / 解除后（`value`）：`起速/封顶/加速度可滑杆` / 原版（`noOpenallValue`）：`SPEED_MAX 1180`
- `anchor`: `export const SPEED_MAX = 1180;` / `target`: `{ file: "pixel-runner/src/engine.mjs", symbol: "SPEED_MAX" }`

### L31 · lab（circuit-lab） · 测量容差 0.001 / 0.01 / 0.02
- 源文件相对路径:行号：`circuit-lab/js/experiment-config.js:25,26,35,45,275`
- 当前代码证据（<=6 行）：
  ```js
  { key: 'vmid', label: '中点电压', target: '2.500', unit: 'V', tolerance: 0.001 },
  { key: 'ir2', label: '支路电流', target: '0.0025', unit: 'A', tolerance: 0.01 },
  const score = total > 0 ? Math.round((done / total) * 100) : 0;   // :275
  ```
- `kind`: `const` / 解除后（`value`）：`容差/评分阈值可配，实验数不封顶` / 原版（`noOpenallValue`）：`tolerance 0.001`
- `anchor`: `tolerance: 0.001` / `target`: `{ file: "circuit-lab/js/experiment-config.js", symbol: "tolerance" }`

### L32 · quiz · 薄弱题上限 150 / 在线题量 20 / 网络超时 8000
- 源文件相对路径:行号：`quiz/.build/engine_core.js:814,1027,1028`
- 当前代码证据（<=6 行）：
  ```js
  var WEAK_CAP=150;
  var QA_NET_TIMEOUT=8000;
  var QA_MAIN_URL='https://opentdb.com/api.php?amount=20&type=multiple&encode=url3986';
  ```
- `kind`: `const` / 解除后（`value`）：`薄弱题/题量/超时可配，上限解除` / 原版（`noOpenallValue`）：`WEAK_CAP 150 / amount 20`
- `anchor`: `var WEAK_CAP=150;` / `target`: `{ file: "quiz/.build/engine_core.js", symbol: "WEAK_CAP" }`

### L33 · zhaoyun · 等级 5 / 波数 6 / 手牌 8 / 军营 5 / 阿斗 3 血
- 源文件相对路径:行号：`zhaoyun/src/units.js:18,22-27,40,41,45`
- 当前代码证据（<=6 行）：
  ```js
  const MAX_LEVEL = 5;            // 兵种/武将等级上限
  const BARRACKS_MAX = 5;         // 军营栏 5 槽
  const HAND_MAX = 8;             // 手牌区 8 格
  const ADOU_HP = 3;              // 阿斗血量（三颗红心）
  const LEVEL_WAVES = 6;          // 关卡模式每关波数
  ```
- `kind`: `const` / 解除后（`value`）：`等级/波数/手牌/生命/资源可滑杆` / 原版（`noOpenallValue`）：`MAX_LEVEL 5 / LEVEL_WAVES 6 / ADOU_HP 3`
- `anchor`: `const MAX_LEVEL = 5;` / `target`: `{ file: "zhaoyun/src/units.js", symbol: "MAX_LEVEL/LEVEL_WAVES" }`

### L34 · shanhai · 伤害下限 1、地形防御 1.2~1.35、克制系数 1.3/0.8
- 源文件相对路径:行号：`shanhai/src/core.mjs:24,28,103-105,133`、`shanhai/src/maps.mjs:18,25,51`
- 当前代码证据（<=6 行）：
  ```js
  defense: 1.35,   // 林地 :24      defense: 1.2,  // 山地 :28
  if (CLASS_CYCLE[attackerClass] === defenderClass) return COEFFICIENTS.advantage;
  const raw = attacker.atk * multiplier - defender.def * terrainRules.defense;
  return Math.max(1, Math.round(raw * splashMultiplier));   // :133 伤害下限
  ```
- `kind`: `const` / 解除后（`value`）：`伤害/防御/地形/克制系数可配，关卡星级不封顶` / 原版（`noOpenallValue`）：`伤害下限 1 / 防御 1.2~1.35`
- `anchor`: `return Math.max(1, Math.round(raw * splashMultiplier));` / `target`: `{ file: "shanhai/src/core.mjs", symbol: "computeDamage" }`

### L35 · warehouse-strike · 实验系统 feature flag 默认 false
- 限制描述：AwakeningSystem / PerkSystem / TrapSystem / ThrowSystem / DayNightSystem / Minimap / PostFX 及对应 config/ui 属 `experimental`，收录策略要求 feature flag 默认 `false`。
- 源文件相对路径:行号：`anchor: null`
- 当前代码证据（<=6 行）：`D:/Projects/WAREHOUSE-STRIKE/` 现存 `src/core/AwakeningSystem.js` 等 12 个系统文件，但**源码中不存在 feature flag 常量**；`experimental` 归类与「默认 false」是 P1 的收录策略（见 `PROVENANCE.md`），不是既有代码锚点。
- `kind`: `guard`
- 解除后的目标值（`value`）：`实验系统可视化开关（可显式启用）`
- 原版值（`noOpenallValue`）：`feature flag 默认 false（策略约定）`
- `anchor`: `null` — 原因：外部仓库当前无对应 flag 代码行；P3 需在受控收录层补锚点。
- `target`: `{ file: "warehouse-strike/src/config/flags.js", symbol: "experimental" }`
- `manual`: `true`

---

## 六、统计

- L01–L35 共 **35** 条；`kind` 分布：`const` 15 条、`guard` 8 条、`ui` 12 条。
- 12 条隐藏/调试入口（kind:ui）已全部收敛：`?game=`、`?seed=`、`?arch=`、`?daily=1`、`?jump=wild`、`?asc=`、`?dbg=1`、`?log=1`、`window.__cv`、`window.__ONECARD`、`window.WILD`、`LEVEL_EXEMPT`。
- `anchor: null` 共 **2** 条：L02（无选关 UI，缺失性事实）、L35（外部仓库无 feature flag 代码行）。其余 **33** 条均有确切源码锚点。
- 分组配置：`src/openall/<id>/openall.json` 共 16 份（15 份按游戏分组 + 1 份 `lab-sandbox` 指针），条目数之和 = 35；`enlisten` 网页版为新建、无既有源码限制，0 条且不建分组文件。
