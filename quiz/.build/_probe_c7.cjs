// 增量二批 C7：自动升档挑战（主指令 4.2.1 + 审查方 7 个边界点）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Session, sleep } = require('./cdp.cjs');

const PORT = 8863;
const APP = process.argv[2] || ('http://127.0.0.1:' + PORT + '/quiz/');
const USE_LOCAL = !process.argv[2];
const pass = [], fail = [];
function ck(n, c, e) { (c ? pass : fail).push(n + (e ? ' :: ' + e : '')); }

(async () => {
  const srv = USE_LOCAL ? spawn(process.execPath, [path.join(__dirname, 'serve.cjs'), String(PORT)], { stdio: 'ignore' }) : null;
  if (USE_LOCAL) await sleep(700);
  const s = new Session({ width: 414, height: 896, port: 9387 });

  const txt = (sel) => s.eval("(function(){var e=document.querySelector('" + sel + "');return e?e.textContent:'';})()");
  const g = (n) => s.eval(n);
  const toast = () => s.eval("(function(){var t=document.getElementById('toast');return t?t.textContent:'';})()");
  const hud = () => txt('#stage .hl');
  const clickText = (sel, t) => s.eval("(function(){var b=[].slice.call(document.querySelectorAll('" + sel + "')).filter(function(x){return x.textContent.indexOf('" + t + "')>=0;})[0];if(!b)return 0;b.click();return 1;})()");
  /* 点选项：right=找与 Q.a 同文的那个，wrong=任意不同文的 */
  const pick = (right) => s.eval("(function(){var Q=qlist[qidx];if(!Q||Q.a==null)return 'no-q';var t=String(Q.a);var bs=[].slice.call(document.querySelectorAll('#stage .obtn'));if(!bs.length)return 'no-opt';for(var i=0;i<bs.length;i++){var hit=bs[i].textContent===t;if(" + (right ? 'hit' : '!hit') + "){bs[i].click();return 'ok';}}return 'none';})()");
  const clickNext = () => s.eval("(function(){var b=document.querySelector('#stage .fb .fbnext');if(!b)return 'no-next';b.click();return 'ok';})()");
  const clickUnk = () => s.eval("(function(){var b=document.querySelector('#stage .unkbtn');if(!b)return 'no-unk';b.click();return 'ok';})()");
  /* 答一题：答完立即读 toast/HUD（自动跳 1 秒后才换题） */
  const ans = async (right) => {
    const r = await pick(right);
    await sleep(220);
    return r;
  };
  /* 等自动跳（1 秒）+ 余量 */
  const autoJump = async () => { await sleep(1350); };
  /* 稳稳进入下一题：优先点「下一题」，没有就等自动跳 */
  const next = async () => {
    const r = await clickNext();
    if (r !== 'ok') await sleep(1350);
    await sleep(260);
  };

  const startBook = async (bookName) => {
    await clickText('#shelf .book', bookName);
    await sleep(600);
    /* 编程首次进入会先弹「知识面检测」（语言/水平）—— 点「跳过」再走板块 */
    const sk = await clickText('#curOverlay .btn', '跳过');
    if (sk) await sleep(500);
    await s.waitFor('!!document.querySelector("#curOverlay .secbtn")', 9000);
    await clickText('#curOverlay .secbtn', '选择题');
    await s.waitFor('!document.querySelector("#curOverlay .secbtn")', 6000);
    await s.waitFor('!!document.querySelector("#curOverlay .diffbtn")', 9000);
    await s.eval("(function(){var b=document.querySelectorAll('#curOverlay .diffbtn')[0];if(b)b.click();return 1;})()");
    await clickText('#curOverlay .btn', '开始出题');
    await s.waitFor('!!document.querySelector("#stage .obtn")', 15000);
  };
  /* 清挑战 + 指定 rank + 重开一局：直接整页重载（全局状态一并归零，最接近真实「重新进来」） */
  const restart = async (rankKey, rankVal, bookName) => {
    await s.eval("localStorage.setItem('" + rankKey + "','" + rankVal + "');1");
    await s.reload();
    await s.ensureLoaded();
    await s.waitFor('!!document.querySelector(".book")', 15000);
    await startBook(bookName || '数学');
  };
  /* 连答 n 题（对/错由 arr 决定），每答完一次 */
  const streak = async (arr) => {
    for (const r of arr) { await ans(r); await next(); }
  };
  const st = async () => JSON.parse(await s.eval("JSON.stringify({ps:promoState,pr:promoRank,pa:promoAsked,pc:promoCorrect,ps2:promoStreak,sr:selfRank,win:selfWindow.length,auto:autoMode})"));

  try {
    await s.open(APP);
    await s.ensureLoaded();
    await s.eval("(function(){['bt_qa_weak','bt_qa_stats','bt_qa_best','bt_qa_daily','bt_qa_extra','bt_qa_rank_math','bt_qa_rank_code','bt_qa_learn_before','bt_qa_autorefill','bt_qa_quickjump'].forEach(function(k){localStorage.removeItem(k);});localStorage.setItem('bt_qa_rank_math','0');1})()");
    await s.reload();
    await s.ensureLoaded();
    await s.waitFor('!!document.querySelector(".book")', 15000);

    /* ================= A. 数学 rank0：连对 3 题触发挑战，目标 rank2 ================= */
    await startBook('数学');
    let a = await st();
    ck('A0 自动模式开局、挑战状态 idle', a.auto === true && a.ps === 'idle' && a.sr === 0, JSON.stringify(a));

    await streak([true, true]);
    let a2 = await st();
    ck('A1 连对 2 题还不触发', a2.ps === 'idle' && a2.ps2 === 2, JSON.stringify(a2));

    await ans(true);                       /* 第 3 题答对 → 触发 */
    const aTo = await toast();
    await autoJump();
    let a3 = await st();
    ck('A2 连对 3 题 → 进入挑战', a3.ps === 'challenge', JSON.stringify(a3));
    ck('A3 挑战档位 = min(0+2, max) = 2', a3.pr === 2, 'promoRank=' + a3.pr);
    ck('A4 触发时计数清零、连对清零（边界 2）', a3.pa === 0 && a3.pc === 0 && a3.ps2 === 0, JSON.stringify(a3));
    ck('A5 触发有 toast 提示目标档位（用数学自己的档名）', /升档挑战/.test(aTo) && /📗 高中/.test(aTo), aTo);
    const aHud = await hud();
    ck('A6 挑战题 HUD = 🔥 升档挑战 1/2 · 目标：📗 高中', /🔥 升档挑战 1\/2/.test(aHud) && /目标：📗 高中/.test(aHud), aHud);
    ck('A7 挑战中 HUD 不再显示「实力：」', aHud.indexOf('实力：') < 0, aHud);

    /* ================= B. 2/2 对 → 升 2 档 ================= */
    const bWin0 = (await st()).win;
    await ans(true);
    const bSt = await st();
    ck('B1 挑战第 1 题答对：count 1/2、仍挑战中', bSt.pa === 1 && bSt.pc === 1 && bSt.ps === 'challenge', JSON.stringify(bSt));
    ck('B2 挑战中 selfWindow 冻结（边界 1）', bSt.win === bWin0, bWin0 + '→' + bSt.win);
    const bFb = await txt('#stage .fb');
    ck('B3 反馈条显示「升档挑战：答对 1/2」', /升档挑战：答对 1\/2/.test(bFb), bFb.replace(/\s+/g, ' ').slice(0, 80));
    await autoJump();
    ck('B4 第 2 题 HUD 变 2/2', /升档挑战 2\/2/.test(await hud()), await hud());

    await ans(true);
    const bTo = await toast();
    const b2 = await st();
    ck('B5 第 2 题答完立即结算（不等下一题）：回到 idle', b2.ps === 'idle', JSON.stringify(b2));
    ck('B6 2/2 → selfRank 0→2（升两档）', b2.sr === 2, 'selfRank=' + b2.sr);
    const bLv = await s.eval("localStorage.getItem('bt_qa_rank_math')");
    ck('B7 新档位已落盘（setRank）', bLv === '2', 'bt_qa_rank_math=' + bLv);
    ck('B8 toast「🎉 升 2 档：🎒 小学 → 📗 高中」', /🎉 升 2 档/.test(bTo) && /🎒 小学/.test(bTo) && /📗 高中/.test(bTo), bTo);
    ck('B9 结算后 HUD 恢复「实力：」显示新档', /实力：/.test(await hud()), await hud());

    /* ================= C. 1/2 对 → 升 1 档 ================= */
    await restart('bt_qa_rank_math', 0);
    await streak([true, true, true]);      /* streak 里每题都点下一题，第 3 题答完进挑战 */
    let c0 = await st();
    ck('C0 重开一局后仍能正常触发挑战（重置没把机制关死）', c0.ps === 'challenge' && c0.sr === 0, JSON.stringify(c0));
    await ans(true);                        /* 挑战 Q1 对 */
    await autoJump();
    await ans(false);                       /* 挑战 Q2 错 */
    const cTo = await toast();
    let c1 = await st();
    ck('C1 1/2 → selfRank 0→1', c1.ps === 'idle' && c1.sr === 1, JSON.stringify(c1));
    ck('C2 toast「⬆️ 升 1 档」', /⬆️ 升 1 档/.test(cTo), cTo);

    /* ================= D. 0/2 → 不升档；答错不降档、仍出第 2 题 ================= */
    await restart('bt_qa_rank_math', 0);
    await streak([true, true, true]);
    const dW0 = await s.eval('loadWeak().length');
    await ans(false);                       /* 挑战 Q1 错 */
    const dW1 = await s.eval('loadWeak().length');
    const d1 = await st();
    ck('D0 挑战题答错照常进薄弱题（边界 5）', dW1 === dW0 + 1, dW0 + '→' + dW1);
    ck('D1 挑战答错不降档（边界 1）', d1.sr === 0, 'selfRank=' + d1.sr);
    ck('D2 挑战答错仍记挑战错、继续第 2 题', d1.ps === 'challenge' && d1.pa === 1 && d1.pc === 0, JSON.stringify(d1));
    await next();
    ck('D3 第 1 题错后仍出第 2 题（HUD 2/2）', /升档挑战 2\/2/.test(await hud()), await hud());
    await ans(false);
    const dTo = await toast();
    const d2 = await st();
    ck('D4 0/2 → 不升档、回 idle', d2.ps === 'idle' && d2.sr === 0, JSON.stringify(d2));
    ck('D5 toast「本轮到挑战结束，未升档」', /未升档/.test(dTo), dTo);

    /* ================= E. 挑战中「不会」不立即降档、继续第 2 题 ================= */
    await restart('bt_qa_rank_math', 0);
    await streak([true, true, true]);
    const eWin = (await st()).win;
    const eU = await clickUnk();
    const e1 = await st();
    ck('E1 挑战中「不会」不降档', eU === 'ok' && e1.sr === 0, 'unk=' + eU + ' ' + JSON.stringify(e1));
    ck('E2 挑战中「不会」不动 selfWindow（边界 1）', e1.win === eWin, eWin + '→' + e1.win);
    ck('E3 挑战中「不会」计入挑战错、仍挑战中', e1.ps === 'challenge' && e1.pa === 1 && e1.pc === 0, JSON.stringify(e1));
    await next();
    ck('E4 挑战中「不会」后仍出第 2 题', /升档挑战 2\/2/.test(await hud()), await hud());
    await ans(true);
    const e2 = await st();
    ck('E5 1/2（不会+对）→ 升 1 档', e2.ps === 'idle' && e2.sr === 1, JSON.stringify(e2));

    /* ================= F. 最高档不触发 ================= */
    await restart('bt_qa_rank_code', 4, '编程');   /* 编程 5 档，max=4 */
    let f0 = await st();
    ck('F0 编程进入最高档（rank=4）', f0.sr === 4 && f0.auto === true, JSON.stringify(f0));
    await streak([true, true, true, true]);
    const f1 = await st();
    ck('F1 最高档连对不触发挑战', f1.ps === 'idle', JSON.stringify(f1));
    ck('F2 最高档 selfRank 不被顶出边界', f1.sr === 4, 'selfRank=' + f1.sr);

    /* ================= G. 地理（扁平题库）不假升档 ================= */
    await restart('bt_qa_rank_math', 0, '地理');
    let g0 = await st();
    ck('G0 地理自动模式：HUD 报「🎲 混合难度」', /🎲 混合难度/.test(await hud()), await hud());
    await streak([true, true, true, true]);
    const g1 = await st();
    ck('G1 地理连对 4 题不触发挑战（边界 6）', g1.ps === 'idle', JSON.stringify(g1));
    ck('G2 地理连对照常计数（promoStreak ≥3）', g1.ps2 >= 3, 'promoStreak=' + g1.ps2);
    ck('G3 地理 HUD 仍「🎲 混合难度」，不假升档', /🎲 混合难度/.test(await hud()), await hud());

    /* ================= H. 换板块 / 退出 清零挑战 ================= */
    await restart('bt_qa_rank_math', 0);
    await streak([true, true, true]);
    let h0 = await st();
    ck('H0 数学又触发挑战', h0.ps === 'challenge', JSON.stringify(h0));
    /* H1：点 HUD 板块 chip → 换板块 */
    await s.eval("(function(){var c=document.querySelector('#stage .hud .chip.sec');if(c)c.click();return 1;})()");
    await s.waitFor('!!document.querySelector("#curOverlay .secbtn")', 8000);
    await clickText('#curOverlay .secbtn', '填空题');
    await s.waitFor('!!document.querySelector("#curOverlay .diffbtn")', 9000);
    await s.eval("(function(){var b=document.querySelectorAll('#curOverlay .diffbtn')[0];if(b)b.click();return 1;})()");
    await clickText('#curOverlay .btn', '开始出题');
    await s.waitFor('!!document.querySelector("#stage .input")||!!document.querySelector("#stage .obtn")', 15000);
    const h1 = await st();
    ck('H1 换板块 → 挑战清零（边界 7）', h1.ps === 'idle' && h1.ps2 === 0, JSON.stringify(h1));
    ck('H2 换板块后 selfRank 不被挑战档位污染', h1.sr === 0, 'selfRank=' + h1.sr);

    /* H3：挑战中退出（返回=结束并结算）→ 清零 */
    await restart('bt_qa_rank_math', 0);
    await streak([true, true, true]);
    let h3a = await st();
    await s.eval("(function(){var b=document.getElementById('backBtn');if(b)b.click();return 1;})()");
    await s.waitFor("!!document.querySelector('#stage .row')", 9000);
    const h3 = await st();
    ck('H3 挑战中退出 → 挑战清零、不补发升档', h3a.ps === 'challenge' && h3.ps === 'idle' && h3.sr === 0, JSON.stringify(h3));

    /* ================= I. 边界 3：计数只认首次作答（源码级守卫） ================= */
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const hits = [...src.matchAll(/=promoCount\(/g)].map(m => m.index);
    ck('I1 promoCount 只被调用 2 处（answer / markUnknown），且不是那处函数定义', hits.length === 2, 'n=' + hits.length);
    const inFirst = hits.map(i => {
      const seg = src.slice(Math.max(0, i - 1600), i);
      const a = seg.lastIndexOf('if(first){'), b = seg.lastIndexOf('}else if(correct)');
      return a >= 0 && a > b;
    });
    ck('I2 两处都落在 if(first){ 内（重写/重试答对不改挑战结果）', inFirst.every(Boolean), JSON.stringify(inFirst));
    /* 旧窗口升档分支必须彻底消失，否则会「挑战 +2 再 +1」 */
    ck('I3 旧 selfWindow 升档分支已删除（只剩降档）', src.indexOf('_acc>=UP_ACC') < 0 && src.indexOf('selfRank++') < 0, '仍有窗口升档残留');
    ck('I4 所有自动模式出题都走 autoQDiff()', /sectionGen\(bk,1,autoQDiff\(\)\)/.test(src) && /genHandTask\(autoQDiff\(\)\)/.test(src));

  } catch (e) {
    fail.push('!! 探针中断：' + e.message);
  }
  if (srv) { try { srv.kill(); } catch (e) {} }
  try { await s.close(); } catch (e) {}

  const all = pass.length + fail.length;
  console.log('\n=== C7 升档挑战：' + pass.length + '/' + all + ' 通过 ===');
  pass.forEach(x => console.log('  ✓ ' + x));
  fail.forEach(x => console.log('  ✗ ' + x));
  process.exit(fail.length ? 1 : 0);
})();
