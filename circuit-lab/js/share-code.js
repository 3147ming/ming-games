/**
 * share-code.js — R9 短链 / 提交码（前端纯函数 + 优雅降级）
 *
 * 后端（Cloudflare Pages Functions + D1）是可选的：
 *   · 有后端：POST /api/shares 存云端，短码真正跨设备；提交走 /api/submissions
 *   · 无后端（默认本地 / Pages 静态托管）：短码存 localStorage，同浏览器可还原；
 *     完整自包含分享链接（R3 的 base64url hash）仍然跨设备可用
 *   · 任何一步网络失败都不能让前端崩，也不弹未捕获异常
 *
 * 存档键沿用项目约定，不新造前缀。
 */
export const SHARES_KEY = 'lab-sim:shares';
export const SUBMISSIONS_KEY = 'lab-sim:submissions';
export const CODE_LENGTH = 6;
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I/O/0/1，避免手抄错
const SHARE_LIMIT = 120;
const SUBMIT_LIMIT = 500;

let memShares = null;
let memSubmits = null;
let backendAvailable = null; // null=未探测 false=确认无后端 true=可用

function store() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (_) { /* 隐私模式 */ }
  return null;
}

function readJson(key, fallback) {
  const s = store();
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch (_) { return fallback; }
}

function writeJson(key, value) {
  const s = store();
  if (!s) return false;
  try { s.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
}

/** 纯函数：生成 6 位短码（rng 可注入以便断言） */
export function makeCode(rng = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const n = Math.floor(rng() * ALPHABET.length);
    out += ALPHABET[Math.min(ALPHABET.length - 1, Math.max(0, n))];
  }
  return out;
}

/** 纯函数：规范化用户输入（大写、去掉非字母数字、截断） */
export function normalizeCode(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

export function isValidCode(code) {
  const c = normalizeCode(code);
  return c.length === CODE_LENGTH && [...c].every((ch) => ALPHABET.includes(ch));
}

/** 纯函数：按班级码过滤提交（空班级码返回全部） */
export function filterSubmissions(list, classCode = '') {
  const arr = Array.isArray(list) ? list : [];
  const cc = normalizeCode(classCode);
  if (!cc) return arr;
  return arr.filter((row) => normalizeCode(row && row.classCode) === cc);
}

export function readShares() {
  if (memShares) return memShares;
  memShares = readJson(SHARES_KEY, {});
  return memShares;
}

export function readSubmissions() {
  if (memSubmits) return memSubmits;
  const v = readJson(SUBMISSIONS_KEY, []);
  memSubmits = Array.isArray(v) ? v : [];
  return memSubmits;
}

/** 本地保存一条短码映射，超出上限删最早 */
export function saveLocalShare(code, circuit, expId) {
  const shares = readShares();
  shares[normalizeCode(code)] = { circuit, expId: expId || null, time: Date.now() };
  const keys = Object.keys(shares);
  if (keys.length > SHARE_LIMIT) {
    keys.sort((a, b) => (shares[a].time || 0) - (shares[b].time || 0));
    keys.slice(0, keys.length - SHARE_LIMIT).forEach((k) => delete shares[k]);
  }
  memShares = shares;
  writeJson(SHARES_KEY, shares);
  return shares;
}

export function resolveLocalShare(code) {
  const hit = readShares()[normalizeCode(code)];
  return hit && hit.circuit ? hit : null;
}

export function saveLocalSubmission(record) {
  const list = readSubmissions();
  list.push(record);
  const trimmed = list.length > SUBMIT_LIMIT ? list.slice(list.length - SUBMIT_LIMIT) : list;
  memSubmits = trimmed;
  writeJson(SUBMISSIONS_KEY, trimmed);
  return record;
}

function apiBase() {
  if (typeof location === 'undefined') return '';
  // 部署在 /circuit-lab/ 子路径时 API 也在该前缀下；本地根目录直跑则为空
  return location.pathname.includes('/circuit-lab') ? '/circuit-lab' : '';
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function api(path, init = {}, timeout = 1200) {
  if (backendAvailable === false) throw new Error('backend unavailable');
  if (typeof fetch !== 'function') throw new Error('no fetch');
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    signal: timeoutSignal(timeout),
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 前端可用的短链 hash（与 R3 的 /lab/<expId>/share/<encoded> 并存） */
export function shareHash(code) {
  return `#/share/${normalizeCode(code)}`;
}

/**
 * 发布电路：优先云端短码，失败回落本地短码。
 * @returns {Promise<{code:string,url:string,backend:boolean}>}
 */
export async function publishShare(circuit, expId) {
  let code = null;
  let backend = false;
  try {
    const res = await api('/api/shares', {
      method: 'POST', body: JSON.stringify({ circuit, expId: expId || null }),
    });
    if (res && res.code && isValidCode(res.code)) {
      code = normalizeCode(res.code);
      backend = true;
      backendAvailable = true;
    }
  } catch (_) {
    backendAvailable = false;
  }
  if (!code) code = makeCode();
  // 云端成功也留一份本地，断网时本浏览器仍可打开自己刚生成的短链
  saveLocalShare(code, circuit, expId);
  const origin = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
  return { code, url: `${origin}${shareHash(code)}`, backend };
}

/** 还原短码：本地优先 → 云端 → null */
export async function resolveShare(code) {
  const c = normalizeCode(code);
  if (!isValidCode(c)) return null;
  const local = resolveLocalShare(c);
  if (local) return local;
  try {
    const res = await api(`/api/shares/${c}`);
    if (res && res.circuit) {
      backendAvailable = true;
      return { circuit: res.circuit, expId: res.expId || null, time: res.created_at || null };
    }
  } catch (_) { /* 无后端或网络不通 */ }
  return null;
}

/** 提交实验：云端失败也必须本地留痕，教师看板才能用 */
export async function submitWork({ circuit, scores, classCode = '', expId = '' }) {
  const studentCode = makeCode();
  const record = {
    id: `${Date.now()}-${studentCode}`,
    studentCode,
    classCode: normalizeCode(classCode) || 'CLASS1',
    expId: expId || null,
    circuit,
    scores: scores || {},
    time: Date.now(),
  };
  let backend = false;
  try {
    const res = await api('/api/submissions', {
      method: 'POST', body: JSON.stringify(record),
    });
    backend = Boolean(res && res.ok !== false);
    backendAvailable = backend;
  } catch (_) {
    backendAvailable = false;
  }
  saveLocalSubmission(record);
  return { studentCode, classCode: record.classCode, backend };
}

/** 教师看板：云端优先，失败回落本地 */
export async function listSubmissions(classCode = '') {
  try {
    const res = await api(`/api/teacher/${normalizeCode(classCode) || 'CLASS1'}`);
    if (res && Array.isArray(res.rows)) {
      backendAvailable = true;
      return { rows: filterSubmissions(res.rows, classCode), backend: true };
    }
  } catch (_) { /* ignore */ }
  return { rows: filterSubmissions(readSubmissions(), classCode), backend: false };
}

export function backendStatus() {
  return backendAvailable;
}
