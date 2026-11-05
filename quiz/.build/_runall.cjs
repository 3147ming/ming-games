/* 本地全量回归：逐条单独跑，抓汇总行 */
const { spawnSync } = require('child_process');
const list = ['_probe_lang.cjs', '_probe_a.cjs', '_probe_b.cjs', '_probe_p0.cjs', '_probe_p1.cjs', '_probe_c1.cjs', '_probe_c2.cjs', '_probe_c3.cjs', '_probe_c4.cjs', '_probe_srs.cjs', '_probe_code.cjs', '_probe_diff.cjs', '_probe_content.cjs', '_probe_p2.cjs', '_probe_c1b.cjs', '_probe_type.cjs', '_probe_401.cjs', '_probe_c7.cjs', 'smoke2.cjs', 'probe_full.cjs', 'probe_ui.cjs', 'probe_section.cjs', 'probe_pwa.cjs', 'probe_weak.cjs', 'probe_hand.cjs', 'probe_quality.cjs', 'probe_refill.cjs'];
/* 长跑可按区间分片：node _runall.cjs [start] [end]（避免单次命令超时） */
const a = process.argv[2] != null ? Number(process.argv[2]) : 0;
const b = process.argv[3] != null ? Number(process.argv[3]) : list.length;
const slice = list.slice(a, b);
console.log('区间 [' + a + ',' + b + ')，共 ' + slice.length + ' 套');
const rows = [];
for (const f of slice) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL' });
  const txt = (r.stdout || '') + (r.stderr || '');
  const m = (txt.match(/=+ *[^=\n]*?(\d+\/\d+) *[^=\n]*=+/g) || []).concat(txt.match(/P\d 定向验证：通过\s*\d+，失败\s*\d+/g) || []);
  const line = m.length ? m[m.length - 1].replace(/=+/g, '').trim() : '(无汇总行)';
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  rows.push([f, line, sec]);
  console.log('· ' + f.padEnd(20) + ' | ' + line + ' | ' + sec + 's');
}
console.log('\n===== 本地全量汇总 =====');
rows.forEach(x => console.log(x[0].padEnd(20) + ' | ' + x[1] + ' | ' + x[2] + 's'));
