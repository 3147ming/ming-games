/**
 * Fix malformed <input> tags across ming-games.
 *
 * Bug: several games write inputs as
 *     <input id="x" ... value="0"
 *   <b id="x-val">0 ms</b>
 * i.e. the tag is never closed (or closed with a bare "/"). The HTML parser then
 * treats the *next* element's markup as attributes of the input, so that element
 * never exists in the DOM — and any JS that touches it throws.
 *
 * Fix: close the input tag with ">" (or "/>").
 *
 * Each fix is listed explicitly (file + exact old text -> new text) so nothing
 * is rewritten by accident.
 */
import fs from 'node:fs';
const base = 'D:/Projects/_github_pages/ming-games/';

const fixes = [
  // ---- wild ----
  ['wild/index.html',
   `<input id="acct-name" class="acct-name" maxlength="16" placeholder="点此起名" aria-label="玩家名称" /`,
   `<input id="acct-name" class="acct-name" maxlength="16" placeholder="点此起名" aria-label="玩家名称" />`],
  ['wild/index.html',
   `<input id="audio-vol" class="audio-range" type="range" min="0" max="100" step="1" value="100"
                     aria-label="主音量" aria-valuetext="100%" /`,
   `<input id="audio-vol" class="audio-range" type="range" min="0" max="100" step="1" value="100"
                     aria-label="主音量" aria-valuetext="100%" />`],

  // ---- one-card ----
  ['one-card/index.html',
   `<input id="sfx-vol" class="sfx-range" type="range" min="0" max="100" step="1" value="100"
                 aria-label="主音量" aria-valuetext="100%" /`,
   `<input id="sfx-vol" class="sfx-range" type="range" min="0" max="100" step="1" value="100"
                 aria-label="主音量" aria-valuetext="100%" />`],

  // ---- brain-gym (JS string literals) ----
  ['brain-gym/index.html',
   `<input id="bgmVol" type="range" min="0" max="100" aria-label="背景音量" value="'+Math.round(getVol()*100)+'"';`,
   `<input id="bgmVol" type="range" min="0" max="100" aria-label="背景音量" value="'+Math.round(getVol()*100)+'" />';`],
  ['brain-gym/index.html',
   `<input id="tcFc" type="number" min="1" max="120" value="'+focusMin+'" 分</label>`,
   `<input id="tcFc" type="number" min="1" max="120" value="'+focusMin+'" /> 分</label>`],
  ['brain-gym/index.html',
   `<input id="tcBr" type="number" min="1" max="60" value="'+breakMin+'" 分</label>`,
   `<input id="tcBr" type="number" min="1" max="60" value="'+breakMin+'" /> 分</label>`],
  ['brain-gym/index.html',
   `<input id="tcRn" type="number" min="1" max="12" value="'+rounds+'"</label>`,
   `<input id="tcRn" type="number" min="1" max="12" value="'+rounds+'" /></label>`],

  // ---- circuit-lab ----
  ['circuit-lab/index.html',
   `<input type="file" id="file-input" accept=".json,application/json" hidden`,
   `<input type="file" id="file-input" accept=".json,application/json" hidden />`],
  ['circuit-lab/index.html',
   `<input type="checkbox" id="hep-opt-silk" checked aria-label="丝绸材质"`,
   `<input type="checkbox" id="hep-opt-silk" checked aria-label="丝绸材质" />`],
  ['circuit-lab/index.html',
   `<input type="checkbox" id="hep-opt-teach" aria-label="教学模式"`,
   `<input type="checkbox" id="hep-opt-teach" aria-label="教学模式" />`],

  // ---- grass-cutter ----
  ['grass-cutter/index.html',
   `<input id="audio-vol" class="au-range" type="range" min="0" max="100" step="1" value="100"
           aria-label="主音量" aria-valuetext="100%" /`,
   `<input id="audio-vol" class="au-range" type="range" min="0" max="100" step="1" value="100"
           aria-label="主音量" aria-valuetext="100%" />`],

  // ---- paper-maze ----
  ['paper-maze/index.html',
   `<input class="vol-range" id="volRange" type="range" min="0" max="100" step="1" value="100"
               aria-label="主音量" aria-valuetext="100%"`,
   `<input class="vol-range" id="volRange" type="range" min="0" max="100" step="1" value="100"
               aria-label="主音量" aria-valuetext="100%" />`],

  // ---- neon-rhythm ----
  ['neon-rhythm/index.html',
   `<input type="range" id="set-offset" min="-200" max="200" step="5" value="0" aria-label="音频偏移（毫秒）"`,
   `<input type="range" id="set-offset" min="-200" max="200" step="5" value="0" aria-label="音频偏移（毫秒）" />`],
  ['neon-rhythm/index.html',
   `<input type="range" id="set-volume" min="0" max="100" step="5" value="80" aria-label="音量"`,
   `<input type="range" id="set-volume" min="0" max="100" step="5" value="80" aria-label="音量" />`],

  // ---- pixel-runner ----
  ['pixel-runner/index.html',
   `<input type="range" id="set-vol" min="0" max="100" step="5" value="70" aria-label="音量"`,
   `<input type="range" id="set-vol" min="0" max="100" step="5" value="70" aria-label="音量" />`],

  // ---- zhaoyun ----
  ['zhaoyun/index.html',
   `<input class="vol-range" id="vol-range" type="range" min="0" max="100" step="5" value="100"
               aria-label="主音量" aria-valuetext="100%" /`,
   `<input class="vol-range" id="vol-range" type="range" min="0" max="100" step="5" value="100"
               aria-label="主音量" aria-valuetext="100%" />`],
];

let ok = 0, miss = 0;
for (const [file, oldText, newText] of fixes) {
  const p = base + file;
  let c = fs.readFileSync(p, 'utf8');
  if (!c.includes(oldText)) {
    console.log('MISS  ' + file + ' :: ' + oldText.split('\n')[0].trim().slice(0, 70));
    miss++;
    continue;
  }
  if (c.includes(newText)) {
    console.log('SKIP  ' + file + ' :: already fixed');
    ok++;
    continue;
  }
  c = c.replace(oldText, newText);
  fs.writeFileSync(p, c, 'utf8');
  console.log('FIXED ' + file + ' :: ' + oldText.split('\n')[0].trim().slice(0, 70));
  ok++;
}

console.log(`\n${ok} applied, ${miss} missed`);
