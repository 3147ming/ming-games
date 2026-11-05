const { Session } = require('./cdp.cjs');
(async () => {
  const s = new Session({ width: 414, height: 896, port: 9343 });
  await s.open('file:///D:/Projects/_github_pages/ming-games/quiz/index.html');
  await s.eval("localStorage.setItem('bt_qa_quickjump','true');1");
  const r = await s.eval(`(function(){
    var out={};
    out.hasAC = typeof (window.AudioContext||window.webkitAudioContext);
    try{ var c=new (window.AudioContext||window.webkitAudioContext)(); out.state=c.state; out.rate=c.sampleRate; }catch(e){ out.err=String(e); }
    document.getElementById('musicBtn').click();
    return JSON.stringify(out);
  })()`);
  console.log('AC:', r);
  const r2 = await s.eval(`(function(){
    var nm=document.getElementById('mpName'), pp=document.getElementById('mpPlay');
    if(!pp) return 'NO_MPPLAY';
    pp.click();
    return JSON.stringify({nm:nm?nm.textContent:null, btn:pp.textContent});
  })()`);
  console.log('AFTER_CLICK:', r2);
  await s.wait(800);
  const r3 = await s.eval(`JSON.stringify({nm:(document.getElementById('mpName')||{}).textContent, btn:(document.getElementById('mpPlay')||{}).textContent})`);
  console.log('LATER:', r3);
  console.log('ERRORS:', s.errors.join(' | ') || '(none)');
  console.log('LOGS:', s.logs.slice(0,10).join(' | ') || '(none)');
  await s.close();
})();
