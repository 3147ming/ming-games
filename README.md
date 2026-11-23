
## ✅ 上线状态（2026-11-20 已推送并部署）

| 项 | 结果 |
|---|---|
| 提交 | 四款与修复随 `8566bd0` / `4154bb7` 进 `3147ming/ming-games` master；后续仓库仍在迭代，四款保持在线（复核于 `3ea224d6`） |
| 线上入口 | https://ming-games.pages.dev/ （canonical，Cloudflare Pages 自动构建） |
| 镜像 | https://3147ming.github.io/ming-games/ （GitHub Pages，同源镜像，已验证同步） |
| 快速直达 | `/archer/` `/jigsaw/` `/sleeper/` `/legion/` 四个目录均可直接访问 |
| 大厅卡片 | 32 张（本批新增 4 张；仓库后来重排过顺序，现为 mahjong / sleeper / rulecraft / legion 收尾），封面全部正常显示 |
| 构建 | `node tools/build.mjs --target=all`：31 款 ready 全量出包 |
| 门禁 | `node tools/verify-all.mjs --unit`：6/6 通过；`rulecraft` 单测 20/20 |
| 复核 | 2026-11-22 复验：两站大厅 32 张卡片、「影弓对决 / 喵篮拼图 / 躺平守夜 / 雪国军团」四款直达均 200，首屏无控制台报错 |
| 规则工坊牌类 | 2026-11-25 `4f8f50f5`：牌类模式独立引擎 + 牌面/棋子分层渲染 + 规则页自动生成，两站 `/rulecraft/` 均 37325 B、8 张对照与四步验收全绿 |
| 影弓对决改版 | 2026-11-23 `eaee7fd` / `c7b7881`：主角站桩 + 地面冲刺兵 / 空中远程兵双兵种，两站 `/archer/` 均 99272 B、开局跑通（主角恒在 x=200，空兵入场悬停并吊射扣盾），竖屏补横屏提示 |

### 影弓对决 · 战斗设计（2026-11-23 改版）

- **主角站桩**：锚定在 `PLAYER_HOME = 200`，A/D 与摇杆不再改位置，胜负全看瞄准与出手时机。
- **地面冲刺兵**（tank / boss，可带盾）：地面推进 → 到 `backOff` 外停住蓄力（脚下红色虚线预警）
  → 高速冲刺近战（冲到主角身前才收刀）→ 收刀后退回助跑距离再冲。盾牌正面弹箭、盾破会踉跄。
- **空中远程兵**（normal / fast / double / elite）：从高空侧翼滑入，悬停主角头顶前方吊射，
  被击落后有坠地动画；它们没有盾，怕的是把准星抬起来打。
- **波次重编**：两种兵种交替编成，每波都要在地面与空中之间切换打法。
- **弹道**：重力 1400 → 1150，玩家初速上限 680 → 980，拖动瞄准时按准星反解初速度（指哪打哪）。

### 龙凤棋 / 占位棋 / 地铁跑酷 · AI 与 2.5D 返工（2026-11-24）

用户反馈「占位棋、龙旗 AI 不操作；地铁跑酷是 2.5D；所有 AI 太弱；整体太糙」，逐项返工：

**龙凤棋（dragonchess）—— 三处致命 bug + 搜索型 AI**

| 症状 | 根因 | 修法 |
|---|---|---|
| 整局只有红方能下，AI 永不出手 | `place()` 落子后漏调 `finishTurn(s)`，红方连下 9 手 `placed.r` 满 9 仍不换手 | 补 `finishTurn`，并把 `checkEnd` 提到 place 末尾 |
| 新局第一手就判负 | `checkEnd` 无条件判「某方 0 子即输」，布子初期盘上本就可能没子 | 只在 `phase === 'move'` 判「吃光对方」 |
| 几十手后 `RangeError: Invalid string length` | `clone()` 把 `history` 一起深拷贝，指数膨胀 | clone 剔除 history + 历史上限 60 |
| 成龙后对方全在龙里 → 整局卡死 | `pendingCapture` 的 `choices` 为空时无人清理 | 新增 `skipCapture` 结算路径；页面与 AI 双端兜底 |

