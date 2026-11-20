/**
 * 主角建模升级守护测试（node --test）
 * 覆盖：CC0 骨骼模型文件本体、视觉放大接线、动画映射、染色强度、旧 LOD 隔离、朝向校正、输入焦点。
 * 说明：heroAsset.js / main.js 依赖浏览器与 three vendor，Node 下无法直接实例化，
 *      故使用源码文本断言 + GLB 二进制结构解析（与美术接入守护口径一致）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..');
const config = fs.readFileSync(path.join(srcDir, 'core', 'config.js'), 'utf8');
const heroAsset = fs.readFileSync(path.join(here, 'heroAsset.js'), 'utf8');
const main = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8');
const modelPath = path.join(srcDir, '..', 'assets', 'hero', 'model.glb');

function readGlbJson(p) {
  const buf = fs.readFileSync(p);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, '不是合法 GLB（magic 错误）');
  const jsonLen = buf.readUInt32LE(12);
  assert.ok(jsonLen > 0 && 20 + jsonLen <= buf.length, 'GLB JSON chunk 长度异常');
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
}

test('model.glb 已是带骨骼/贴图/动画的 CC0 骑士模型，不再是占位模型', () => {
  assert.ok(fs.existsSync(modelPath), '缺少 assets/hero/model.glb');
  assert.ok(fs.statSync(modelPath).size > 200_000, '模型文件过小，疑似仍是旧占位模型');

  const gltf = readGlbJson(modelPath);
  assert.ok((gltf.nodes || []).length >= 20, `骨骼节点不足：${(gltf.nodes || []).length}`);
  assert.ok((gltf.skins || []).length >= 1, '缺少蒙皮骨骼');
  assert.ok((gltf.materials || []).length >= 1, '缺少材质');
  assert.ok((gltf.images || []).length >= 1, '缺少贴图');
  assert.ok((gltf.animations || []).length >= 8, `动画数量不足：${(gltf.animations || []).length}`);

  const names = (gltf.animations || []).map((a) => a.name);
  for (const clip of ['idle', 'run', 'punch', 'death']) {
    assert.ok(names.includes(clip), `模型缺少动画 clip：${clip}`);
  }
});

test('视觉放大只作用于渲染层，不改相机与碰撞规格', () => {
  assert.match(config, /ASSET_PATH:\s*'assets\/hero\/model\.glb'/, '资产路径未指向 model.glb');
  assert.match(config, /MODEL_VISUAL_SCALE:\s*1\.25/, '缺少主角视觉放大配置');
  assert.match(heroAsset, /root\.scale\.setScalar\(HERO\.MODEL_VISUAL_SCALE\s*\?\?\s*1\)/, '外部模型未应用视觉放大');
  assert.match(main, /playerMesh\.scale\.setScalar\(HERO\.MODEL_VISUAL_SCALE\s*\?\?\s*1\)/, '内置回退模型未同步视觉放大');

  // 相机 8m/4m 是项目硬规格；本次只放大模型，不改这些值。
  assert.match(config, /DISTANCE:\s*8\b/, '相机水平距离规格被改动');
  assert.match(config, /HEIGHT:\s*4\b/, '相机抬升规格被改动');
  assert.match(config, /HEIGHT:\s*1\.8\b/, '玩家碰撞高度被改动');
});

test('动画映射与染色强度适配 CC0 骑士模型', () => {
  for (const state of ['N1', 'N2', 'C3', 'C4', 'C5', 'heavy', 'musou', 'art1', 'art2']) {
    assert.match(config, new RegExp(`${state}:\\s*'punch'`), `${state} 未借用 punch 攻击动画`);
  }
  const tone = config.match(/TONE_MIX:\s*([0-9.]+)/);
  assert.ok(tone, '缺少 TONE_MIX 配置');
  assert.ok(Number(tone[1]) <= 0.55, `染色过强：TONE_MIX=${tone[1]}`);
});

test('旧占位 LOD 副资产不参与加载，避免新旧模型串用', () => {
  const lodBlock = config.match(/LOD:\s*\{([\s\S]*?)\n  \},/)?.[1] || '';
  assert.match(lodBlock, /ENABLED:\s*false/, 'LOD 副资产未关闭，可能加载旧占位 LOD');
});

test('CC0 骑士补 180° 朝向校正，避免攻击时脸朝镜头', () => {
  assert.match(config, /ASSET_FACING_OFFSET:\s*Math\.PI/, '缺少模型朝向校正配置');
  assert.match(heroAsset, /asset\.scene\.rotation\.y\s*=\s*facingOffset/,
    '外部模型场景未应用朝向校正');
  assert.match(heroAsset, /if \(lod\.lod1\) lod\.lod1\.rotation\.y\s*=\s*facingOffset/,
    'LOD 副资产朝向未同步校正');
  // 只转模型场景，绝不碰逻辑朝向/命中判定
  assert.doesNotMatch(heroAsset, /player\.facing\s*=\s*facingOffset/, '朝向校正污染了逻辑 facing');
});

test('输入层吞掉全部游戏键默认行为与右键菜单，并把焦点锁在画布', () => {
  const inputSrc = fs.readFileSync(path.join(srcDir, 'player', 'input.js'), 'utf8');
  const html = fs.readFileSync(path.join(srcDir, '..', 'index.html'), 'utf8');
  assert.match(inputSrc, /\.\.\.Object\.values\(ACTIONS\)\.flat\(\)/, 'SWALLOW 未覆盖全部游戏按键');
  assert.match(inputSrc, /!e\.ctrlKey && !e\.metaKey && !e\.altKey/, '系统组合键被误吞');
  assert.match(inputSrc, /_onContextMenu\s*=\s*\(e\)\s*=>\s*e\.preventDefault\(\)/, '右键卸势仍会弹出浏览器菜单');
  assert.match(inputSrc, /addEventListener\('contextmenu', this\._onContextMenu\)/, '右键菜单拦截未接线');
  // keyup 也要拦，否则按钮上的空格/回车在松手时仍会触发
  assert.match(inputSrc, /_onKeyUp[\s\S]{0,200}shouldSwallow\(e\)/ , 'keyup 未拦默认行为');
  assert.match(html, /<canvas[^>]*tabindex="0"/, '画布不可聚焦，进入游戏键盘焦点不在游戏里');
  assert.match(main, /canvas\.focus\(\{ preventScroll: true \}\)/, '启动后未把焦点交给画布');
});
