import { h, ic, ago, fmtCoord, dmChannel } from './util.js';
import { S, init, on, totalUnread, sendSOS, setStatus, send, admin, dm, net, logout } from './state.js';
import * as geo from './geo.js';
import { startSiren, stopSiren, sirenOn, vibrate, beep } from './sound.js';
import { toast, connChip, avatar, openLayer, logoSvg } from './ui.js';
import { renderJoin } from './view-join.js';
import { renderChats } from './view-chats.js';
import { renderMap } from './view-map.js';
import { renderPeople } from './view-people.js';
import { renderSettings } from './view-settings.js';

const app = document.getElementById('app');
let teardownShell = null;
let teardownView = null;
let shell = null;

export const nav = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

async function boot() {
  await init();
  document.documentElement.classList.toggle('large', S.prefs.large);
  registerSW();
  on('session', render);
  window.addEventListener('hashchange', () => S.session && route());
  render();
  document.getElementById('boot')?.remove();
}

function render() {
  teardownView?.(); teardownView = null;
  teardownShell?.(); teardownShell = null;
  stopSiren();
  if (!S.session) { geo.stop(); teardownView = renderJoin(app); return; }
  buildShell();
  geo.start();
  route();
}

// ===================== casca do app =====================
function buildShell() {
  const isAdmin = S.me.role === 'admin';
  const chip = connChip();
  const bannerBox = h('div', { class: 'banners' });
  const view = h('main', { class: 'view', id: 'view' });
  const sosBtn = !isAdmin && h('button', { class: 'sos-btn', 'aria-label': 'Enviar pedido de socorro SOS', onclick: startSosFlow }, ic('alert', 18), 'SOS');
  const top = h('header', { class: 'topbar' }, h('div', { class: 'brand' }, h('i', null, ic('signal', 18)), 'ELO'), h('div', { class: 'grow' }), chip.el, sosBtn);
  const tabDefs = [
    ['chats', 'chat', 'Chats'], ['map', 'map', 'Mapa'],
    ['people', isAdmin ? 'radar' : 'users', isAdmin ? 'Painel' : 'Pessoas'], ['settings', 'gear', 'Ajustes'],
  ];
  const tabEls = {};
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Navegação' }, tabDefs.map(([k, icon, label]) => {
    const badge = h('span', { class: 'badge hidden' });
    const el = h('button', { class: 'tab', 'aria-label': label, onclick: () => nav('#/' + k) }, ic(icon, 22), label, badge);
    tabEls[k] = { el, badge };
    return el;
  }));
  const el = h('div', { class: 'shell' }, top, bannerBox, view, tabs);
  app.replaceChildren(el);
  shell = { el, view, tabEls, bannerBox };

  const activeSos = () => [...S.users.values()].filter((u) => u.status === 'sos' && u.id !== S.me.id && !u.banned);
  const dismissed = () => { try { return sessionStorage.getItem('motd') || ''; } catch (_) { return ''; } };

  function drawBanners() {
    const out = [];
    const sos = activeSos();
    if (isAdmin && sos.length) out.push(h('div', { class: 'banner sos', role: 'alert', onclick: () => openSosOverlay() }, ic('alert', 18), `${sos.length} chamado${sos.length > 1 ? 's' : ''} SOS ativo${sos.length > 1 ? 's' : ''} — toque para ver`));
    if (!isAdmin && S.me.status === 'sos') {
      const pending = (S.msgs.get('general') || []).some((m) => m.kind === 'sos' && m.from === S.me.id && m.status === 'pending');
      out.push(h('div', { class: 'banner red', role: 'alert' }, ic('alert', 18), h('span', null, pending ? 'SOS na fila — será enviado assim que houver conexão.' : 'SOS enviado: o comando foi avisado.'),
        h('button', { class: 'linkbtn', onclick: cancelSos }, 'Cancelar')));
    } else if (!isAdmin) {
      const pending = (S.msgs.get('general') || []).some((m) => m.kind === 'sos' && m.from === S.me.id && m.status === 'pending');
      if (pending) out.push(h('div', { class: 'banner red', role: 'alert' }, ic('alert', 18), 'SOS na fila — será enviado assim que houver conexão.'));
    }
    if (S.settings.motd && dismissed() !== S.settings.motd) {
      out.push(h('div', { class: 'banner info' }, ic('mega', 18), h('span', null, S.settings.motd), h('button', { 'aria-label': 'Dispensar', onclick: () => { try { sessionStorage.setItem('motd', S.settings.motd); } catch (_) {} drawBanners(); } }, ic('x', 16))));
    }
    if (!window.isSecureContext && S.info?.tls) {
      const url = `https://${location.hostname}:${S.info.httpsPort || 8443}/`;
      out.push(h('div', { class: 'banner' }, ic('shield', 18), h('span', null, 'Modo básico (sem HTTPS): GPS e uso offline do app indisponíveis. '), h('a', { href: url }, 'Abrir versão segura')));
    } else if (S.prefs.share && S.geoState === 'denied') {
      out.push(h('div', { class: 'banner' }, ic('pin', 18), 'Localização bloqueada: libere nas permissões do navegador para o comando saber onde você está.'));
    }
    if (S.conn === 'offline') out.push(h('div', { class: 'banner info' }, ic('signal', 18), 'Sem conexão com o servidor. Mensagens e posições ficam salvas e serão enviadas quando o sinal voltar.'));
    bannerBox.replaceChildren(...out);
  }

  function drawBadges() {
    const n = totalUnread();
    const set = (k, v, red) => { const b = tabEls[k].badge; b.textContent = v > 99 ? '99+' : v; b.classList.toggle('hidden', !v); b.classList.toggle('red', !!red); };
    set('chats', n);
    if (isAdmin) set('people', activeSos().length, true);
    document.title = (n ? `(${n}) ` : '') + 'ELO — Comunicação de Emergência';
    try { n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch (_) {}
  }

  // alarme de SOS para o admin
  const offSos = on('sos', (u) => {
    if (!isAdmin) return;
    vibrate([400, 150, 400, 150, 800]);
    if (S.prefs.sound) startSiren();
    openSosOverlay();
  });
  const offUsers = on('users', () => {
    drawBanners(); drawBadges();
    if (!activeSos().length) { stopSiren(); sosClose?.(); }
  });

  const all = () => { chip.update(); drawBanners(); drawBadges(); };
  const offs = [on('conn', all), on('outbox', () => { chip.update(); drawBanners(); }), on('msg', () => { drawBadges(); drawBanners(); }), on('msgupdate', drawBanners),
    on('unread', drawBadges), on('settings', drawBanners), on('myloc', drawBanners), on('info', drawBanners), offSos, offUsers];
  all();
  teardownShell = () => { offs.forEach((f) => f()); sosClose?.(); };
}

