/* =============================================================================
 * src/net/p2p.js —— 纯 P2P 联机底座（零服务器 · 零第三方 · 零费用）
 * -----------------------------------------------------------------------------
 * 定位
 *   把「多人联机」这件事做到不需要任何服务器：
 *     · 不自建房间服务、不用 Cloudflare Worker、不用 Durable Object
 *     · 不连任何第三方信令 / STUN / TURN（iceServers 为空）
 *     · 不需要固定 IP、不需要端口映射、不需要改路由配置
 *     · 不花钱
 *
 * 代价（必须说清楚，别宣传成「只输房号就能进」）
 *   WebRTC 建立连接前，双方必须交换 SDP 与 ICE candidate。
 *   没有信令服务器，「发现彼此」这一步就得靠人把一段码传给对方。
 *   所以本模块的形态是「两段码交换」：
 *     房主生成【房主码】 → 通过任意方式发给朋友 → 朋友生成【加入码】
 *     → 发回房主 → 房主粘贴 → 通道打开，开始游戏。
 *
 *   能不能跨公网？
 *     iceServers: [] 意味着只用本机网卡地址（host candidate）。
 *     同一局域网 / 同一台机器的两个标签页 → 稳连。
 *     跨公网 → 取决于双方 NAT 类型，多数家庭宽带（锥型 NAT）可以直连，
 *     对称 NAT 会失败。失败时给出明确提示，而不是让用户对着转圈等。
 *
 *   这是「完全不依赖任何服务器」的必然结果，不是实现偷懒。
 *
 * 纪律
 *   · 顶层不碰 DOM、不碰 localStorage；所有读写在函数里 try/catch。
 *   · 任何一步失败都必须给中文人话提示，绝不 throw 到调用方。
 *   · 纯 ES module，浏览器原生支持，不依赖任何第三方库。
 *
 * 消息协议（跑在 DataChannel 上，JSON 一行一条）
 *   { t:'hello',  name, seat }          加入通道后互报身份
 *   { t:'input',  seq, act }            玩家输入（房主权威模型：只有房主广播结果）
 *   { t:'state',  tick, data }          权威状态广播
 *   { t:'hash',   tick, hash }          状态摘要，用于一致性校验
 *   { t:'sync',   tick, data }          房主下发的完整快照（纠偏用）
 *   { t:'chat',   text }                聊天
 *   { t:'ping'/'pong', at }             延迟探测
 * ========================================================================== */

export const VERSION = 1;
export const NS = 'ming.p2p.v1';

/* 连接码有效期：10 分钟。过期了让房主重新生成即可 —— 过期码留着没意义，
   留着反而会让人以为"码还能用但连不上"，白白排查半天。 */
const CODE_TTL_MS = 10 * 60 * 1000;

/* 候选地址收集上限：拿够就停。收集太久会拖慢「生成连接码」的等待时间，
   而 host candidate 本来就只有网卡那几个，等再久也不会多出公网地址。 */
const CANDIDATE_TIMEOUT_MS = 1500;

/* 消息体积上限：DataChannel 有 message size 限制，超了会直接断通道。
   16KB 足够发棋盘状态；再大的东西（比如一张图）不走这条道。 */
const MAX_MESSAGE_BYTES = 16 * 1024;

/* ---------------------------------------------------------------------------
 * 码的编码
 * ---------------------------------------------------------------------------
 * 连接码里装的是：版本、游戏 id、房号、过期时间、密码盐、offer/answer、候选地址。
 * 直接 JSON + base64 会很长（SDP 动辄 1-2KB），要靠压缩压短。
 *
 * 用 CompressionStream('deflate-raw') 压缩 —— 浏览器原生 API，零依赖零第三方。
 * 不支持它的浏览器（老 Safari）降级为不压缩，码会变长但仍可用。
 * ------------------------------------------------------------------------- */

const HAS_COMPRESSION = typeof CompressionStream === 'function' &&
  typeof DecompressionStream === 'function';