新增 `dragonchess/src/ai.mjs`：negamax + α–β + 迭代加深，估值含子力/成龙/双联威胁/内圈位置/机动性，
三档 easy(2 层) / normal(3 层) / hard(5 层)。实测 easy(先手) vs hard(后手) 8 局：hard 5 胜 3 和 0 负。
界面加「提示」按钮（AI 给 3 步建议，金色虚线 + ①②③ 序号）与「思考中…」状态。

**占位棋（territory）—— 从一层贪心换成 α–β**

旧版只看「走完后对手剩几步」，不会算翻子与角位。新版用经典黑白棋估值：
位置权重表（角 120 / 边 -20 / 角旁 -25）+ 稳定子（角邻稳定）+ 机动性 + 奇偶控制，
三档 depth 1/3/5。实测随机应对时 hard 档 25:5 碾压；单步搜索毫秒级。同样加了三档难度 + 提示 + 思考态。

**地铁跑酷（metro-runner）—— 伪 3D 改真 2.5D**

旧 `proj()` 的屏幕 y 与 z 无关（`ground - (ground-horizon)*0`），远近物体贴在同一条水平线上，
等于没有纵深。重写为 `f = FOC/(FOC+z)`，屏幕 y = `hz + (gy-hz)*f - y*f*SX`，z→∞ 全部收敛到地平线。
配套重做：地面三轨凹槽 + 每 1.5 m 枕木按透视滚动、左右侧壁 + 顶灯带形成通道、等距 z 的隧道拱架、
立体列车（车顶/侧面/车头/挡风玻璃/车头灯/顶灯）、路边支柱与广告牌视差、双层天际线。
玩法侧：金币与障碍改「穿越判定」（高速不跳帧）、60% 金币铺在玩家轨道、开局预铺近距离金币、
连击提示、轻点分屏操作、镜头随切轨倾斜。

构建 `node tools/build.mjs --target=all` 通过（metro-runner 42764 B、territory 26678 B），
门禁 `node tools/verify-all.mjs --unit` 6/6 通过。

### 规则工坊 · 牌类模式（2026-11-25）

提交 `4f8f50f5`（`shared/rule-engine.mjs` 65970 B / `shared/art-render.mjs` 14294 B / `rulecraft/index.html` 37325 B）。
用户点名五条：牌类模式、四套牌型表、6 类追问不代填、棋子/牌面美术分层 + 8 张实拍对照、规则页自动生成。
外加四步验收（人机 3–5 手 / 20 局 / 7 项勾检 / 版本 diff）。

**牌类引擎（`shared/rule-engine.mjs`）**

| 症状 | 根因 | 修法 |
|---|---|---|
| 牌类出来是「52 张 / 5 张手牌 / 21 分 / 60 回合」 | `cardConfig` 用 `?? 54 / ?? 5 / ?? 21` 兜底，棋类默认值被当牌类参数 | 缺项一律 `null` 并记进 `missing`；`start()` 见 `missing` 不开局，返回 `reason:'not-ready'` |
| 追问面板「待答 6 项」但照样能生成 | 追问只影响文案，不影响引擎 | `pendingQuestions` 与 `cardConfig.missing` 同源，`pending` 非空时预览与试玩一律拦住 |
| 「三副」「共 126 张」「洗回最多 3 次」识别不到 | 正则要求紧跟数字 | 放宽为 `(\d+|[一二两三四五六])\s*副`、`(?:共|一共|总共)\s*(\d{2,3})\s*张`、`洗(?:回|牌)?\s*(?:最多)?\s*(\d+)\s*次` |
| 「赢家补 6 张其余 3 张」识别不到 | 正则没允许中间那个「补」 | 允许 `补/得/拿/加/给/发` 动词；「名次」一词不再直接代填 6/3/3，必须真写出名次表 |
| 3 / 4 人局有人整局不动 | 一轮结束判定是「所有人都 pass」，最后出牌者也 pass 过就提前收轮 | 改为「除最后出牌者外其余全 pass」 |
| 算分模式一到 1 分就终局 | 每赢一轮 `score+1` 就直接判胜 | 按名次表记分，到目标分才终局；未到则保留分数重新发牌，40 局封顶 |
| 洗回丢牌 | `tryReshuffle` 在牌堆未空时把 `pile` 直接换成 `discard` | 只在 `pile` 空时 `shuffle(pile.concat(discard))` |
| AI 先手必胜 | `movesOf` 把整张 table 传给 `beats`，压牌判定恒假；评分又奖励大牌 | 只传 `table.pattern`；自由出牌时先走小散牌 |
| 「三子连线赢」被读成 3 枚棋子 | 棋子数正则吃掉连线里的数字 | 先剔除 `N 子连线` 短语再匹配棋子数 |

