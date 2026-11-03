import { h, ic, add, fmtTime, fmtDay, ago, dmChannel, dmOther, hashColor, compressImage, fmtCoord, clear } from './util.js';
import { S, on, channelMsgs, unread, markRead, sendText, sendImage, sendLocationMsg, retry, isRead, chTitle, setStatus, admin, dm } from './state.js';
import { avatar, iconAvatar, toast, statusChip, connChip, openLayer, confirmDialog } from './ui.js';
import { STATUS } from './util.js';
import { requestNow } from './geo.js';

const previewOf = (m) => (m.deleted ? 'Mensagem apagada' : m.kind === 'image' ? '📷 Foto' : m.kind === 'loc' ? '📍 Localização' : m.kind === 'sos' ? '🆘 SOS ' + (m.text || '') : m.text);

function channelList() {
  const chs = new Set(['alerts', 'general']);
  for (const ch of S.msgs.keys()) if (S.msgs.get(ch).length) chs.add(ch);
  const rank = (ch) => (ch === 'alerts' ? 3e15 : ch === 'general' ? 2e15 : (channelMsgs(ch).at(-1)?.cts || 0));
  return [...chs].sort((a, b) => rank(b) - rank(a));
}

export function renderChats(root, ch, nav) {
  const wrap = h('div', { class: 'chats' + (ch ? ' open' : '') });
  const colList = h('div', { class: 'col-list' });
  const colThread = h('div', { class: 'col-thread' });
  wrap.append(colList, colThread);
  root.replaceChildren(wrap);

  // ----- lista -----
  const listBox = h('div', { class: 'list' });
  const quick = h('div', { class: 'quick' });
  colList.append(quick, listBox);

  function drawQuick() {
    if (S.me.role === 'admin') { quick.classList.add('hidden'); return; }
    quick.classList.remove('hidden');
    const cur = S.me.status || 'unknown';
    quick.replaceChildren(h('span', { class: 'lbl' }, 'Meu status'),
      ...['safe', 'help', 'injured'].map((k) => h('button', {
        class: 'qbtn' + (cur === k ? ' act' : ''), style: { '--c': STATUS[k].color }, 'aria-pressed': String(cur === k),
        onclick: () => { setStatus(cur === k ? 'unknown' : k); toast(cur === k ? 'Status removido' : `Status: ${STATUS[k].label}`, 'ok'); },
      }, h('i'), STATUS[k].label)));
  }

  function drawList() {
    const rows = channelList().map((c) => {
      const last = channelMsgs(c).at(-1);
      const isDm = c.startsWith('dm:');
      const u = isDm ? S.users.get(dmOther(c, S.me.id)) : null;
      const sender = last && last.from !== S.me.id ? S.users.get(last.from)?.name?.split(' ')[0] : last ? 'Você' : '';
      const n = unread(c);
      const hasSos = c === 'general' && channelMsgs(c).some((m) => m.kind === 'sos' && m.seq > (S.lastRead[c] || 0));
      return h('button', { class: 'row' + (c === ch ? ' sel' : ''), onclick: () => nav(`#/chat/${encodeURIComponent(c)}`) },
        c === 'alerts' ? iconAvatar('mega', 'al') : c === 'general' ? iconAvatar('users') : avatar(u || { name: '?' }),
        h('div', { class: 'main' },
          h('div', { class: 'title' }, h('span', null, chTitle(c)), last && h('span', { class: 'time' }, fmtTime(last.sts || last.cts))),
          h('div', { class: 'sub' },
            h('span', null, last ? (sender && c !== 'alerts' && !isDm ? sender + ': ' : isDm && last.from === S.me.id ? 'Você: ' : '') + previewOf(last) : c === 'alerts' ? 'Comunicados oficiais do comando' : 'Nenhuma mensagem ainda'),
            n > 0 && h('span', { class: 'badge' + (hasSos ? ' red' : '') }, n > 99 ? '99+' : n))));
    });
    listBox.replaceChildren(...rows,
      h('div', { style: { padding: '18px 14px' } }, h('button', { class: 'btn block', onclick: () => nav('#/people') }, ic('users', 18), S.me.role === 'admin' ? 'Abrir painel de pessoas' : 'Nova conversa')));
  }
  drawQuick(); drawList();

  const offs = [on('msg', drawList), on('unread', drawList), on('users', () => { drawList(); drawQuick(); }), on('msgupdate', drawList)];
  let threadCleanup = null;
  if (ch) threadCleanup = renderThread(colThread, ch, nav);
  else colThread.append(h('div', { class: 'empty' }, h('div', null, ic('chat', 56)), h('b', null, 'Selecione uma conversa'), h('small', null, 'Suas mensagens ficam salvas no aparelho, mesmo sem rede.')));
  return () => { offs.forEach((f) => f()); threadCleanup && threadCleanup(); };
}

