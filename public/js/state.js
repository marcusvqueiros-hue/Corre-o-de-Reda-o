// Estado central + sincronização "local-first": tudo é gravado no aparelho e enviado quando houver conexão.
import { db } from './db.js';
import { Net } from './net.js';
import { uuid, dmChannel, dmOther } from './util.js';
import { beep, vibrate } from './sound.js';

const listeners = new EventTarget();
export const emit = (name, detail) => listeners.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => {
  const f = (e) => fn(e.detail);
  listeners.addEventListener(name, f);
  return () => listeners.removeEventListener(name, f);
};

export const DEFAULT_PREFS = { sound: true, vibrate: true, saver: false, share: true, wake: false, large: false, notif: true, serverUrl: '', consent: false };

export const S = {
  ready: false,
  deviceId: '',
  session: null, // { token, me }
  me: null,
  users: new Map(),
  msgs: new Map(), // canal -> mensagens ordenadas
  byId: new Map(),
  lastSeq: 0,
  lastRead: {},
  peerRead: {},
  trails: new Map(),
  settings: { shareMap: false, groupName: 'Geral', motd: '' },
  prefs: { ...DEFAULT_PREFS },
  conn: 'offline', // offline | connecting | online
  info: null,
  activeCh: null,
  outboxCount: 0,
  locQueued: 0,
  myLoc: null,
  geoState: 'idle', // idle | on | denied | unavailable | insecure | searching
  battery: null,
  authError: null,
};

export const net = new Net();
const outbox = new Map();

// ---------- persistência ----------
const saveKv = (k, v) => db.put('kv', v, k);
export const savePrefs = () => saveKv('prefs', S.prefs);

function sortChannel(arr) {
  arr.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || a.cts - b.cts);
}

// ---------- inicialização ----------
export async function init() {
  await db.init();
  S.prefs = { ...DEFAULT_PREFS, ...((await db.get('kv', 'prefs')) || {}) };
  S.deviceId = (await db.get('kv', 'deviceId')) || uuid();
  await saveKv('deviceId', S.deviceId);
  S.session = (await db.get('kv', 'session')) || null;
  S.lastSeq = (await db.get('kv', 'lastSeq')) || 0;
  S.lastRead = (await db.get('kv', 'lastRead')) || {};
  S.peerRead = (await db.get('kv', 'peerRead')) || {};
  S.settings = { ...S.settings, ...((await db.get('kv', 'settings')) || {}) };
  S.info = (await db.get('kv', 'info')) || null;
  for (const u of await db.all('users')) S.users.set(u.id, u);
  for (const m of await db.all('msgs')) addLocal(m);
  for (const arr of S.msgs.values()) sortChannel(arr);
  for (const m of await db.all('outbox')) outbox.set(m.id, m);
  S.outboxCount = outbox.size;
  if (S.session) S.me = S.session.me;
  refreshInfo();
  S.ready = true;
  if (S.session) startNet();
  setInterval(resendStale, 6000);
}

export function serverBase() {
  const u = S.prefs.serverUrl.trim();
  if (!u) return '';
  return /^https?:\/\//.test(u) ? u.replace(/\/+$/, '') : `https://${u.replace(/\/+$/, '')}`;
}
function wsUrl() {
  const b = serverBase();
  if (b) return b.replace(/^http/, 'ws') + '/ws';
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

export async function refreshInfo() {
  try {
    const r = await fetch(serverBase() + '/api/info', { cache: 'no-store' });
    S.info = await r.json();
    saveKv('info', S.info);
    emit('info');
  } catch (_) { /* offline: usa o último conhecido */ }
}

// ---------- entrar / sair ----------
export async function join({ name, code, adminPassword }) {
  let r;
  try {
    r = await fetch(serverBase() + '/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code, adminPassword: adminPassword || undefined, deviceId: S.deviceId }),
    });
  } catch (_) {
    throw new Error('Sem conexão com o servidor. Conecte-se à rede local (Wi-Fi do administrador) e tente de novo.');
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = { code: 'Código de acesso incorreto.', admin_password: 'Senha de administrador incorreta.', banned: 'Acesso bloqueado pelo administrador.', rate: 'Muitas tentativas. Aguarde alguns minutos.', admin_required: 'Este aparelho é de um administrador: informe a senha.', name: 'Informe um nome.' }[d.error];
    throw new Error(msg || 'Não foi possível entrar.');
  }
  S.session = { token: d.token, me: d.user, code: code || '' };
  S.me = d.user;
  S.authError = null;
  await saveKv('session', S.session);
  startNet();
  emit('session');
}

