/* M3：题库权威数据 = quiz/data/pools.json。
   职责：
   1) load()       读 JSON；
   2) validate()   构建前校验字段 / 选项 / 去重 / 语言标签（不合规直接阻断构建）；
   3) js()         序列化成注入产物的 `var POOLS=...;`；
   4) fromCore()   从 src/engine_core.js 抽出「离线可直跑镜像」的字面量并求值；
   5) assertMatchesCore() 强制镜像与 JSON 逐字节语义一致，杜绝两份数据漂移；
   6) CLI：`node _pools.cjs --check`（只校验）/ `--sync`（把 JSON 回写进 core 镜像）。

   为什么 core 里还留一份字面量：9 个 Node 探针直接装配 engine_core.js（不起浏览器、不跑构建），
   必须能拿到题库。它由 --sync 从 JSON 生成、由构建期断言锁死，不是可手改的第二真相。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'pools.json');
const CORE = path.join(ROOT, 'src', 'engine_core.js');
const START = 'var POOLS={';
const END = '\n};;';

function load() {
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}
function readCore() {
  return fs.readFileSync(CORE, 'utf8');
}
function coreBlock(coreText) {
  const a = coreText.indexOf(START);
  const b = coreText.indexOf(END, a + START.length);
  if (a < 0 || b < 0) throw new Error('engine_core.js 的 POOLS 块锚点缺失（应保持 `var POOLS={` 与 `};;` 结尾）');
  return { start: a, end: b + END.length, literal: coreText.slice(a + 'var POOLS='.length, b + 2) };
}
function fromCore(coreText) {
  return vm.runInNewContext('(' + coreBlock(coreText || readCore()).literal + ')');
}
function js(data) {
  return 'var POOLS=' + JSON.stringify(data) + ';';
}
function assertMatchesCore(coreText) {
  const data = load();
  const mirror = fromCore(coreText);
  const a = JSON.stringify(data), b = JSON.stringify(mirror);
  if (a !== b) {
    throw new Error('题库镜像与 data/pools.json 不一致：改完 JSON 请执行 node quiz/.build/_pools.cjs --sync');
  }
  return true;
}

/* 普通分类的 tag 必须等于分类名；code 分类的 tag 是语言标记（白名单由 _probe_pools.cjs
   用沙箱里的 CODE_LANGS 交叉校验，这里只做格式约束，避免构建脚本反向依赖 UI 层）。 */
const CODE_TAG_RE = /^[a-z]+$/;
function validate(data) {
  const errs = [];
  const stats = { subjects: 0, questions: 0, withDistractors: 0, withCandidates: 0, plain: 0, meta: 0, byTag: {} };
  if (!data || typeof data !== 'object' || Array.isArray(data)) { errs.push('pools.json 顶层必须是对象'); return { errs, stats }; }
  Object.keys(data).forEach(function (k) {
    const v = data[k];
    const groups = Array.isArray(v) ? { flat: v } : v;
    stats.subjects++;
    Object.keys(groups).forEach(function (g) {
      const list = groups[g];
      if (!Array.isArray(list)) { errs.push(k + '/' + g + ' 不是数组'); return; }
      const seen = {};
      list.forEach(function (it, i) {
        const where = k + '/' + g + '#' + i;
        stats.questions++;
        if (!Array.isArray(it) || it.length < 3) { errs.push(where + ' 结构不完整（需 [题干,答案,tag]）'); return; }
        const q = it[0], a = it[1], tag = it[2];
        if (typeof q !== 'string' || !q.trim()) errs.push(where + ' 题干为空');
        if (typeof a !== 'string' || !a.trim()) errs.push(where + ' 答案为空');
        if (typeof tag !== 'string' || !tag.trim()) errs.push(where + ' 缺语言/分类标签');
        else {
          stats.byTag[tag] = (stats.byTag[tag] || 0) + 1;
          if (k === 'code') {
            if (!CODE_TAG_RE.test(tag)) errs.push(where + ' code 题标签非法: ' + tag);
          } else if (tag !== k) errs.push(where + ' 标签与分类不一致: ' + tag + ' ≠ ' + k);
        }
        if (seen[q]) errs.push(where + ' 题干重复: ' + q);
        seen[q] = 1;
        const w = it[3];
        if (w == null) { stats.plain++; }
        else {
          if (typeof w !== 'string' || !w.trim()) { errs.push(where + ' 干扰项不是字符串'); return; }
          const opts = w.split('|');
          const uniq = {};
          let dup = false;
          opts.forEach(function (o) { const key = String(o).trim(); if (uniq[key]) dup = true; uniq[key] = 1; });
          if (dup) errs.push(where + ' 选项重复');
          const hasA = opts.indexOf(a) >= 0;
          if (opts.length === 3 && !hasA) stats.withDistractors++;
          else if (opts.length === 4 && hasA) stats.withCandidates++;
          else errs.push(where + ' 选项形态非法（应为 3 干扰项不含答案，或 4 候选含答案）：' + opts.length + '/' + hasA);
        }
        const m = it[4];
        if (m != null) {
          stats.meta++;
          if (typeof m !== 'object' || Array.isArray(m)) errs.push(where + ' meta 不是对象');
          else if (m.exp != null && typeof m.exp !== 'string') errs.push(where + ' meta.exp 不是字符串');
          else if (m.src != null && typeof m.src !== 'string') errs.push(where + ' meta.src 不是字符串');
        }
      });
    });
  });
  return { errs, stats };
}

function sync() {
  const data = load();
  const v = validate(data);
  if (v.errs.length) { console.error('题库校验不通过，拒绝回写：\n  ' + v.errs.slice(0, 20).join('\n  ')); process.exit(1); }
  const core = readCore();
  const b = coreBlock(core);
  const next = core.slice(0, b.start) + 'var POOLS=' + JSON.stringify(data, null, 2) + ';;' + core.slice(b.end);
  fs.writeFileSync(CORE, next, 'utf8');
  console.log('已回写 src/engine_core.js 的 POOLS 镜像（' + v.stats.questions + ' 题），请重新构建');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const data = load();
  const v = validate(data);
  if (v.errs.length) {
    console.error('题库校验失败 ' + v.errs.length + ' 项：\n  ' + v.errs.slice(0, 30).join('\n  '));
    process.exit(1);
  }
  if (args.indexOf('--sync') >= 0) { sync(); process.exit(0); }
  assertMatchesCore(readCore());
  console.log('题库校验通过：' + v.stats.subjects + ' 分类 / ' + v.stats.questions + ' 题' +
    '（3 干扰项 ' + v.stats.withDistractors + ' · 4 候选 ' + v.stats.withCandidates +
    ' · 无定制 ' + v.stats.plain + ' · 带解析 ' + v.stats.meta + '）');
  console.log('core 镜像与 data/pools.json 一致；产物将由 JSON 序列化注入');
}

module.exports = { load, validate, js, fromCore, coreBlock, assertMatchesCore, sync, DATA, CORE };
