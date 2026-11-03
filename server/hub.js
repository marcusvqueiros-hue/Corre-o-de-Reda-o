'use strict';
// Lógica do protocolo: autenticação por token, salas, entrega, presença e localização.
const { uid: newId, haversine, cleanName } = require('./util');
const { canSee } = require('./store');

const MAX_TEXT = 4000;
const MAX_IMG = 180000; // caracteres do dataURL (cliente comprime para ~100 KB)
const STATUSES = new Set(['unknown', 'safe', 'help', 'injured', 'sos']);
const KINDS = new Set(['text', 'image', 'sos', 'loc']);

const validCoord = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

class Hub {
  constructor(store) {
    this.store = store;
    this.conns = new Set();
    this.online = new Map(); // userId -> Set<conn>
    this.lastLocWrite = new Map(); // userId -> {ts, lat, lng}
    this.hb = setInterval(() => this._heartbeat(), 20000);
    this.hb.unref();
  }

  // ---------- util ----------
  isOnline(id) { return (this.online.get(id)?.size || 0) > 0; }
  canSeeLoc(viewer) { return viewer.role === 'admin' || this.store.settings.shareMap; }

  pubUser(u, viewer) {
    const o = {
      id: u.id, name: u.name, role: u.role, status: u.status || 'unknown',
      online: this.isOnline(u.id), lastSeen: u.lastSeen || 0,
    };
    if (viewer.role === 'admin') o.banned = !!u.banned;
    if (u.loc && this.canSeeLoc(viewer)) o.loc = u.loc;
    return o;
  }

  pubSettings(viewer) {
    const s = this.store.settings;
    const o = { shareMap: !!s.shareMap, groupName: s.groupName, motd: s.motd };
    if (viewer.role === 'admin') o.accessCode = s.accessCode;
    return o;
  }

  send(conn, obj) { return conn.send(JSON.stringify(obj)); }

  eachAuthed(fn) { for (const c of this.conns) if (c.user) fn(c); }

  sendToUser(id, obj) {
    const set = this.online.get(id);
    if (!set) return;
    const s = JSON.stringify(obj);
    for (const c of set) c.send(s);
  }

  broadcastPresence(u) {
    this.eachAuthed((c) => this.send(c, { t: 'presence', u: this.pubUser(u, c.user) }));
  }

  sendUsers(conn) {
    const users = [];
    for (const u of this.store.users.values()) if (!u.banned || conn.user.role === 'admin') users.push(this.pubUser(u, conn.user));
    this.send(conn, { t: 'users', users });
  }

  // ---------- conexão ----------
  onConnection(conn) {
    conn.lastRx = Date.now();
    conn.user = null;
    conn.tokens = 30;
    conn.tokenAt = Date.now();
    this.conns.add(conn);
    const authTimer = setTimeout(() => { if (!conn.user) conn.close(4001); }, 10000);
    conn.on('pong', () => { conn.lastRx = Date.now(); });
    conn.on('message', (raw) => {
      conn.lastRx = Date.now();
      let d;
      try { d = JSON.parse(raw); } catch (_) { return; }
      if (!d || typeof d.t !== 'string') return;
      try { this._dispatch(conn, d); } catch (e) { console.error('[hub] erro:', e); }
    });
    conn.on('close', () => {
      clearTimeout(authTimer);
      this.conns.delete(conn);
      if (conn.user) {
        const set = this.online.get(conn.user.id);
        if (set) { set.delete(conn); if (!set.size) this.online.delete(conn.user.id); }
        if (!this.isOnline(conn.user.id)) {
          conn.user.lastSeen = Date.now();
          this.store.saveUser(conn.user);
          this.broadcastPresence(conn.user);
        }
      }
    });
  }

  _heartbeat() {
    const now = Date.now();
    for (const c of this.conns) {
      if (now - c.lastRx > 60000) { c.close(4000); continue; }
      c.ping();
    }
  }

  _rate(conn, cost = 1) {
    const now = Date.now();
    conn.tokens = Math.min(30, conn.tokens + ((now - conn.tokenAt) / 1000) * 5);
    conn.tokenAt = now;
    if (conn.tokens < cost) return false;
    conn.tokens -= cost;
    return true;
  }

  _dispatch(conn, d) {
    if (d.t === 'ping') return this.send(conn, { t: 'pong', ts: Date.now() });
    if (d.t === 'hello') return this._hello(conn, d);
    if (!conn.user) return;
    if (conn.user.banned) return conn.close(4003);
    if (!this._rate(conn, d.t === 'locs' ? 3 : 1)) return this.send(conn, { t: 'err', code: 'rate' });
    switch (d.t) {
      case 'msg': return this._msg(conn, d);
      case 'loc': return this._loc(conn, d.p);
      case 'locs': return this._locs(conn, d.items);
      case 'status': return this._status(conn, d.status);
      case 'read': return this._read(conn, d);
      case 'get_trail': return this._trail(conn, d.uid);
      case 'rename': return this._rename(conn, d.name);
      case 'admin': return this._admin(conn, d);
      default: return undefined;
    }
  }