export async function logout(wipe = true) {
  net.stop();
  S.session = null; S.me = null; S.conn = 'offline';
  await db.del('kv', 'session');
  if (wipe) {
    for (const st of ['msgs', 'outbox', 'locq', 'users']) await db.clear(st);
    for (const k of ['lastSeq', 'lastRead', 'peerRead', 'settings']) await db.del('kv', k);
    S.msgs.clear(); S.byId.clear(); S.users.clear(); outbox.clear(); S.trails.clear();
    S.lastSeq = 0; S.lastRead = {}; S.peerRead = {}; S.outboxCount = 0; S.locQueued = 0;
  }
  emit('session');
}

// ---------- rede ----------
function startNet() { net.start(wsUrl()); }

net.addEventListener('open', () => net.send({ t: 'hello', token: S.session?.token, lastSeq: S.lastSeq }));
net.addEventListener('state', () => { setConn(); });
net.addEventListener('msg', (e) => handle(e.detail));
net.addEventListener('close', (e) => { if (e.detail === 4003) forceLogout('Acesso bloqueado pelo administrador.'); });
function setConn() {
  const c = net.state === 'online' ? 'online' : net.state === 'offline' ? 'offline' : 'connecting';
  if (S.conn !== c) { S.conn = c; emit('conn', c); }
}
async function forceLogout(msg) {
  await logout(true);
  S.authError = msg;
  emit('session');
}

async function reauth() {
  // O servidor não reconhece o token (ex.: dados do servidor apagados): tenta reentrar automaticamente.
  try {
    await join({ name: S.me?.name || 'Usuário', code: S.session?.code || '' });
  } catch (err) {
    await forceLogout(S.me?.role === 'admin' ? 'Sessão expirada. Entre novamente como administrador.' : err.message);
  }
}

function handle(d) {
  switch (d.t) {
    case 'hello_ok': {
      if (d.seq < S.lastSeq) { // servidor foi reiniciado do zero: refaz o histórico
        S.lastSeq = 0; saveKv('lastSeq', 0);
        for (const arr of S.msgs.values()) arr.length = 0;
        S.byId.clear(); db.clear('msgs');
        net.reconnectNow();
        return;
      }
      S.me = { ...S.me, ...d.me };
      S.session.me = S.me; saveKv('session', S.session);
      S.settings = d.settings; saveKv('settings', S.settings);
      net.markReady();
      emit('settings');
      emit('online');
      flushOutbox();
      break;
    }
    case 'users': {
      S.users = new Map(d.users.map((u) => [u.id, u]));
      for (const u of d.users) db.put('users', u);
      emit('users');
      break;
    }
    case 'presence': {
      const old = S.users.get(d.u.id);
      const u = { ...old, ...d.u };
      if (!d.u.loc && old?.loc) u.loc = old.loc;
      S.users.set(u.id, u);
      db.put('users', u);
      if (S.me && u.id === S.me.id) { S.me = { ...S.me, status: u.status, name: u.name }; }
      emit('users');
      if (S.me?.role === 'admin' && u.status === 'sos' && old?.status !== 'sos' && u.id !== S.me.id) emit('sos', u);
      break;
    }
    case 'backlog': {
      for (const m of d.msgs) ingest(m, true);
      if (d.done) emit('synced');
      break;
    }
    case 'msg': ingest(d.m, false); break;
    case 'ack': {
      const m = S.byId.get(d.id);
      if (m) { m.seq = d.seq; m.sts = d.sts; m.status = 'sent'; persistMsg(m); resort(m.ch); noteSeq(d.seq); }
      if (outbox.delete(d.id)) { db.del('outbox', d.id); S.outboxCount = outbox.size; }
      emit('msgupdate', d.id);
      emit('outbox');
      break;
    }
    case 'nack': {
      const m = S.byId.get(d.id);
      if (m) { m.status = 'failed'; m.reason = d.reason; persistMsg(m); }
      if (outbox.delete(d.id)) { db.del('outbox', d.id); S.outboxCount = outbox.size; }
      emit('msgupdate', d.id);
      emit('outbox');
      break;
    }
    case 'loc': {
      const u = S.users.get(d.uid);
      if (u) {
        S.users.set(d.uid, { ...u, loc: d.p });
        const tr = S.trails.get(d.uid);
        if (tr) tr.push([d.p.ts, d.p.lat, d.p.lng, d.p.acc]);
        emit('loc', d.uid);
      }
      break;
    }
    case 'trail': S.trails.set(d.uid, d.pts); emit('trail', d.uid); break;
    case 'loc_ok': emit('loc_ok', d); break;
    case 'locate': emit('locate'); break;
    case 'settings': S.settings = d.s; saveKv('settings', S.settings); emit('settings'); break;
    case 'read': {
      S.peerRead[d.ch] = Math.max(S.peerRead[d.ch] || 0, d.seq);
      saveKv('peerRead', S.peerRead);
      emit('peerread', d.ch);
      break;
    }
    case 'del': {
      const m = S.byId.get(d.id);
      if (m) { m.deleted = true; m.text = ''; m.img = null; m.loc = null; persistMsg(m); emit('msgupdate', d.id); emit('msg', m.ch); }
      break;
    }
    case 'err':
      if (d.code === 'auth') reauth();
      else if (d.code === 'banned') forceLogout('Acesso bloqueado pelo administrador.');
      else if (d.code === 'rate') emit('toast', 'Muitas ações seguidas. Aguarde um instante.');
      break;
    default: break;
  }
}

