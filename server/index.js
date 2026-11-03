#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { Hub } = require('./hub');
const ws = require('./ws');
const { ensureCerts } = require('./tls');
const { uid, hashPassword, verifyPassword, safeEqual, lanAddresses, RateLimiter, cleanName } = require('./util');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const HOST = process.env.HOST || '0.0.0.0';
const TLS_MODE = (process.env.TLS || 'auto').toLowerCase();
const VERSION = require('../package.json').version;

fs.mkdirSync(DATA, { recursive: true });

// ---------- senha do administrador ----------
const cfgFile = path.join(DATA, 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (_) {}
let generatedPassword = null;
if (process.env.ADMIN_PASSWORD) {
  cfg.adminHash = hashPassword(process.env.ADMIN_PASSWORD);
} else if (!cfg.adminHash) {
  generatedPassword = uid(5);
  cfg.adminHash = hashPassword(generatedPassword);
  fs.writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
}

const store = new Store(DATA, { accessCode: process.env.ACCESS_CODE || '' });
const hub = new Hub(store);

// ---------- certificados ----------
const lan = lanAddresses();
const extraIps = (process.env.EXTRA_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
const hostnames = ['localhost', 'elo.local', ...(process.env.EXTRA_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)];
const tlsMaterial = TLS_MODE === 'off' ? null : ensureCerts(DATA, ['127.0.0.1', ...lan, ...extraIps], hostnames);
const CA_PATH = tlsMaterial ? tlsMaterial.caPath : null;

// ---------- tiles (opcional) ----------
const REMOTE_TILES = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const LOCAL_TILES_DIR = path.join(DATA, 'tiles');
const tileUrls = () => {
  const out = [];
  try { if (fs.readdirSync(LOCAL_TILES_DIR).length) out.push('/tiles/{z}/{x}/{y}.png'); } catch (_) {}
  if (REMOTE_TILES && REMOTE_TILES !== 'off') out.push(REMOTE_TILES);
  return out;
};
const remoteOrigin = (() => { try { return new URL(REMOTE_TILES.replace('{s}', 'a')).origin; } catch (_) { return ''; } })();
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${remoteOrigin}`, "connect-src 'self' ws: wss:", "worker-src 'self'",
  "manifest-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

const joinLimiter = new RateLimiter(40, 10 * 60e3);
const adminLimiter = new RateLimiter(8, 10 * 60e3);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bearerUser(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  return m ? store.userByToken(m[1]) : null;
}

async function handleJoin(req, res) {
  const ip = req.socket.remoteAddress || '?';
  if (!joinLimiter.allow(ip)) return json(res, 429, { error: 'rate' });
  let b;
  try { b = JSON.parse(await readBody(req)); } catch (_) { return json(res, 400, { error: 'bad_request' }); }
  const name = cleanName(b.name);
  const deviceId = String(b.deviceId || '');
  if (!name) return json(res, 400, { error: 'name' });
  if (!/^[\w-]{8,64}$/.test(deviceId)) return json(res, 400, { error: 'device' });

  const wantsAdmin = !!b.adminPassword;
  if (wantsAdmin) {
    if (!adminLimiter.allow(ip)) return json(res, 429, { error: 'rate' });
    const ok = process.env.ADMIN_PASSWORD
      ? safeEqual(b.adminPassword, process.env.ADMIN_PASSWORD)
      : verifyPassword(b.adminPassword, cfg.adminHash);
    if (!ok) return json(res, 403, { error: 'admin_password' });
  } else if (store.settings.accessCode && !safeEqual(String(b.code || '').trim(), store.settings.accessCode)) {
    return json(res, 403, { error: 'code' });
  }

  let user = store.userByDevice(deviceId);
  if (user && user.banned) return json(res, 403, { error: 'banned' });
  if (user && user.role === 'admin' && !wantsAdmin) return json(res, 403, { error: 'admin_required' });
  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (!user) {
    user = { id: uid(6), deviceId, name, role: wantsAdmin ? 'admin' : 'user', status: 'unknown', createdAt: Date.now(), lastSeen: Date.now() };
  } else {
    user.name = name;
    if (wantsAdmin) user.role = 'admin';
  }
  user.tokenHash = tokenHash;
  store.saveUser(user);
  hub.broadcastPresence(store.users.get(user.id));
  json(res, 200, { token, user: hub.pubUser(store.users.get(user.id), store.users.get(user.id)) });
}

function handleExport(req, res, url) {
  const u = bearerUser(req);
  if (!u || u.role !== 'admin') return json(res, 403, { error: 'forbidden' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (url.pathname.endsWith('.geojson')) {
    const feats = [];
    for (const usr of store.users.values()) {
      if (usr.loc) {
        feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [usr.loc.lng, usr.loc.lat] },
          properties: { id: usr.id, name: usr.name, role: usr.role, status: usr.status, ts: usr.loc.ts, acc: usr.loc.acc, bat: usr.loc.bat } });
      }
      const t = store.trail(usr.id);
      if (t.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.map((p) => [p[2], p[1]]) }, properties: { id: usr.id, name: usr.name, kind: 'trail' } });
    }
    res.writeHead(200, { 'Content-Type': 'application/geo+json', 'Content-Disposition': `attachment; filename="elo-${stamp}.geojson"`, 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ type: 'FeatureCollection', features: feats }));
  }
  const esc = (s) => { s = String(s ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const rows = ['seq,hora,canal,de,tipo,texto,lat,lng'];
  for (const m of store.msgs) {
    const from = store.users.get(m.from);
    rows.push([m.seq, new Date(m.sts).toISOString(), m.ch, esc(from ? from.name : m.from), m.kind, esc(m.text), m.loc ? m.loc.lat : '', m.loc ? m.loc.lng : ''].join(','));
  }
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="elo-mensagens-${stamp}.csv"`, 'Cache-Control': 'no-store' });
  res.end('﻿' + rows.join('\n'));
}

