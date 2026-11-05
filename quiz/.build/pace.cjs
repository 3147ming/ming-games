/* 统一「走一题」节奏：答对只停 800ms 且没有按钮，答错/不会停 2.5s 并给「下一题 ›」。
   固定 sleep 拍不准 —— 有按钮时点掉，然后轮询到本题真正走完（新题可答 / 进入结算）。 */
const { sleep } = require('./cdp.cjs');

/* 返回：1 = 已到下一题（可作答），2 = 进入结算页，0 = 超时 */
async function step(s, tries) {
  await s.eval("(function(){var b=document.querySelector('#fbzone .fb .fbnext');if(b)b.click();return 1;})()");
  const n = tries || 45;
  for (let k = 0; k < n; k++) {
    const st = await s.eval(`(function(){
      var bs=[].slice.call(document.querySelectorAll('#stage .btn'));
      /* ⚠ 无限模式答题页顶栏本身就有「结束并结算」按钮，不能拿它当结算页判据；
         结算页特征是「再来一局 / 返回书架」 */
      for(var i=0;i<bs.length;i++){if(/再来一局|返回书架/.test(bs[i].textContent))return 2;}
      var o=document.querySelector('#stage .obtn');
      if(o&&!o.disabled)return 1;
      if(document.querySelector('#stage input[type=text]')&&!document.querySelector('#fbzone .fb'))return 1;
      return 0;})()`);
    if (st) return st;
    await sleep(100);
  }
  return 0;
}

module.exports = { step };