// ---------- mensagens ----------
function addLocal(m) {
  let arr = S.msgs.get(m.ch);
  if (!arr) { arr = []; S.msgs.set(m.ch, arr); }
  arr.push(m);
  S.byId.set(m.id, m);
}
function resort(ch) { const a = S.msgs.get(ch); if (a) sortChannel(a); }
const persistMsg = (m) => db.put('msgs', m);
function noteSeq(seq) {
  if (seq > S.lastSeq) { S.lastSeq = seq; saveKv('lastSeq', seq); }
}

function ingest(m, backlog) {
  const ex = S.byId.get(m.id);
  if (ex) {
    Object.assign(ex, m, { status: 'sent' });
    persistMsg(ex); resort(ex.ch); noteSeq(m.seq);
    emit('msgupdate', m.id);
    return;
  }
  m.status = 'sent';
  addLocal(m);
  resort(m.ch);
  persistMsg(m);
  noteSeq(m.seq);
  emit('msg', m.ch);
  if (!backlog && S.me && m.from !== S.me.id) notifyIncoming(m);
}

export function channelMsgs(ch) { return S.msgs.get(ch) || []; }

export function unread(ch) {
  const last = S.lastRead[ch] || 0;
  let n = 0;
  for (const m of channelMsgs(ch)) if (m.seq > last && m.from !== S.me?.id && !m.deleted) n++;
  return n;
}
export function totalUnread() {
  let n = 0;
  for (const ch of S.msgs.keys()) n += unread(ch);
  return n;
}

export function markRead(ch) {
  const arr = channelMsgs(ch);
  const top = arr.reduce((a, m) => (m.seq && m.seq > a ? m.seq : a), 0);
  if (top > (S.lastRead[ch] || 0)) {
    S.lastRead[ch] = top;
    saveKv('lastRead', S.lastRead);
    if (ch.startsWith('dm:')) net.send({ t: 'read', ch, seq: top });
    emit('unread');
  }
}

export function isRead(m) { // recibo de leitura em conversas diretas
  return m.ch.startsWith('dm:') && m.seq && (S.peerRead[m.ch] || 0) >= m.seq;
}

