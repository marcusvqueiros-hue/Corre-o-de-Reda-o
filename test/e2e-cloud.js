'use strict';
// UI no modo NUVEM: serve public/ estático e intercepta as chamadas ao Supabase com um mock em memória. node test/e2e-cloud.js [pasta-screenshots]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PUB = path.join(__dirname, '..', 'public');
const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'elo-cloud-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// ---------- mock do backend ----------
const B = { users: new Map(), msgs: [], seq: 0, rev: 0, cfg: { accessCode: '', shareMap: false, groupName: 'Geral', motd: '' } };
const vis = (m, id) => m.ch === 'general' || m.ch === 'alerts' || m.ch.split(':').slice(1).includes(id);
const pub = (u, v) => { const o = { id: u.id, name: u.name, role: u.role, status: u.status, online: Date.now() - u.seen < 30000, lastSeen: u.seen, rev: u.rev }; if (u.loc && (v.role === 'admin' || B.cfg.shareMap)) o.loc = u.loc; return o; };
const who = (t) => { const u = [...B.users.values()].find((x) => x.token === t); if (!u) throw new Error('auth'); return u; };
const RPC = {
  elo_info: () => ({ app: 'elo', needsCode: !!B.cfg.accessCode, tiles: [], secure: true, tls: false }),
  elo_join: (a) => {
    if (a.p_admin_pw) { if (a.p_admin_pw !== 'comando123') return { error: 'admin_password' }; } else if (B.cfg.accessCode && a.p_code !== B.cfg.accessCode) return { error: 'code' };
    let u = [...B.users.values()].find((x) => x.dev === a.p_device);
    if (!u) { u = { id: 'u' + (B.users.size + 1), dev: a.p_device, role: a.p_admin_pw ? 'admin' : 'user', status: 'unknown', seen: Date.now() }; B.users.set(u.id, u); }
    u.name = a.p_name; u.token = 'tok-' + u.id + '-' + Math.random().toString(36).slice(2).padEnd(20, 'x'); u.rev = ++B.rev;
    return { token: u.token, user: pub(u, u) };
  },
  elo_poll: (a) => {
    const me = who(a.p_token); me.seen = Date.now();
    return { now: Date.now(), me: pub(me, me), settings: { shareMap: B.cfg.shareMap, groupName: 'Geral', motd: '' }, seq: B.seq,
      msgs: B.msgs.filter((m) => m.seq > Math.max(0, a.p_since_seq - 20) && vis(m, me.id)), users: [...B.users.values()].filter((u) => u.rev > Math.max(0, a.p_since_users - 20)).map((u) => pub(u, me)),
      ucur: B.rev, dels: [], dcur: 0, reads: [], seen: Object.fromEntries([...B.users.values()].map((u) => [u.id, u.seen])), locate: false };
  },
  elo_send: (a) => {
    const me = who(a.p_token); const m = a.p_msg; let e = B.msgs.find((x) => x.id === m.id);
    if (!e) {
      e = { seq: ++B.seq, id: m.id, ch: m.ch, from: me.id, kind: m.kind, text: m.text || '', img: null, loc: m.loc || null, cts: m.cts, sts: Date.now() }; B.msgs.push(e);
      if (m.kind === 'sos') { me.status = 'sos'; me.rev = ++B.rev; if (m.loc) me.loc = { ...m.loc, ts: Date.now() }; }
    }
    return { ack: { id: e.id, seq: e.seq, sts: e.sts } };
  },
  elo_loc: (a) => { const me = who(a.p_token); const p = a.p_points.at(-1); me.loc = { lat: p.lat, lng: p.lng, acc: p.acc, ts: p.ts, bat: p.bat }; me.rev = ++B.rev; return { n: a.p_points.length, ts: p.ts }; },
  elo_status: (a) => { const me = who(a.p_token); me.status = a.p_status; me.rev = ++B.rev; return null; },
  elo_read: () => null, elo_rename: () => null, elo_trail: () => [],
  elo_admin: (a) => { who(a.p_token); if (a.p_op === 'clear_sos') { const u = B.users.get(a.p_args.uid); u.status = 'unknown'; u.rev = ++B.rev; } return null; },
};

