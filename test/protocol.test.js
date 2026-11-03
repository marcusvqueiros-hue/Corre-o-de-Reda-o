'use strict';
// Teste de integração do servidor: node test/protocol.test.js
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'elo-test-'));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, TLS: 'off', PORT: String(PORT), DATA_DIR: DATA, ADMIN_PASSWORD: 'segredo', ACCESS_CODE: 'abc' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return p;
}
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/info'); return; } catch (_) { await sleep(100); } }
  throw new Error('servidor não subiu');
}
async function join(name, extra = {}) {
  const deviceId = extra.deviceId || 'dev-' + Math.random().toString(36).slice(2, 12);
  const r = await fetch(BASE + '/api/join', { method: 'POST', body: JSON.stringify({ name, deviceId, ...extra }) });
  return { status: r.status, deviceId, ...(await r.json()) };
}
function client(token, lastSeq = 0) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    inbox.push(d);
    for (const w of [...waiters]) if (w.fn(d)) { waiters.splice(waiters.indexOf(w), 1); w.res(d); }
  };
  const c = {
    ws, inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    wait: (fn, ms = 3000) => {
      const hit = inbox.find(fn);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { fn, res };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout')); } }, ms);
      });
    },
    ready: new Promise((res) => { ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', token, lastSeq })); res(); }; }),
    close: () => ws.close(),
  };
  return c;
}