  // ---------- hello / sincronização ----------
  _hello(conn, d) {
    const user = this.store.userByToken(d.token);
    if (!user) return this.send(conn, { t: 'err', code: 'auth' }), conn.close(4002);
    if (user.banned) return this.send(conn, { t: 'err', code: 'banned' }), conn.close(4003);
    conn.user = user;
    let set = this.online.get(user.id);
    if (!set) { set = new Set(); this.online.set(user.id, set); }
    set.add(conn);
    user.lastSeen = Date.now();

    const lastSeq = Number.isFinite(d.lastSeq) ? d.lastSeq : 0;
    const limit = lastSeq === 0 ? 300 : 1500;
    const backlog = this.store.visibleMsgs(user, lastSeq, limit);
    this.send(conn, {
      t: 'hello_ok',
      me: this.pubUser(user, user),
      seq: this.store.seq,
      serverTime: Date.now(),
      settings: this.pubSettings(user),
    });
    this.sendUsers(conn);
    let chunk = [];
    let size = 0;
    for (const m of backlog) {
      const sz = (m.img ? m.img.length : 0) + 300;
      if (chunk.length && size + sz > 400000) {
        this.send(conn, { t: 'backlog', msgs: chunk });
        chunk = []; size = 0;
      }
      chunk.push(m); size += sz;
    }
    this.send(conn, { t: 'backlog', msgs: chunk, done: true });
    if (set.size === 1) this.broadcastPresence(user);
  }

  // ---------- mensagens ----------
  _msg(conn, d) {
    const u = conn.user;
    const id = typeof d.id === 'string' && /^[\w-]{8,64}$/.test(d.id) ? d.id : null;
    if (!id) return;
    const existing = this.store.msgById.get(id);
    if (existing) return this.send(conn, { t: 'ack', id, seq: existing.seq, sts: existing.sts }); // idempotente
    const ch = String(d.ch || '');
    const kind = KINDS.has(d.kind) ? d.kind : 'text';

    if (ch === 'alerts') { if (u.role !== 'admin') return this._reject(conn, id, 'forbidden'); }
    else if (ch === 'general') { /* ok */ }
    else if (/^dm:[\w-]+:[\w-]+$/.test(ch)) {
      const [, a, b] = ch.split(':');
      if (a > b || (a !== u.id && b !== u.id)) return this._reject(conn, id, 'forbidden');
      const other = a === u.id ? b : a;
      const ou = this.store.users.get(other);
      if (!ou || ou.banned || other === u.id) return this._reject(conn, id, 'forbidden');
    } else return this._reject(conn, id, 'channel');

    let text = typeof d.text === 'string' ? d.text.replace(/\u0000/g, '').slice(0, MAX_TEXT) : '';
    let img = null;
    let loc = null;
    if (kind === 'image') {
      if (typeof d.img !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d.img) || d.img.length > MAX_IMG)
        return this._reject(conn, id, 'image');
      img = d.img;
    }
    if (kind === 'loc' || kind === 'sos') {
      const l = d.loc;
      if (l && validCoord(+l.lat, +l.lng)) loc = { lat: +l.lat, lng: +l.lng, acc: Math.max(0, +l.acc || 0) };
      else if (kind === 'loc') return this._reject(conn, id, 'loc');
    }
    if (kind === 'sos' && ch !== 'general') return this._reject(conn, id, 'channel');
    if (kind === 'text' && !text.trim()) return;

    const cts = Number.isFinite(d.cts) ? d.cts : Date.now();
    const m = { seq: this.store.nextSeq(), id, ch, from: u.id, kind, text, img, loc, cts, sts: Date.now() };
    this.store.addMsg(m);
    this.send(conn, { t: 'ack', id, seq: m.seq, sts: m.sts });

