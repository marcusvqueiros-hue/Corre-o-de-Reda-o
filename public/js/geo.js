// Compartilhamento de localização com fila offline: pontos coletados sem rede são enviados em lote ao reconectar.
import { S, net, emit, on } from './state.js';
import { db } from './db.js';
import { cloud } from './supa.js';

let watchId = null;
let lastSent = null;
let inflight = null; // { keys: [] }
let wake = null;
let draining = false;

const cfg = () => (S.prefs.saver ? { interval: 90000, dist: 40, high: false, maxAge: 60000 } : { interval: 20000, dist: 12, high: true, maxAge: 5000 });
const MAX_QUEUE = 1500;

function distance(a, b) {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
}

function point(pos) {
  const c = pos.coords;
  const p = { lat: c.latitude, lng: c.longitude, acc: Math.round(c.accuracy || 0), ts: pos.timestamp || Date.now() };
  if (c.speed != null && !Number.isNaN(c.speed)) p.spd = c.speed;
  if (c.heading != null && !Number.isNaN(c.heading)) p.hdg = c.heading;
  if (c.altitude != null) p.alt = c.altitude;
  if (S.battery) { p.bat = Math.round(S.battery.level * 100); p.chg = S.battery.charging; }
  return p;
}

function onFix(pos, force) {
  const p = point(pos);
  S.myLoc = p;
  S.geoState = 'on';
  emit('myloc');
  if (!S.prefs.share || !S.me) return;
  const k = cfg();
  if (force || !lastSent || p.ts - lastSent.ts >= k.interval || distance(lastSent, p) >= k.dist) {
    lastSent = p;
    report(p);
  }
}

async function report(p) {
  if (!cloud && net.state === 'online' && !draining && !(await db.count('locq'))) {
    net.send({ t: 'loc', p });
  } else {
    await db.put('locq', { ...p });
    await refreshQueued();
    if (net.state === 'online') drain();
  }
}

async function refreshQueued() {
  let items = await db.all('locq');
  if (items.length > MAX_QUEUE) { // descarta o excesso mais antigo, mantendo a trilha "esticada"
    const drop = items.slice(0, items.length - MAX_QUEUE);
    for (const it of drop) await db.del('locq', it.k);
    items = items.slice(drop.length);
  }
  S.locQueued = items.length;
  emit('outbox');
  return items;
}

async function drain() {
  if (draining || net.state !== 'online') return;
  draining = true;
  try {
    const items = (await db.all('locq')).sort((a, b) => a.ts - b.ts).slice(0, 100);
    if (!items.length) { draining = false; return; }
    inflight = { keys: items.map((i) => i.k), n: items.length };
    net.send({ t: 'locs', items: items.map(({ k, ...p }) => p) });
    setTimeout(() => { if (inflight) { inflight = null; draining = false; } }, 10000); // sem ack: tenta de novo depois
  } catch (_) { draining = false; }
}

on('loc_ok', async (d) => {
  if (!inflight || d.n == null) return;
  for (const k of inflight.keys) await db.del('locq', k);
  inflight = null;
  draining = false;
  const left = await refreshQueued();
  if (left.length) drain();
});
on('online', async () => { draining = false; inflight = null; await refreshQueued(); drain(); });
on('locate', () => requestNow());

export function requestNow() {
  if (!('geolocation' in navigator) || !S.me) return;
  navigator.geolocation.getCurrentPosition((pos) => onFix(pos, true), () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

export function start() {
  stop();
  if (!S.prefs.share || !S.me) return;
  if (!('geolocation' in navigator)) { S.geoState = 'unavailable'; emit('myloc'); return; }
  if (!window.isSecureContext) { S.geoState = 'insecure'; emit('myloc'); return; }
  S.geoState = 'searching';
  emit('myloc');
  const k = cfg();
  watchId = navigator.geolocation.watchPosition(
    (pos) => onFix(pos, false),
    (err) => { S.geoState = err.code === 1 ? 'denied' : 'searching'; emit('myloc'); },
    { enableHighAccuracy: k.high, maximumAge: k.maxAge, timeout: 30000 }
  );
  setupBattery();
  updateWake();
}

export function stop() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  releaseWake();
  S.geoState = 'idle';
}

async function setupBattery() {
  if (S.battery || !navigator.getBattery) return;
  try {
    const b = await navigator.getBattery();
    S.battery = b;
    const up = () => emit('battery');
    b.addEventListener('levelchange', up);
    b.addEventListener('chargingchange', up);
    emit('battery');
  } catch (_) {}
}

async function updateWake() {
  releaseWake();
  if (!S.prefs.wake || !('wakeLock' in navigator)) return;
  try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch (_) {}
}
function releaseWake() { try { wake?.release(); } catch (_) {} wake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.prefs.wake && !wake && watchId != null) updateWake(); });
on('prefs', (k) => { if (k === 'saver' || k === 'share') start(); if (k === 'wake') updateWake(); });