function serveFile(req, res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    const ext = path.extname(file).toLowerCase();
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etag, 'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
      ...extraHeaders,
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function makeHandler(secure) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (req.method === 'POST' && p === '/api/join') return await handleJoin(req, res);
      if (req.method === 'GET' && p === '/api/info') {
        return json(res, 200, { app: 'elo', version: VERSION, needsCode: !!store.settings.accessCode, secure, tiles: tileUrls(), time: Date.now(), tls: !!tlsMaterial, httpsPort: tlsMaterial ? PORT : null });
      }
      if (req.method === 'GET' && p.startsWith('/api/export/')) return handleExport(req, res, url);
      if (p === '/ca.crt') {
        if (!CA_PATH) return json(res, 404, { error: 'no_ca' });
        return serveFile(req, res, CA_PATH, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="elo-ca.crt"' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      if (p.startsWith('/tiles/')) {
        const f = path.join(LOCAL_TILES_DIR, p.slice(7));
        if (!f.startsWith(LOCAL_TILES_DIR + path.sep)) { res.writeHead(403); return res.end(); }
        return serveFile(req, res, f, { 'Cache-Control': 'public, max-age=604800' });
      }
      if (p === '/js/config.js') { // modo servidor local: sem nuvem
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end('export const CONFIG = {};\n');
      }
      if (!secure && tlsMaterial && p === '/') p = '/landing.html';
      if (p === '/app') p = '/index.html';
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(PUBLIC, p);
      if (!f.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
      return serveFile(req, res, f);
    } catch (e) {
      if (!res.headersSent) { res.writeHead(400); }
      res.end();
    }
  };
}

function attachWs(server) {
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    socket.on('error', () => {});
    ws.accept(req, socket, (conn) => hub.onConnection(conn));
  });
}

// ---------- subir servidores ----------
const PORT = +(process.env.PORT || (tlsMaterial ? 8443 : 8080));
const HTTP_PORT = +(process.env.HTTP_PORT || 8080);
const servers = [];

if (tlsMaterial) {
  const s = https.createServer({ key: tlsMaterial.key, cert: tlsMaterial.cert, minVersion: 'TLSv1.2' }, makeHandler(true));
  attachWs(s);
  s.listen(PORT, HOST);
  servers.push(s);
  const h = http.createServer(makeHandler(false));
  attachWs(h);
  h.listen(HTTP_PORT, HOST);
  servers.push(h);
} else {
  const h = http.createServer(makeHandler(false));
  attachWs(h);
  h.listen(PORT, HOST);
  servers.push(h);
}

const c = { r: '\x1b[0m', b: '\x1b[1m', cy: '\x1b[36m', g: '\x1b[32m', y: '\x1b[33m' };
setTimeout(() => {
  console.log(`\n${c.b}${c.cy}  ELO — Chat de Emergência${c.r}  v${VERSION}`);
  console.log('  ─────────────────────────────────────────');
  const addrs = lan.length ? lan : ['localhost'];
  if (tlsMaterial) {
    console.log(`  ${c.g}App (HTTPS):${c.r}`);
    addrs.forEach((a) => console.log(`    https://${a}:${PORT}`));
    console.log(`  ${c.y}Primeiro acesso / instalar certificado (HTTP):${c.r}`);
    addrs.forEach((a) => console.log(`    http://${a}:${HTTP_PORT}`));
  } else {
    console.log(`  ${c.y}Sem TLS (modo básico)${c.r} — em redes locais o GPS e o modo offline do PWA exigem HTTPS.`);
    addrs.forEach((a) => console.log(`    http://${a}:${PORT}`));
  }
  if (generatedPassword) {
    console.log(`\n  ${c.b}Senha do administrador (gerada agora, anote!):${c.r} ${c.y}${generatedPassword}${c.r}`);
    console.log('  Para trocar: defina ADMIN_PASSWORD=... ao iniciar, ou apague data/config.json.');
  } else if (process.env.ADMIN_PASSWORD) console.log('\n  Senha do administrador: definida por ADMIN_PASSWORD');
  else console.log('\n  Senha do administrador: a gerada no primeiro início (data/config.json).');
  if (store.settings.accessCode) console.log(`  Código de acesso dos usuários: ${store.settings.accessCode}`);
  console.log(`  Dados em: ${DATA}\n`);
}, 250);

function shutdown() {
  console.log('\nEncerrando e salvando dados…');
  try { store.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => console.error('[erro]', e));

module.exports = { store, hub, servers };
