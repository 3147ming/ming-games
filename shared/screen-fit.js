/* ming-games 宽屏观感升级 · 共享装配脚本
 * 用法：页面在引入本脚本前设置 window.MG_SCREEN_FIT = {...}。
 * 只做布局装配与信息卡渲染，不触碰任何游戏逻辑、存档或计时器。
 */
(function () {
  'use strict';
  if (window.__MG_SCREEN_FIT_READY__) return;
  window.__MG_SCREEN_FIT_READY__ = true;

  var cfg = window.MG_SCREEN_FIT || {};
  var main = document.querySelector('.wrap') ||
             document.querySelector('main') ||
             document.querySelector('#app') ||
             document.body.firstElementChild;
  if (!main || document.querySelector('.mg-fit-shell')) return;

  var body = document.body;
  body.classList.add('mg-fit-enabled');
  if (cfg.accent) body.style.setProperty('--mg-fit-accent', cfg.accent);
  if (cfg.bg) body.style.setProperty('--mg-fit-bg', cfg.bg);
  if (cfg.mainWidth) body.style.setProperty('--mg-fit-main', cfg.mainWidth);
  if (cfg.cover) body.style.setProperty('--mg-fit-cover', 'url("' + cfg.cover + '")');
  if (cfg.light) body.classList.add('mg-fit-light');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 背景层置于 body 最前，position:fixed 不参与 flex 布局 */
  var ambient = el('div', 'mg-fit-ambient');
  var grid = el('div', 'mg-fit-grid');
  body.insertBefore(grid, body.firstChild);
  body.insertBefore(ambient, body.firstChild);

  var shell = el('div', 'mg-fit-shell');
  var left = el('aside', 'mg-fit-rail mg-fit-rail--left');
  var center = el('div', 'mg-fit-stage');
  var right = el('aside', 'mg-fit-rail mg-fit-rail--right');
  shell.appendChild(left);
  shell.appendChild(center);
  shell.appendChild(right);
  main.parentNode.insertBefore(shell, main);
  center.appendChild(main);

  function card(title, bodyText, hero) {
    var c = el('section', 'mg-fit-card' + (hero ? ' mg-fit-card--hero' : ''));
    if (hero) {
      c.appendChild(el('h2', null, title));
      if (bodyText) c.appendChild(el('span', null, bodyText));
    } else {
      if (title) c.appendChild(el('h3', null, title));
      if (bodyText) c.appendChild(el('p', null, bodyText));
    }
    return c;
  }

  if (cfg.title) left.appendChild(card(cfg.title, cfg.tagline || '', true));
  (cfg.left || []).forEach(function (item) {
    left.appendChild(card(item.title, item.body));
  });
  (cfg.right || []).forEach(function (item) {
    right.appendChild(card(item.title, item.body));
  });

  /* 底部信息带：把原本空着的下半屏变成可用的导航与提示区 */
  var dock = el('div', 'mg-fit-dock');
  var dockTitle = el('div');
  dockTitle.appendChild(el('strong', null, cfg.title || '游戏'));
  dockTitle.appendChild(el('span', null, cfg.tagline || '本机存档 · 断网可玩'));
  dock.appendChild(dockTitle);

  var dockTip = el('div');
  dockTip.appendChild(el('strong', null, '一句话上手'));
  dockTip.appendChild(el('span', null, cfg.tip || (cfg.left && cfg.left[0] ? cfg.left[0].body : '')));
  dock.appendChild(dockTip);

  var links = el('div', 'mg-fit-links');
  var hub = el('a', 'mg-fit-link mg-fit-link--primary', '返回大厅');
  hub.href = '../';
  links.appendChild(hub);
  var next = el('a', 'mg-fit-link', '随机一局');
  next.href = 'javascript:void(0)';
  next.addEventListener('click', function () {
    var list = (window.MG_SCREEN_FIT_FRIENDS || []).slice();
    if (!list.length) { location.href = '../'; return; }
    location.href = '../' + list[Math.floor(Math.random() * list.length)] + '/';
  });
  links.appendChild(next);
  var focus = el('button', 'mg-fit-link', '沉浸模式');
  focus.type = 'button';
  focus.title = '隐藏侧栏与信息带，专注游戏画面';
  focus.addEventListener('click', function () {
    var on = body.classList.toggle('mg-fit-immersive');
    focus.textContent = on ? '退出沉浸' : '沉浸模式';
  });
  links.appendChild(focus);
  dock.appendChild(links);
  shell.appendChild(dock);

  /* 暴露只读诊断接口，便于线上验证 */
  window.__MG_SCREEN_FIT__ = {
    ready: true,
    config: cfg,
    rails: { left: left.children.length, right: right.children.length },
    dock: true,
    immersive: function (on) { body.classList.toggle('mg-fit-immersive', !!on); }
  };
})();