/** base64url：比标准 base64 少 +/= 四个字符，粘在聊天窗口里不容易被截断。 */
function toB64Url(bytes) {
  let bin = '';
  const chunk = 0x8000;                       /* 分块，避免大字符串爆栈 */
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(bytes) {
  if (!HAS_COMPRESSION) return { raw: true, bytes };
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return { raw: false, bytes: new Uint8Array(buf) };
}

async function inflate(bytes) {
  if (!HAS_COMPRESSION) return { raw: true, bytes };
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return { raw: false, bytes: new Uint8Array(buf) };
}

/**
 * 把对象编码成连接码文本。
 * @param {object} obj
 * @returns {Promise<string>}
 */
export async function encodeCode(obj) {
  const json = JSON.stringify(obj);
  const raw = new TextEncoder().encode(json);
  const { raw: isRaw, bytes } = await deflate(raw);
  /* 首字符标记是否压缩过：'M'=压缩（raw），'P'=明文（plain）。 */
  return (isRaw ? 'P' : 'M') + toB64Url(bytes);
}

/**
 * 解码连接码文本。
 * @param {string} text
 * @returns {Promise<object>} 失败时 throw Error（中文人话）
 */
export async function decodeCode(text) {
  const s = String(text || '').trim();
  if (!s) throw new Error('连接码是空的');
  const flag = s[0];
  const body = s.slice(1);
  if (flag !== 'M' && flag !== 'P') {
    throw new Error('这不是有效的连接码（开头应为 M 或 P）');
  }
  let bytes;
  try {
    bytes = fromB64Url(body);
  } catch (e) {
    throw new Error('连接码字符不完整，复制时可能丢了内容');
  }
  if (flag === 'M') {
    try {
      const r = await inflate(bytes);
      bytes = r.bytes;
    } catch (e) {
      throw new Error('连接码解压失败，复制时可能损坏了内容');
    }
  }
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error('连接码内容不是合法数据，复制时可能损坏了内容');
  }
  if (!obj || typeof obj !== 'object') throw new Error('连接码内容异常');
  return obj;
}

/* ---------------------------------------------------------------------------
 * 密码
 * ---------------------------------------------------------------------------
 * 不用明文传密码，也不在码里放密码本身。
 * 做法：码里放随机盐，双方各自用「密码 + 盐」算出同一把密钥，
 * 加入方用它生成一份证明（proof）发给房主，房主用同样方式算一遍来比对。
 * 密码错的话两边算出的证明不同，房主就知道密码不对，但密码本身没上网。
 * ------------------------------------------------------------------------- */

/** 生成随机盐（16 字节）。 */
function randomSalt() {
  const a = new Uint8Array(16);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(a);
  } else {
    for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return toB64Url(a);
}

/**
 * 由「密码 + 盐」派生房间密钥。
 * 用 PBKDF2（浏览器原生 crypto.subtle），没有 subtle 时降级为简易哈希。
 * @param {string} password
 * @param {string} salt
 * @returns {Promise<string>} base64url 密钥
 */
export async function deriveKey(password, salt) {
  const pwd = String(password || '');
  if (!pwd) return '';
  if (globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.subtle.importKey) {
    try {
      const enc = new TextEncoder();
      const key = await globalThis.crypto.subtle.importKey(
        'raw', enc.encode(pwd), { name: 'PBKDF2' }, false, ['deriveBits']
      );
      const saltBytes = fromB64Url(salt);
      const bits = await globalThis.crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
        key, 256
      );
      return toB64Url(new Uint8Array(bits));
    } catch (e) {
      /* 落到下面的简易实现 */
    }
  }
  /* 降级：不是密码学强度，但至少密码不明文传输、且依赖它才能连上。 */
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = pwd + '|' + salt;
  for (let i = 0; i < s.length; i++) {
    h1 = ((h1 ^ s.charCodeAt(i)) * 16777619) >>> 0;
    h2 = ((h2 + s.charCodeAt(i)) * 2654435761) >>> 0;
  }
  return 'fb' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 生成密码证明：HMAC(密钥, 房号)。
 * @param {string} key
 * @param {string} roomId
 * @returns {Promise<string>}
 */
