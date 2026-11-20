# 外部资源来源与授权（assets/）

本目录是 SOUDACHE 唯一的外部美术资源来源。**P24 起，3D 模型、图标、音效三条线都已接进运行时**
（见下表第 1 节），并且游戏内有一级入口的「致谢」页承担 CC BY 3.0 的署名义务。

导入原则：只收 CC0 或明确允许商用的资源；授权有冲突、需登录、需付费、无法直链的一律不收。
来源清单与逐文件信息见 `2026-11-16/art-assets/outputs/assets-manifest.md`（采集时的原始档案）。

---

## 1. 已在运行时使用（CC0 1.0 为主 + 图标 CC BY 3.0 需署名）

| 用途 | 文件 | 作者 / 来源 |
|---|---|---|
| `crate` 补给箱 | `models/kenney-survival-kit/box-large.glb` | Kenney · Survival Kit（CC0 1.0） |
| `safe` 保险箱 | `models/kenney-survival-kit/chest.glb` | Kenney · Survival Kit（CC0 1.0） |
| `weaponbox` 军械箱 | `models/kenney-blaster-kit/crate-medium.glb` | Kenney · Blaster Kit（CC0 1.0） |
| `drawer` 抽屉柜 | `models/kenney-blaster-kit/crate-small.glb` | Kenney · Blaster Kit（CC0 1.0） |
| 敌人 / 友军 | `models/kenney-mini-characters/character-soldier\|worker\|raider.glb` | Kenney · Mini Characters（CC0 1.0） |
| 第一人称枪模（9 把） | `models/poly-pizza/weapon-*.glb` | Quaternius（经 Poly Pizza 分发，CC0 1.0） |
| 物品 / 武器图标 | `icons/game-icons/*.svg`（14 个，经 CSS mask 染色） | Sbed / Lorc / Delapouite / Skoll / John Colburn · game-icons.net（**CC BY 3.0**） |
| UI 点击 / 材质命中音 | `audio/kenney-interface-sounds`、`audio/kenney-impact-sounds`（9 条） | Kenney · Interface Sounds / Impact Sounds（CC0 1.0） |
| 界面字体（W0 新增） | `fonts/barlow-condensed-latin-{400,600,700}-normal.woff2` | The Barlow Project Authors（**SIL OFL 1.1**） |
| 等宽字体（W0 新增） | `fonts/jetbrains-mono-latin-{400,700}-normal.woff2` | The JetBrains Mono Project Authors（**SIL OFL 1.1**） |

Kenney 全系模型共用外部调色板 `Textures/colormap.png`。**四套 kit 的调色板内容不同**，
所以目录结构必须保持 `<kit>/<model>.glb` + `<kit>/Textures/colormap.png` 的原始相对关系，
不能把 GLB 拍平到一个目录里。

---

## 2. 已入库、尚未接入运行时（预置素材）

| 分类 | 目录 | 来源 | 授权 |
|---|---|---|---|
| 3D | `models/kenney-survival-kit`、`kenney-city-kit-industrial`、`kenney-mini-characters`、`kenney-blaster-kit` | Kenney（kenney.nl） | CC0 1.0 |
| 3D | `models/poly-pizza/*.glb` 中未列入第 1 节的部分 | Quaternius（经 Poly Pizza 分发） | CC0 1.0 |
| 3D | `models/poly-pizza/emplacement-minigun-turret.glb` | Thardoc nolastname（经 Poly Pizza） | **CC BY 3.0** |
| 3D | `models/kenney-city-kit-industrial` | Kenney | CC0 1.0 |
| 图标 | `icons/game-icons/*.svg` 中未被 `src/icons.js` 引用的部分 | game-icons.net | **CC BY 3.0** |
| 图标 | `icons/kenney-game-icons/*.png` | Kenney · Game Icons | CC0 1.0 |
| 音效 | `audio/kenney-*` | Kenney（RPG Audio / Interface Sounds / UI Audio / Impact Sounds） | CC0 1.0 |
| 音效 | `audio/opengameart-gunshots/*` | kurt、hingydunyas（OpenGameArt） | CC0 1.0 |

### ⚠ 署名义务（已履行）

CC BY 3.0 的来源**要求署名**。P24 已经把这段文字做进游戏内的一级入口「致谢」页
（`src/icons.js` 的 `CREDITS` 常量 → `src/ui.js` 的 `data-screen="credits"` 面板），
文案改这里时两边要一起改：

```
Gun turret model: "Gun Turret Minigun" by Thardoc nolastname, via Poly Pizza, CC BY 3.0.
Icons made by Sbed, Lorc, Delapouite, Skoll and John Colburn from game-icons.net, licensed under CC BY 3.0.
```

改动 `CREDITS` 常量时注意：`tests/p24-glb-actors.test.mjs` 会断言里面同时出现
`CC BY 3.0`、`Kenney`、`game-icons.net` —— 署名文案被删掉会直接红。

---

## 3. 与项目铁律的关系

- 项目禁止直接使用《三角洲行动》的模型 / 贴图 / 音频 / 字体。这里的资源全部来自
  独立作者的 CC0 / CC BY 包，与该作品无关，不触碰这条红线。
- 资源必须能被"关掉"：关卡构建支持 `?glb=0` 退回纯程序化模型，用于弱机、排障与 A/B 复现。
- 新增任何资源都要同步 `tools/sync-deploy.mjs` 的白名单口径（`assets/` 已按递归整目录纳入，过 md5 parity）。
