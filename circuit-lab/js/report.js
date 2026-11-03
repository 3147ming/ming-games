/**
 * report.js — 实验报告生成（指令包 12）
 *
 * 纯函数：输入一个快照对象，输出单文件 HTML 字符串（内嵌 CSS + base64 截图）。
 * 报告是"冻结时刻"的数据：调用方传进来的测量值/截图就是最终结果，
 * 生成之后不再随仿真变化。
 */

/** 结论判定文案 */
export function verdictOf(item) {
  if (item.pass) return '符合';
  return '超差';
}

/** 单文件 HTML 报告 */
export function buildReportHtml(snapshot = {}) {
  const title = escapeHtml(snapshot.title || '实验报告');
  const time = escapeHtml(snapshot.time || new Date().toLocaleString('zh-CN'));
  const summary = snapshot.circuit || { components: [], wireCount: 0, netCount: 0, platform: '' };
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const observations = escapeHtml(snapshot.observations || '');
  const screenshot = typeof snapshot.screenshot === 'string' && snapshot.screenshot.startsWith('data:image')
    ? snapshot.screenshot
    : '';

  const rows = items.map((item) => {
    const measured = typeof item.measured === 'number'
      ? formatNumber(item.measured)
      : escapeHtml(String(item.measured === null || item.measured === undefined ? '—' : item.measured));
    const deviation = item.deviation === null || item.deviation === undefined
      ? '—'
      : `${(item.deviation * 100).toFixed(2)}%`;
    const cls = item.pass ? 'ok' : 'bad';
    return `<tr class="${cls}">
      <td>${escapeHtml(item.label)}</td>
      <td>${escapeHtml(String(item.target))} ${escapeHtml(item.unit || '')}</td>
      <td>${measured} ${escapeHtml(item.unit || '')}</td>
      <td>${deviation}</td>
      <td>±${((item.tolerance || 0) * 100).toFixed(2)}%</td>
      <td><b>${verdictOf(item)}</b></td>
    </tr>`;
  }).join('\n');

  const passCount = items.filter((x) => x.pass).length;
  const conclusion = items.length === 0
    ? '本次实验没有测量项。'
    : `共 ${items.length} 项测量，${passCount} 项符合预期${passCount === items.length ? '，实验结论成立。' : '，其余项超出容差，建议检查接线与元件参数。'}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root { --ink: #1c2330; --muted: #5b6675; --line: #d7dce4; --ok: #1e7a4b; --bad: #b8452f; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 32px 40px; font: 14px/1.65 "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--ink); background: #fbfaf6; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
  h2 { font-size: 15px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
  .shot { width: 100%; max-height: 320px; object-fit: contain; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
  ul { margin: 6px 0 0 18px; padding: 0; }
  li { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; }
  th { background: #eef1f6; font-weight: 600; }
  tr.ok td:last-child { color: var(--ok); }
  tr.bad td:last-child { color: var(--bad); }
  .conclusion { margin-top: 12px; padding: 10px 12px; border-left: 3px solid var(--ok); background: #f0f7f2; }
  .obs { white-space: pre-wrap; border: 1px dashed var(--line); border-radius: 6px; padding: 8px 10px; min-height: 48px; }
  .note { color: var(--muted); font-size: 11.5px; margin-top: 18px; }
  @media print {
    body { background: #fff; padding: 0; }
    @page { size: A4; margin: 16mm 14mm; }
    h2 { page-break-after: avoid; }
    table, .shot { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <h1>${title}</h1>
  <p class="meta">生成时间：${time} · 平台：${escapeHtml(summary.platform || '—')} · 元件 ${summary.components.length} 个 · 导线 ${summary.wireCount} 根 · 网络 ${summary.netCount} 个</p>

  <h2>一、电路</h2>
  ${screenshot ? `<img class="shot" src="${screenshot}" alt="电路截图">` : '<p class="meta">（无截图）</p>'}
  <ul>${summary.components.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>

  <h2>二、测量数据与预期对比</h2>
  ${items.length === 0 ? '<p class="meta">没有测量项。</p>' : `<table>
    <thead><tr><th>测量项</th><th>期望值</th><th>实测值</th><th>偏差</th><th>容差</th><th>判定</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`}

  <h2>三、结论</h2>
  <p class="conclusion">${escapeHtml(conclusion)}</p>

  <h2>四、我的观察</h2>
  <div class="obs">${observations || '（未填写）'}</div>

  <p class="note">本报告由电路实验模拟器生成；数值来自仿真结果，容差按实验模板定义。</p>
</body>
</html>`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e5)) return value.toExponential(3);
  return String(Number(value.toPrecision(5)));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