**牌型表**：内置 `doudizhu`（含炸弹 / 王炸）/ `zhengshangyou` / `single` / `custom` 四套，
`patternSet` 默认留空由人指定，回牌验收用斗地主式。

**美术分层（新增 `shared/art-render.mjs`）**

- `renderCardFace`：四角点数（右下倒置）+ 按真扑克点阵摆花（2–10 经典列阵、下半区点翻转）+ JQK 人像框 / A 大花色 / 王竖排。
- `renderCardBack`：菱格纹 / 同心圆 / 斜纹三套，渐变底 + 内框 + 剪裁纹样。
- `renderPiece`：棋类才走这套（圆/方载体 + 环纹 + 角饰 + 字）。
- `contactItems / drawContactCell / artContactSheet`：生成后并排 8 张——牌类固定给 ♠5 ♥10 ♦K ♣A ♠2 + 三套牌背，
  正好把验收清单点名的 5 / 10 / K 摆在第一屏；棋类按棋子类型循环。棋子按格位最短边缩进，不再被切边。

**规则页**：`rulePageHtml` 直接把规则卡 Markdown 逐行转 HTML（标题/引用/列表），没有任何手抄段落，
所以「满天飞写出处」这类附加内容不会自己长回来；「下载规则页 HTML」导出的是同一份。

**验收（四步，全绿）**

1. 人机试玩 5 手：出单张 / 过牌 / 轮转 / 手牌数都对（`a:11 b:12 c:10`，动作序列含炸弹与王炸）。
2. 20 局自对弈：0 卡死，20/20 以「先出完」结束，洗回共 60 次（每局 3 次，正好压在上限）。
3. 7 项勾检：发 10 张 ✓ / 牌堆 126 ✓ / 赢家 6 其余 3 ✓ / 牌堆空洗回 ✓ / 最多 3 次 ✓ / 先出完 ✓ / 5·10·K 点数为「待你定」。
4. 版本与 diff：记下点数后 `v1 → v2`，版本条即时刷新，规则页随版本重渲染。

`rulecraft/tests/rule-engine.test.mjs` 20/20 通过（其中「四类模板都能开局」一条靠补齐简化麻将 / 七对麻将的
`card` 参数才通过——模板是已拍板的预设，参数必须写全，引擎不再替它兜底）。

### 喵篮拼图 · 去掉拼板底图（2026-11-23）

拼板原来在空槽位上铺了一张 `globalAlpha 0.16` 的原图，等于把答案摊在桌面上——
玩家不用看碎片内容，照着底影轮廓找位就行，拼图本身没难度。已删除底影，改为：

- 空槽 = 木色底 + 极浅棋盘错色 + 内凹阴影，只交代「这里有个格子」，不含任何画面信息；
- 拼板尺寸、吸附半径、提示逻辑（💡 3 次，闪一个目标格）均未改动；
- 原图只在选关页与结算页出现，对局中不再泄漏。

### 本次一并修掉的既有缺陷

1. **大厅脚本语法错误**：`index.html` 里 `en: 'Liar's Bar',` 单引号提前终止字符串，
   整个大厅 `<script>` 抛 `SyntaxError`，所有卡片都渲染不出来（线上三个形态全中）。
2. **`soudache/src/storage.js`**：两条 import 之间丢换行（`};import {`），
   `esm-to-classic` 打包抛"非法绑定名"，**全量构建直接失败**。
