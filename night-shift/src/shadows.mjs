/**
 * PCSS 软阴影（批五 R3，参考件 game.js 3937 的 `SALTLINE_SHADOW` 段移植）
 *
 * ── 为什么不再用 three 自带的 PCF ─────────────────────────
 * PCF 的模糊核是**固定大小**的：靠近遮挡物的硬边和远处的软边一样宽，
 * 于是要么处处发糊，要么处处锯齿。PCSS 按"遮挡物到接收面的距离"决定半影宽度 ——
 * 贴着地面的货架投出锐利的边，离地高的灯罩投出很软的边，这才是真的软阴影。
 *
 * ── 实现方式：改写 three 的 shader chunk ──────────────────
 * 项目没有 examples/jsm（ADR-001/004），不能换 ShadowMap 实现，
 * 所以只能把 `ShaderChunk.shadowmap_pars_fragment` 里的 `getShadow` 换掉。
 * ⚠ 这是**版本耦合**的：three 升级后函数签名/内部依赖可能变。
 *   因此：
 *     ① 找不到函数就返回 { ok:false }，静默退回 stock PCF（绝不抛）；
 *     ② 找不到 unpackRGBAToDepth 也退回（PCSS 需要读原始深度）；
 *     ③ 只在开启阴影的档位启用（默认桌面 high，触屏关闭）。
 *
 * ── 一条已知的良性告警（不要"顺手修"）─────────────────────
 * PCSS 必须在循环里采样深度图，ANGLE 会报
 *   `warning X3595: gradient instruction used in a loop ... partial derivatives may be undefined`。
 * 可以忽略：阴影图是 NearestFilter 且没有 mip 链，隐式 LOD 恒等于 LOD 0，
 * "导数未定义"在这里没有可观察后果。真要消掉只能改用 textureLod（GLSL ES 3.00 专属），
 * 那会让 WebGL1 兜底路径直接编译失败 —— 得不偿失。
 */

/** 括号配平：从 `float getShadow(` 找到函数体的结束位置 */
function findFunctionEnd(src, start) {
  const open = src.indexOf('{', start);
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * 安装 PCSS。必须在任何材质**首次编译之前**调用。
 * @param THREE   three 命名空间（用 ShaderChunk）
 * @param opts    { depthMeters, widthMeters, blockers, taps }
 * @returns { ok, reason? }
 */
export function installSoftShadows(THREE, opts = {}) {
  const depthMeters = Number(opts.depthMeters) || 11.5;
  const widthMeters = Number(opts.widthMeters) || 10.0;
  const blockers = Math.max(4, Math.min(16, opts.blockers ?? 8));
  const taps = Math.max(6, Math.min(24, opts.taps ?? 12));

  let src = '';
  try {
    src = THREE.ShaderChunk.shadowmap_pars_fragment || '';
  } catch {
    return { ok: false, reason: 'no-chunk' };
  }
  if (!src) return { ok: false, reason: 'no-chunk' };
  const start = src.indexOf('float getShadow(');
  if (start < 0) return { ok: false, reason: 'no-getShadow' };
  if (src.indexOf('unpackRGBAToDepth') < 0) return { ok: false, reason: 'no-unpack' };
  const end = findFunctionEnd(src, start);
  if (end < 0) return { ok: false, reason: 'no-fn-end' };

  const fn = /* glsl */`
float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  shadowCoord.xyz /= shadowCoord.w;
  vec3 sc = shadowCoord.xyz;
  if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;

  // 接收面在阴影图 uv 空间里的深度梯度（解决斜面的自阴影条纹，替代"加大 bias"）
  vec3 dx = dFdx( sc ), dy = dFdy( sc );
  float det = dx.x * dy.y - dx.y * dy.x;
  vec2 dz = vec2( 0.0 );
  if ( abs( det ) > 1e-12 ) dz = vec2( dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z ) / det;
  vec2 texel = 1.0 / shadowMapSize;
  float maxSlope = 0.0032 / max( texel.x, texel.y );
  dz = clamp( dz, vec2( - maxSlope ), vec2( maxSlope ) );
  float zr = sc.z + shadowBias - ( abs( dz.x ) * texel.x + abs( dz.y ) * texel.y ) * 0.35;

  // IGN + 黄金角螺旋：固定采样数也不会出现规则的带状伪影
  float phi = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
  float searchTexels = max( 1.5, shadowRadius * 0.55 );

  // ---- 遮挡物搜索 ----
  float blk = 0.0, nb = 0.0;
  for ( int i = 0; i < ${blockers}; i ++ ) {
    float r = sqrt( ( float( i ) + 0.5 ) / float( ${blockers} ) );
    float th = float( i ) * 2.39996323 + phi;
    vec2 o = r * vec2( cos( th ), sin( th ) ) * searchTexels * texel;
    float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
    float z = zr + dot( o, dz );
    if ( d < z ) { blk += d; nb += 1.0; }
  }
  if ( nb < 0.5 ) return 1.0;

  // ---- 半影宽度：遮挡物越远越软 ----
  float avg = blk / nb;
  float distM = max( zr - avg, 0.0 ) * ${depthMeters.toFixed(3)};
  float penM = clamp( distM * 0.055, 0.015, 0.75 );
  float filterTexels = clamp( penM / ${widthMeters.toFixed(3)} * shadowMapSize.x, 0.75, 22.0 );

  // ---- 过滤 ----
  float lit = 0.0;
  for ( int i = 0; i < ${taps}; i ++ ) {
    float r = sqrt( ( float( i ) + 0.5 ) / float( ${taps} ) );
    float th = float( i ) * 2.39996323 + phi * 1.7;
    vec2 o = r * vec2( cos( th ), sin( th ) ) * filterTexels * texel;
    float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
    lit += ( d < zr + dot( o, dz ) ) ? 0.0 : 1.0;
  }
  return lit / float( ${taps} );
}
`;

  const patched = src.slice(0, start) + fn + src.slice(end);
  try {
    THREE.ShaderChunk.shadowmap_pars_fragment = patched;
  } catch {
    return { ok: false, reason: 'readonly' };
  }
  return { ok: true, blockers, taps };
}

/** 恢复 stock PCF（测试/回滚用；正常游戏流程不需要） */
export function uninstallSoftShadows(THREE, original) {
  if (original) THREE.ShaderChunk.shadowmap_pars_fragment = original;
}
