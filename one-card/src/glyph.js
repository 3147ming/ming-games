// 程序化剪影生成
// 口径：美术零素材。所有敌人形象由 shape 种子确定性生成「极简剪影」——
//      这直接兑现了阶段 0 的美术风格决策（零位图、零外部产能），
//      也让「加一个敌人」的美术成本归零。

const PALETTE = {
  normal: '#8d8378',
  elite: '#c2703f',
  boss: '#d1544a',
};

function lcg(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 生成一个左右对称的剪影路径（返回 SVG path 的 d 字符串，坐标在 0~100 的 viewBox）。
 * 结构：以中轴为镜像，右半边取 N 个极坐标点，半径受种子噪声扰动 → 得到有机的怪物轮廓。
 * 阶段 6 导出：荒野关的敌人剪影复用同一套生成逻辑（零素材、零额外美术成本）。
 */
export function silhouette(shape, spikes) {
  const rnd = lcg(shape);
  const N = 9 + (shape % 4);
  const right = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const angle = -Math.PI / 2 + t * Math.PI; // 从顶部扫到底部
    let r = 30 + rnd() * 22;
    if (spikes && i % 2 === 1) r += 6 + rnd() * 8; // 尖刺
    const x = Math.cos(angle) * r * 0.72;
    const y = Math.sin(angle) * r * 1.28;
    right.push([x, y]);
  }
  const pts = [
    ...right.map(([x, y]) => [50 + x, 46 + y]),
    ...right.slice().reverse().map(([x, y]) => [50 - x, 46 + y]),
  ];
  return 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L') + 'Z';
}

export function glyphSvg(enemy) {
  const shape = enemy.shape || 1;
  const tier = enemy.tier || 'normal';
  const color = PALETTE[tier] || PALETTE.normal;
  const spikes = tier === 'elite' || tier === 'boss';
  const d = silhouette(shape, spikes);

  const rnd = lcg(shape * 7 + 3);
  const eyeCount = tier === 'boss' ? 3 : 2;
  const eyes = [];
  for (let i = 0; i < eyeCount; i++) {
    const off = eyeCount === 1 ? 0 : (i - (eyeCount - 1) / 2) * 9;
    const y = 34 + rnd() * 6;
    eyes.push(`<circle cx="${(50 + off).toFixed(1)}" cy="${y.toFixed(1)}" r="${tier === 'boss' ? 3 : 2.2}" fill="#0d0c0b"/>`);
  }

  const crown =
    tier === 'boss'
      ? `<path d="M32 20 L50 4 L68 20" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`
      : '';

  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="${d}" fill="${color}" opacity="0.92"/>
  ${crown}
  ${eyes.join('')}
</svg>`;
}

export function glyphColor(tier) {
  return PALETTE[tier] || PALETTE.normal;
}

/** 卡牌流派的图形符号（矢量化，零素材） */
export function archetypeMark(archetype) {
  switch (archetype) {
    case 'blade':
      return '<path d="M12 2 L15 16 L12 22 L9 16 Z" fill="currentColor"/>';
    case 'frost':
      return '<path d="M12 3 L19 9 L12 21 L5 9 Z" fill="none" stroke="currentColor" stroke-width="2"/>';
    case 'rot':
      return '<circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/>';
    case 'flux':
      return '<path d="M12 2 A10 10 0 1 1 11.9 2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2 L12 8" stroke="currentColor" stroke-width="2"/>';
    default:
      return '<rect x="8" y="8" width="8" height="8" fill="currentColor"/>';
  }
}