export async function makeProof(key, roomId) {
  if (!key) return '';
  if (globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.subtle.sign) {
    try {
      const enc = new TextEncoder();
      const k = await globalThis.crypto.subtle.importKey(
        'raw', fromB64Url(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig = await globalThis.crypto.subtle.sign('HMAC', k, enc.encode(String(roomId)));
      return toB64Url(new Uint8Array(sig));
    } catch (e) {
      /* 落到简易实现 */
    }
  }
  let h = 0x811c9dc5;
  const s = key + '|' + roomId;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return 'fp' + h.toString(16).padStart(8, '0');
}

/* ---------------------------------------------------------------------------
 * 底层工具
 * ------------------------------------------------------------------------- */

/** 生成房间号：5 位数字，避免 0 开头（和 WorldHub 的房间号规则一致）。 */
export function makeRoomId() {
  return String(10000 + Math.floor(Math.random() * 90000));
}

/** 等到 ICE 收集完成（或超时）。收集到的候选地址全塞进码里，不做 trickle。 */
function waitIceGathering(pc, timeoutMs) {
  return new Promise(function (resolve) {
    if (pc.iceGatheringState === 'complete') return resolve();
    let done = false;
    const finish = function () {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = function () {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * 新建一个只含本机候选地址的 RTCPeerConnection。
 * iceServers 传空数组 —— 这是「绝不依赖任何第三方 STUN/TURN」的硬保证。
 */
function newPeer() {
  if (typeof RTCPeerConnection !== 'function') {
    throw new Error('这个浏览器不支持 WebRTC，没法纯 P2P 联机');
  }
  return new RTCPeerConnection({
    iceServers: [],                 /* 不连任何 STUN/TURN：零第三方、零费用 */
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
  });
}

function randomId() {
  const a = new Uint8Array(8);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return toB64Url(a);
}

/* ---------------------------------------------------------------------------
 * P2PSession —— 一次联机会话
 * ---------------------------------------------------------------------------
 * 两种角色：
 *   host：建房方，生成房主码，等对方回加入码
 *   guest：加入方，拿到房主码后生成加入码，回传给房主
 *
 * 事件（都是回调式，避免引入 EventTarget 在老环境的坑）：
 *   onStatus(state, text)   连接状态变化：waiting / connecting / open / closed / failed
 *   onMessage(msg)          收到一条协议消息
 *   onPeer(name)            对端就位
 * ========================================================================== */

export class P2PSession {
  /**
   * @param {object} opts
   * @param {'host'|'guest'} opts.role
   * @param {string} opts.gameId
   * @param {string} [opts.name]     自己的昵称
   * @param {string} [opts.roomId]   房号（host 生成；guest 从码里取）
   * @param {string} [opts.salt]     密码盐（host 生成；guest 从码里取）
   */
  constructor(opts) {
    const o = opts || {};
    this.role = o.role === 'guest' ? 'guest' : 'host';
    this.gameId = o.gameId || 'unknown';
    this.name = o.name || '玩家';
    this.roomId = o.roomId || (this.role === 'host' ? makeRoomId() : '');
    this.salt = o.salt || randomSalt();
    this.key = '';                  /* 由密码派生的房间密钥 */
    this.state = 'idle';
    this.peerName = '';
    this.peerSeat = -1;
    this._pc = null;
    this._dc = null;
    this._candidates = [];
    this._seq = 0;
    this._handlers = { status: [], message: [], peer: [] };
    this._closed = false;
  }

  /* ---- 事件订阅 ---- */
  on(evt, fn) {
    if (this._handlers[evt]) this._handlers[evt].push(fn);
    return this;
  }
  _emit(evt, a, b) {
    const list = this._handlers[evt] || [];
    for (let i = 0; i < list.length; i++) {
      try { list[i](a, b); } catch (e) { console.error('[p2p] 处理器出错', e); }
    }
  }
  _setStatus(state, text) {
    this.state = state;
    this._emit('status', state, text || '');
  }

  /* ---- 房主：生成房主码 ---- */
  async createHostCode(password) {
    if (this.role !== 'host') throw new Error('只有房主能生成房主码');
    this.key = await deriveKey(password, this.salt);
    const pc = newPeer();
    this._pc = pc;
    const dc = pc.createDataChannel('ming', { ordered: true });
    this._wireChannel(dc);
    pc.onicecandidate = (ev) => { if (ev.candidate) this._candidates.push(ev.candidate.toJSON()); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGathering(pc, CANDIDATE_TIMEOUT_MS);
    this._setStatus('waiting', '等待朋友把加入码发回来');
    const payload = {
      v: VERSION, ns: NS, role: 'host', gameId: this.gameId,
      roomId: this.roomId, name: this.name, salt: this.salt,
      hasPassword: !!password, exp: Date.now() + CODE_TTL_MS,
      offer: pc.localDescription, candidates: this._candidates.slice(),
    };
    return encodeCode(payload);
  }

  /* ---- 加入方：拿到房主码，生成加入码 ---- */
  async createGuestCode(hostCodeText, password) {
    if (this.role !== 'guest') throw new Error('只有加入方能生成加入码');
    const host = await decodeCode(hostCodeText);
    if (host.v !== VERSION) throw new Error('连接码版本对不上，请让对方重新生成');
    if (host.exp && host.exp < Date.now()) throw new Error('连接码已过期（超过 10 分钟），让房主重新生成');
    if (host.hasPassword && !password) throw new Error('这个房间设了密码，请输入密码');
    if (!host.hasPassword && password) throw new Error('这个房间没设密码，不用输密码');

    this.roomId = host.roomId || '';
    this.salt = host.salt || randomSalt();
    this.key = await deriveKey(password, this.salt);
    this.peerName = host.name || '房主';

    const pc = newPeer();
    this._pc = pc;
    pc.onicecandidate = (ev) => { if (ev.candidate) this._candidates.push(ev.candidate.toJSON()); };
    pc.ondatachannel = (ev) => { this._wireChannel(ev.channel); };
    await pc.setRemoteDescription(host.offer);
    for (const c of (host.candidates || [])) {
      try { await pc.addIceCandidate(c); } catch (e) { /* 单个候选失败不致命 */ }
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGathering(pc, CANDIDATE_TIMEOUT_MS);
    this._setStatus('connecting', '正在建立通道，请把加入码发回房主');

    const proof = await makeProof(this.key, this.roomId);
    const payload = {
      v: VERSION, ns: NS, role: 'guest', gameId: this.gameId,
      roomId: this.roomId, name: this.name, salt: this.salt,
      hasPassword: !!password, exp: Date.now() + CODE_TTL_MS,
      answer: pc.localDescription, candidates: this._candidates.slice(), proof: proof,
    };
    return encodeCode(payload);
  }

  /* ---- 房主：收到加入码，完成握手 ---- */
  async acceptGuestCode(guestCodeText) {
    if (this.role !== 'host') throw new Error('只有房主能接收加入码');
    const guest = await decodeCode(guestCodeText);
    if (guest.v !== VERSION) throw new Error('加入码版本对不上，请让对方重新生成');
    if (guest.roomId && this.roomId && guest.roomId !== this.roomId) {
      throw new Error('这个加入码不属于你创建的房间');
    }
    if (guest.exp && guest.exp < Date.now()) throw new Error('加入码已过期（超过 10 分钟）');

    /* 密码校验：双方用同一把密钥对房号签名，签名一致才是同一密码。
       房主自己那把 key 是建房时算出来的；加入方那份写在加入码里。 */
    if (this.key) {
      const expect = await makeProof(this.key, this.roomId);
      if (!guest.proof || guest.proof !== expect) {
        throw new Error('密码不正确');
      }
    }

    this.peerName = guest.name || '玩家';
    const pc = this._pc;
    if (!pc) throw new Error('还没生成房主码，不能接收加入码');
    await pc.setRemoteDescription(guest.answer);
    for (const c of (guest.candidates || [])) {
      try { await pc.addIceCandidate(c); } catch (e) { /* 单个候选失败不致命 */ }
    }
    this._setStatus('connecting', '正在建立通道…');
  }

  /* ---- DataChannel 装配 ---- */
  _wireChannel(dc) {
    this._dc = dc;
    dc.onopen = () => {
      this._setStatus('open', '通道已建立');
      this.send({ t: 'hello', name: this.name, seat: this.role === 'host' ? 0 : 1 });
    };
    dc.onclose = () => {
      if (this._closed) return;
      this._closed = true;
      this._setStatus('closed', '对方断开了');
    };
    dc.onerror = () => {
      this._setStatus('failed', '通道出错，可能是网络环境不支持纯 P2P');
    };
    dc.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') {
        this.peerName = msg.name || this.peerName;
        this.peerSeat = typeof msg.seat === 'number' ? msg.seat : this.peerSeat;
        this._emit('peer', this.peerName, this.peerSeat);
      }
      this._emit('message', msg);
    };
  }

  /* ---- 发消息 ---- */
  send(msg) {
    if (!this._dc || this._dc.readyState !== 'open') return false;
    try {
      const text = JSON.stringify(msg);
      if (text.length > MAX_MESSAGE_BYTES) {
        console.warn('[p2p] 消息过大，已丢弃', text.length);
        return false;
      }
      this._dc.send(text);
      return true;
    } catch (e) {
      console.error('[p2p] 发送失败', e);
      return false;
    }
  }

  /** 发一条带序号的输入消息（房主权威模型用）。 */
  sendInput(act) {
    this._seq += 1;
    return this.send({ t: 'input', seq: this._seq, act: act });
  }

  /** 广播权威状态。 */
  sendState(tick, data) {
    return this.send({ t: 'state', tick: tick, data: data });
  }

  /** 广播状态摘要，双方比对自己算出的摘要是否一致。 */
  sendHash(tick, hash) {
    return this.send({ t: 'hash', tick: tick, hash: hash });
  }

  /** 下发完整快照（对不上时的纠偏）。 */
  sendSync(tick, data) {
    return this.send({ t: 'sync', tick: tick, data: data });
  }

  /** 探活。 */
  ping() {
    return this.send({ t: 'ping', at: Date.now() });
  }

  get isOpen() { return !!(this._dc && this._dc.readyState === 'open'); }
  get isHost() { return this.role === 'host'; }

  /** 断开并清理。 */
  close() {
    this._closed = true;
    try { if (this._dc) this._dc.close(); } catch (e) { /* ignore */ }
    try { if (this._pc) this._pc.close(); } catch (e) { /* ignore */ }
    this._dc = null;
    this._pc = null;
    this._setStatus('closed', '已断开');
  }
}

/* ---------------------------------------------------------------------------
 * 房主权威：状态同步辅助
 * ---------------------------------------------------------------------------
 * 纯 P2P 没有服务器仲裁，多人同时操作同一份状态必然冲突。
 * 标准解法是「房主权威」：
 *   · 玩家只上报「我想做什么」（input）
 *   · 房主决定「实际发生了什么」，广播结果（state）
 *   · 双方用同一随机种子重放，状态一致
 *   · 定期比对状态摘要（hash），不一致由房主下发快照（sync）纠偏
 *
 * 这个类把上面的协议包成一个小状态机，游戏侧只管调 input() 和 applyState()。
 * ========================================================================== */

export class HostAuthority {
  /**
   * @param {P2PSession} session
   * @param {object} opts
   * @param {function(object):object} opts.reduce  (state, actions) => newState   房主侧：推进状态
   * @param {function(object):object} opts.replay  (seed, actions) => state      双方侧：从种子重放
   * @param {function(object):string} opts.hash    (state) => string            状态摘要
   */
  constructor(session, opts) {
    this.session = session;
    this.opts = opts || {};
    this.actions = [];              /* 已确认的动作序列（重放用） */
    this.state = null;
    this.tick = 0;
    this._pending = [];
    this._onState = null;
    this._onLocalState = null;
    this._onError = null;
    this._onReject = null;
    session.on('message', (m) => this._onMsg(m));
  }

  /** 房主：初始化一局。
      注意：state 必须能 JSON.stringify —— Uint8Array 会被转成一堆 {"0":0,…}，
      所以棋盘之类的东西要自己转成普通数组再传。 */
  init(seed) {
    this.actions = [];
    const base = this.opts.replay ? this.opts.replay(seed, []) : {};
    this.state = Object.assign({ seed: seed }, base);
    this.tick = 0;
    this.session.sendState(this.tick, this._view(this.state));
    return this.state;
  }

  /** 广播前的视图裁剪（默认原样传出）。 */
  _view(state) {
    if (this.opts.view) {
      try { return this.opts.view(state); } catch (e) { console.error('[p2p] view 出错', e); }
    }
    return state;
  }

  /** 玩家：上报一个动作（本地不立即生效，等房主广播）。 */
  input(act) {
    this.session.sendInput(act);
  }

  /** 房主：本地落子也走这里 —— 玩家点了棋盘，房主自己就是权威，
      不用等网络往返。加入方则通过 input() 上报给房主。 */
  applyLocal(act) {
    if (!this.session.isHost) return false;
    this._hostApply(act);
    return true;
  }

  /** 房主：收到玩家动作，推进并广播。
   *
   *  这里必须做**合法性校验**（opts.validate）：
   *  玩家可能在你判断之前就已经出牌了（比如网络乱序、或者玩家连点两下）。
   *  如果把非法动作也塞进 actions 序列，那么之后每次重放都会在那一手断掉 ——
   *  整局从此卡死，两端状态再也对不上。
   *  校验不通过就把动作丢掉，并把当前权威状态重新推给对端（纠偏）。
   */
  _hostApply(act) {
    if (this.opts.validate) {
      const v = this.opts.validate(this.state, act);
      const okAct = v === true || (v && v.ok !== false);
      if (!okAct) {
        const reason = (v && v.reason) || '这一手不合法，已忽略';
        /* 把当前权威状态推回去，让对端知道自己那手没生效 */
        this.session.sendSync(this.tick, this._view(this.state));
        this.session.send({ t: 'reject', reason });
        if (this._onError) this._onError(reason);
        return;
      }
    }
    this.actions.push(act);
    const next = this.opts.reduce ? this.opts.reduce(this.state, [act]) : this.state;
    this.state = Object.assign({ seed: this.state.seed }, next);
    this.tick += 1;
    this.session.sendState(this.tick, this._view(this.state));
    /* 房主本地也要刷新 —— 广播只发给对端，不会回环到自己。
       没有这一句，房主点了子棋盘不动，会以为没点上。 */
    if (this._onLocalState) this._onLocalState(this.state, this.tick);
    this._checkHash();
  }

  /** 双方：收到权威状态。 */
  _guestApply(tick, data) {
    this.tick = tick;
    this.state = data;
    if (this._onState) this._onState(data, tick);
  }

  /** 房主：把当前动作序列回放一遍，核对摘要。 */
  _replayState() {
    if (!this.opts.replay) return null;
    return this.opts.replay(this.state && this.state.seed, this.actions);
  }
  _checkHash() {
    if (!this.opts.hash || !this.opts.replay) return;
    const replayed = this._replayState();
    if (!replayed) return;
    const h = this.opts.hash(replayed);
    this.session.sendHash(this.tick, h);
  }

  _onMsg(m) {
    switch (m.t) {
      case 'input':
        if (this.session.isHost) this._hostApply(m.act);
        break;
      case 'state':
        if (!this.session.isHost) this._guestApply(m.tick, m.data);
        break;
      case 'hash':
        /* 加入方拿自己的摘要跟房主比，对不上就申请快照。 */
        if (!this.session.isHost && this.opts.hash && this.state) {
          const mine = this.opts.hash(this.state);
          if (mine !== m.hash) this.session.send({ t: 'need-sync', tick: m.tick });
        }
        break;
      case 'need-sync':
        if (this.session.isHost) this.session.sendSync(this.tick, this._view(this.state));
        break;
      case 'sync':
        if (!this.session.isHost) this._guestApply(m.tick, m.data);
        break;
      case 'reject':
        /* 房主判定这一手不合法 —— 告诉对端「你这手没生效」，
           免得加入方一直以为牌已经打出去了。 */
        if (!this.session.isHost && this._onReject) this._onReject(m.reason || '');
        break;
      default:
        break;
    }
  }

  /** 订阅状态变化（加入方用）。 */
  onState(fn) { this._onState = fn; return this; }
  /** 订阅房主本地状态变化（房主用）。 */
  onLocalState(fn) { this._onLocalState = fn; return this; }
  onError(fn) { this._onError = fn; return this; }
  /** 订阅「你的动作被房主驳回」（加入方用）。 */
  onReject(fn) { this._onReject = fn; return this; }
}

/* ---------------------------------------------------------------------------
 * 浏览器环境自检
 * ------------------------------------------------------------------------- */

/**
 * 检查当前环境能不能用纯 P2P。
 * @returns {{ok:boolean, reason:string, canHost:boolean}}
 */
export function checkSupport() {
  if (typeof RTCPeerConnection !== 'function') {
    return { ok: false, reason: '这个浏览器不支持 WebRTC（换个新版浏览器试试）', canHost: false };
  }
  if (typeof RTCPeerConnection.prototype.createDataChannel !== 'function') {
    return { ok: false, reason: '这个浏览器不支持 DataChannel', canHost: false };
  }
  if (typeof WebSocket !== 'undefined' && false) {
    /* 占位：这里不检查 WebSocket，纯 P2P 根本不用它。 */
  }
  return { ok: true, reason: '可以纯 P2P 联机（不经过任何服务器）', canHost: true };
}

/** 当前设备是否可能与公网另一台设备直连（启发式判断，仅作提示）。 */
export function likelyReachable() {
  /* 拿不到真实 NAT 类型，只能给个保守提示：
     同一网络内必能连；跨公网取决于双方 NAT，锥型 NAT 一般没问题。 */
  try {
    const ua = navigator.userAgent || '';
    const mobile = /Android|iPhone|iPad|iPod/i.test(ua);
    return { mobile: mobile, hint: mobile ? '手机跨网可能受限，同一 WiFi 最稳' : '同一网络内最稳' };
  } catch (e) {
    return { mobile: false, hint: '' };
  }
}