3. **两个单测 ROOT 写死** `D:/Projects/_github_pages/ming-games`，异地环境必失败，改 `process.cwd()`。

### 本批四款游戏自身的回归修复

jigsaw / legion / sleeper 的全屏弹层缺 `pointer-events`，被 420×720 画布覆盖层拦截，
菜单点不动（自动化点击只落在 canvas 上）。已在 `.ov` 上加 `.pe` 并对 `.ov.on` 加兜底规则。

截图见 `_verify/`。

> 备注：`jigsaw/index.html` 单文件 1.23 MB（12 张插画全内联 base64）。走 GitHub Pages（Fastly）
> 首次拉取约 60 s 且有截断重试，国内网络可能体感"打不开"；走 Cloudflare Pages 正常。
> 想让镜像也秒开，可把底图改为外链文件（每张 ~90 KB），代价是丢掉"单文件双击可玩"。

# ming-games 新增四款游戏 · 资源包与指令总览（完整版 v3）

> 本包用于把视频里的四款小游戏复刻进 `D:\Projects\_github_pages\ming-games\` 大厅。
> 指令按游戏拆成独立块，分别粘贴给 WorkBuddy，**不要合并**。
> 复刻口径：玩法照搬参考视频，美术为本包原创生成素材；不复制原游戏任何贴图、音频、文案代码。
> **本批为完整版**：关卡推进 + 成长系统 + 局外长期存档；四款开始层均有局外面板（解锁进度 / 最佳纪录 / 图鉴），影弓额外做装备跨局背包。

## 一、四款一览

| 序号 | ID / 目录 | 中文名 | 英文 | 标签 | 方向 | 封面 | 完整版内容 |
|---|---|---|---|---|---|---|---|
| 01 | `archer` | 影弓对决 | Shadow Archer | 射击 | 横屏 landscape | `covers/archer.webp` | 5 大关共 20 波，第 20 波终局 Boss；三槽装备**跨局保留** + 词条升级池 + 局外钱包/图鉴/商店 |
| 02 | `jigsaw` | 喵篮拼图 | Cat Basket Jigsaw | 益智 | 竖屏 portrait | `covers/jigsaw.webp` | 12 张底图 × 3 档片数 = 36 关，计步计时评星，图鉴点亮 |
| 03 | `sleeper` | 躺平守夜 | Sleepy Defense | 塔防 | 竖屏 portrait | `covers/sleeper.webp` | 3 房间 × 5 波 = 15 波，末波猎梦者 Boss；**1/2/4 三档倍速**，建筑与炮台扩充 |
| 04 | `legion` | 雪国军团 | Snow Legion | 策略 | 竖屏 portrait | `covers/legion.webp` | 6 关递进，第 3、6 关 Boss 中场；三类敌军，9 项技能池，大招成长 |

## 二、资源落位（WorkBuddy 开工前先放好）

| 包内路径 | 落位到仓库 | 说明 |
|---|---|---|
| `covers/archer.webp` | `covers/archer.webp` | 大厅封面，1280×800 |
| `covers/jigsaw.webp` | `covers/jigsaw.webp` | 大厅封面，780×1040 |
| `covers/sleeper.webp` | `covers/sleeper.webp` | 大厅封面，780×1040 |
| `covers/legion.webp` | `covers/legion.webp` | 大厅封面，780×1040 |
| `jigsaw/art/*.jpg`（12 张） | 仅构建参考；**必须全部转 data URI 内联进 `jigsaw/index.html`** | 拼图底图 900×900；classic 打包不拷外部位图，禁止留相对路径 |
| `refs/*.jpg` | 不进仓库，留作对照 | 视频抽帧：站位、UI 布局、配色、造型参考 |

### 拼图底图清单（`jigsaw/art/`，12 张）

| 文件 | 画面 | 文件 | 画面 |
|---|---|---|---|
| `cat-basket.jpg` | 花篮白猫 | `ocean-fish.jpg` | 海洋小丑鱼 |
| `sunflower-cat.jpg` | 向日葵花田橘猫 | `dessert-rabbit.jpg` | 甜品派对白兔 |
| `rose-squirrel.jpg` | 玫瑰窗台松鼠 | `forest-bug.jpg` | 森林瓢虫蝴蝶 |
| `daisy-rabbit.jpg` | 雏菊野餐白兔 | `snow-village.jpg` | 雪景小镇 |
| `succulent-cat.jpg` | 多肉桌面虎斑猫 | `fruit-basket.jpg` | 水果市集篮 |
| `forest-deer.jpg` | 森林小鹿 | `star-camp.jpg` | 星空露营小鹿 |

## 三、技术形态（四款统一）

- **renderer = classic**：每款一个目录，目录内只有一个自包含 `index.html`（HTML + CSS + JS 全内联，IIFE 包裹，`'use strict'`），与现有 `brick/index.html` 同一范式。
- **零外部依赖**：不引 CDN、不引网络字体、不引外部图片/音频；图形用 Canvas 2D 程序化绘制或内联 SVG；音效用 WebAudio 程序化合成（可静音）。
- **样式基线**：`<link rel="stylesheet" href="../shared/tokens.css">`，主题色在各文件 `:root` 内覆盖。
- **存档分层**：`localStorage` key 前缀 `mg_<id>.v1`；局外长期档（解锁关卡、星级、钱包、背包、图鉴、最佳纪录）与单局进度分开字段，局内死亡不清长期档。
- **适配**：viewport `width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no`；触屏拖拽跟手，同时支持鼠标与键盘；留安全区 `env(safe-area-inset-*)`；无横向滚动溢出。
- **可访问性/降级**：`prefers-reduced-motion` 下关闭动画；控制台零报错；`file://` 双击可玩。
- **性能**：同屏实体走对象池复用；粒子/飘字数量上限；完整版实体增多，注意 60fps，低端机可降级粒子数量。

## 四、大厅接入登记点（四份清单都要加）

### 4.1 `games.json`（构建清单）

`games` 数组末尾追加四条：

```json
{ "id": "archer",   "name": "影弓对决", "dir": "archer",   "cover": "covers/archer.webp",   "tag": "射击", "status": "ready", "renderer": "classic" },
{ "id": "jigsaw",   "name": "喵篮拼图", "dir": "jigsaw",   "cover": "covers/jigsaw.webp",   "tag": "益智", "status": "ready", "renderer": "classic" },
{ "id": "sleeper",  "name": "躺平守夜", "dir": "sleeper",  "cover": "covers/sleeper.webp",  "tag": "塔防", "status": "ready", "renderer": "classic" },
{ "id": "legion",   "name": "雪国军团", "dir": "legion",   "cover": "covers/legion.webp",   "tag": "策略", "status": "ready", "renderer": "classic" }
```

### 4.2 `index.html` 大厅 `GAMES` 数组（卡片清单）

参照现有卡片字段追加四条（`order` 接在现有最大序号之后）：

```js
{
  id: 'archer', name: '影弓对决', en: 'Shadow Archer',
  desc: '紫夜荒原弓手对决：5 大关 20 波推进，装备跨局保留，词条叠加 build，局外商店补强。',
  kw: '弓箭 对决 抛物线 射击 火柴人 关卡 装备 词条 跨局 肉鸽 archery',
  tag: '射击', cover: 'covers/archer.webp', ar: '1280 / 800',
  url: 'archer/', status: 'live', order: 25, orientation: 'landscape',
},
{
  id: 'jigsaw', name: '喵篮拼图', en: 'Cat Basket Jigsaw',
  desc: '12 张治愈插画 × 3 档片数共 36 关：拖拽拼片、限量提示、计步计时评星、图鉴收集。',
  kw: '拼图 益智 猫咪 花篮 花卉 拖拽 关卡 图鉴 jigsaw puzzle',
  tag: '益智', cover: 'covers/jigsaw.webp', ar: '780 / 1040',
  url: 'jigsaw/', status: 'live', order: 26, orientation: 'portrait',
},
{
  id: 'sleeper', name: '躺平守夜', en: 'Sleepy Defense',
  desc: '上床躺平产金币，升级床门建炮台，三个房间 15 波守夜迎战 Boss，支持 1/2/4 倍速。',
  kw: '躺平 塔防 守夜 睡觉 炮台 发育 倍速 boss 关卡 defense',
  tag: '塔防', cover: 'covers/sleeper.webp', ar: '780 / 1040',
  url: 'sleeper/', status: 'live', order: 27, orientation: 'portrait',
},
{
  id: 'legion', name: '雪国军团', en: 'Snow Legion',
  desc: '雪地军团自动推进：6 关递进双 Boss 中场，三类敌军，技能三选一与暴风雪大招成长。',
  kw: '军团 自走棋 塔防 雪地 兵种 大招 技能三选一 boss 关卡 legion',
  tag: '策略', cover: 'covers/legion.webp', ar: '780 / 1040',
  url: 'legion/', status: 'live', order: 28, orientation: 'portrait',
}
```

## 五、构建与验收（全部完成后统一跑）

```bash
node tools/build.mjs --target=all
node tools/verify-all.mjs --unit
```

- classic 产物 HTML 体积不得低于源 `index.html` 的 80%（构建链有护栏，防止内联脚本被剥离）。
- 四款在 `dist/`、`offline/`、根目录三种形态下都能进入游玩；大厅卡片封面不破图。
- 回归：既有 24 款游戏的卡片、存档、构建产物不受影响。

## 六、指令文件

- `instructions/00-总览与大厅接入-WorkBuddy指令.md`：仓库约定、登记步骤、通用验收（先读这份）。
- `instructions/01-影弓对决-archer-WorkBuddy指令.md`
- `instructions/02-喵篮拼图-jigsaw-WorkBuddy指令.md`
- `instructions/03-躺平守夜-sleeper-WorkBuddy指令.md`
- `instructions/04-雪国军团-legion-WorkBuddy指令.md`

## 七、已拍板规格（WorkBuddy 按此实现；数值平衡可在各指令 CONFIG 内微调）

| 项 | 已确认规格 |
|---|---|
| 影弓结构 | 5 大关 × 4 波 = 20 波，第 20 波终局 Boss |
| 影弓局外 | 装备跨局背包 + 局外钱包 + 图鉴；出装三槽带入下一局，当局生效 |
| 拼图关卡 | 12 图 × 3 档（3×3 / 4×4 / 5×5）= 36 关 |
| 躺平波次 | 3 房间 × 5 波 = 15 波，第 15 波 Boss 猎梦者收尾 |
| 倍速档位 | 1× / 2× / 4× 三档（已砍 8×） |
| 军团关卡 | 6 关，第 3 关中场 Boss、第 6 关终局 Boss |
| 局外面板 | 四款开始层均展示长期进度；不做局外永久数值加成 |
| 音效 | WebAudio 程序化合成，可静音 |

## 交付物

| 文件 | 说明 |
|---|---|
| `archer/` `jigsaw/` `sleeper/` `legion/` | 四份自包含 `index.html`（已进仓库，线上直接用这份源文件） |
| `covers/*.webp` | 四张大厅封面 |
| `shared/tokens.css` | 内联版设计令牌（带 var fallback） |
| `ming-games-四款游戏-离线包.zip` | 21 MB，解压双击 `index.html` 即四款大厅，断网可玩 |
| `_verify/*.png` | 线上与构建产物的验收截图 |
| `_dev/` | 内联脚本、可读源 JS、Playwright 冒烟测试 |

### 改版顺带修掉的缺陷（影弓对决）

1. **HUD 层没定位**：`.lay` 只有 `display:block` 没有 `position`，运行时才被 JS 钉过 left/top，
   而画布是 flex 居中的 —— HUD 会先落在页面左上角压住主角。改为 `position:fixed` + `transform-origin:0 0`。
2. **词条无法应用**：`applyTrait` 手写的一长串 getter/setter 漏属性，升级选词条时抛
   `Cannot set properties of undefined`；改用统计对象上的轻量代理，另补 `G.traitApplied` 初始化。
3. **局间商店崩溃**：买走一件后 `shopOffers[i] = null`，`renderInter()` 仍读 `it.price` 抛异常，改为跳过空位。
