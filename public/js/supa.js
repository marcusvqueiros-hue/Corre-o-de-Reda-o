// Transporte "nuvem": fala com o Supabase por RPC (PostgREST) e reproduz o mesmo protocolo do WebSocket local,
// para que o restante do app (estado, fila offline, telas) funcione sem alterações.
import { CONFIG } from './config.js';

export const cloud = !!(CONFIG && CONFIG.supabase && CONFIG.supabase.url);
const SB = cloud ? CONFIG.supabase : { url: '', key: '' };

class RpcError extends Error {
  constructor(message, { network = false, status = 0 } = {}) { super(message); this.network = network; this.status = status; }
}

export async function rpc(fn, args = {}, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(`${SB.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: SB.key, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: ctl.signal,
    });
  } catch (_) {
    throw new RpcError('network', { network: true });
  } finally { clearTimeout(timer); }
  const text = await r.text().catch(() => '');
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch (_) { /* resposta não-JSON */ }
  if (!r.ok) throw new RpcError(d?.message || `http_${r.status}`, { network: r.status >= 500 || r.status === 429, status: r.status });
  return d;
}

// ---------- API "HTTP" equivalente ----------
export const backend = {
  info: () => rpc('elo_info'),
  async join({ name, deviceId, code, adminPassword }) {
    return rpc('elo_join', { p_name: name, p_device: deviceId, p_code: code || '', p_admin_pw: adminPassword || '' });
  },
  setAdminPassword: (token, pw) => rpc('elo_set_admin_password', { p_token: token, p_new: pw }),
  async exportBlob(token, kind) {
    const d = await rpc('elo_export', { p_token: token, p_kind: kind === 'geojson' ? 'geojson' : 'messages' }, 30000);
    if (kind === 'geojson') return new Blob([JSON.stringify(d)], { type: 'application/geo+json' });
    const esc = (s) => { s = String(s ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const rows = ['seq,hora,canal,de,tipo,texto,lat,lng'];
    for (const m of d) rows.push([m.seq, new Date(m.sts).toISOString(), m.ch, esc(m.from), m.kind, esc(m.text), m.lat ?? '', m.lng ?? ''].join(','));
    return new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  },
};

// ---------- transporte ----------
const POLL_VISIBLE = 2500;
const POLL_HIDDEN = 15000;
const ONLINE_MS = 30000;

export class SupaNet extends EventTarget {
  constructor() {
    super();
    this.state = 'offline';
    this.want = false;
    this.gen = 0;
    this.attempt = 0;
    this.token = null;
    this._timer = null;
    this._polling = false;
    this._reset();
    window.addEventListener('online', () => this.want && this.state !== 'online' && this.reconnectNow());
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.state === 'online') this.kick(150); });
  }

  _reset() {
    this.seq = 0; this.ucur = 0; this.dcur = 0; this.first = true;
    this.revs = new Map(); this.online = new Map(); this.locTs = new Map();
    this.seenMsgs = new Set(); this.seenDels = new Set(); this.readSeq = new Map();
    this.settingsJson = ''; this.inflight = new Set();
  }
  _set(s) { if (this.state !== s) { this.state = s; this.dispatchEvent(new CustomEvent('state', { detail: s })); } }
  _emit(o) { this.dispatchEvent(new CustomEvent('msg', { detail: o })); }
  markReady() { this._set('online'); }

  start() { this.stop(); this.want = true; this.attempt = 0; this._connect(); }
  stop() {
    this.want = false; this.gen++;
    clearTimeout(this._timer); this._polling = false;
    this._set('offline');
  }
  reconnectNow() { if (!this.want) return; this.gen++; clearTimeout(this._timer); this._polling = false; this.attempt = 0; this._connect(); }

  async _connect() {
    if (!this.want) return;
    const gen = this.gen;
    this._set('connecting');
    try {
      await rpc('elo_info', {}, 10000);
    } catch (_) {
      if (gen === this.gen) this._down(1006);
      return;
    }
    if (gen !== this.gen || !this.want) return;
    this.attempt = 0;
    this._set('connected');
    this.dispatchEvent(new Event('open')); // o estado responde com { t:'hello' }
  }

  _down(code) {
    this.gen++; this._polling = false; clearTimeout(this._timer);
    this._set('offline');
    this.dispatchEvent(new CustomEvent('close', { detail: code }));
    if (this.want && code !== 4002 && code !== 4003) {
      const base = Math.min(15000, 800 * 2 ** Math.min(this.attempt++, 5));
      this._timer = setTimeout(() => this._connect(), base / 2 + Math.random() * base / 2);
    }
  }

  kick(ms = 0) {
    if (!this.want || this.state !== 'online') return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._poll(), ms);
  }
  _schedule() { this.kick(document.hidden ? POLL_HIDDEN : POLL_VISIBLE); }

  // ---------- saída (cliente -> servidor) ----------
  send(o) {
    if (!this.want || (this.state !== 'online' && this.state !== 'connected')) return false;
    const T = this.token;
    switch (o.t) {
      case 'hello':
        this.token = o.token; this._reset(); this.seq = Number(o.lastSeq) || 0;
        this._poll(true);
        break;
      case 'ping': break;
      case 'msg': this._send(o); break;
      case 'loc': this._call('elo_loc', { p_token: T, p_points: [o.p] }).then((d) => d && this._emit({ t: 'loc_ok', ts: d.ts })); break;
      case 'locs': this._call('elo_loc', { p_token: T, p_points: o.items }).then((d) => d && this._emit({ t: 'loc_ok', ts: d.ts, n: o.items.length })); break;
      case 'status': this._call('elo_status', { p_token: T, p_status: o.status }).then(() => this.kick(300)); break;
      case 'rename': this._call('elo_rename', { p_token: T, p_name: o.name }).then(() => this.kick(300)); break;
      case 'read': this._call('elo_read', { p_token: T, p_ch: o.ch, p_seq: o.seq }); break;
      case 'get_trail': this._call('elo_trail', { p_token: T, p_uid: o.uid }).then((pts) => pts && this._emit({ t: 'trail', uid: o.uid, pts })); break;
      case 'admin': {
        const { t, op, ...args } = o;
        this._call('elo_admin', { p_token: T, p_op: op, p_args: args }).then((ok) => ok !== undefined && this.kick(250));
        break;
      }
      default: return false;
    }
    return true;
  }

  async _send(o) {
    if (this.inflight.has(o.id)) return;
    this.inflight.add(o.id);
    const { id, ch, kind, text, img, loc, cts } = o;
    try {
      const d = await this._call('elo_send', { p_token: this.token, p_msg: { id, ch, kind, text, img, loc, cts } });
      if (d?.ack) { this.seenMsgs.add(id); this._emit({ t: 'ack', ...d.ack }); this.kick(400); }
      else if (d?.nack) this._emit({ t: 'nack', ...d.nack });
    } finally { this.inflight.delete(id); }
  }

  // chamada com tratamento de erros de sessão; erros de rede ficam para o reenvio automático
  async _call(fn, args) {
    const gen = this.gen;
    try { const d = await rpc(fn, args); return d === null || d === undefined ? true : d; }
    catch (e) {
      if (gen !== this.gen) return undefined;
      if (e.message === 'auth') this._authLost();
      else if (e.message === 'banned') this._down(4003);
      else if (e.message === 'forbidden') this._emit({ t: 'err', code: 'forbidden' });
      return undefined;
    }
  }
  _authLost() { this.want = false; this.gen++; clearTimeout(this._timer); this._set('offline'); this._emit({ t: 'err', code: 'auth' }); }

  // ---------- entrada (servidor -> cliente) ----------
  async _poll(first = false) {
    if (!this.want || this._polling) return;
    this._polling = true;
    const gen = this.gen;
    let d;
    try {
      d = await rpc('elo_poll', { p_token: this.token, p_since_seq: this.seq, p_since_users: this.ucur, p_since_del: this.dcur }, 20000);
    } catch (e) {
      if (gen !== this.gen) return;
      this._polling = false;
      if (e.message === 'auth') return this._authLost();
      if (e.message === 'banned') return this._down(4003);
      return this._down(1006);
    }
    if (gen !== this.gen) return;
    this._polling = false;
    try { this._apply(d); } catch (err) { console.error('[elo] erro ao aplicar atualização', err); }
    if (this.state === 'online') this._schedule();
  }

  _apply(d) {
    const first = this.first;
    const now = d.now;
    const gen = this.gen;
    if (first) {
      this._emit({ t: 'hello_ok', me: d.me, seq: d.seq, serverTime: now, settings: d.settings });
      if (gen !== this.gen) return; // o estado pode ter reiniciado a conexão (servidor zerado)
      this.first = false;
      this.settingsJson = JSON.stringify(d.settings);
    }
    // usuários
    if (first) {
      for (const u of d.users) { this.revs.set(u.id, u.rev); this.online.set(u.id, u.online); if (u.loc) this.locTs.set(u.id, u.loc.ts); }
      this._emit({ t: 'users', users: d.users });
    } else {
      for (const u of d.users) {
        if ((this.revs.get(u.id) || 0) >= u.rev) continue;
        this.revs.set(u.id, u.rev); this.online.set(u.id, u.online);
        this._emit({ t: 'presence', u });
        if (u.loc && this.locTs.get(u.id) !== u.loc.ts && u.id !== d.me.id) { this.locTs.set(u.id, u.loc.ts); this._emit({ t: 'loc', uid: u.id, p: u.loc }); }
      }
      for (const [id, seen] of Object.entries(d.seen || {})) {
        const on = now - seen < ONLINE_MS;
        if (this.online.has(id) && this.online.get(id) !== on) { this.online.set(id, on); this._emit({ t: 'presence', u: { id, online: on, lastSeen: seen } }); }
      }
    }
    // mensagens
    const fresh = [];
    for (const m of d.msgs) {
      if (m.seq > this.seq) this.seq = m.seq;
      if (this.seenMsgs.has(m.id) && !first) continue;
      this.seenMsgs.add(m.id);
      fresh.push(m);
    }
    if (first) this._emit({ t: 'backlog', msgs: fresh, done: true });
    else for (const m of fresh) this._emit({ t: 'msg', m });
    // apagadas
    for (const id of d.dels) if (!this.seenDels.has(id)) { this.seenDels.add(id); this._emit({ t: 'del', id }); }
    // recibos de leitura
    for (const r of d.reads) {
      const k = `${r.ch}|${r.by}`;
      if ((this.readSeq.get(k) || 0) < r.seq) { this.readSeq.set(k, r.seq); this._emit({ t: 'read', ch: r.ch, by: r.by, seq: r.seq }); }
    }
    // configurações e pedido de posição
    const sj = JSON.stringify(d.settings);
    if (!first && sj !== this.settingsJson) { this.settingsJson = sj; this._emit({ t: 'settings', s: d.settings }); }
    if (d.locate) this._emit({ t: 'locate' });
    this.ucur = d.ucur; this.dcur = d.dcur;
  }
}
