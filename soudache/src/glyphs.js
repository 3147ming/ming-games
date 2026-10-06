/**
 * 矢量图标绘制（Canvas 2D）—— 物品 / 容器 / UI 共用的程序化美术资源
 *
 * 本模块不依赖 THREE，也不依赖任何外部图片：图标全部由路径绘制。
 * 从原 2D 渲染器中抽出，供 DOM 覆盖层 UI 独立复用。
 */

export function drawGlyph(ctx, kind, x, y, s, color) {
  const h = s / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, s * 0.09);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const rect = (rx, ry, rw, rh, fill) => {
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    if (fill) ctx.fill();
    else ctx.stroke();
  };
  const line = (x1, y1, x2, y2) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  const circle = (cx, cy, r, fill) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (fill) ctx.fill();
    else ctx.stroke();
  };

  switch (kind) {
    case 'bolt':
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const px = Math.cos(a) * h * 0.85;
        const py = Math.sin(a) * h * 0.85;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      circle(0, 0, h * 0.28, true);
      break;
    case 'wire':
      ctx.beginPath();
      ctx.moveTo(-h * 0.8, h * 0.4);
      ctx.quadraticCurveTo(-h * 0.2, -h * 0.9, h * 0.2, h * 0.1);
      ctx.quadraticCurveTo(h * 0.5, h * 0.8, h * 0.85, -h * 0.2);
      ctx.stroke();
      break;
    case 'fuel':
      rect(-h * 0.6, -h * 0.7, h * 1.2, h * 1.4);
      line(-h * 0.25, -h * 0.7, -h * 0.25, -h);
      line(h * 0.2, -h * 0.3, h * 0.2, h * 0.3);
      break;
    case 'battery':
      rect(-h * 0.7, -h * 0.45, h * 1.3, h * 0.9);
      rect(h * 0.6, -h * 0.18, h * 0.25, h * 0.36, true);
      line(-h * 0.35, -h * 0.2, -h * 0.35, h * 0.2);
      break;
    case 'parts':
      circle(0, 0, h * 0.45);
      for (let i = 0; i < 4; i += 1) {
        const a = (Math.PI / 2) * i;
        line(Math.cos(a) * h * 0.45, Math.sin(a) * h * 0.45, Math.cos(a) * h * 0.85, Math.sin(a) * h * 0.85);
      }
      break;
    case 'medkit':
      rect(-h * 0.8, -h * 0.55, h * 1.6, h * 1.1);
      line(-h * 0.3, 0, h * 0.3, 0);
      line(0, -h * 0.3, 0, h * 0.3);
      break;
    case 'bandage':
      rect(-h * 0.8, -h * 0.4, h * 1.6, h * 0.8);
      line(-h * 0.4, -h * 0.4, -h * 0.1, h * 0.4);
      line(h * 0.1, -h * 0.4, h * 0.4, h * 0.4);
      break;
    case 'pill':
      ctx.beginPath();
      ctx.ellipse(-h * 0.15, 0, h * 0.62, h * 0.36, Math.PI / 5, 0, Math.PI * 2);
      ctx.stroke();
      line(-h * 0.62, h * 0.1, h * 0.2, -h * 0.35);
      break;
    case 'chip':
      rect(-h * 0.5, -h * 0.5, h, h);
      rect(-h * 0.2, -h * 0.2, h * 0.4, h * 0.4, true);
      for (let i = -1; i <= 1; i += 1) {
        line(i * h * 0.3, -h * 0.5, i * h * 0.3, -h * 0.85);
        line(i * h * 0.3, h * 0.5, i * h * 0.3, h * 0.85);
        line(-h * 0.5, i * h * 0.3, -h * 0.85, i * h * 0.3);
        line(h * 0.5, i * h * 0.3, h * 0.85, i * h * 0.3);
      }
      break;
    case 'watch':
      circle(0, 0, h * 0.5);
      line(0, 0, 0, -h * 0.28);
      line(0, 0, h * 0.22, h * 0.1);
      line(-h * 0.22, -h * 0.5, -h * 0.22, -h * 0.85);
      line(h * 0.22, -h * 0.5, h * 0.22, -h * 0.85);
      line(-h * 0.22, h * 0.5, -h * 0.22, h * 0.85);
      line(h * 0.22, h * 0.5, h * 0.22, h * 0.85);
      break;
    case 'doc':
      rect(-h * 0.55, -h * 0.75, h * 1.1, h * 1.5);
      line(-h * 0.32, -h * 0.4, h * 0.32, -h * 0.4);
      line(-h * 0.32, -h * 0.05, h * 0.32, -h * 0.05);
      line(-h * 0.32, h * 0.3, h * 0.1, h * 0.3);
      break;
    case 'optic':
      rect(-h * 0.75, -h * 0.3, h * 1.5, h * 0.6);
      circle(-h * 0.45, 0, h * 0.26);
      circle(h * 0.45, 0, h * 0.26);
      line(-h * 0.15, -h * 0.3, -h * 0.15, -h * 0.6);
      break;
    case 'suppressor':
      rect(-h * 0.75, -h * 0.32, h * 1.5, h * 0.64);
      for (let i = -2; i <= 2; i += 1) line(i * h * 0.3, -h * 0.32, i * h * 0.3, h * 0.32);
      break;
    case 'gold':
      ctx.beginPath();
      ctx.moveTo(-h * 0.7, h * 0.3);
      ctx.lineTo(-h * 0.4, -h * 0.35);
      ctx.lineTo(h * 0.7, -h * 0.35);
      ctx.lineTo(h * 0.4, h * 0.3);
      ctx.closePath();
      ctx.stroke();
      line(-h * 0.55, 0.05 * h, h * 0.55, 0.05 * h);
      break;
    case 'keycard':
      rect(-h * 0.7, -h * 0.45, h * 1.4, h * 0.9);
      rect(-h * 0.55, -h * 0.25, h * 0.5, h * 0.22, true);
      circle(h * 0.35, h * 0.05, h * 0.16);
      break;
    case 'ammo':
      ctx.beginPath();
      ctx.moveTo(-h * 0.35, h * 0.6);
      ctx.lineTo(-h * 0.35, -h * 0.2);
      ctx.quadraticCurveTo(-h * 0.35, -h * 0.8, 0, -h * 0.8);
      ctx.quadraticCurveTo(h * 0.35, -h * 0.8, h * 0.35, -h * 0.2);
      ctx.lineTo(h * 0.35, h * 0.6);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'wpn_rifle':
      line(-h * 0.9, h * 0.1, h * 0.9, h * 0.1);
      line(-h * 0.9, h * 0.1, -h * 0.75, h * 0.55);
      line(-h * 0.2, h * 0.1, -h * 0.1, h * 0.5);
      line(h * 0.1, h * 0.1, h * 0.55, -h * 0.05);
      rect(-h * 0.55, -h * 0.15, h * 0.7, h * 0.25);
      break;
    case 'wpn_smg':
      line(-h * 0.75, h * 0.15, h * 0.8, h * 0.15);
      line(-h * 0.1, h * 0.15, -h * 0.05, h * 0.55);
      rect(-h * 0.45, -h * 0.1, h * 0.5, h * 0.25);
      line(h * 0.1, h * 0.1, h * 0.5, -h * 0.1);
      break;
    case 'wpn_pistol':
      line(-h * 0.55, h * 0.05, h * 0.45, h * 0.05);
      line(-h * 0.55, h * 0.05, -h * 0.4, h * 0.6);
      line(-h * 0.2, h * 0.05, -h * 0.15, h * 0.45);
      rect(-h * 0.55, -h * 0.2, h * 0.5, h * 0.25);
      break;
    case 'armor':
      ctx.beginPath();
      ctx.moveTo(-h * 0.55, -h * 0.6);
      ctx.lineTo(-h * 0.75, -h * 0.1);
      ctx.lineTo(-h * 0.4, h * 0.7);
      ctx.lineTo(h * 0.4, h * 0.7);
      ctx.lineTo(h * 0.75, -h * 0.1);
      ctx.lineTo(h * 0.55, -h * 0.6);
      ctx.lineTo(0, -h * 0.25);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'drawer':
      rect(-h * 0.85, -h * 0.6, h * 1.7, h * 1.2);
      line(-h * 0.85, 0, h * 0.85, 0);
      line(-h * 0.25, -h * 0.3, h * 0.25, -h * 0.3);
      line(-h * 0.25, h * 0.3, h * 0.25, h * 0.3);
      break;
    case 'crate':
      rect(-h * 0.85, -h * 0.7, h * 1.7, h * 1.4);
      line(-h * 0.85, -h * 0.7, h * 0.85, h * 0.7);
      line(h * 0.85, -h * 0.7, -h * 0.85, h * 0.7);
      break;
    case 'weaponbox':
      rect(-h * 0.9, -h * 0.45, h * 1.8, h * 0.9);
      line(-h * 0.35, -h * 0.45, -h * 0.35, h * 0.45);
      line(h * 0.35, -h * 0.45, h * 0.35, h * 0.45);
      circle(0, 0, h * 0.16, true);
      break;
    case 'safe':
      rect(-h * 0.7, -h * 0.7, h * 1.4, h * 1.4);
      circle(0, 0, h * 0.3);
      line(h * 0.55, -h * 0.35, h * 0.55, h * 0.35);
      break;
    case 'body':
      circle(-h * 0.5, -h * 0.35, h * 0.22);
      ctx.beginPath();
      ctx.moveTo(-h * 0.28, -h * 0.1);
      ctx.lineTo(h * 0.55, -h * 0.1);
      ctx.stroke();
      line(-h * 0.05, h * 0.5, h * 0.3, -h * 0.15);
      break;
    default:
      circle(0, 0, h * 0.5);
      break;
  }
  ctx.restore();
}
