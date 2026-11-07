/**
 * Regenerate sw.js for all 12 games from tools/sw-template.js
 * (replaces the earlier cache-first-for-navigation version).
 */
import fs from 'node:fs';

const base = 'D:/Projects/_github_pages/ming-games/';
const games = ['wild','one-card','soudache','night-shift','brain-gym','circuit-lab',
               'grass-cutter','paper-maze','neon-rhythm','pixel-runner','shanhai','zhaoyun'];

const template = fs.readFileSync(base + 'tools/sw-template.js', 'utf8');

for (const dir of games) {
  const sw = template.split('<%= DIR %>').join(dir);
  fs.writeFileSync(base + dir + '/sw.js', sw, 'utf8');
  console.log(dir + ': sw.js regenerated (network-first navigation)');
}
console.log('done');