// ===================== conversa =====================
function renderThread(root, ch, nav) {
  S.activeCh = ch;
  const isDm = ch.startsWith('dm:');
  const otherId = isDm ? dmOther(ch, S.me.id) : null;
  const readonly = ch === 'alerts' && S.me.role !== 'admin';

  const sub = h('small');
  const headBtns = h('div', { class: 'row-actions', style: { flexWrap: 'nowrap' } });
  const whoAvatar = ch === 'alerts' ? iconAvatar('mega', 'al sm') : ch === 'general' ? iconAvatar('users', 'sm') : null;
  const head = h('div', { class: 'thead' },
    h('button', { class: 'icon-btn back', 'aria-label': 'Voltar', onclick: () => nav('#/chats') }, ic('back')),
    h('span', { class: 'avwrap' }),
    h('div', { class: 'who' }, h('b', null, chTitle(ch)), sub), headBtns);
  const list = h('div', { class: 'msgs', tabIndex: -1, 'aria-live': 'polite' });
  const text = h('textarea', { class: 'input', rows: 1, placeholder: 'Mensagem', maxLength: 4000, 'aria-label': 'Mensagem', enterKeyHint: 'send' });
  const fileIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: async () => {
    const f = fileIn.files[0]; fileIn.value = '';
    if (!f) return;
    try { sendImage(ch, await compressImage(f)); } catch (e) { toast('Não foi possível enviar a imagem: ' + e.message, 'err'); }
  } });
  const doSend = () => { if (sendText(ch, text.value)) { text.value = ''; autosize(); } text.focus(); };
  const autosize = () => { text.style.height = 'auto'; text.style.height = Math.min(140, text.scrollHeight) + 'px'; };
  text.addEventListener('input', autosize);
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover:hover)').matches) { e.preventDefault(); doSend(); } });

  const composer = readonly
    ? h('div', { class: 'composer-note' }, '📢 Somente o comando publica avisos neste canal.')
    : h('div', { class: 'composer' },
      h('button', { class: 'icon-btn', 'aria-label': 'Enviar foto', onclick: () => fileIn.click() }, ic('image')),
      h('button', { class: 'icon-btn', 'aria-label': 'Compartilhar minha localização', onclick: () => {
        if (!S.myLoc) { requestNow(); toast(S.geoState === 'denied' ? 'Localização bloqueada nas permissões do navegador.' : 'Obtendo sua posição… tente de novo em instantes.'); return; }
        sendLocationMsg(ch); toast('Localização enviada', 'ok');
      } }, ic('pin')),
      text, fileIn,
      h('button', { class: 'icon-btn send', 'aria-label': 'Enviar', onclick: doSend }, ic('send')));

  root.replaceChildren(h('div', { class: 'thread' }, head, list, composer));
  const avslot = head.querySelector('.avwrap');

  function drawHead() {
    if (isDm) {
      const u = S.users.get(otherId);
      avslot.replaceChildren(avatar(u || { name: '?' }, { size: 'sm' }));
      sub.textContent = u ? (u.online ? 'online agora' : `visto há ${ago(u.lastSeen)}`) + (u.status && u.status !== 'unknown' ? ' · ' + STATUS[u.status].label : '') : '';
      headBtns.replaceChildren();
      if (S.me.role === 'admin' && u) {
        add(headBtns,
          u.loc && h('button', { class: 'icon-btn', 'aria-label': 'Ver no mapa', onclick: () => nav(`#/map/${u.id}`) }, ic('map')),
          h('button', { class: 'icon-btn', 'aria-label': 'Pedir localização agora', title: 'Pedir localização agora', onclick: () => { admin('locate', { uid: u.id }); toast('Pedido de localização enviado'); } }, ic('crosshair')));
      }
    } else {
      avslot.replaceChildren(whoAvatar.cloneNode(true));
      if (ch === 'general') {
        const all = [...S.users.values()].filter((u) => !u.banned);
        sub.textContent = `${all.filter((u) => u.online).length} online · ${all.length} pessoas`;
      } else sub.textContent = 'Comunicados oficiais';
    }
  }
  drawHead();

  // ----- renderização incremental das mensagens -----
  const els = new Map();
  let lastSig = new Map();
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 140;

  function bubble(m) {
    const mine = m.from === S.me.id;
    const sender = S.users.get(m.from);
    const cls = ['bub', mine ? 'me' : 'them'];
    if (m.kind === 'sos') cls.push('sos');
    if (m.ch === 'alerts') cls.push('alert');
    if (m.deleted) cls.push('del');
    const body = [];
    if (m.ch === 'alerts') body.push(h('div', { class: 'hd' }, ic('mega', 16), 'AVISO DO COMANDO'));
    if (m.kind === 'sos') body.push(h('div', { class: 'hd' }, ic('alert', 18), mine ? 'SOS ENVIADO' : `SOS — ${sender?.name || 'alguém'}`));
    else if (!mine && !isDm && m.ch !== 'alerts') body.push(h('div', { class: 'nm', style: { color: hashColor(m.from) } }, sender?.name || 'Desconhecido'));
    if (m.deleted) body.push(h('div', { class: 'tx' }, 'Mensagem apagada pelo comando'));
    else {
      if (m.kind === 'image') {
        body.push(m.img ? h('img', { class: 'photo', src: m.img, alt: 'Foto enviada', loading: 'lazy', onclick: () => viewImage(m.img) }) : h('div', { class: 'tx mut' }, '📷 Foto (removida do histórico)'));
      }
      if (m.loc) body.push(locCard(m, nav));
      if (m.text) body.push(h('div', { class: 'tx' }, m.text));
    }
    const tick = mine ? (m.status === 'pending' ? h('span', { class: 'tick', title: 'Aguardando conexão' }, ic('clock', 12))
      : m.status === 'failed' ? h('button', { class: 'tick fail', title: 'Falhou — tocar para reenviar', onclick: () => retry(m.id) }, '! reenviar')
      : isRead(m) ? h('span', { class: 'tick read', title: 'Lida' }, ic('check', 12), ic('check', 12)) : h('span', { class: 'tick', title: 'Enviada' }, ic('check', 12))) : null;
    const del = S.me.role === 'admin' && !mine && !m.deleted && m.seq ? h('button', { class: 'tick', title: 'Apagar (admin)', 'aria-label': 'Apagar mensagem', onclick: async () => { if (await confirmDialog({ title: 'Apagar mensagem?', text: 'Será removida para todos.', ok: 'Apagar', danger: true })) admin('del_msg', { id: m.id }); } }, '🗑') : null;
    body.push(h('div', { class: 'meta' }, del, fmtTime(m.sts || m.cts), tick));
    return h('div', { class: cls.join(' '), dataset: { id: m.id } }, body);
  }

  function reconcile(force) {
    const stick = nearBottom();
    const msgs = channelMsgs(ch);
    const wanted = [];
    let day = '';
    for (const m of msgs) {
      const d = fmtDay(m.sts || m.cts);
      if (d !== day) { day = d; wanted.push({ key: 'day:' + d + ':' + m.id, node: () => h('div', { class: 'day' }, d), sig: 'd' }); }
      wanted.push({ key: m.id, node: () => bubble(m), sig: `${m.status}|${m.seq}|${m.deleted ? 1 : 0}|${isRead(m) ? 1 : 0}|${S.users.get(m.from)?.name}` });
    }
    const keep = new Set(wanted.map((w) => w.key));
    for (const [k, el] of els) if (!keep.has(k)) { el.remove(); els.delete(k); lastSig.delete(k); }
    let prev = null;
    for (const w of wanted) {
      let el = els.get(w.key);
      if (!el || lastSig.get(w.key) !== w.sig || force) {
        const n = w.node();
        if (el) el.replaceWith(n);
        el = n; els.set(w.key, n); lastSig.set(w.key, w.sig);
      }
      const want = prev ? prev.nextSibling : list.firstChild;
      if (el !== want) list.insertBefore(el, want);
      prev = el;
    }
    if (stick) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  reconcile();
  list.scrollTop = list.scrollHeight;
  markRead(ch);

  const offs = [
    on('msg', (c) => { if (c === ch) { reconcile(); if (!document.hidden) markRead(ch); } }),
    on('msgupdate', () => reconcile()),
    on('peerread', (c) => c === ch && reconcile()),
    on('users', () => { drawHead(); reconcile(); }),
  ];
  const onVis = () => { if (!document.hidden) markRead(ch); };
  document.addEventListener('visibilitychange', onVis);
  if (matchMedia('(hover:hover)').matches) setTimeout(() => text.focus(), 60);
  return () => { S.activeCh = null; offs.forEach((f) => f()); document.removeEventListener('visibilitychange', onVis); };
}

function locCard(m, nav) {
  const { lat, lng, acc } = m.loc;
  return h('div', { class: 'loccard' },
    h('div', { class: 'pinic' }, ic('pin', 22)),
    h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'co' }, fmtCoord(lat, lng)), h('small', null, acc ? `precisão ±${acc} m` : 'localização compartilhada')),
    S.me.role === 'admin' || S.settings.shareMap ? h('button', { class: 'btn sm', onclick: () => nav(`#/map/at/${lat.toFixed(6)},${lng.toFixed(6)}`) }, 'Mapa') : null,
    h('a', { class: 'btn sm', href: `geo:${lat},${lng}?q=${lat},${lng}`, 'aria-label': 'Abrir no app de mapas' }, ic('nav', 16)));
}

function viewImage(src) {
  const close = openLayer(h('div', { class: 'viewer', onclick: () => close() }, h('img', { src, alt: 'Foto' })), { cls: '' });
}
