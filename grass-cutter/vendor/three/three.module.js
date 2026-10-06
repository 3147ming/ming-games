/**
 * ⚠ 本文件由 tools/sync-deploy.mjs **自动生成**，不要手改。
 *    （开发时这个路径上放的是 three 的原始文件；只有部署包里它才是解析器。）
 *
 * 为什么需要它：surge 从本机只有 ~10KB/s，1.27MB 的 three 会被中途掐断
 *   （net::ERR_CONNECTION_RESET → 页面全黑）。所以按"快源优先"依次尝试，
 *   每档带超时 + 长度校验，全部失败才抛错（错误里列出每一档的具体原因）。
 */
const CANDIDATES = [
  { url: 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js', ms: 8000 },
  { url: 'https://unpkg.com/three@0.160.1/build/three.module.js', ms: 10000 },
  { url: new URL('./three.module.full.js', import.meta.url).href, ms: 40000 },
];

async function loadFrom(url, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('超时 ' + ms + 'ms')), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const len = Number(res.headers.get('content-length'));
    // 长度校验：截断的模块会以"语法错误"的形式爆炸，比这里直接判掉难查得多。
    // ⚠ 只在**没有压缩**时才能比 —— 有 content-encoding 时 content-length 是压缩后的长度，
    //   而 arrayBuffer() 给的是解压后的字节数，直接比会把正常的 gzip 响应误判成"截断"
    //   （实测踩过：jsdelivr 返回 gzip 255KB / 解压 1243KB，于是白白降级到下一档源）。
    const encoded = res.headers.get('content-encoding');
    if (!encoded && Number.isFinite(len) && len > 0 && buf.byteLength !== len) {
      throw new Error('传输被截断：' + buf.byteLength + '/' + len + ' 字节');
    }
    if (buf.byteLength < 100000) {
      // three 无论怎么压都不可能小于 100KB；这么小只可能是拿到了一张错误页
      throw new Error('返回内容可疑，仅 ' + buf.byteLength + ' 字节');
    }
    const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
    return await import(/* @vite-ignore */ blobUrl);
  } finally {
    clearTimeout(timer);
  }
}

let mod = null;
const failures = [];
for (const c of CANDIDATES) {
  try {
    mod = await loadFrom(c.url, c.ms);
    if (typeof window !== 'undefined') window.__THREE_SOURCE__ = c.url;
    break;
  } catch (err) {
    failures.push(c.url + ' → ' + (err && err.message ? err.message : String(err)));
  }
}
if (!mod) {
  throw new Error('three.js 加载失败，三个来源都不可用：\n' + failures.join('\n'));
}

export const {
  ACESFilmicToneMapping,
  ARTS,
  AdditiveBlending,
  AmbientLight,
  AnimationClip,
  AnimationMixer,
  AxesHelper,
  BackSide,
  Bone,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  ClampToEdgeWrapping,
  Clock,
  Color,
  ColorManagement,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  FileLoader,
  Float32BufferAttribute,
  Fog,
  FogExp2,
  FrontSide,
  Group,
  HalfFloatType,
  INKFX,
  IcosahedronGeometry,
  ImageBitmapLoader,
  InstancedBufferAttribute,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Interpolant,
  InterpolateDiscrete,
  InterpolateLinear,
  LOD,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearMipmapNearestFilter,
  LinearSRGBColorSpace,
  Loader,
  LoaderUtils,
  MUSOU,
  Material,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MirroredRepeatWrapping,
  NearestFilter,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  NormalBlending,
  NumberKeyframeTrack,
  Object3D,
  OrthographicCamera,
  PCFSoftShadowMap,
  POSTFX,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  PropertyBinding,
  Quaternion,
  QuaternionKeyframeTrack,
  REVISION,
  Raycaster,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Skeleton,
  SkinnedMesh,
  Sphere,
  SphereGeometry,
  SpotLight,
  Sprite,
  SpriteMaterial,
  TIME,
  Texture,
  TextureLoader,
  TorusGeometry,
  TriangleFanDrawMode,
  TriangleStripDrawMode,
  TrianglesDrawMode,
  UnsignedByteType,
  Vector2,
  Vector3,
  VectorKeyframeTrack,
  WebGLRenderTarget,
  WebGLRenderer,
} = mod;
