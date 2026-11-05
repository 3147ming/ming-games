// 用 Chrome 自己的 installability 判定，验证「可添加到主屏幕」
const { Session, sleep } = require('./cdp.cjs');
(async () => {
  const s = new Session({ port: 9450, width: 414, height: 896 });
  await s.open('https://ming-games.surge.sh/quiz/');
  await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
  await s.waitFor(`navigator.serviceWorker.getRegistrations().then(function(rs){return rs.some(function(r){return r.active&&r.active.state==='activated';});})`, 40000);
  const mani = await s.send('Page.getAppManifest');
  console.log('manifest url :', mani.url);
  console.log('manifest errs:', JSON.stringify(mani.errors || []));
  console.log('parsed name  :', mani.parsed && mani.parsed.name, '| display:', mani.parsed && mani.parsed.display);
  try {
    const inst = await s.send('Page.getInstallabilityErrors');
    console.log('installability errors:', JSON.stringify(inst.installabilityErrors || []));
  } catch (e) {
    console.log('installability query failed:', e.message);
  }
  // 顺带确认 app 图标与首屏
  const fs = require('fs');
  const shot = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('shots/pwa-live.png', Buffer.from(shot.data, 'base64'));
  console.log('errors:', s.errors.slice(-3));
  await s.close();
})();
