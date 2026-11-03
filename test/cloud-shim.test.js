'use strict';
// Testa o transporte da nuvem (public/js/supa.js) contra um mock em memória do PostgREST. node test/cloud-shim.test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

// ---- ambiente de navegador mínimo ----
global.window = new EventTarget();
global.document = Object.assign(new EventTarget(), { hidden: false });

// ---- mock do backend (mesma semântica das RPCs: cursores, rev, seen, dels, reads) ----
const db = { users: new Map(), msgs: [], seq: 0, rev: 0, dels: new Map(), reads: new Map(), locate: new Set(), tokens: new Map(), now: 1_000_000, fail: 0 };
const addUser = (id, role) => { const u = { id, name: id, role, status: 'unknown', online: false, lastSeen: db.now, rev: ++db.rev, seen: db.now }; db.users.set(id, u); db.tokens.set('tok-' + id + '-xxxxxxxxxxxxxxxxxxxx', id); return 'tok-' + id + '-xxxxxxxxxxxxxxxxxxxx'; };
const visible = (m, uid) => m.ch === 'general' || m.ch === 'alerts' || m.ch.split(':').slice(1).includes(uid);
const RPC = {
  elo_info: () => ({ app: 'elo' }),
  elo_poll: (a) => {
    const id = db.tokens.get(a.p_token); if (!id) throw Object.assign(new Error('auth'), { http: 400 });
    const me = db.users.get(id); me.seen = db.now;
    const msgs = db.msgs.filter((m) => m.seq > Math.max(0, a.p_since_seq - (a.p_since_seq > 0 ? 20 : 0)) && visible(m, id)).slice(-300);
    return {
      now: db.now, me: { ...me, online: true }, settings: { shareMap: false, groupName: 'Geral', motd: '' }, seq: db.seq, msgs,
      users: [...db.users.values()].filter((u) => u.rev > Math.max(0, a.p_since_users - 20)).map((u) => ({ ...u, online: db.now - u.seen < 30000 })),
      ucur: db.rev, dels: [...db.dels].filter(([, r]) => r > Math.max(0, a.p_since_del - 20)).map(([i]) => i), dcur: Math.max(0, ...db.dels.values()),
      reads: [...db.reads].map(([k, seq]) => ({ ch: k.split('|')[0], by: k.split('|')[1], seq })).filter((r) => r.by !== id),
      seen: Object.fromEntries([...db.users.values()].map((u) => [u.id, u.seen])), locate: db.locate.delete(id),
    };
  },
  elo_send: (a) => { const id = db.tokens.get(a.p_token); const m = a.p_msg; let e = db.msgs.find((x) => x.id === m.id);
    if (!e) { e = { seq: ++db.seq, id: m.id, ch: m.ch, from: id, kind: m.kind, text: m.text, img: null, loc: null, cts: m.cts, sts: db.now }; db.msgs.push(e); }
    return { ack: { id: e.id, seq: e.seq, sts: e.sts } }; },
  elo_loc: (a) => { const id = db.tokens.get(a.p_token); const u = db.users.get(id); const p = a.p_points.at(-1); u.loc = { lat: p.lat, lng: p.lng, acc: 5, ts: p.ts }; u.rev = ++db.rev; return { n: a.p_points.length, ts: p.ts }; },
  elo_status: (a) => { const u = db.users.get(db.tokens.get(a.p_token)); u.status = a.p_status; u.rev = ++db.rev; return null; },
  elo_read: (a) => { db.reads.set(a.p_ch + '|' + db.tokens.get(a.p_token), a.p_seq); return null; },
  elo_trail: () => [[1, 2, 3, 4]],
  elo_admin: (a) => { if (a.p_op === 'del_msg') db.dels.set(a.p_args.id, ++db.rev); if (a.p_op === 'locate') db.locate.add(a.p_args.uid); return null; },
};
global.fetch = async (url, init) => {
  const fn = String(url).split('/rpc/')[1];
  if (db.fail > 0) { db.fail--; throw new TypeError('fetch failed'); }
  try { const out = RPC[fn](JSON.parse(init.body)); return { ok: true, status: 200, text: async () => (out === null ? '' : JSON.stringify(out)) }; }
  catch (e) { return { ok: false, status: 400, text: async () => JSON.stringify({ message: e.message }) }; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(token) {
  const events = [];
  return { events, net: null, token, pull: (t) => events.filter((e) => e.t === t) };
}

(async () => {
  const { SupaNet } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'supa.js')).href);
  const tAdmin = addUser('admin', 'admin'); const tUser = addUser('maria', 'user');
  let n = 0; const ok = (m) => console.log('  ✓', m, ++n && '');

  async function connect(c, lastSeq = 0) {
    const net = new SupaNet(); c.net = net;
    net.addEventListener('msg', (e) => { c.events.push(e.detail); if (e.detail.t === 'hello_ok') net.markReady(); });
    net.addEventListener('open', () => net.send({ t: 'hello', token: c.token, lastSeq }));
    net.addEventListener('close', (e) => c.events.push({ t: '_close', code: e.detail }));
    net.start();
    for (let i = 0; i < 50 && !c.pull('hello_ok').length; i++) await sleep(20);
    assert.ok(c.pull('hello_ok').length, 'hello_ok');
  }
  const A = client(tAdmin), U = client(tUser);
  await connect(A); await connect(U);
  assert.ok(A.pull('users').length === 1 && A.pull('backlog')[0].done); ok('conexão: hello_ok + users + backlog (primeira sincronização)');

  // mensagem: ack no remetente, 'msg' único no destinatário (mesmo com poll repetido)
  U.net.send({ t: 'msg', id: 'msg-aaaa-0001', ch: 'general', kind: 'text', text: 'oi', cts: 1 });
  await sleep(30);
  assert.strictEqual(U.pull('ack').length, 1);
  await A.net._poll(); await A.net._poll();
  assert.strictEqual(A.pull('msg').filter((e) => e.m.id === 'msg-aaaa-0001').length, 1);
  await U.net._poll();
  assert.strictEqual(U.pull('msg').length, 0); ok('mensagem: ack ao remetente e entrega única ao admin (dedupe entre polls)');

  // reenvio idempotente
  U.net.send({ t: 'msg', id: 'msg-aaaa-0001', ch: 'general', kind: 'text', text: 'oi', cts: 1 }); await sleep(30);
  assert.strictEqual(db.msgs.length, 1); ok('reenvio da mesma mensagem não duplica');

  // localização + trilha + status
  U.net.send({ t: 'loc', p: { lat: -23.5, lng: -46.6, acc: 9, ts: 111 } }); U.net.send({ t: 'status', status: 'help' }); await sleep(30);
  await A.net._poll();
  assert.ok(A.pull('loc').some((e) => e.uid === 'maria' && e.p.lat === -23.5), 'loc');
  assert.ok(A.pull('presence').some((e) => e.u.id === 'maria' && e.u.status === 'help'), 'presence status');
  A.net.send({ t: 'get_trail', uid: 'maria' }); await sleep(30);
  assert.deepStrictEqual(A.pull('trail')[0].pts, [[1, 2, 3, 4]]); ok('localização, status e trilha chegam ao admin');

  U.net.send({ t: 'locs', items: [{ lat: 1, lng: 1, ts: 5 }, { lat: 2, lng: 2, ts: 6 }] }); await sleep(30);
  assert.ok(U.pull('loc_ok').some((e) => e.n === 2)); ok('lote de posições (fila offline) confirma com loc_ok{n}');

  // presença: usuário "some" (sem poll por >30s) -> offline
  db.now += 60000; await A.net._poll();
  assert.ok(A.pull('presence').some((e) => e.u.id === 'maria' && e.u.online === false), 'offline'); ok('presença: usuário sem poll há >30 s vira offline');

  // apagar mensagem, recibo de leitura, locate
  A.net.send({ t: 'admin', op: 'del_msg', id: 'msg-aaaa-0001' }); A.net.send({ t: 'admin', op: 'locate', uid: 'maria' }); U.net.send({ t: 'read', ch: 'dm:admin:maria', seq: 1 }); await sleep(30);
  await U.net._poll(); await A.net._poll();
  assert.ok(U.pull('del').length === 1 && U.pull('locate').length === 1 && A.pull('read').length === 1); ok('del_msg, pedido de posição e recibo de leitura propagam uma única vez');

  // queda de rede -> close, reconexão automática, novo hello (sem perder cursor)
  db.fail = 3; await U.net._poll();
  assert.ok(U.pull('_close').some((e) => e.code === 1006)); assert.strictEqual(U.net.state, 'offline');
  db.fail = 0; const before = U.pull('hello_ok').length;
  for (let i = 0; i < 120 && U.pull('hello_ok').length === before; i++) await sleep(50);
  assert.ok(U.pull('hello_ok').length > before && U.net.state === 'online'); ok('queda de rede: close(1006) e reconexão automática com novo hello');

  // sessão inválida
  db.tokens.delete(tUser); await U.net._poll();
  assert.ok(U.pull('err').some((e) => e.code === 'auth')); ok('token inválido: err{auth} (o estado reentra ou desloga)');

  A.net.stop(); U.net.stop();
  console.log(`\n${n} verificações do transporte nuvem OK`);
  process.exit(0);
})().catch((e) => { console.error('\nFALHOU:', e); process.exit(1); });