(async () => {
  let srv = startServer();
  await waitUp();
  let ok = 0;
  const t = (name) => { ok++; console.log('  ✓', name); };

  // --- autenticação ---
  assert.strictEqual((await join('Ana')).status, 403); t('código de acesso exigido');
  assert.strictEqual((await join('Hack', { adminPassword: 'errada' })).status, 403); t('senha de admin errada recusada');
  const admin = await join('Comando', { adminPassword: 'segredo' });
  assert.strictEqual(admin.user.role, 'admin'); t('admin autentica');
  const ana = await join('Ana', { code: 'abc' });
  const bob = await join('Bob', { code: 'abc' });
  assert.strictEqual(ana.status, 200);
  const evil = await join('Ana', { deviceId: admin.deviceId, code: 'abc' });
  assert.strictEqual(evil.status, 403); t('deviceId de admin não escala sem senha');

  const A = client(admin.token), N = client(ana.token), B = client(bob.token);
  await Promise.all([A.ready, N.ready, B.ready]);
  await Promise.all([A.wait((d) => d.t === 'hello_ok'), N.wait((d) => d.t === 'hello_ok'), B.wait((d) => d.t === 'hello_ok')]);
  t('hello_ok para todos');

  // --- mensagens e idempotência ---
  N.send({ t: 'msg', id: 'msg-aaaa-0001', ch: 'general', kind: 'text', text: 'Olá pessoal', cts: Date.now() });
  const ack = await N.wait((d) => d.t === 'ack' && d.id === 'msg-aaaa-0001');
  await B.wait((d) => d.t === 'msg' && d.m.id === 'msg-aaaa-0001');
  N.send({ t: 'msg', id: 'msg-aaaa-0001', ch: 'general', kind: 'text', text: 'Olá pessoal', cts: Date.now() });
  await sleep(150);
  assert.strictEqual(N.inbox.filter((d) => d.t === 'ack' && d.id === 'msg-aaaa-0001').length, 2);
  assert.strictEqual(B.inbox.filter((d) => d.t === 'msg' && d.m.id === 'msg-aaaa-0001').length, 1);
  assert.strictEqual(ack.seq, 1); t('mensagem entregue; reenvio é idempotente (sem duplicar)');

  // --- DM privada ---
  const [x, y] = [ana.user.id, admin.user.id].sort();
  N.send({ t: 'msg', id: 'msg-aaaa-0002', ch: `dm:${x}:${y}`, kind: 'text', text: 'segredo', cts: Date.now() });
  await A.wait((d) => d.t === 'msg' && d.m.id === 'msg-aaaa-0002');
  await sleep(150);
  assert.ok(!B.inbox.some((d) => d.t === 'msg' && d.m.id === 'msg-aaaa-0002')); t('DM não vaza para terceiros');
  B.send({ t: 'msg', id: 'msg-aaaa-0003', ch: `dm:${x}:${y}`, kind: 'text', text: 'intruso', cts: Date.now() });
  await B.wait((d) => d.t === 'nack' && d.id === 'msg-aaaa-0003'); t('intruso não escreve em DM alheia');

  // --- alertas só admin ---
  N.send({ t: 'msg', id: 'msg-aaaa-0004', ch: 'alerts', kind: 'text', text: 'falso alarme', cts: Date.now() });
  await N.wait((d) => d.t === 'nack' && d.id === 'msg-aaaa-0004');
  A.send({ t: 'msg', id: 'msg-aaaa-0005', ch: 'alerts', kind: 'text', text: 'Evacuar área norte', cts: Date.now() });
  await B.wait((d) => d.t === 'msg' && d.m.id === 'msg-aaaa-0005'); t('somente admin publica avisos');

  // --- localização: só o admin vê ---
  N.send({ t: 'loc', p: { lat: -23.55, lng: -46.63, acc: 12, ts: Date.now(), bat: 54 } });
  const loc = await A.wait((d) => d.t === 'loc' && d.uid === ana.user.id);
  assert.strictEqual(loc.p.bat, 54);
  await sleep(150);
  assert.ok(!B.inbox.some((d) => d.t === 'loc')); t('localização chega ao admin e não a outros usuários');
  N.send({ t: 'locs', items: [{ lat: -23.551, lng: -46.631, acc: 9, ts: Date.now() - 60000 }, { lat: -23.552, lng: -46.632, acc: 9, ts: Date.now() - 30000 }] });
  await N.wait((d) => d.t === 'loc_ok' && d.n === 2);
  N.send({ t: 'loc', p: { lat: 999, lng: 0, acc: 1 } }); // inválida, ignorada
  A.send({ t: 'get_trail', uid: ana.user.id });
  const tr = await A.wait((d) => d.t === 'trail');
  assert.ok(tr.pts.length >= 3); t('trilha (inclui pontos enfileirados offline)');
  B.send({ t: 'get_trail', uid: ana.user.id }); await sleep(150);
  assert.ok(!B.inbox.some((d) => d.t === 'trail')); t('usuário comum não lê trilha alheia');

  // --- SOS ---
  B.send({ t: 'msg', id: 'msg-aaaa-0006', ch: 'general', kind: 'sos', text: 'preso', loc: { lat: -23.5, lng: -46.6, acc: 20 }, cts: Date.now() });
  const pres = await A.wait((d) => d.t === 'presence' && d.u.id === bob.user.id && d.u.status === 'sos');
  assert.ok(pres.u.loc); await N.wait((d) => d.t === 'msg' && d.m.kind === 'sos'); t('SOS: status, localização e alerta a todos');

  // --- permissões de admin ---
  N.send({ t: 'admin', op: 'setting', shareMap: true }); await N.wait((d) => d.t === 'err' && d.code === 'forbidden'); t('usuário não administra');
  A.send({ t: 'admin', op: 'setting', shareMap: true });
  await B.wait((d) => d.t === 'settings' && d.s.shareMap === true); t('admin liga mapa compartilhado');
  A.send({ t: 'admin', op: 'clear_sos', uid: bob.user.id });
  await A.wait((d) => d.t === 'presence' && d.u.id === bob.user.id && d.u.status === 'unknown'); t('admin encerra SOS');

  // --- reconexão: backlog só do que faltou ---
  N.close(); await sleep(150);
  A.send({ t: 'msg', id: 'msg-aaaa-0007', ch: 'general', kind: 'text', text: 'enquanto você estava off', cts: Date.now() });
  await A.wait((d) => d.t === 'ack' && d.id === 'msg-aaaa-0007');
  const N2 = client(ana.token, 1); await N2.ready;
  const bl = await N2.wait((d) => d.t === 'backlog' && d.done);
  const ids = N2.inbox.filter((d) => d.t === 'backlog').flatMap((d) => d.msgs.map((m) => m.id));
  assert.ok(ids.includes('msg-aaaa-0007') && !ids.includes('msg-aaaa-0001')); t('reconexão recebe apenas o backlog pendente');
  N2.close(); A.close(); B.close(); await sleep(200);

  // --- persistência após reinício ---
  srv.kill('SIGTERM'); await sleep(600);
  srv = startServer(); await waitUp();
  const A2 = client(admin.token, 0); await A2.ready;
  await A2.wait((d) => d.t === 'hello_ok');
  const us = await A2.wait((d) => d.t === 'users');
  const anaU = us.users.find((u) => u.id === ana.user.id);
  assert.ok(anaU && anaU.loc && anaU.loc.lat < -23.5); t('usuários e última localização sobrevivem a reinício');
  await A2.wait((d) => d.t === 'backlog' && d.done);
  const all = A2.inbox.filter((d) => d.t === 'backlog').flatMap((d) => d.msgs);
  assert.strictEqual(all.length, 5); t('histórico de mensagens sobrevive a reinício');
  const carl = await join('Carl', { code: 'abc' });
  const C = client(carl.token); await C.ready; await C.wait((d) => d.t === 'hello_ok');
  A2.send({ t: 'admin', op: 'ban', uid: carl.user.id });
  await C.wait((d) => d.t === 'err' && d.code === 'banned');
  assert.strictEqual((await join('Carl', { deviceId: carl.deviceId, code: 'abc' })).status, 403); t('banimento derruba e impede retorno');
  A2.close();

  // --- export ---
  const ex = await fetch(BASE + '/api/export/locations.geojson', { headers: { Authorization: 'Bearer ' + admin.token } });
  assert.strictEqual(ex.status, 200); assert.ok((await ex.json()).features.length >= 2);
  assert.strictEqual((await fetch(BASE + '/api/export/messages.csv', { headers: { Authorization: 'Bearer nope' } })).status, 403); t('exportação protegida');

  srv.kill('SIGTERM');
  await sleep(800);
  console.log(`\n${ok} verificações OK`);
  fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
  process.exit(0);
})().catch((e) => { console.error('\nFALHOU:', e); process.exit(1); });
