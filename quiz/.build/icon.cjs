// 生成 PWA 图标：按正方形精确渲染，不做任何拉伸
const fs = require('fs');
const path = require('path');
const { Session, sleep } = require('./cdp.cjs');

const DIR = 'D:/Projects/_github_pages/ming-games/quiz/.build';
const OUT = 'D:/Projects/_github_pages/ming-games/quiz/icons';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = new Session({ port: 9401, width: 512, height: 512 });
  await s.open('file:///' + DIR + '/icon.html');
  await s.eval("document.fonts && document.fonts.ready ? 1 : 1");
  await sleep(700);

  for (const size of [512, 192]) {
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(350);
    const r = await s.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
      captureBeyondViewport: false,
    });
    const buf = Buffer.from(r.data, 'base64');
    const file = path.join(OUT, 'icon-' + size + '.png');
    fs.writeFileSync(file, buf);
    console.log('icon-' + size + '.png  ' + buf.length + 'B');
  }
  console.log('errors:', s.errors.length ? s.errors : 'none');
  await s.close();
})();
