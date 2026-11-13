# ming-games · 游戏合集

个人开发的 H5 游戏合集，全部为纯前端静态网页，托管于 GitHub Pages。

## 🎮 在线地址

**游戏大厅（主入口）**：https://3147ming.github.io/ming-games/

| 游戏 | 说明 | 地址 |
|---|---|---|
| 荒野 WILD | 十分钟单局生存割草，四把武器、三系职业、剑气进化、长期成长与转生 | https://3147ming.github.io/ming-games/wild/ |
| 搜打撤 | 3D 第一人称撤离射击：搜刮物资 → 交火突围 → 活着撤离 | https://3147ming.github.io/ming-games/soudache/ |
| 一世一牌 | 每一世只带回一张牌的卡牌肉鸽，轮回不止 | https://3147ming.github.io/ming-games/one-card/ |
| 脑力训练场 | 53 款脑力小游戏：记忆 / 反应 / 视觉 / 数学 / 益智，九大类每日开练 | https://3147ming.github.io/ming-games/brain-gym/ |
| 夜班便利店 | 深夜营业的 3D 模拟经营：补货、收银、应付夜客，撑过七个夜班 | https://3147ming.github.io/ming-games/night-shift/ |
| 传统割草游戏 | 3D 战场原型：地形、光照、摄像机、战斗系统与敌人分层 AI | https://3147ming.github.io/ming-games/grass-cutter/ |
| 知识问答 | 书架式分类刷题：719 道人工题 + 8 个生成器，选择题 / 补全 / 手写三板块，支持离线与 AI 建题 | https://ming-games.pages.dev/games/quiz/index.html |
| 电路实验模拟器 | 面包板 / 数字实验箱上搭电路，实时仿真直流·数字·暂态，配万用表与示波器 | https://3147ming.github.io/ming-games/circuit-lab/ |

## 📁 目录结构

```
ming-games/
├── index.html        # 游戏大厅（含全部游戏入口）
├── covers/           # 大厅封面图
├── wild/             # 荒野 WILD
├── soudache/         # 搜打撤
├── one-card/         # 一世一牌
├── brain-gym/        # 脑力训练场
├── night-shift/      # 夜班便利店
├── grass-cutter/     # 传统割草游戏（原型）
├── circuit-lab/      # 电路实验模拟器
└── quiz/             # 知识问答（源码在 quiz/src，index.html 是拼接产物）
```

## 🚀 更新部署

本仓库通过 GitHub Pages 自动部署（源：`master` 分支根目录）。

```bash
# 修改对应子目录中的文件后：
git add -A
git commit -m "更新说明"
git push
```

推送后约 1-3 分钟线上自动生效，无需其他操作。

## 🧪 构建与验证

```bash
node tools/build.mjs --target=all   # 生成 dist/ 与 offline/
node tools/verify-all.mjs --unit    # 部署门禁 + 三形态产物完整性 + 单元测试
```

单文件游戏（如知识问答）的产物由自己的构建脚本生成，再进入统一构建：

```bash
node quiz/.build/build.js           # 四片源码 → quiz/index.html + SW 版本
node quiz/.build/build.js --check   # 校验产物 / 部署包 / SW / dist 是否一致
```

## 🛠 技术栈

纯 HTML / CSS / JavaScript 静态网页，无后端依赖，可离线运行。

---
© 2026 ming-games