    if (kind === 'sos') {
      u.status = 'sos';
      if (loc) this._loc(conn, { ...loc, ts: Date.now() }, true);
      this.store.saveUser(u);
      this.broadcastPresence(u);
    }
    this.eachAuthed((c) => { if (c !== conn && canSee(c.user, m)) this.send(c, { t: 'msg', m }); });
    // outros aparelhos do mesmo usuário (se houver) já recebem via eachAuthed
  }

  _reject(conn, id, reason) { this.send(conn, { t: 'nack', id, reason }); }

  _read(conn, d) {
    const ch = String(d.ch || '');
    const seq = +d.seq;
    if (!/^dm:[\w-]+:[\w-]+$/.test(ch) || !Number.isFinite(seq)) return;
    const [, a, b] = ch.split(':');
    if (a !== conn.user.id && b !== conn.user.id) return;
    const other = a === conn.user.id ? b : a;
    this.sendToUser(other, { t: 'read', ch, by: conn.user.id, seq });
  }

  _rename(conn, name) {
    const n = cleanName(name);
    if (!n) return;
    conn.user.name = n;
    this.store.saveUser(conn.user);
    this.broadcastPresence(conn.user);
  }

  // ---------- status e localização ----------
  _status(conn, status) {
    if (!STATUSES.has(status) || status === 'sos') return; // SOS só via mensagem sos
    conn.user.status = status;
    this.store.saveUser(conn.user);
    this.broadcastPresence(conn.user);
  }

  _normLoc(p, now = Date.now()) {
    if (!p) return null;
    const lat = +p.lat, lng = +p.lng;
    if (!validCoord(lat, lng)) return null;
    let ts = Number.isFinite(+p.ts) ? +p.ts : now;
    if (ts > now + 3600e3) ts = now;
    const o = { lat, lng, acc: Math.max(0, Math.round(+p.acc || 0)), ts };
    if (Number.isFinite(+p.spd)) o.spd = +(+p.spd).toFixed(1);
    if (Number.isFinite(+p.hdg)) o.hdg = Math.round(+p.hdg);
    if (Number.isFinite(+p.alt)) o.alt = Math.round(+p.alt);
    if (Number.isFinite(+p.bat)) o.bat = Math.max(0, Math.min(100, Math.round(+p.bat)));
    if (p.chg === true || p.chg === false) o.chg = p.chg;
    return o;
  }

  _loc(conn, p, silentSelf) {
    const u = conn.user;
    const pt = this._normLoc(p);
    if (!pt) return;
    this._applyLoc(u, pt, true);
    if (!silentSelf) this.send(conn, { t: 'loc_ok', ts: pt.ts });
  }

  _locs(conn, items) {
    if (!Array.isArray(items)) return;
    const u = conn.user;
    const pts = items.slice(0, 120).map((p) => this._normLoc(p)).filter(Boolean).sort((a, b) => a.ts - b.ts);
    if (!pts.length) return;
    pts.forEach((pt, i) => this._applyLoc(u, pt, i === pts.length - 1, true));
    this.send(conn, { t: 'loc_ok', ts: pts[pts.length - 1].ts, n: pts.length });
  }

  _applyLoc(u, pt, live, forceWrite) {
    const prev = this.lastLocWrite.get(u.id);
    const moved = !prev || haversine(prev.lat, prev.lng, pt.lat, pt.lng) >= 5;
    const stale = !prev || pt.ts - prev.ts >= 10000;
    const newer = !u.loc || pt.ts >= u.loc.ts;
    if (forceWrite || moved || stale) {
      this.store.addLoc(u.id, pt, pt.bat, pt.chg);
      this.lastLocWrite.set(u.id, { lat: pt.lat, lng: pt.lng, ts: pt.ts });
    } else if (newer) {
      u.loc = { ...pt };
    }
    if (live && newer) {
      const msg = JSON.stringify({ t: 'loc', uid: u.id, p: pt });
      this.eachAuthed((c) => { if (c.user.id !== u.id && this.canSeeLoc(c.user)) c.send(msg); });
    }
  }

  _trail(conn, id) {
    if (!this.store.users.has(id)) return;
    if (conn.user.role !== 'admin' && id !== conn.user.id) return;
    this.send(conn, { t: 'trail', uid: id, pts: this.store.trail(id) });
  }

  // ---------- administração ----------
  _admin(conn, d) {
    if (conn.user.role !== 'admin') return this.send(conn, { t: 'err', code: 'forbidden' });
    const s = this.store;
    switch (d.op) {
      case 'setting': {
        const patch = {};
        if (typeof d.accessCode === 'string') patch.accessCode = d.accessCode.trim().slice(0, 40);
        if (typeof d.shareMap === 'boolean') patch.shareMap = d.shareMap;
        if (typeof d.groupName === 'string' && cleanName(d.groupName, 30)) patch.groupName = cleanName(d.groupName, 30);
        if (typeof d.motd === 'string') patch.motd = d.motd.slice(0, 280);
        s.setSettings(patch);
        this.eachAuthed((c) => { this.send(c, { t: 'settings', s: this.pubSettings(c.user) }); if ('shareMap' in patch) this.sendUsers(c); });
        break;
      }
      case 'ban': case 'unban': {
        const u = s.users.get(d.uid);
        if (!u || u.role === 'admin') return;
        u.banned = d.op === 'ban';
        s.saveUser(u);
        if (u.banned) for (const c of [...(this.online.get(u.id) || [])]) { this.send(c, { t: 'err', code: 'banned' }); c.close(4003); }
        this.eachAuthed((c) => this.send(c, { t: 'presence', u: this.pubUser(u, c.user) }));
        break;
      }
      case 'clear_sos': {
        const u = s.users.get(d.uid);
        if (!u) return;
        u.status = 'unknown';
        s.saveUser(u);
        this.broadcastPresence(u);
        break;
      }
      case 'locate': {
        const targets = d.uid === 'all' ? [...this.online.keys()] : [d.uid];
        for (const id of targets) if (id !== conn.user.id) this.sendToUser(id, { t: 'locate' });
        break;
      }
      case 'del_msg': {
        const m = s.msgById.get(d.id);
        if (!m) return;
        s.delMsg(d.id);
        this.eachAuthed((c) => { if (canSee(c.user, m)) this.send(c, { t: 'del', id: d.id }); });
        break;
      }
      default: break;
    }
  }
}

module.exports = { Hub, newId };
