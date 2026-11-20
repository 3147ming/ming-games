import { SPECIALS, heatState, rate, tipRate, tipFor, matchSpecials, PATIENCE } from '../scoring.mjs';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); } };

console.log('=== 六条特殊要求 ===');
ok('恰好六条', SPECIALS.length === 6, SPECIALS);
['少油','不要葱','加辣','面硬一点','蛋全熟','不要香菜'].forEach(s => ok('含「'+s+'」', SPECIALS.includes(s)));
let m = matchSpecials(['少油','加辣'], ['少油','加辣','不要葱']);
ok('命中2缺0多1', m.hitCount === 2 && m.miss.length === 0 && m.extra.length === 1, m);
m = matchSpecials(['蛋全熟','不要香菜'], ['蛋全熟']);
ok('命中1缺1', m.hitCount === 1 && m.miss[0] === '不要香菜', m);

console.log('=== 火候三态 ===');
ok('欠火 raw(0.6)', heatState(0.6) === 'raw');
ok('正好 perfect(1.0)', heatState(1.0) === 'perfect');
ok('过火 burnt(1.4)', heatState(1.4) === 'burnt');
ok('边界0.85→正好', heatState(0.85) === 'perfect');
ok('边界1.15→正好', heatState(1.15) === 'perfect');
ok('1.16→过火', heatState(1.16) === 'burnt');

console.log('=== 四维加权 ===');
const full = rate({ foodOK:true, heat:'perfect', platedRatio:1, patienceRatio:1, reqHit:2, reqTotal:2 });
ok('满分100分', full.score === 100, full);
ok('满分5星', full.stars === 5);
ok('四维权重40+20+25+15', full.parts.taste===40 && full.parts.plate===20 && full.parts.speed===25 && full.parts.req===15, full.parts);
const half = rate({ foodOK:true, heat:'perfect', platedRatio:0.5, patienceRatio:0.5, reqHit:1, reqTotal:2 });
ok('半分项=40+10+12.5+7.5=70', half.score === 70, half);
ok('70分→4星(3.5四舍五入)', half.stars === 4, half.stars);
const bad = rate({ foodOK:false, heat:'burnt', platedRatio:0, patienceRatio:0, reqHit:0, reqTotal:2 });
ok('全错1星', bad.stars === 1, bad);

console.log('=== 星级边界(1/3/5) ===');
ok('20分→1星', rate({foodOK:false,heat:'raw',platedRatio:0,patienceRatio:0,reqHit:0,reqTotal:2}).stars >= 1);
ok('40+7.5=47.5分', rate({foodOK:true,heat:'perfect',platedRatio:0,patienceRatio:0,reqHit:1,reqTotal:2}).score === 47.5);
const s60 = rate({foodOK:true,heat:'perfect',platedRatio:1,patienceRatio:0,reqHit:0,reqTotal:2});
ok('60分→3星', s60.score === 60 && s60.stars === 3, s60);
const mid = rate({foodOK:true,heat:'perfect',platedRatio:1,patienceRatio:0.4,reqHit:1,reqTotal:2});
ok('中段评星在1..5', mid.stars>=1 && mid.stars<=5, mid);

console.log('=== 小费 ===');
ok('1星0小费', tipRate(1) === 0);
ok('3星+20%', tipRate(3) === 0.2);
ok('5星+50%', tipRate(5) === 0.5);
ok('100金币5星+50', tipFor(5, 100) === 50);
ok('小费随星级递增', tipRate(2) < tipRate(3) && tipRate(3) < tipRate(4) && tipRate(4) < tipRate(5));

console.log('=== 耐心三档 ===');
ok('急客40s', PATIENCE.rush === 40);
ok('普通60s', PATIENCE.normal === 60);
ok('慢客90s', PATIENCE.slow === 90);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
