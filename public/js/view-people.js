import { h, ic, add, ago, fmtCoord, STATUS } from './util.js';
import { S, on, admin, send, dm, requestTrail } from './state.js';
import { avatar, statusChip, toast, sheet, confirmDialog } from './ui.js';

export function renderPeople(root, nav) {
  const isAdmin = S.me.role === 'admin';
  let q = '';
  const page = h('div', { class: 'page narrow' });
  root.replaceChildren(page);

  const statsBox = h('div', { class: 'grid-stats' });
  const sosBox = h('div');
  const listBox = h('div', { class: 'card', style: { padding: 0, overflow: 'hidden' } });
  const search = h('input', { class: 'input', placeholder: 'Buscar pessoa…', type: 'search', 'aria-label': 'Buscar pessoa', oninput: () => { q = search.value.toLowerCase(); drawList(); } });

  // aviso geral (admin)
  const notice = h('textarea', { class: 'input', rows: 2, placeholder: 'Escreva um aviso para todos…', maxLength: 1000 });
  const noticeCard = isAdmin && h('div', null,
    h('div', { class: 'h-sec' }, 'Aviso geral'),
    h('div', { class: 'card' }, notice,
      h('div', { class: 'row-actions', style: { marginTop: '10px' } },
        h('button', { class: 'btn primary', onclick: () => { if (!notice.value.trim()) return; send({ ch: 'alerts', kind: 'text', text: notice.value.trim() }); notice.value = ''; toast('Aviso publicado', 'ok'); } }, ic('mega', 18), 'Publicar aviso'),
        h('button', { class: 'btn', onclick: () => { admin('locate', { uid: 'all' }); toast('Pedido de posição enviado a todos os online'); } }, ic('crosshair', 18), 'Pedir posição de todos'))));

  add(page,
    isAdmin ? h('div', { class: 'h-sec', style: { marginTop: 0 } }, 'Visão geral') : h('div', { class: 'h-sec', style: { marginTop: 0 } }, 'Pessoas'),
    isAdmin && statsBox, sosBox, noticeCard,
    h('div', { class: 'h-sec' }, isAdmin ? 'Todas as pessoas' : 'Iniciar conversa'), h('div', { style: { marginBottom: '10px' } }, search), listBox);

  function users() {
    return [...S.users.values()].filter((u) => u.id !== S.me.id && (isAdmin || !u.banned))
      .sort((a, b) => (b.status === 'sos') - (a.status === 'sos') || b.online - a.online || a.name.localeCompare(b.name));
  }

  function drawStats() {
    if (!isAdmin) return;
    const us = users();
    const stat = (cls, n, l) => h('div', { class: 'stat ' + cls }, h('b', null, n), h('span', null, l));
    statsBox.replaceChildren(
      stat(us.some((u) => u.status === 'sos') ? 'alert' : '', us.filter((u) => u.status === 'sos').length, 'SOS ativos'),
      stat('warn', us.filter((u) => ['help', 'injured'].includes(u.status)).length, 'Precisam de ajuda'),
      stat('ok', us.filter((u) => u.online).length, 'Online'),
      stat('cy', us.filter((u) => u.loc).length, `Com posição / ${us.length}`));
  }

  function drawSos() {
    const act = users().filter((u) => u.status === 'sos');
    sosBox.replaceChildren();
    if (!isAdmin || !act.length) return;
    sosBox.append(h('div', { class: 'h-sec', style: { color: 'var(--bad)' } }, '🆘 Chamados de emergência'),
      ...act.map((u) => h('div', { class: 'sositem' }, avatar(u),
        h('div', { class: 'main' }, h('b', null, u.name), h('div', { class: 'mut', style: { fontSize: '12.5px' } }, u.loc ? `${fmtCoord(u.loc.lat, u.loc.lng)} · há ${ago(u.loc.ts)}` : 'sem posição'), h('div', { class: 'row-actions', style: { marginTop: '8px' } },
          u.loc && h('button', { class: 'btn sm primary', onclick: () => nav(`#/map/${u.id}`) }, ic('map', 16), 'Mapa'),
          h('button', { class: 'btn sm', onclick: () => nav(`#/chat/${encodeURIComponent(dm(u.id))}`) }, ic('chat', 16), 'Responder'),
          h('button', { class: 'btn sm ghost', onclick: () => admin('clear_sos', { uid: u.id }) }, 'Encerrar'))))));
  }

  function drawList() {
    const us = users().filter((u) => !q || u.name.toLowerCase().includes(q));
    if (!us.length) { listBox.replaceChildren(h('div', { class: 'empty', style: { padding: '28px' } }, h('small', null, S.users.size <= 1 ? 'Ninguém entrou ainda. Compartilhe o endereço do servidor.' : 'Nenhum resultado'))); return; }
    listBox.replaceChildren(...us.map((u) => h('button', { class: 'row', onclick: () => (isAdmin ? userSheet(u, nav) : nav(`#/chat/${encodeURIComponent(dm(u.id))}`)) },
      avatar(u),
      h('div', { class: 'main' },
        h('div', { class: 'title' }, h('span', null, u.name), u.role === 'admin' && h('span', { class: 'pill' }, 'comando'), u.banned && h('span', { class: 'chip off' }, 'bloqueado')),
        h('div', { class: 'sub' }, statusChip(u.status),
          isAdmin && h('span', null, u.online ? 'online' : `visto há ${ago(u.lastSeen)}`),
          isAdmin && u.loc && h('span', null, `📍 ${ago(u.loc.ts)}`),
          isAdmin && u.loc?.bat != null && h('span', null, `🔋${u.loc.bat}%`))))));
  }

  const all = () => { drawStats(); drawSos(); drawList(); };
  all();
  const offs = [on('users', all), on('loc', () => { drawStats(); drawList(); })];
  const t = setInterval(drawList, 30000);
  return () => { offs.forEach((f) => f()); clearInterval(t); };
}