(async () => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const f = path.join(PUB, p);
    if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(f).pipe(res);
  }).listen(0);
  const BASE = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' };
  const wire = async (ctx, state) => ctx.route('**/rest/v1/rpc/*', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (state.down) return route.abort('internetdisconnected');
    const fn = req.url().split('/rpc/')[1];
    try { const out = RPC[fn](req.postDataJSON() || {}); await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: out === null ? '' : JSON.stringify(out) }); }
    catch (e) { await route.fulfill({ status: 400, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ message: e.message }) }); }
  });
  let ok = 0; const step = (n) => { ok++; console.log('  ✓', n); };
  const geo = { permissions: ['geolocation'] };

  const actx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...geo, geolocation: { latitude: -23.5505, longitude: -46.6333, accuracy: 8 } });
  const aS = { down: false }; await wire(actx, aS);
  const admin = await actx.newPage(); admin.on('pageerror', (e) => errors.push('admin: ' + e.message));
  await admin.goto(BASE + '/');
  await admin.waitForSelector('.join .panel');
  assert.strictEqual(await admin.locator('details.adv').count(), 0, 'modo nuvem não mostra "endereço do servidor"');
  await admin.fill('#j-name', 'Comando'); await admin.click('text=Sou administrador');
  await admin.fill('#j-pass', 'errada'); await admin.click('button[type=submit]');
  await admin.waitForFunction(() => /incorreta/.test(document.querySelector('.err')?.textContent || ''));
  await admin.fill('#j-pass', 'comando123'); await admin.click('button[type=submit]');
  await admin.waitForSelector('.shell'); await admin.waitForSelector('.chip.on', { timeout: 10000 });
  step('admin: senha errada recusada, senha certa entra e conecta (nuvem)');

  const uctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...geo, geolocation: { latitude: -23.5612, longitude: -46.6559, accuracy: 15 } });
  const uS = { down: false }; await wire(uctx, uS);
  const user = await uctx.newPage(); user.on('pageerror', (e) => errors.push('user: ' + e.message));
  await user.goto(BASE + '/'); await user.fill('#j-name', 'Maria Souza'); await user.check('#j-consent'); await user.click('button[type=submit]');
  await user.waitForSelector('.shell'); await user.waitForSelector('.chip.on', { timeout: 10000 });
  step('usuário entra e conecta');

  await user.click('.row:has-text("Geral")');
  await user.fill('.composer textarea', 'Olá comando, estou na Paulista.'); await user.click('button[aria-label="Enviar"]');
  await admin.click('.tab:has-text("Chats")');
  await admin.waitForSelector('.row:has-text("Olá comando")', { timeout: 10000 });
  await admin.click('.row:has-text("Geral")'); await admin.fill('.composer textarea', 'Recebido, Maria.'); await admin.keyboard.press('Enter');
  await user.waitForSelector('.bub.them:has-text("Recebido, Maria.")', { timeout: 10000 });
  assert.strictEqual(await admin.locator('.bub:has-text("Olá comando")').count(), 1);
  step('chat nos dois sentidos via polling (sem duplicar)');

  await admin.click('.tab:has-text("Mapa")'); await admin.waitForSelector('.map-canvas');
  await admin.waitForFunction(() => /-23\./.test(document.querySelector('.hud')?.textContent || ''), null, { timeout: 12000 });
  await sleep(800); await admin.screenshot({ path: path.join(SHOTS, 'cloud-admin-map.png') });
  step('mapa do admin recebe a posição da Maria');

  // queda da conexão com o Supabase: fila local e reenvio
  uS.down = true;
  await user.waitForSelector('.chip.off, .chip.wait', { timeout: 15000 });
  await user.fill('.composer textarea', 'Sem sinal aqui, mas continuo escrevendo.'); await user.click('button[aria-label="Enviar"]');
  await user.waitForSelector('.bub.me:has-text("Sem sinal") .tick svg');
  await user.waitForSelector('.topbar .chip .badge');
  await user.screenshot({ path: path.join(SHOTS, 'cloud-user-offline.png') });
  step('sem conexão com a nuvem: mensagem pendente e fila visível');
  uS.down = false;
  await user.waitForSelector('.chip.on', { timeout: 30000 });
  await admin.click('.tab:has-text("Chats")'); await admin.click('.row:has-text("Geral")');
  await admin.waitForSelector('.bub.them:has-text("Sem sinal aqui")', { timeout: 15000 });
  assert.strictEqual(await admin.locator('.bub:has-text("Sem sinal aqui")').count(), 1);
  step('conexão volta: mensagem entregue uma única vez');

  await user.click('.sos-btn'); await user.click('text=ENVIAR AGORA');
  await admin.waitForSelector('.soscard:has-text("Maria Souza")', { timeout: 10000 });
  await sleep(500); await admin.screenshot({ path: path.join(SHOTS, 'cloud-admin-sos.png') });
  step('SOS chega ao admin com alarme');
  await admin.click('.soscard >> text=Encerrar'); await admin.waitForFunction(() => !document.querySelector('.soscard'), null, { timeout: 8000 });
  step('admin encerra o SOS');

  assert.deepStrictEqual(errors, [], errors.join(' | ')); step('sem erros JavaScript');
  await browser.close(); srv.close();
  console.log(`\n${ok} verificações de interface (nuvem) OK. Screenshots: ${SHOTS}`);
  process.exit(0);
})().catch((e) => { console.error('\nFALHOU:', e); process.exit(1); });
