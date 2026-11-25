/* verify-all.mjs — 全站验证统一入口（deploy.config.json 的 build.verify 指向这里）
 *
 * 分三层，默认只跑第一层（秒级，可进 CI）：
 *   静态门禁   部署写目标 / quiz 产物与 SW 一致性 / 三形态产物完整性
 *   --unit     Node 侧单元测试（错题本、资源层、vendor 映射）
 *   --browser  无头 Edge 三形态验收（真实浏览器，慢，需要本机浏览器）
 *   --all      三层全跑
 *
 * 用法：
 *   node tools/verify-all.mjs
 *   node tools/verify-all.mjs --unit
 *   node tools/verify-all.mjs --all
 *   node tools/verify-all.mjs --target=all --unit --report   （兼容 deploy.config.json 的旧调用）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const UNIT = has('--unit') || has('--all');
const BROWSER = has('--browser') || has('--all');
/* --target / --report 是历史调用参数：target 由构建脚本自己决定，report 恒开 */
const TARGET = (argv.find((a) => a.startsWith('--target=')) || '--target=all').split('=')[1];

const results = [];
function run(label, file, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, file), ...args], {
    cwd: ROOT, stdio: 'inherit', timeout: opts.timeout || 600000
  });
  const ms = Date.now() - started;
  const ok = r.status === 0 && !r.error;
  results.push({ label, ok, ms, note: r.error ? String(r.error.message || r.error) : '' });
  if (!ok) console.log(`\n[FAIL] ${label}（${ms} ms）${r.error ? '：' + r.error.message : ''}\n`);
  return ok;
}

console.log(`=== 1/3 静态门禁（target=${TARGET}） ===`);
run('部署写目标门禁', 'tools/check-deploy.mjs', []);
run('大厅索引一致性（封面/入口/首页清单）', 'tools/check-hub-index.mjs', []);
run('quiz 产物一致性（产物/部署包/SW/dist）', 'quiz/.build/build.js', ['--check']);
run('三形态产物完整性', 'tools/check-artifacts.mjs', []);

