const { Session } = require('./cdp.cjs');
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, 'shots');
async function shot(s, name) {
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  console.log('saved', name);
}
(async () => {
  const s = new Session({ width: 414, height: 896, port: 9345 });
  await s.open('file:///D:/Projects/_github_pages/ming-games/quiz/index.html');
  // 答题反馈
  await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return /地理/.test(x.textContent)})[0];b.click();return 1})()`);
  await s.wait(250);
  await s.eval(`(function(){document.querySelectorAll('.diffbtn')[1].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()`);
  await s.wait(500);
  await s.eval(`document.querySelectorAll('.obtn')[0].click()`);
  await s.wait(120);
  await shot(s, '07-feedback');
  // 结算
  for (let i = 0; i < 14; i++) {
    const end = await s.eval('!!([].slice.call(document.querySelectorAll("button")).filter(function(x){return /再来一局/.test(x.textContent)})[0])');
    if (end) break;
    await s.eval('(function(){var o=document.querySelector(".obtn:not([disabled])");if(o)o.click();return 1})()');
    await s.wait(950);
  }
  await shot(s, '08-finish');
  // 新建题库
  await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return /返回书架/.test(x.textContent)})[0];if(b)b.click();return 1})()`);
  await s.wait(300);
  await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /新建/.test(x.textContent)})[0];b.click();return 1})()`);
  await s.wait(300);
  await shot(s, '09-newcat');
  await s.eval(`(function(){var c=document.querySelector('#curOverlay .close');c.click();return 1})()`);
  // 薄弱题回顾
  await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return /薄弱题/.test(x.textContent)})[0];b.click();return 1})()`);
  await s.wait(400);
  await shot(s, '10-review');
  console.log('ERRORS:', s.errors.join(' | ') || '(none)');
  await s.close();
})();
