'use strict';
// Persistência à prova de queda de energia: snapshot atômico + journal append-only.
// O journal é reaplicado de forma idempotente por cima do snapshot ao iniciar.
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./util');

const MAX_MSGS = 10000;
const MAX_TRAIL = 500;
const KEEP_IMAGES = 200;

class Store {
  constructor(dir, defaults = {}) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.snapFile = path.join(dir, 'snapshot.json');
    this.journalFile = path.join(dir, 'journal.jsonl');
    this.users = new Map();
    this.byToken = new Map();
    this.byDevice = new Map();
    this.msgs = [];
    this.msgById = new Map();
    this.trails = new Map();
    this.seq = 0;
    this.settings = { accessCode: '', shareMap: false, groupName: 'Geral', motd: '', ...defaults };
    this.ops = 0;
    this.dirty = false;
    this._load();
    this.fd = fs.openSync(this.journalFile, 'a');
    this._syncTimer = null;
    this.lastSnap = Date.now();
    this._snapTimer = setInterval(() => {
      if (this.ops > 1500 || (this.ops > 0 && Date.now() - this.lastSnap > 15 * 60e3)) this.snapshot();
    }, 60000);
    this._snapTimer.unref();
  }

  // ---------- carga ----------
  _load() {
    let loaded = false;
    for (const f of [this.snapFile, this.snapFile + '.bak']) {
      try {
        const s = JSON.parse(fs.readFileSync(f, 'utf8'));
        this.seq = s.seq || 0;
        Object.assign(this.settings, s.settings || {});
        for (const u of s.users || []) this._putUser(u);
        for (const m of s.msgs || []) this._putMsg(m);
        for (const [uid, pts] of s.trails || []) this.trails.set(uid, pts);
        loaded = true;
        break;
      } catch (_) { /* tenta o backup */ }
    }
    if (!loaded && fs.existsSync(this.snapFile)) console.warn('[store] snapshot ilegível; usando apenas o journal');
    try {
      const lines = fs.readFileSync(this.journalFile, 'utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        try { this._apply(JSON.parse(line)); } catch (_) { /* linha truncada por queda de energia */ }
      }
    } catch (_) { /* sem journal ainda */ }
  }

  _putUser(u) {
    const old = this.users.get(u.id);
    if (old && old.tokenHash) this.byToken.delete(old.tokenHash);
    const merged = { ...(old || {}), ...u };
    this.users.set(merged.id, merged);
    if (merged.tokenHash) this.byToken.set(merged.tokenHash, merged.id);
    this.byDevice.set(merged.deviceId, merged.id);
    return merged;
  }

  _putMsg(m) {
    if (this.msgById.has(m.id)) return false;
    this.msgs.push(m);
    this.msgById.set(m.id, m);
    if (m.seq > this.seq) this.seq = m.seq;
    return true;
  }

  _pushTrail(uid, p) {
    let t = this.trails.get(uid);
    if (!t) { t = []; this.trails.set(uid, t); }
    const last = t[t.length - 1];
    const pt = [p.ts, p.lat, p.lng, p.acc || 0];
    if (!last || last[0] < p.ts) t.push(pt);
    else {
      // ponto antigo (ex.: enfileirado offline): insere ordenado, ignorando duplicatas
      let i = t.length - 1;
      while (i >= 0 && t[i][0] > p.ts) i--;
      if (i >= 0 && t[i][0] === p.ts) return false;
      t.splice(i + 1, 0, pt);
    }
    if (t.length > MAX_TRAIL) t.splice(0, t.length - MAX_TRAIL);
    return true;
  }

  _apply(r) {
    switch (r.k) {
      case 'user': this._putUser(r.u); break;
      case 'msg': this._putMsg(r.m); break;
      case 'del': {
        const m = this.msgById.get(r.id);
        if (m) { m.deleted = true; m.text = ''; m.img = null; m.loc = null; }
        break;
      }
      case 'loc': {
        const u = this.users.get(r.uid);
        if (u && (!u.loc || r.p.ts >= u.loc.ts)) u.loc = { ...r.p, bat: r.bat, chg: r.chg };
        this._pushTrail(r.uid, r.p);
        break;
      }
      case 'settings': Object.assign(this.settings, r.s); break;
      default: break;
    }
  }

  // ---------- escrita ----------
  append(rec) {
    this._apply(rec);
    try {
      fs.writeSync(this.fd, JSON.stringify(rec) + '\n');
    } catch (e) {
      console.error('[store] falha ao gravar journal:', e.message);
    }
    this.ops++;
    this.dirty = true;
    if (!this._syncTimer) {
      this._syncTimer = setTimeout(() => {
        this._syncTimer = null;
        try { fs.fsyncSync(this.fd); } catch (_) {}
      }, 400);
      this._syncTimer.unref();
    }
    if (this.ops > 5000) this.snapshot();
  }

  snapshot() {
    this._trim();
    const data = {
      v: 1,
      seq: this.seq,
      settings: this.settings,
      users: [...this.users.values()],
      msgs: this.msgs,
      trails: [...this.trails.entries()],
    };
    const tmp = this.snapFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      const fd = fs.openSync(tmp, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.existsSync(this.snapFile)) fs.copyFileSync(this.snapFile, this.snapFile + '.bak');
      fs.renameSync(tmp, this.snapFile);
      fs.closeSync(this.fd);
      fs.writeFileSync(this.journalFile, '');
      this.fd = fs.openSync(this.journalFile, 'a');
      this.ops = 0;
      this.dirty = false;
      this.lastSnap = Date.now();
    } catch (e) {
      console.error('[store] falha no snapshot:', e.message);
      try { this.fd = fs.openSync(this.journalFile, 'a'); } catch (_) {}
    }
  }

  _trim() {
    if (this.msgs.length > MAX_MSGS) {
      const drop = this.msgs.splice(0, this.msgs.length - MAX_MSGS);
      for (const m of drop) this.msgById.delete(m.id);
    }
    let kept = 0;
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.img) { if (++kept > KEEP_IMAGES) { m.img = null; m.imgDropped = true; } }
    }
  }

  close() {
    this.snapshot();
    try { fs.closeSync(this.fd); } catch (_) {}
    clearInterval(this._snapTimer);
  }

  // ---------- API ----------
  nextSeq() { return ++this.seq; }
  userByToken(token) {
    if (!token || typeof token !== 'string') return null;
    const id = this.byToken.get(sha256(token));
    return id ? this.users.get(id) : null;
  }
  userByDevice(deviceId) {
    const id = this.byDevice.get(deviceId);
    return id ? this.users.get(id) : null;
  }
  saveUser(u) {
    const { loc, ...rest } = u; // a localização é persistida via registros 'loc'
    this.append({ k: 'user', u: rest });
  }
  setSettings(patch) { this.append({ k: 'settings', s: patch }); }
  addMsg(m) { this.append({ k: 'msg', m }); }
  delMsg(id) { this.append({ k: 'del', id }); }
  addLoc(uid, p, bat, chg) { this.append({ k: 'loc', uid, p, bat, chg }); }
  trail(uid) { return this.trails.get(uid) || []; }

  visibleMsgs(user, afterSeq, limit) {
    const out = [];
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      const m = this.msgs[i];
      if (m.seq <= afterSeq) break;
      if (canSee(user, m)) { out.push(m); if (out.length >= limit) break; }
    }
    return out.reverse();
  }
}

function canSee(user, m) {
  if (m.ch === 'general' || m.ch === 'alerts') return true;
  if (m.ch.startsWith('dm:')) {
    const [, a, b] = m.ch.split(':');
    return a === user.id || b === user.id;
  }
  return false;
}

module.exports = { Store, canSee };
