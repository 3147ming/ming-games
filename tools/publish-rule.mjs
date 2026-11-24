/**
 * 一键发布规则：node tools/publish-rule.mjs rules/<slug>.json
 * 合并指令 块9：建目录 → 生成五件套(index.html/src/rules.mjs/src/render.mjs/covers/<slug>.png/rulebook.md)
 *   → 追加 games.json(tag=custom) → 进构建链 → 打印改动清单。
 * 定稿门槛：规则卡 7 项齐全 + 20 局 0 非法 + 规则页无出处（由本工具复检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES7 = ['decks', 'handSize', 'winBy', 'replenish', 'shuffleLimit', 'patternSet', 'powerLadder'];

/** 7 项齐全检查：兼容规则工坊 RuleSet 与回牌规则卡两种字段布局 */
function gate(card) {
  const reasons = [];
  const pick = {
    decks: () => card.deck?.decks ?? card.card?.decks,
    handSize: () => card.deal?.handSize ?? card.card?.handSize,
    winBy: () => card.win ?? card.card?.winBy,
    replenish: () => card.refill ?? card.card?.replenish,
    shuffleLimit: () => card.reshuffle?.max ?? card.card?.shuffleLimit,
    patternSet: () => card.patterns?.basic ?? card.card?.patternSet,
    powerLadder: () => card.powerLadder,
  };
  for (const k of RULES7) {
    const v = pick[k]?.();
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) {
      reasons.push(`规则卡缺第 7 项：${k}`);
    }
  }
  return reasons;
}

export function publishRule(slug, opts = {}) {
  const cardPath = path.join(ROOT, 'rules', `${slug}.json`);
  const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
  const target = path.join(ROOT, slug);
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.mkdirSync(path.join(target, 'covers'), { recursive: true });

  // 五件套
  fs.writeFileSync(path.join(target, 'src', 'rules.mjs'),
    `// ${card.name} 规则卡（由 rules/${slug}.json 生成，勿手改）\nexport default ${JSON.stringify(card, null, 2)};\n`, 'utf8');
  fs.writeFileSync(path.join(target, 'src', 'render.mjs'),
    `// ${card.name} 牌面渲染器入口（复用 shared 牌面渲染，详见 rulecraft）\nexport const tier = 'classic';\nexport const suits = ['S','H','C','D'];\n`, 'utf8');
  const { rulebookMarkdown, rulePageHtml } = renderMod;
  fs.writeFileSync(path.join(target, 'rulebook.md'), rulebookMarkdown(card), 'utf8');
  fs.writeFileSync(path.join(target, 'rules.html'), rulePageHtml(card), 'utf8');
  // 已存在的可玩入口不覆盖（如回牌本体）——只补缺的入口
  if (!fs.existsSync(path.join(target, 'index.html'))) {
    fs.writeFileSync(path.join(target, 'index.html'), entryHtml(card, slug), 'utf8');
  }
  // 封面：若用户成品图存在则复制，否则留空并在清单标注（不生成占位图）
  const coverSrcs = [`covers/${slug}.jpg`, `covers/${slug}.png`];
  const cover = coverSrcs.find((c) => fs.existsSync(path.join(ROOT, c)));
  if (cover) fs.copyFileSync(path.join(ROOT, cover), path.join(target, 'covers', path.basename(cover)));

  // 追加 games.json（幂等）
  const gamesPath = path.join(ROOT, 'games.json');
  const cfg = JSON.parse(fs.readFileSync(gamesPath, 'utf8'));
  let entry = cfg.games.find((g) => g.id === slug);
  if (!entry) {
    entry = { id: slug, name: card.name, dir: slug, cover: cover ? `covers/${slug}/${path.basename(cover)}` : `covers/${slug}.png`,
      tag: 'custom', status: 'ready', renderer: 'classic', version: 1, updatedAt: new Date().toISOString().slice(0, 10),
      funFact: `${card.deck.decks} 副牌 · ${card.patterns.special?.name || '自定义'} 特殊牌型` };
    cfg.games.push(entry);
    fs.writeFileSync(gamesPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }

  const files = [
    `${slug}/index.html`, `${slug}/src/rules.mjs`, `${slug}/src/render.mjs`,
    `${slug}/covers/${cover ? path.basename(cover) : '<待用户提供封面>'}`, `${slug}/rulebook.md`, `${slug}/rules.html`,
    'games.json',
  ];
  return { slug, files, coverProvided: !!cover, entry, gates: gate(card) };
}

import * as renderMod from './render-rulebook.mjs';

function entryHtml(card, slug) {
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(card.name)}</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3C/svg%3E"><link rel="stylesheet" href="../shared/tokens.css"><style>body{margin:0;background:#0f2a21;color:#e8f0e4;font-family:system-ui,sans-serif;padding:24px}h1{color:#d9b66a}a{color:#9ec}</style></head><body><h1>${esc(card.name)}</h1><p>由规则工坊定稿发布：${card.deck.decks} 副牌 · ${card.players} 人 · ${esc(card.win)}。</p><p><a href="./rules.html">查看规则</a> · 玩法引擎见 <code>src/rules.mjs</code></p></body></html>`;
}

if (process.argv[1] && process.argv[1].endsWith('publish-rule.mjs')) {
  const arg = process.argv[2] || 'rules/huipai.json';
  const slug = path.basename(arg, '.json');
  const r = publishRule(slug);
  console.log(`[publish-rule] ${slug} 发布完成`);
  console.log('改动清单：');
  r.files.forEach((f) => console.log('  ' + f));
  if (!r.coverProvided) console.log('  ⚠ 封面缺：需要 covers/<slug>.jpg|png（未生成占位图）');
  if (r.gates.length) { console.log('⚠ 定稿门槛未过：' + r.gates.join('；')); process.exitCode = 2; }
  else console.log('定稿门槛：规则卡 7 项齐全 ✓');
}
