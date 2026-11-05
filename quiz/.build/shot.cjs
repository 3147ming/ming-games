const { Session } = require('./cdp.cjs');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

async function shot(s, name) {
  const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  console.log('saved', name);
}

(async () => {
  const s = new Session({ width: 414, height: 896, port: 9344 });
  await s.open('file:///D:/Projects/_github_pages/ming-games/quiz/index.html');
  await shot(s, '01-shelf');
  await s.eval(`(function(){var b=[].slice.call(document.querySelectorAll('.book')).filter(function(x){return /数学/.test(x.textContent)})[0];b.click();return 1})()`);
  await s.wait(300);
  await shot(s, '02-diff');
  await s.eval(`(function(){document.querySelectorAll('.diffbtn')[1].click();var go=[].slice.call(document.querySelectorAll('#curOverlay .btn')).filter(function(x){return /开始出题/.test(x.textContent)})[0];go.click();return 1})()`);
  await s.wait(500);
  await shot(s, '03-quiz');
  await s.eval(`document.getElementById('musicBtn').click()`);
  await s.wait(250);
  await shot(s, '04-music');
  await s.eval(`(function(){var c=document.querySelector('#curOverlay .close');c.click();document.getElementById('settingsBtn').click();return 1})()`);
  await s.wait(250);
  await shot(s, '05-settings');
  await s.eval(`(function(){var c=document.querySelector('#curOverlay .close');c.click();document.getElementById('statsBtn').click();return 1})()`);
  await s.wait(250);
  await shot(s, '06-stats');
  console.log('ERRORS:', s.errors.join(' | ') || '(none)');
  await s.close();
})();
