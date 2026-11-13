# `.build/` 目录说明

这个目录**不是可删除的中间产物目录**。它是知识问答的源码 + 构建脚本 + 验证探针三合一。

## 源码（改这里）

| 文件 | 说明 |
|---|---|
| `head.html` | 产物第 1 片：`<!DOCTYPE>` 到 `<script>`，含全部 CSS 与静态骨架 |
| `engine_core.js` | 产物第 2 片：题库 `POOLS`、`QA_TYPES`、`SUBJECT_GROUPS`、出题与判分 |
| `quiz-ui.js` | 产物第 4 片：书架、答题、统计、AI 建题、音乐、设置 |

产物 `../index.html` 由 `build.js` 拼装，勿手改（首行有生成标识）。

## 构建与门禁

| 文件 | 说明 |
|---|---|
| `build.js` | 拼装产物、同步部署包、按产物哈希重算 SW 版本；`--check` 只校验不写入 |
| `_guard_tags.cjs` | 构建前置断言：手写题语言标签 / 出题链路抽样 478 题 |
| `_sandbox.cjs` | Node 沙箱：按 build.js 的顺序装配引擎 + UI，并导出待测函数 |

## 探针（验证）

- `_runall.cjs`：27 套定向验证的串行入口，逐套限时、逐套落盘。
- `probe_*.cjs` / `_probe_*.cjs`：单套 CDP 探针，自带本地静态服务与无头 Edge。
- `cdp.cjs`：CDP（浏览器调试协议）客户端封装。
- `_probe_shelf.cjs`：书架四组分类、存储 schema 迁移、备份清单派生（纯 Node，秒级）。

## 一次性脚本

`_b7.cjs`、`_c2_hist.cjs`、`_fix_opts.cjs`、`sync-engine.cjs`、`extract_core.js` 等是历史批次的一次性改稿/抽取脚本，保留作审计线索，不参与构建与回归。它们可能引用旧路径或旧函数名，失效属正常，不要当回归失败。

## 历史备份

`head.html.bak7` 等 `.bak*` 文件被 `.gitignore` 排除，仅本机存在。