// ===================== rotas =====================
function route() {
  if (!S.session || !shell) return;
  teardownView?.(); teardownView = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = ['chats', 'chat', 'map', 'people', 'settings'].includes(parts[0]) ? parts[0] : 'chats';
  const tabKey = page === 'chat' ? 'chats' : page;
  for (const [k, t] of Object.entries(shell.tabEls)) { t.el.classList.toggle('act', k === tabKey); t.el.setAttribute('aria-current', k === tabKey ? 'page' : 'false'); }
  shell.el.dataset.page = page;
  const v = shell.view;
  if (page === 'chats' || page === 'chat') teardownView = renderChats(v, page === 'chat' ? decodeURIComponent(parts[1] || '') || null : null, nav);
  else if (page === 'map') teardownView = renderMap(v, parts.slice(1).join('/'), nav);
  else if (page === 'people') teardownView = renderPeople(v, nav);
  else teardownView = renderSettings(v);
}

// ===================== SOS =====================
function startSosFlow() {
  let n = 5, timer;
  let close;
  const cd = h('div', { class: 'countdown' }, n);
  const done = () => { clearInterval(timer); close(); };
  const fire = () => {
    done();
    sendSOS();
    vibrate([200, 100, 200, 100, 600]);
    if (S.prefs.sound) beep.alert();
    toast(S.conn === 'online' ? 'SOS enviado ao comando' : 'SOS salvo — será enviado ao reconectar', 'ok');
  };
  const card = h('div', { class: 'soscard', role: 'alertdialog', 'aria-label': 'Confirmar SOS' },
    h('div', { class: 'big' }, 'SOS'), h('h2', null, 'PEDIR SOCORRO?'),
    h('p', { class: 'mut', style: { margin: '4px 0 6px' } }, 'O comando e todos do grupo serão avisados com a sua localização.'),
    cd,
    h('div', { class: 'row-actions', style: { justifyContent: 'center', marginTop: '16px' } },
      h('button', { class: 'btn danger', onclick: fire }, 'ENVIAR AGORA'),
      h('button', { class: 'btn', onclick: done }, 'Cancelar')));
  close = openLayer(card, { cls: 'sos-layer', onClose: () => clearInterval(timer) });
  vibrate(120);
  timer = setInterval(() => { n--; cd.textContent = n; vibrate(60); if (n <= 0) fire(); }, 1000);
}

