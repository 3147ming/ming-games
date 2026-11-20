import { classify, compare, TYPES, makeDeck, shuffle, strength, aiDecide, simulateHand } from '../zha-jin-hua.mjs';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); } };
const C = (s, r) => ({ s, r, v: ({ '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13,A:14 })[r] });

console.log('=== 牌型判定 ===');
ok('豹子', classify([C('S','7'),C('H','7'),C('D','7')]).type === TYPES.TRIPS);
ok('同花顺', classify([C('S','5'),C('S','6'),C('S','7')]).type === TYPES.STRAIGHT_FLUSH);
ok('同花', classify([C('S','2'),C('S','7'),C('S','K')]).type === TYPES.FLUSH);
ok('顺子', classify([C('S','5'),C('H','6'),C('D','7')]).type === TYPES.STRAIGHT);
ok('A23小顺', classify([C('S','A'),C('H','2'),C('D','3')]).type === TYPES.STRAIGHT);
ok('对子', classify([C('S','9'),C('H','9'),C('D','4')]).type === TYPES.PAIR);
ok('单张', classify([C('S','2'),C('H','7'),C('D','K')]).type === TYPES.HIGH);

console.log('=== 牌型优先级 ===');
const trips = [C('S','3'),C('H','3'),C('D','3')];
const sf = [C('S','5'),C('S','6'),C('S','7')];
const flush = [C('H','2'),C('H','9'),C('H','K')];
const straight = [C('S','9'),C('H','10'),C('D','J')];
const pair = [C('S','A'),C('H','A'),C('D','4')];
const high = [C('S','A'),C('H','9'),C('D','4')];
ok('豹子>同花顺', compare(trips, sf) > 0);
ok('同花顺>同花', compare(sf, flush) > 0);
ok('同花>顺子', compare(flush, straight) > 0);
ok('顺子>对子', compare(straight, pair) > 0);
ok('对子>单张', compare(pair, high) > 0);

console.log('=== 同级比较 ===');
ok('大豹子>小豹子', compare([C('S','K'),C('H','K'),C('D','K')], trips) > 0);
ok('大同花顺>小同花顺', compare([C('S','9'),C('S','10'),C('S','J')], sf) > 0);
ok('A23顺最小', compare([C('S','4'),C('H','5'),C('D','6')], [C('S','A'),C('H','2'),C('D','3')]) > 0);
ok('对子比对子点数', compare([C('S','Q'),C('H','Q'),C('D','2')], [C('S','J'),C('H','J'),C('D','A')]) > 0);
ok('单张比最大牌', compare([C('S','A'),C('H','5'),C('D','3')], [C('S','K'),C('H','9'),C('D','4')]) > 0);

console.log('=== 牌力与AI ===');
ok('豹子牌力最高', strength(trips) > strength(high));
let seed = 12345; const rand = () => ((seed = (seed*1103515245+12345)&0x7fffffff)/0x7fffffff);
ok('52张牌', makeDeck().length === 52);
const sh = shuffle(makeDeck(), rand); ok('洗牌不重复', new Set(sh.map(c=>c.s+c.r)).size === 52);
let valid = 0;
for (let i=0;i<200;i++){ const d = simulateHand(rand); if (d.valid) valid++; }
ok('200局自对弈动作合法', valid === 200, valid);
// 不看牌下注为看牌半价
const r2 = () => 0.99; // 高随机→不弃牌不诈唬，倾向跟注
const seenCall = aiDecide(high, {toCall:10,pot:20,unit:10,seen:true,rand:r2,level:'casual'});
const unseenCall = aiDecide(high, {toCall:10,pot:20,unit:10,seen:false,rand:r2,level:'casual'});
ok('不看牌跟注≤看牌半价', unseenCall.amount <= seenCall.amount, {seen:seenCall.amount,unseen:unseenCall.amount});
// 诈唬：弱牌 + 低随机 + pro
const bluff = aiDecide(high, {toCall:10,pot:20,unit:10,seen:true,rand:()=>0.01,level:'pro'});
ok('pro会诈唬', bluff.bluff === true, bluff);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
