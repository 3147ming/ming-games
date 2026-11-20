// ESM 模块需用动态 import 加载
(async () => {
const H = await import('../src/hero-vector.mjs');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
}
console.log('=== 1. 帧数定义 ===');
ok('run 8 帧', H.FRAMES.run === 8);
ok('idle 6 帧', H.FRAMES.idle === 6);
ok('slide 4 帧', H.FRAMES.slide === 4);
ok('hit 6 帧', H.FRAMES.hit === 6);

console.log('=== 2. 速度→步频映射 ===');
ok('低速 base=8fps', H.frameRate(430) === 8);
ok('高速 max=16fps', H.frameRate(1180) === 16);
ok('中速线性 12fps', Math.abs(H.frameRate(805) - 12) < 0.01, H.frameRate(805));
ok('超高速封顶 16', H.frameRate(3000) === 16);
ok('低速下限 8', H.frameRate(10) === 8);

console.log('=== 3. run 姿态关节驱动 ===');
// 扫描 run 8 帧所有相位，检查角度范围与反摆
let maxThigh = 0, minThigh = 0, maxShin = 0, torsoSeen = false, opp = true;
for (let i = 0; i < 800; i++) {
  const t = i * 0.005;
  const p = H.poseAt('run', t, 430);
  maxThigh = Math.max(maxThigh, p.thighL);
  minThigh = Math.min(minThigh, p.thighL);
  maxShin = Math.max(maxShin, p.shinL, p.shinR);
  if (Math.abs(p.torso - 8) < 0.01) torsoSeen = true;
  // 双臂反摆：upperArmL 与 upperArmR 始终反号
  if (p.upperArmL * p.upperArmR > 0 && Math.abs(p.upperArmL) > 1) opp = false;
}
ok('大腿摆幅接近 ±30°', maxThigh > 29 && minThigh < -29, { maxThigh, minThigh });
ok('小腿有滞后弯曲', maxShin > 55, maxShin);
ok('躯干前倾 8°', torsoSeen);
ok('双臂反摆', opp);
// run 8 帧拼图：8 个不同帧
const frames = new Set();
for (let i = 0; i < 8; i++) frames.add(H.poseAt('run', i / 8 * (8 / 8), 430).frame);
ok('run 产生多个不同帧', frames.size >= 4, [...frames]);

console.log('=== 4. 各状态姿态合理性 ===');
['idle', 'jump', 'rise', 'fall', 'slide', 'hit'].forEach(st => {
  const p = H.poseAt(st, 0.31, 800);
  ok(st + ' 姿态有效(无NaN)', Object.values(p).every(v => typeof v !== 'number' || isFinite(v)));
});
ok('slide 躯干大幅前倾', H.poseAt('slide', 0.2, 800).torso > 50);
ok('hit 有翻滚角', typeof H.poseAt('hit', 0.2, 800).roll === 'number');
ok('run boosting 前倾更大', H.poseAt('run', 0.1, 430, { boosting: true }).torso > H.poseAt('run', 0.1, 430).torso);

console.log('=== 5. 状态推断 ===');
ok('dead→hit', H.stateOf({ dead: true }) === 'hit');
ok('sliding→slide', H.stateOf({ sliding: true }) === 'slide');
ok('上升 vy>120→rise', H.stateOf({ onGround: false, vy: 800 }) === 'rise');
ok('下降 vy<-120→fall', H.stateOf({ onGround: false, vy: -800 }) === 'fall');
ok('地面速度→run', H.stateOf({ onGround: true, speed: 500 }) === 'run');
ok('静止→idle', H.stateOf({ onGround: true, speed: 0 }) === 'idle');
ok('落地压缩→jump', H.stateOf({ onGround: true, speed: 500, landSquashT: 0.1 }) === 'jump');

console.log('=== 6. 纯函数性（不改入参/无外部依赖）===');
const inp = { onGround: true, speed: 500 };
H.stateOf(inp);
ok('stateOf 不修改入参', JSON.stringify(inp) === '{"onGround":true,"speed":500}');
ok('draw 是函数', typeof H.draw === 'function');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
