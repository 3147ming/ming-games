# 决策记录 · 全项目统一改造（2026-11-08）

本文件是本次改造的**决策真源**。历史记忆与维护文档若与本文件冲突，以本文件为准。

## D1 唯一入口与收录范围

- 唯一真源：`D:\Projects\_github_pages\ming-games\`，线上唯一入口 `https://ming-games.pages.dev/`。
- 全收录：13 个既有主站卡片 + FUTURE-LIGHT + WAREHOUSE-STRIKE + lab-simulator + EN-LISTEN 网页版。
- `D:\Projects\HUB`（surge 跳转镜像）、`D:\Projects\zuoye`（WorldHub 旧快照 v1.3.0）、`D:\Projects\WorldHub`（2D 世界大厅，23 条 ITEMS 多为第三方开源）归档到 `D:\Projects\_archive\`，**不并入主站**（许可与重复内容原因）。
- **覆盖历史裁定 A**：`HUB\MAINTENANCE.md` 中「ONE-CARD 封存 · 一行代码不许改」——本次用户指令要求解除全部体验限制，视为解禁。执行上仍保持 ONE-CARD 业务源码零 diff，解锁由构建期 patch 层实现。
- **覆盖历史裁定 B**：`FUTURE-LIGHT\.workbuddy\memory\2026-10-03.md` 中「3D 两款不要纳入」——本次要求全部项目统一，视为作废。

## D2 三种打开形态全要

1. `file://` 双击 `offline/index.html`，完全离线可玩；
2. `serve.bat` 起本地零依赖服务，浏览器开 `http://127.0.0.1:<port>/`；
3. `https://ming-games.pages.dev/` 联网即玩。

三份产物由 `tools/build.mjs` 从同一份源码生成，游戏逻辑 JS 的 SHA256 必须一致（由 `tools/verify-all.mjs` 断言）。

## D3 美术口径

大厅、卡片、图标、按钮、角色立绘、UI 组件统一为精致可爱 Q 版成品；各游戏内保留原有主题气质，只把纯代码绘制与占位素材替换为真实精致素材并精修。**不**把军事写实 FPS / 水墨割草 / 极简剪影卡牌强行改成 Q 版。

## D4 新增玩法（用户已逐项勾选确认，提前报备）

- 全局元系统：跨游戏账号 / 金币 / 成就 / 图鉴 / 每日挑战 / 连胜 / 本地排行 / 一份贯通存档。
- 自由沙盒与全开放面板：任选关卡 + 7 类滑杆 + 无限资源 + 隐藏选项可视化开关。
- 新增可玩模式：无尽 / Boss Rush / 限时挑战 / 随机词条每日变体 / 本地双人。
- 大厅本身可玩化：Q 版角色走动换装 / 图鉴收集 / 任务板 / 签到。

「解除全部限制」为独立必做项，不依赖 D4 勾选：全关卡 / 全模式 / 全角色 / 全道具 / 数值上限解除 / 参数面板 / 隐藏选项可视化，逐项目落实为 `LIMITS.md` 的 L01–L35。

## D5 EN-LISTEN 网页版（用户追加指令）

听力程序由「仅留下载卡」升级为**做成网页版并纳入统一大厅**。APK 下载入口保留在网页版「关于」里。能力矩阵见计划文件第 4 节：纯函数与演示数据直接移植；系统内录 / sherpa-onnx / llama.cpp / ML Kit OCR / 悬浮窗 / 前台服务整块降级或删除；生词本、跟读、题库关卡、历史、评分、SM-2 等属于**新增玩法**（原 Android App 并不存在），已在 D4 报备范围内。

## D6 纯 P2P 联机（用户明确否决「要服务器 / 改 IP / 花钱」）

用户原话：**「我要的不是那种要服务器、改IP、花钱的」**。因此联机底座定为：

- **纯 P2P WebRTC DataChannel**，底层 `iceServers: []` —— 硬保证不连任何 STUN/TURN，不引入任何服务器、第三方 CDN 或付费服务。
- **手动交换连接码**：房主生成码 → 对方粘贴 → 反向生成加入码 → 房主粘贴。一次性、离线可传，不做 trickle ICE。
- **房主权威模型**：房主推进状态、广播权威状态、周期比对 hash；加入方动作进权威动作序列，保证可重放。
- **随机数必须可推导**：一切随机来自 `seed + 计数器`，`hashState` 含 seed 与计数器序号，房主改不了。
  - 飞行棋更进一步 —— 点数不是「掷」出来的，是 `H(seed|掷骰序号) % 6 + 1` 算出来的，双方各自算必然一致。
- **私密信息隔离**：`publicView` 裁掉私密字段，私密信息绝不进动作序列。骗子酒馆用 commit-reveal（先承诺、后揭示）。
- **连续像素数据走独立通道**：你画我猜的笔迹、切片的轨迹走 `dg-stroke` 增量消息，不进离散动作序列。
- **加入方不采信房主广播**：自己按同一份动作序列重放，与房主广播的 hash 对不上就报「房主在作弊」。

代价是双方必须手动传一次码、需要同一网络可达 —— 这是「零服务器」约束下的必然取舍，接受。

## D7 门禁与一致性

- 新增 `tools/check-hub-index.mjs`：校验 games.json 每条的 cover 与 dir/index.html 真实存在，且根首页内联 GAMES 条数与「应上首页条目数」一致。挂进 `tools/verify-all.mjs` 静态层。
- 现有 16 款既有游戏源码保持零 diff；新游戏一律 ESM（`renderer: "esm"`, `entry: "src/main.mjs"`）。
- 封面用 canvas 生成（`tools/gen-cover-*.mjs`），不依赖 Windows 上的 Edge + ImageMagick 链路。

## 域名裁决

见 `deploy.config.json`。两个冲突域名 `ming-games.surge.sh` 与 `ming-game-gym.surge.sh` 全部冻结，禁止任何脚本再写入，杜绝「后写覆盖先写」。

## 执行纪律

- 大体量 HTML / 长 Markdown 改写一律经 `tools/anchor.mjs` 的锚点唯一性校验，命中次数不为 1 即整体中止、不写盘。
- 构建产物由「模板 + 数据」生成，不做读原文局部改写的半途写入。
- 16 个既有游戏的业务源码全程保持零 diff；既有单测跑源码，天然全绿。
- `--no-openall` 可一键生成原版行为产物作为回退对照。
- 对外发布（pages.dev 推送）在任何一批前都先与用户确认。
