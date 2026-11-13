/* 书架四组分类 / 存储 schema 迁移 / 备份清单派生 —— 定向验证（Node 沙箱，秒级）
   覆盖 A1 回灌（SUBJECT_GROUPS）与 Q2（注册表 + 幂等迁移）两处改动。 */
const fs = require('fs');
const path = require('path');
const SB = require('./_sandbox.cjs');
const E = SB.E, store = SB.store, doc = SB.document;

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? ' → ' + extra : '')); }
}
function shelf() { return doc.getElementById('shelf'); }
function kids(el) { return el.children || []; }
function groups() { return kids(shelf()).filter((c) => c.className === 'shelf-group'); }
function titleOf(g) { return (kids(g)[0] && kids(g)[0].textContent) || ''; }
function cardsOf(g) {
  const grid = kids(g).filter((c) => c.className === 'shelf')[0];
  return grid ? kids(grid).length : -1;
}

console.log('=== 1) 科目分组定义 ===');
const G = E.SUBJECT_GROUPS;
ok(Array.isArray(G) && G.length === 4, '恰好 4 个分组', G && G.length);
const all = [].concat.apply([], G.map((g) => g.sub));
const types = Object.keys(E.QA_TYPES).filter((k) => k !== 'online');
ok(new Set(all).size === all.length, '没有科目被重复登记');
ok(types.every((k) => all.indexOf(k) >= 0), '所有内置科目都进了组', types.filter((k) => all.indexOf(k) < 0).join(','));
ok(all.every((k) => !!E.QA_TYPES[k]), '组里没有不存在的科目', all.filter((k) => !E.QA_TYPES[k]).join(','));

console.log('=== 2) 书架真实渲染（init 已跑过一次 renderShelf） ===');
const gs = groups();
ok(gs.length === 5, '渲染出 5 个分组块（4 组科目 + 我的/联网）', gs.length);
ok(gs.slice(0, 4).map(titleOf).join('|') === '🔬 自然科学|📜 人文社科|🧠 生活百科|💻 信息技术',
  '4 组标题与顺序正确', gs.slice(0, 4).map(titleOf).join('|'));
ok(titleOf(gs[4] || {}) === '📚 我的 / 联网', '自定义 + 联网归入末尾分组', titleOf(gs[4] || {}));
const expectCards = [4, 4, 3, 1];
ok(gs.slice(0, 4).every((g, i) => cardsOf(g) === expectCards[i]),
  '各组卡片数 = 4/4/3/1', gs.slice(0, 4).map(cardsOf).join(','));
ok(cardsOf(gs[4] || {}) === 1, '无自定义题时该组只有联网卡', cardsOf(gs[4] || {}));
/* 兜底：新增一个没登记的科目，重渲染后不能消失 */
E.QA_TYPES.__probe_new = { name: '探针科目', icon: '🧪', alias: [], gen: function () { return []; } };
E.renderShelf();
const gs2 = groups();
function textOf(el) { return String(el.textContent || '') + kids(el).map(textOf).join(''); }
const orphan = kids(shelf()).filter((c) => c.className === 'shelf' && textOf(c).indexOf('探针科目') >= 0);
ok(gs2.length === 5 && orphan.length === 1, '未登记的新科目落到兜底网格，不消失', 'groups=' + gs2.length + ' orphan=' + orphan.length);
delete E.QA_TYPES.__probe_new;
E.renderShelf();

console.log('=== 3) 存储 schema 迁移（幂等 / 不伤合法数据） ===');
ok(E.STORE_SCHEMA === 2, '当前 schema 版本 = 2', E.STORE_SCHEMA);
delete store.bt_qa_schema;
store.bt_qa_stats = '{坏掉的 JSON';
store.bt_qa_weak = '{"not":"an array"}';
E.migrateStore();
ok(store.bt_qa_stats === '{}', '损坏的 stats 被重置为 {}', store.bt_qa_stats);
ok(store.bt_qa_weak === '[]', '类型不对的 weak 被重置为 []', store.bt_qa_weak);
ok(store.bt_qa_schema === '2', '迁移后写入 schema=2', store.bt_qa_schema);
/* 合法数据必须原样保留 */
const good = JSON.stringify({ 'b:math': { n: 9, c: 7 } });
store.bt_qa_stats = good;
delete store.bt_qa_schema;
E.migrateStore();
ok(store.bt_qa_stats === good, '合法 stats 迁移后逐字节不变', store.bt_qa_stats);
const before = store.bt_qa_stats;
E.migrateStore();
ok(store.bt_qa_stats === before && store.bt_qa_schema === '2', '再跑一次不产生任何写入（幂等）');

console.log('=== 4) 备份清单由注册表派生 ===');
const bk = E.BACKUP_KEYS;
ok(bk.indexOf('bt_qa_schema') >= 0, '备份包含 schema 版本键');
['bt_qa_stats', 'bt_qa_best', 'bt_qa_weak', 'bt_qa_custom', 'bt_qa_ai', 'bt_qa_extra', 'bt_qa_daily', 'bt_qa_profile_code']
  .forEach((k) => ok(bk.indexOf(k) >= 0, '备份包含 ' + k));
ok(bk.indexOf('bt_qa_music') < 0, '不备份音乐索引（b:0）');
store.bt_qa_rank_math = '100';
store.bt_qa_recent_code_x = '[]';
const keys = E.backupKeys();
ok(keys.indexOf('bt_qa_rank_math') >= 0 && keys.indexOf('bt_qa_recent_code_x') >= 0, '带前缀的动态键整族进备份', keys.join(','));
delete store.bt_qa_rank_math; delete store.bt_qa_recent_code_x;

console.log('=== 5) 源码里的存储键都在注册表 / 前缀表内（新增键必漏的反向守卫） ===');
function literals(file) {
  const s = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const out = {};
  const re = /['"](bt_qa_[a-z0-9_]*)['"]/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = 1;
  return Object.keys(out);
}
const regKeys = Object.keys(E.STORE_REG).map((n) => E.STORE_REG[n].k);
const prefixes = ['bt_qa_rank_', 'bt_qa_recent_'];
const known = regKeys.concat(['bt_qa_schema', 'bt_qa_']);
const unknown = [];
['../src/wrongbook.js', 'engine_core.js', 'quiz-ui.js'].forEach((f) => {
  literals(f).forEach((k) => {
    if (known.indexOf(k) >= 0) return;
    if (prefixes.some((p) => k.indexOf(p) === 0)) return;
    unknown.push(f + ':' + k);
  });
});
ok(unknown.length === 0, '没有游离在注册表外的 bt_qa_* 键', unknown.join(', '));

console.log('=== 6) 产物层面：死引用与缩放限制已清 ===');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok(html.indexOf('shared/tokens.css') < 0, '产物不再引用 shared/tokens.css');
ok(html.indexOf('user-scalable=no') < 0, 'viewport 不再禁缩放');
ok(html.indexOf('GENERATED') >= 0 || html.indexOf('生成文件') >= 0, '产物带「生成文件」标识');
ok((html.match(/shelf-group-title/g) || []).length >= 3, '产物含分组样式与渲染代码');

console.log('\n=== P0 定向验证：通过 ' + pass + '，失败 ' + fail + ' ===');
process.exit(fail ? 1 : 0);
