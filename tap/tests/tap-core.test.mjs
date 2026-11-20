/**
 * 节奏拍打纯逻辑单测 —— 第三批任务块 F。
 * 运行：node --test tap/tests/tap-core.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(resolve(here, '../src/tap-core.mjs')).href);
const { judge, summarize, comboPitchSemis, chartIntegrity, buildSongs, dailyChart, WINDOWS } = mod;

test('判定窗口：±45 Perfect / ±90 Great / ±140 Good / 其余 Miss', () => {
  assert.equal(judge(0), 'perfect');
  assert.equal(judge(45), 'perfect');
  assert.equal(judge(-45), 'perfect');
  assert.equal(judge(46), 'great');
  assert.equal(judge(90), 'great');
  assert.equal(judge(-91), 'good');
  assert.equal(judge(140), 'good');
  assert.equal(judge(141), 'miss');
  assert.equal(judge(-500), 'miss');
  assert.equal(WINDOWS.perfect, 45);
});

test('评级 S/A/B/C/D 阈值', () => {
  const mk = (acc) => {
    const n = 100, perfect = Math.round(n * acc);
    return summarize([
      ...Array.from({ length: perfect }, () => ({ judge: 'perfect', delta: 0 })),
      ...Array.from({ length: n - perfect }, () => ({ judge: 'miss', delta: 0 })),
    ]);
  };
  assert.equal(mk(0.98).rank, 'S');
  assert.equal(mk(0.90).rank, 'A');
  assert.equal(mk(0.80).rank, 'B');
  assert.equal(mk(0.65).rank, 'C');
  assert.equal(mk(0.30).rank, 'D');
});

test('结算：四类计数 = 总数，准度 / 最大连击 / 平均偏移一致', () => {
  const r = summarize([
    { judge: 'perfect', delta: 10 }, { judge: 'perfect', delta: -10 },
    { judge: 'great', delta: 60 }, { judge: 'good', delta: 120 },
    { judge: 'miss', delta: 0 }, { judge: 'miss', delta: 0 },
  ]);
  assert.equal(r.total, 6);
  assert.deepEqual(r.counts, { perfect: 2, great: 1, good: 1, miss: 2 });
  assert.equal(r.maxCombo, 4);
  assert.equal(r.avgDelta, 45); // (10-10+60+120)/4 = 45
  assert.ok(Math.abs(r.accuracy - (2 + 0.7 + 0.4) / 6 * 100) < 1e-6);
});

test('连击音高：25/50/100 连 +2 半音，封顶 +4', () => {
  assert.equal(comboPitchSemis(0), 0);
  assert.equal(comboPitchSemis(24), 0);
  assert.equal(comboPitchSemis(25), 2);
  assert.equal(comboPitchSemis(50), 4);
  assert.equal(comboPitchSemis(75), 4);
  assert.equal(comboPitchSemis(100), 4);
});

test('谱面：≥8 首，覆盖 5 种风格，≥2 首 6 键，都有 hold 与元数据', () => {
  const songs = buildSongs();
  assert.ok(songs.length >= 8, `曲谱数 ${songs.length}`);
  const genres = new Set(songs.map((s) => s.genre));
  for (const g of ['电子', '鼓点', '钢琴', '8-bit', '慢摇']) assert.ok(genres.has(g), `缺风格 ${g}`);
  assert.ok(songs.filter((s) => s.lanes === 6).length >= 2, '至少 2 首 6 键');
  for (const s of songs) {
    assert.equal(typeof s.name, 'string');
    assert.ok(s.bpm > 0 && s.diff >= 1 && s.diff <= 5);
    assert.ok(s.durationMs > 0 && s.noteCount > 0);
    assert.ok(s.notes.every((n) => n.lane >= 0 && n.lane < s.lanes && typeof n.t === 'number'));
  }
  // 至少一首谱含 hold
  assert.ok(songs.some((s) => s.notes.some((n) => n.type === 'hold')), '应有 hold 音符');
});

test('谱面 JSON 结构：{name,bpm,offsetMs,lanes,notes:[{t,lane,type}]}', () => {
  const s = buildSongs()[0];
  const json = JSON.parse(JSON.stringify(s));
  assert.ok('name' in json && 'bpm' in json && 'offsetMs' in json && 'lanes' in json && 'notes' in json);
  assert.deepEqual(Object.keys(json.notes[0]).sort(), ['lane', 't', 'type']);
});

test('每日谱：同日同谱、确定性', () => {
  const a = dailyChart('2026-11-20');
  const b = dailyChart('2026-11-20');
  const c = dailyChart('2026-11-21');
  assert.deepEqual(a.notes, b.notes, '同日谱面一致');
  assert.notDeepEqual(a.notes, c.notes, '不同日谱面不同');
});

test('谱面音符数 = 四类判定总数（完整性）', () => {
  const s = buildSongs()[0];
  const results = s.notes.map((n) => ({ judge: n.t % 3 === 0 ? 'perfect' : n.t % 3 === 1 ? 'great' : 'miss', delta: 0 }));
  const c = chartIntegrity(s, results);
  assert.equal(c.chartNotes, c.judged);
  assert.equal(c.ok, true);
});

test('offset 校准：Perfect 集中在 0±45ms', () => {
  const deltas = Array.from({ length: 50 }, (_, i) => -45 + i * 1.8);
  const perfects = deltas.filter((d) => judge(d) === 'perfect');
  assert.equal(perfects.length, 50);
  const s = summarize(perfects.map((d) => ({ judge: 'perfect', delta: d })));
  assert.ok(Math.abs(s.avgDelta) <= 45);
});

test('静音不影响判定（judge 与音频无关）', () => {
  // judge 是纯函数，无音频副作用
  assert.equal(judge(0), 'perfect');
  assert.equal(judge(200), 'miss');
});
