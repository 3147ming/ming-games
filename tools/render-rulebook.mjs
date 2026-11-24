/**
 * rules/<slug>.json → rulebook.md / rules.html（合并指令 块7/块9）
 * 规则页只渲染规则卡本身，绝不补出处、文献、备选。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

export function rulebookMarkdown(card) {
  const L = [`# ${card.name} · 规则`, ''];
  L.push(`- 人数：${card.players} 人`);
  L.push(`- 牌：${card.deck.decks} 副共 ${card.deck.total} 张（含 ${card.deck.jokers} 张大小王）`);
  L.push(`- 开局：每人 ${card.deal.handSize} 张，余 ${card.deal.pile} 张作牌堆；首局随机定首出，此后由上一局第一个出完者先出`);
  L.push('', '## 基本牌型', '');
  (card.patterns.basic || []).forEach((p) => L.push(`- ${p}`));
  L.push('', '## 特殊牌型', '');
  const sp = card.patterns.special;
  L.push(`- ${sp.name}：${sp.cards.join('、')} 各一张共 ${sp.count} 张，${sp.rule}`);
  L.push('', '## 牌力阶梯（从小到大）', '');
  L.push('```', card.powerLadder.join(' < '), '```');
  L.push('');
  L.push(`- 花色强弱：${Object.entries(card.suitStrength).map(([k, v]) => `${k}=${v}`).join(' < ')}`);
  L.push(`- ${card.suitRule.threeDifferent}；${card.suitRule.threeSame}；${card.suitRule.twoSameOneDiff}`);
  L.push(`- ${card.suitRule.sameTierTie}`);
  L.push('', '## 比较与点数', '');
  L.push(`- 点数：${card.rankOrder}`);
  L.push(`- ${card.compareRule}`);
  L.push('', '## 补给 / 洗牌 / 胜负', '');
  L.push(`- 补给：第 1 名 ${card.refill.winner} 张，其余各 ${card.refill.others} 张`);
  L.push(`- 洗牌：牌堆抽空则弃牌洗回，最多 ${card.reshuffle.max} 次；${card.reshuffle.after}`);
  L.push(`- 胜负：${card.win}`);
  L.push(`- 和棋：${card.draw}；计分：${card.score}`);
  L.push('', '## 边缘细则', '');
  (card.edges || []).forEach((e, i) => L.push(`${i + 1}. ${e}`));
  return L.join('\n') + '\n';
}

export function rulePageHtml(card) {
  const md = rulebookMarkdown(card);
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const lines = md.split('\n');
  let body = '', list = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { if (list) { body += `</ul>`; list = null; } continue; }
    if (l.startsWith('# ')) { body += `<h1>${esc(l.slice(2))}</h1>`; continue; }
    if (l.startsWith('## ')) { if (list) { body += '</ul>'; list = null; } body += `<h2>${esc(l.slice(3))}</h2>`; continue; }
    if (l.startsWith('```')) { body += `<pre>`; continue; }
    if (l.startsWith('- ')) {
      if (!list) { body += '<ul>'; list = true; }
      body += `<li>${esc(l.slice(2))}</li>`; continue;
    }
    if (/^\d+\.\s/.test(l)) {
      if (!list) { body += '<ol>'; list = 'ol'; }
      body += `<li>${esc(l.replace(/^\d+\.\s/, ''))}</li>`; continue;
    }
    if (l.startsWith('<') && list === null) { body += `<pre>${esc(l)}`; continue; }
    if (l === '```') continue;
    if (body.includes('<pre>') && !body.endsWith('</pre>')) { body += `${esc(l)}</pre>`; continue; }
    body += `<p>${esc(l)}</p>`;
  }
  if (list) body += `</ul>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(card.name)} · 规则</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='10' fill='%23f3ead8'/%3E%3C/svg%3E"><link rel="stylesheet" href="../shared/tokens.css"><style>*{box-sizing:border-box}body{margin:0;background:#0f2a21;color:#e8f0e4;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;line-height:1.75}.wrap{max-width:760px;margin:0 auto;padding:18px 16px 40px}h1{font-size:22px;color:#d9b66a}h2{font-size:16px;color:#e4c98c;margin-top:20px}li{margin:3px 0}pre{background:#0a2119;border:1px solid #3e6a53;border-radius:8px;padding:10px;overflow-x:auto;color:#f4e6b0;font-size:12px}.back{display:inline-block;min-height:44px;line-height:44px;padding:0 16px;border:1px solid #6b5839;border-radius:10px;color:#f3e9d4;text-decoration:none}a{color:#9ec}</style></head><body><div class="wrap"><p><a class="back" href="./index.html">← 返回牌桌</a></p>${body}</div></body></html>`;
}

if (process.argv[1] && process.argv[1].endsWith('render-rulebook.mjs')) {
  const slug = process.argv[2] || 'huipai';
  const card = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules', `${slug}.json`), 'utf8'));
  const target = path.join(ROOT, slug);
  fs.writeFileSync(path.join(target, 'rulebook.md'), rulebookMarkdown(card), 'utf8');
  fs.writeFileSync(path.join(target, 'rules.html'), rulePageHtml(card), 'utf8');
  console.log(`[render-rulebook] ${slug}: rulebook.md + rules.html 由规则卡生成（无出处/文献/备选）`);
}
