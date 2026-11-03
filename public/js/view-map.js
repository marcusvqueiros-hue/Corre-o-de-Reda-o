import { h, ic, add, clear, ago, fmtCoord, fmtDist, haversine, bearing, compass, STATUS } from './util.js';
import { S, on, admin, requestTrail, dm } from './state.js';
import { MapView } from './map.js';
import { avatar, statusChip, toast } from './ui.js';
import { requestNow } from './geo.js';

const FILTERS = [['all', 'Todos'], ['attn', 'Atenção'], ['online', 'Online'], ['stale', 'Sem sinal']];

export function renderMap(root, param, nav) {
  const isAdmin = S.me.role === 'admin';
  let canSeeOthers = isAdmin || S.settings.shareMap;
  let filter = 'all', selected = null, showTrail = true, tilesOn = true, base = null, fixedPt = null;

  const wrap = h('div', { class: 'map-wrap' });
  const sheetBox = h('div');
  const hud = h('div', { class: 'hud' }, '—');
  const note = h('div', { class: 'mapnote hidden' });
  const chips = h('div', { class: 'map-top' });
  const side = h('div', { class: 'map-side' });
  root.replaceChildren(wrap);
  wrap.append(chips, side, h('div', { class: 'north', title: 'Norte' }, 'N'), hud, note, sheetBox);

  const hasTiles = () => (S.info?.tiles || []).length > 0;
  const map = new MapView(wrap, {
    tileUrls: S.info?.tiles || [],
    onSelect: (id) => { select(id === '__me' ? null : id); },
    onMove: (c) => { hud.textContent = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} · Z${c.z.toFixed(1)}`; },
  });
  wrap.prepend(map.canvas);

  function markers() {
    const now = Date.now();
    const out = [];
    if (canSeeOthers) {
      for (const u of S.users.values()) {
        if (!u.loc || u.banned || u.id === S.me.id) continue;
        const stale = now - u.loc.ts > 15 * 60e3;
        const m = { id: u.id, name: u.name, lat: u.loc.lat, lng: u.loc.lng, acc: u.loc.acc, status: u.status || 'unknown', online: u.online, stale, role: u.role, ts: u.loc.ts };
        if (filter === 'attn' && !['sos', 'help', 'injured'].includes(m.status)) continue;
        if (filter === 'online' && !u.online) continue;
        if (filter === 'stale' && !stale) continue;
        out.push(m);
      }
    }
    if (fixedPt) out.push({ id: '__pt', name: 'Local compartilhado', lat: fixedPt.lat, lng: fixedPt.lng, acc: 0, status: 'unknown', online: true, stale: false });
    return out;
  }

  function refresh() {
    const list = markers();
    map.setMarkers(list);
    map.setMe(S.myLoc && S.prefs.share ? S.myLoc : S.myLoc);
    if (!base) {
      base = S.myLoc || (list.length ? { lat: list.reduce((a, m) => a + m.lat, 0) / list.length, lng: list.reduce((a, m) => a + m.lng, 0) / list.length } : null);
      if (base) map.setOrigin(base);
    } else if (S.myLoc) map.setOrigin(S.myLoc);
    const tr = selected && showTrail ? S.trails.get(selected) : null;
    map.setTrail(tr || null);
    if (selected && !list.find((m) => m.id === selected) && selected !== '__pt') select(null, true);
    drawSheet();
    drawNote(list);
    hud.textContent = `${map.lat.toFixed(5)}, ${map.lng.toFixed(5)} · Z${map.z.toFixed(1)}`;
  }

  function drawNote(list) {
    let msg = '';
    if (!canSeeOthers && !S.myLoc) msg = S.geoState === 'denied' ? 'Localização bloqueada nas permissões do navegador' : S.geoState === 'insecure' ? 'GPS exige conexão HTTPS' : 'Aguardando sinal de GPS…';
    else if (canSeeOthers && !list.length && !S.myLoc) msg = isAdmin ? 'Nenhuma posição recebida ainda' : 'Ninguém compartilhou posição ainda';
    else if (!canSeeOthers) msg = 'Somente o comando vê as posições dos demais';
    note.textContent = msg;
    note.classList.toggle('hidden', !msg);
  }

  function select(id, silent) {
    selected = id;
    map.setSelected(id);
    if (id && id !== '__pt' && isAdmin && !S.trails.has(id)) requestTrail(id);
    if (!silent) drawSheet();
  }

  function drawSheet() {
    sheetBox.replaceChildren();
    if (!selected) return;
    if (selected === '__pt' && fixedPt) {
      sheetBox.append(h('div', { class: 'msheet' }, h('div', { class: 'top' }, h('div', { class: 'main' }, h('b', null, 'Local compartilhado'), h('div', { class: 'mono mut', style: { fontSize: '11px' } }, fmtCoord(fixedPt.lat, fixedPt.lng))), closeBtn()),
        h('div', { class: 'row-actions' }, copyBtn(fixedPt.lat, fixedPt.lng), navBtn(fixedPt.lat, fixedPt.lng))));
      return;
    }
    const u = S.users.get(selected);
    if (!u || !u.loc) return;
    const from = S.myLoc || base;
    let dist = '—';
    if (from) { const d = haversine(from.lat, from.lng, u.loc.lat, u.loc.lng); dist = `${fmtDist(d)} ${compass(bearing(from.lat, from.lng, u.loc.lat, u.loc.lng))}`; }
    const kv = (k, v) => h('div', null, h('small', null, k), h('b', null, v));
    sheetBox.append(h('div', { class: 'msheet' },
      h('div', { class: 'top' }, avatar(u), h('div', { class: 'main' }, h('b', null, u.name, u.role === 'admin' && ' ', u.role === 'admin' && h('span', { class: 'pill' }, 'comando')), h('div', null, statusChip(u.status))), closeBtn()),
      h('div', { class: 'kv' },
        kv('Posição', fmtCoord(u.loc.lat, u.loc.lng)),
        kv('Atualizada', 'há ' + ago(u.loc.ts)),
        kv('Precisão', u.loc.acc ? `±${u.loc.acc} m` : '—'),
        kv('Distância', dist),
        kv('Bateria', u.loc.bat != null ? `${u.loc.bat}%${u.loc.chg ? ' ⚡' : ''}` : '—'),
        kv('Conexão', u.online ? 'online' : `offline há ${ago(u.lastSeen)}`)),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn sm primary', onclick: () => nav(`#/chat/${encodeURIComponent(dm(u.id))}`) }, ic('chat', 16), 'Mensagem'),
        isAdmin && h('button', { class: 'btn sm', onclick: () => { admin('locate', { uid: u.id }); toast('Pedido de posição enviado'); } }, ic('crosshair', 16), 'Atualizar'),
        copyBtn(u.loc.lat, u.loc.lng), navBtn(u.loc.lat, u.loc.lng),
        isAdmin && h('button', { class: 'btn sm' + (showTrail ? '' : ' ghost'), onclick: () => { showTrail = !showTrail; refresh(); } }, ic('trail', 16), 'Trilha'),
        isAdmin && u.status === 'sos' && h('button', { class: 'btn sm danger', onclick: () => admin('clear_sos', { uid: u.id }) }, 'Encerrar SOS'))));
  }
  const closeBtn = () => h('button', { class: 'icon-btn', 'aria-label': 'Fechar', onclick: () => { select(null); } }, ic('x'));
  const copyBtn = (lat, lng) => h('button', { class: 'btn sm', onclick: async () => {
    const t = `${lat.toFixed(6)},${lng.toFixed(6)}`;
    try { await navigator.clipboard.writeText(t); toast('Coordenadas copiadas', 'ok'); } catch (_) { prompt('Copie as coordenadas:', t); }
  } }, ic('copy', 16), 'Copiar');
  const navBtn = (lat, lng) => h('a', { class: 'btn sm', href: `geo:${lat},${lng}?q=${lat},${lng}` }, ic('nav', 16), 'Rota');

  // ----- controles -----
  function drawChips() {
    chips.replaceChildren(...(canSeeOthers ? FILTERS : []).map(([k, l]) => h('button', {
      class: 'qbtn' + (filter === k ? ' act' : ''), style: { '--c': '#19e3ff' }, onclick: () => { filter = k; drawChips(); refresh(); },
    }, l)));
  }
  function fitAll() {
    const pts = markers().filter((m) => m.id !== '__pt').map((m) => ({ lat: m.lat, lng: m.lng }));
    if (S.myLoc) pts.push({ lat: S.myLoc.lat, lng: S.myLoc.lng });
    if (pts.length) map.fit(pts); else toast('Ainda não há posições para enquadrar');
  }
  function drawSide() {
    clear(side);
    add(side,
      h('button', { class: 'icon-btn', 'aria-label': 'Aproximar', onclick: () => map.zoomBy(1) }, ic('plus')),
      h('button', { class: 'icon-btn', 'aria-label': 'Afastar', onclick: () => map.zoomBy(-1) }, ic('minus')),
      canSeeOthers && h('button', { class: 'icon-btn', 'aria-label': 'Enquadrar todos', onclick: fitAll }, ic('fit')),
      h('button', { class: 'icon-btn', 'aria-label': 'Minha posição', onclick: () => {
        if (S.myLoc) map.flyTo(S.myLoc.lat, S.myLoc.lng, Math.max(map.z, 16)); else { requestNow(); toast('Buscando sua posição…'); }
      } }, ic('crosshair')),
      hasTiles() && h('button', { class: 'icon-btn' + (tilesOn ? ' act' : ''), 'aria-label': 'Camada de mapa', title: 'Alternar mapa de fundo', onclick: () => { tilesOn = !tilesOn; map.set({ showTiles: tilesOn }); drawSide(); } }, ic('layers')));
  }
  drawChips(); drawSide();

  // ----- foco inicial -----
  const q = (param || '').split('/');
  if (q[0] === 'at' && q[1]) {
    const [lat, lng] = q[1].split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) { fixedPt = { lat, lng }; map.set({ lat, lng, z: 16 }); selected = '__pt'; map.setSelected('__pt'); }
  } else if (q[0] && S.users.get(q[0])?.loc) {
    const u = S.users.get(q[0]);
    map.set({ lat: u.loc.lat, lng: u.loc.lng, z: 16 });
    select(q[0], true);
  } else if (S.myLoc) map.set({ lat: S.myLoc.lat, lng: S.myLoc.lng, z: 15 });
  refresh();
  if (!param) { const pts = markers().map((m) => ({ lat: m.lat, lng: m.lng })); if (S.myLoc) pts.push(S.myLoc); if (pts.length > 1) setTimeout(() => map.fit(pts), 60); else if (pts.length === 1) map.set({ lat: pts[0].lat, lng: pts[0].lng, z: 15 }); }

  let pend = false;
  const soon = () => { if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; refresh(); }); } };
  const offs = [on('users', soon), on('loc', soon), on('myloc', soon), on('trail', soon), on('info', () => { map.setTileUrls(S.info?.tiles || []); drawSide(); }), on('settings', () => { canSeeOthers = isAdmin || S.settings.shareMap; drawChips(); drawSide(); soon(); })];
  const timer = setInterval(soon, 20000);
  return () => { offs.forEach((f) => f()); clearInterval(timer); map.destroy(); };
}
