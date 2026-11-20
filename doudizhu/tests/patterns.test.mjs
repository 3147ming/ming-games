import { parse, canBeat, isBomb, LABEL } from '../patterns.mjs';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); } };
const H = (...vals) => vals.map(v => ({ v }));

console.log('=== 11 类牌型识别 ===');
ok('单张', parse(H(7)).t === 'single');
ok('对子', parse(H(7, 7)).t === 'pair');
ok('三张', parse(H(7, 7, 7)).t === 'triple');
ok('三带一', parse(H(7,7,7,3)).t === 'triple1');
ok('三带二', parse(H(7,7,7,3,3)).t === 'triple2');
ok('顺子≥5', parse(H(3,4,5,6,7)).t === 'straight');
ok('顺子4张不合法', parse(H(3,4,5,6)) === null);
ok('顺子含2不合法', parse(H(11,12,13,14,15)) === null);
ok('连对≥3', parse(H(3,3,4,4,5,5)).t === 'pairseq');
ok('连对2对不合法', parse(H(3,3,4,4)) === null);
ok('飞机', parse(H(3,3,3,4,4,4)).t === 'plane');
ok('飞机带单', parse(H(3,3,3,4,4,4,7,8)).t === 'plane1');
ok('飞机带对', parse(H(3,3,3,4,4,4,7,7,8,8)).t === 'plane2');
ok('四带二(两单)', parse(H(6,6,6,6,3,4)).t === 'quad2');
ok('四带二(两对)', parse(H(6,6,6,6,3,3,4,4)).t === 'quad2');
ok('炸弹', parse(H(9,9,9,9)).t === 'bomb');
ok('王炸', parse(H(16,17)).t === 'rocket');
ok('非法(散牌)', parse(H(3,5,9)) === null);

console.log('=== 压牌规则 ===');
ok('大单压小单', canBeat(parse(H(9)), parse(H(7))));
ok('小单压不过大单', !canBeat(parse(H(6)), parse(H(7))));
ok('炸弹压普通', canBeat(parse(H(3,3,3,3)), parse(H(9))));
ok('王炸压炸弹', canBeat(parse(H(16,17)), parse(H(9,9,9,9))));
ok('炸弹压不过王炸', !canBeat(parse(H(14,14,14,14)), parse(H(16,17))));
ok('大炸弹压小炸弹', canBeat(parse(H(10,10,10,10)), parse(H(9,9,9,9))));
ok('不同型不能压', !canBeat(parse(H(7,7)), parse(H(3,4,5,6,7))));
ok('同型不同长不能压', !canBeat(parse(H(3,4,5,6,7)), parse(H(3,4,5,6,7,8))));
ok('顺子比最大牌', canBeat(parse(H(4,5,6,7,8)), parse(H(3,4,5,6,7))));
ok('连对比最大对', canBeat(parse(H(4,4,5,5,6,6)), parse(H(3,3,4,4,5,5))));
ok('飞机比最大三张', canBeat(parse(H(4,4,4,5,5,5)), parse(H(3,3,3,4,4,4))));
ok('空牌不能出', !canBeat(null, null));
ok('无上家可出任意', canBeat(parse(H(3)), null));

console.log('=== 倍数/标签 ===');
ok('炸弹识别', isBomb(parse(H(2,2,2,2))));
ok('王炸识别', isBomb(parse(H(16,17))));
ok('普通牌非炸弹', !isBomb(parse(H(7))));
ok('标签齐全', ['single','pair','triple','straight','bomb','rocket'].every(t => !!LABEL[t]));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