if (UNIT) {
  console.log('\n=== 2/3 单元测试 ===');
  run('错题本 pure functions', 'quiz/tests/wrongbook.test.mjs', []);
  run('资源本地化层', 'tools/build-assets.test.mjs', []);
  run('vendor 映射', 'tools/vendor-map.test.mjs', []);
  run('五子棋规则引擎', 'gomoku/tests/rules.test.mjs', []);
  run('四子棋规则引擎', 'connect4/tests/rules.test.mjs', []);
  run('谁是卧底规则引擎', 'undercover/tests/rules.test.mjs', []);
  run('你画我猜规则引擎', 'drawguess/tests/rules.test.mjs', []);
  run('骗子酒馆规则引擎', 'liar/tests/rules.test.mjs', []);
  run('飞行棋规则引擎', 'ludo/tests/rules.test.mjs', []);
  run('山海合成规则引擎', 'shanhai-merge/tests/rules.test.mjs', []);
  run('小铺垂钓规则引擎', 'fishing/tests/rules.test.mjs', []);
  run('切片大师规则引擎', 'slicer/tests/rules.test.mjs', []);
  run('快问快答派对规则引擎', 'quiz-party/tests/rules.test.mjs', []);
  run('方块爆破规则引擎', 'blast/tests/rules.test.mjs', []);
  /* 纯 P2P 底座：连接码编解码 / 密码证明 / 真连一次 / 房主权威。
     这一项要起浏览器，比纯 Node 单测慢，所以单独归到 P2P 层而不是 --unit。 */
  run('纯 P2P 底座（浏览器内）', 'tools/test-p2p.mjs', [], { timeout: 300000 });
  run('五子棋纯 P2P 联机端到端', 'tools/test-gomoku-p2p.mjs', [], { timeout: 300000 });
  run('四子棋纯 P2P 联机端到端', 'tools/test-connect4-p2p.mjs', [], { timeout: 300000 });
  run('UNO 彩牌纯 P2P 联机端到端', 'tools/test-uno.mjs', [], { timeout: 300000 });
  /* 谁是卧底：除了联机，还要验私密信息隔离 ——
     加入方页面/状态里不能出现别人的词，也不能拿到自己是不是卧底。 */
  run('谁是卧底纯 P2P 联机端到端', 'tools/test-undercover.mjs', [], { timeout: 300000 });
  /* 你画我猜：除了联机，还要验两件特别的事 ——
     ① 私密信息隔离：画师手上的词不能漏给猜的人
     ② 笔迹走独立通道（不进权威动作序列），但两端都要能看到。 */
  run('你画我猜纯 P2P 联机端到端', 'tools/test-drawguess.mjs', [], { timeout: 300000 });
  /* 骗子酒馆：除了联机，还要验两件特别的事 ——
     ① commit-reveal 私密隔离：双方都算不出对方的点数
     ② 房主谎报结算会被加入方发现（actual / 叫牌 / 骰子都要能验出来）。 */
  run('骗子酒馆纯 P2P 联机端到端', 'tools/test-liar.mjs', [], { timeout: 300000 });
  /* 飞行棋：除了联机，还要验两件特别的事 ——
     ① 点数可推导：两端算出的点数必须一致，房主改不了
     ② 加入方不采信房主广播的局面 —— 自己重放，对不上就报出来。 */
  run('飞行棋纯 P2P 联机端到端', 'tools/test-ludo.mjs', [], { timeout: 300000 });
  /* 山海合成：单人合成类游戏，要验三件特别的事 ——
     ① 每日固定局可复现：同一天的盘面与飘落序列人人相同
     ② 拖拽 / 点选两种合成交互都work，撤销能还原盘面
     ③ file:// 产物零报错。 */
  run('山海合成端到端', 'tools/test-shanhai-merge.mjs', [], { timeout: 300000 });
  /* 小铺垂钓：除了联机，还要验三件特别的事 ——
     ① 同一片湖：两端的鱼群 / 咬钩延迟 / 反应窗口必须一致，房主改不了
     ② 窗口判定：正中完美区＝大鱼，偏一点＝小鱼，超时＝空钩
     ③ 每日一钓：种子由日期派生，同一天人人相同；file:// 下也能玩。 */
  run('小铺垂钓纯 P2P 联机端到端', 'tools/test-fishing.mjs', [], { timeout: 300000 });
  /* 切片大师：除了联机，还要验三件特别的事 ——
     ① 轨迹走独立通道（不进权威动作序列），但两端结算必须一致
     ② 结算可推导：两端各自按轨迹算，分数一模一样，房主改不了
     ③ 危险物判负 + 每日一局同种子 + file:// 下也能玩。 */
  run('切片大师纯 P2P 联机端到端', 'tools/test-slicer.mjs', [], { timeout: 300000 });
  /* 快问快答派对：除了联机，还要验三件特别的事 ——
     ① 答案不上线：动作序列与公开视图里都没有答案 / 分数
     ② 结算可推导：两端各自按动作序列算分，一模一样，房主改不了
     ③ 每日一局同种子 + 房主谎报答案会被加入方发现 + file:// 下也能玩。 */
  run('快问快答派对纯 P2P 联机端到端', 'tools/test-quiz-party.mjs', [], { timeout: 300000 });
  /* 方块爆破：除了联机，还要验两件特别的事 ——
     ① 随机数由 seed+计数器推导，房主改不了落块颜色
     ② 房主删动作/改撤销范围 → 加入方重放出的摘要对不上，当场报作弊。 */
  run('方块爆破纯 P2P 联机端到端', 'tools/test-blast.mjs', [], { timeout: 300000 });
}

if (BROWSER) {
  console.log('\n=== 3/3 无头浏览器验收 ===');
  run('三形态真实浏览器验收', 'tools/verify-p0.mjs', [], { timeout: 900000 });
}

const bad = results.filter((r) => !r.ok);
console.log('\n=== 验证汇总 ===');
results.forEach((r) => console.log(`${r.ok ? '✓' : '✗'} ${r.label}  ${r.ms} ms`));
console.log(bad.length ? `\n未通过 ${bad.length}/${results.length} 项` : `\n全部通过（${results.length} 项）`);
process.exit(bad.length ? 1 : 0);