function cancelSos() {
  setStatus('unknown');
  send({ ch: 'general', kind: 'text', text: '✅ SOS cancelado — estou bem.' });
  toast('SOS cancelado');
}

let sosClose = null;
function openSosOverlay() {
  sosClose?.();
  const list = h('div');
  const draw = () => {
    const act = [...S.users.values()].filter((u) => u.status === 'sos' && !u.banned);
    list.replaceChildren(...act.map((u) => h('div', { class: 'sositem' }, avatar(u),
      h('div', { class: 'main' }, h('b', null, u.name), h('div', { class: 'mut', style: { fontSize: '12.5px' } }, u.loc ? `${fmtCoord(u.loc.lat, u.loc.lng)} · há ${ago(u.loc.ts)}` : 'sem posição ainda'),
        h('div', { class: 'row-actions', style: { marginTop: '8px' } },
          u.loc && h('button', { class: 'btn sm primary', onclick: () => { sosClose(); nav(`#/map/${u.id}`); } }, ic('map', 16), 'Mapa'),
          h('button', { class: 'btn sm', onclick: () => { sosClose(); nav(`#/chat/${encodeURIComponent(dm(u.id))}`); } }, ic('chat', 16), 'Responder'),
          h('button', { class: 'btn sm ghost', onclick: () => admin('clear_sos', { uid: u.id }) }, 'Encerrar'))))));
    if (!act.length) { sosClose?.(); }
  };
  const card = h('div', { class: 'soscard', role: 'alertdialog', 'aria-label': 'Chamados SOS' },
    h('div', { class: 'big' }, 'SOS'), h('h2', null, 'CHAMADO DE EMERGÊNCIA'), list,
    h('div', { class: 'row-actions', style: { justifyContent: 'center', marginTop: '12px' } },
      h('button', { class: 'btn', onclick: () => { stopSiren(); toast('Alarme silenciado'); } }, 'Silenciar alarme'),
      h('button', { class: 'btn ghost', onclick: () => sosClose?.() }, 'Fechar')));
  const off = on('users', draw);
  const c = openLayer(card, { cls: 'sos-layer', onClose: () => { off(); if (sosClose === wrapped) sosClose = null; } });
  const wrapped = () => { c(); };
  sosClose = wrapped;
  draw();
}

// ===================== PWA =====================
function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('App atualizado. Reabra para usar a nova versão.'); });
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open-chat' && e.data.ch) nav('#/chat/' + encodeURIComponent(e.data.ch)); });
}

boot();