function userSheet(u, nav) {
  let close;
  const go = (hash) => { close(); nav(hash); };
  close = sheet(u.name, [
    h('div', { class: 'row', style: { cursor: 'default' } }, avatar(u, {}), h('div', { class: 'main' }, statusChip(u.status), h('div', { class: 'mut', style: { fontSize: '13px', marginTop: '4px' } }, u.online ? 'online agora' : `visto há ${ago(u.lastSeen)}`, u.loc ? ` · ${fmtCoord(u.loc.lat, u.loc.lng)}` : ' · sem posição'))),
    h('div', { class: 'list' },
      h('button', { class: 'row', onclick: () => go(`#/chat/${encodeURIComponent(dm(u.id))}`) }, ic('chat', 20), h('div', { class: 'main' }, 'Enviar mensagem')),
      u.loc && h('button', { class: 'row', onclick: () => go(`#/map/${u.id}`) }, ic('map', 20), h('div', { class: 'main' }, 'Ver no mapa')),
      h('button', { class: 'row', onclick: () => { admin('locate', { uid: u.id }); toast('Pedido de posição enviado'); close(); } }, ic('crosshair', 20), h('div', { class: 'main' }, 'Pedir posição agora')),
      u.status === 'sos' && h('button', { class: 'row', onclick: () => { admin('clear_sos', { uid: u.id }); close(); } }, ic('shield', 20), h('div', { class: 'main' }, 'Encerrar chamado SOS')),
      u.role !== 'admin' && h('button', { class: 'row', style: { color: 'var(--bad)' }, onclick: async () => {
        close();
        if (await confirmDialog({ title: u.banned ? 'Desbloquear?' : 'Bloquear acesso?', text: u.banned ? `${u.name} poderá entrar de novo.` : `${u.name} será desconectado e não poderá mais entrar.`, ok: u.banned ? 'Desbloquear' : 'Bloquear', danger: !u.banned })) admin(u.banned ? 'unban' : 'ban', { uid: u.id });
      } }, ic('x', 20), h('div', { class: 'main' }, u.banned ? 'Desbloquear' : 'Bloquear acesso')))]);
}