function notifyIncoming(m) {
  const sender = S.users.get(m.from);
  const name = sender?.name || 'Alguém';
  const viewing = S.activeCh === m.ch && !document.hidden;
  const sos = m.kind === 'sos';
  if (viewing && !sos) { markRead(m.ch); if (S.prefs.sound) beep.msg(); return; }
  if (S.prefs.sound) (sos ? beep.alert : beep.msg)();
  if (S.prefs.vibrate) vibrate(sos ? [300, 120, 300, 120, 600] : 80);
  if (document.hidden && S.prefs.notif && 'Notification' in window && Notification.permission === 'granted') {
    const title = sos ? `🆘 SOS — ${name}` : m.ch === 'alerts' ? '📢 Aviso do comando' : name;
    const body = m.kind === 'image' ? '📷 Foto' : m.kind === 'loc' ? '📍 Localização' : m.text.slice(0, 140);
    navigator.serviceWorker?.getRegistration().then((reg) => reg?.showNotification(title, { body, tag: m.ch, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', vibrate: sos ? [300, 100, 300] : [80], requireInteraction: sos, data: { ch: m.ch } }));
  }
  emit('incoming', m);
}

export function send(partial) {
  if (!S.me) return null;
  const m = { id: uuid(), from: S.me.id, cts: Date.now(), status: 'pending', text: '', ...partial };
  addLocal(m);
  resort(m.ch);
  persistMsg(m);
  outbox.set(m.id, { ...m, lastTry: 0 });
  db.put('outbox', outbox.get(m.id));
  S.outboxCount = outbox.size;
  emit('msg', m.ch);
  emit('outbox');
  trySend(m.id);
  if (S.prefs.sound) beep.sent();
  return m;
}

function trySend(id) {
  const o = outbox.get(id);
  if (!o || net.state !== 'online') return;
  o.lastTry = Date.now();
  const { id: i, ch, kind, text, img, loc, cts } = o;
  net.send({ t: 'msg', id: i, ch, kind, text, img, loc, cts });
}
function flushOutbox() { for (const id of [...outbox.keys()].sort((a, b) => outbox.get(a).cts - outbox.get(b).cts)) trySend(id); }
function resendStale() {
  if (net.state !== 'online') return;
  const now = Date.now();
  for (const [id, o] of outbox) if (now - o.lastTry > 8000) trySend(id);
}
export function retry(id) {
  const m = S.byId.get(id);
  if (!m || m.status !== 'failed') return;
  m.status = 'pending'; persistMsg(m);
  outbox.set(id, { ...m, lastTry: 0 }); db.put('outbox', outbox.get(id));
  S.outboxCount = outbox.size;
  emit('msgupdate', id); trySend(id);
}

export const sendText = (ch, text) => text.trim() && send({ ch, kind: 'text', text: text.trim() });
export const sendImage = (ch, img) => send({ ch, kind: 'image', img });
export const sendLocationMsg = (ch) => S.myLoc && send({ ch, kind: 'loc', loc: { lat: S.myLoc.lat, lng: S.myLoc.lng, acc: S.myLoc.acc }, text: '' });
export const sendSOS = (text = '') => send({ ch: 'general', kind: 'sos', text, loc: S.myLoc ? { lat: S.myLoc.lat, lng: S.myLoc.lng, acc: S.myLoc.acc } : null });

export function setStatus(status) {
  if (S.me) { S.me = { ...S.me, status }; const u = S.users.get(S.me.id); if (u) S.users.set(u.id, { ...u, status }); }
  net.send({ t: 'status', status });
  emit('users');
}
export const rename = (name) => net.send({ t: 'rename', name });
export const admin = (op, data = {}) => net.send({ t: 'admin', op, ...data });
export const requestTrail = (uid) => net.send({ t: 'get_trail', uid });
export const dm = (uid) => dmChannel(S.me.id, uid);
export const chTitle = (ch) => {
  if (ch === 'general') return S.settings.groupName || 'Geral';
  if (ch === 'alerts') return 'Avisos do comando';
  return S.users.get(dmOther(ch, S.me?.id))?.name || 'Conversa';
};

export async function exportFile(kind) {
  const path = kind === 'geojson' ? '/api/export/locations.geojson' : '/api/export/messages.csv';
  const r = await fetch(serverBase() + path, { headers: { Authorization: 'Bearer ' + S.session.token } });
  if (!r.ok) throw new Error('Falha na exportação (precisa estar conectado).');
  return r.blob();
}

// reage a mudanças de preferência de bateria etc.
export function setPref(k, v) { S.prefs[k] = v; savePrefs(); emit('prefs', k); }
