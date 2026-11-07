/**
 * Scan ming-games HTML for malformed <input> tags.
 *
 * A well-formed input tag is `<input ...>` or `<input ... />`; the tag must end
 * before the next "<" starts. If it doesn't, the following element's markup is
 * swallowed as attributes of the input and that element never reaches the DOM.
 *
 * Fragments inside <script> blocks are skipped: those are JS string literals the
 * game turns into markup at runtime, and the regex cannot tell markup from code.
 */
import fs from 'node:fs';

const base = 'D:/Projects/_github_pages/ming-games/';
const games = ['wild','one-card','soudache','night-shift','brain-gym','circuit-lab','quiz',
               'grass-cutter','paper-maze','neon-rhythm','pixel-runner','shanhai','zhaoyun'];

/** Return the HTML with all <script>…</script> blocks blanked out (length preserved). */
function stripScripts(html) {
  const out = html.split('');
  const re = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    for (let i = m.index; i < m.index + m[0].length; i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  }
  return out.join('');
}

let total = 0;
for (const g of games) {
  const raw = fs.readFileSync(base + g + '/index.html', 'utf8');
  const c = stripScripts(raw);
  const bad = [];

  // Match "<input" up to the next "<" (or end of string).
  const re = /<input\b[^<]*/gi;
  let m;
  while ((m = re.exec(c)) !== null) {
    const frag = m[0].trimEnd();
    // The fragment must end with ">" or "/>".
    if (!/>\s*\/?$/.test(frag)) {
      const line = raw.slice(0, m.index).split('\n').length;
      bad.push({ line, frag: frag.trim().slice(0, 110) });
    }
  }

  if (bad.length) {
    total += bad.length;
    console.log(`\n${g}: ${bad.length} malformed <input>`);
    for (const b of bad) console.log(`  line ${b.line}: ${b.frag}`);
  }
}

console.log(total === 0
  ? '\nOK: no malformed <input> tags in any game'
  : `\n${total} malformed <input> tags remain`);
process.exit(total === 0 ? 0 : 1);
