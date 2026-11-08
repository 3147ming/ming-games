/**
 * 入口文件：启动游戏
 */
import { Game } from './core/Game.js';

const game = new Game();

game.init().catch((err) => {
  console.error('[Game] 初始化失败：', err);
  const text = document.getElementById('loading-text');
  if (text) {
    text.textContent = '加载失败：' + (err && err.message ? err.message : err);
    text.style.color = '#ff5a2d';
  }
  const hint = document.querySelector('.loading-hint');
  if (hint) hint.textContent = '请确认通过本地服务器访问（例如 python -m http.server 8080），不要直接双击 index.html';
});

// 便于在浏览器控制台调试
window.__game = game;
