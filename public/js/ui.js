import { h, ic, initials, hashColor, STATUS, append, add } from './util.js';
import { S } from './state.js';

export function toast(text, kind = '') {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + kind }, text);
  box.append(t);
  setTimeout(() => t.remove(), 3800);
}

export function openLayer(content, { cls = '', onClose, dismissable = true } = {}) {
  const layer = h('div', { class: 'layer ' + cls }, content);
  const close = () => { layer.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  if (dismissable) layer.addEventListener('pointerdown', (e) => { if (e.target === layer) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(layer);
  return close;
}

export function sheet(title, nodes) {
  let close;
  const el = h('div', { class: 'sheet', role: 'dialog', 'aria-label': title }, title && h('h3', null, title), nodes);
  close = openLayer(el);
  return close;
}

export function confirmDialog({ title, text, ok = 'Confirmar', cancel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; close(); resolve(v); } };
    const el = h('div', { class: 'sheet', role: 'alertdialog' },
      h('h3', null, title), text && h('p', null, text),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => fin(true) }, ok),
        h('button', { class: 'btn ghost', onclick: () => fin(false) }, cancel)));
    const close = openLayer(el, { onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

export function avatar(user, { size = '', pres = true } = {}) {
  const name = user?.name || '?';
  const el = h('div', { class: `avatar ${size} ${user?.status === 'sos' ? 'sos' : ''}`, style: { '--c': hashColor(user?.id || name) }, 'aria-hidden': 'true' }, initials(name));
  if (pres && user) el.append(h('i', { class: 'pres' + (user.online ? ' on' : '') }));
  return el;
}
export const iconAvatar = (name, cls = '') => h('div', { class: 'avatar ico ' + cls, 'aria-hidden': 'true' }, ic(name, 22));

export function statusChip(st) {
  const s = STATUS[st] || STATUS.unknown;
  return h('span', { class: 'chip st', style: { color: s.color } }, h('span', { class: 'dot', style: { background: s.color } }), s.label);
}

export function connChip() {
  const el = h('span', { class: 'chip off', role: 'status' });
  const update = () => {
    const q = S.outboxCount + S.locQueued;
    const map = { online: ['on', 'Online'], connecting: ['wait', 'Conectando'], offline: ['off', 'Sem rede'] };
    const [cls, label] = map[S.conn] || map.offline;
    el.className = 'chip ' + cls;
    el.replaceChildren();
    add(el, h('span', { class: 'dot' }), label, q ? h('span', { class: 'badge', title: `${q} item(ns) na fila para enviar` }, q) : null);
    el.title = S.conn === 'online' ? 'Conectado ao servidor' : 'Sem conexão: mensagens e posições ficam salvas e serão enviadas ao reconectar.';
  };
  update();
  return { el, update };
}

export function field(label, input, hint) {
  return h('div', { class: 'field' }, h('label', null, label), input, hint && h('small', { class: 'mut' }, hint));
}

export function toggleRow(title, sub, checked, onChange) {
  const inp = h('input', { type: 'checkbox', checked, 'aria-label': title, onchange: () => onChange(inp.checked) });
  return h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, title), sub && h('small', null, sub)), h('label', { class: 'switch' }, inp, h('i')));
}

export function logoSvg(size = 72) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 100 100'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.innerHTML = '<defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#19e3ff"/><stop offset="1" stop-color="#8a5cff"/></linearGradient></defs><g fill="none" stroke="url(#lg)" stroke-width="5" stroke-linecap="round"><path d="M22 38a40 40 0 0 1 56 0" opacity=".45"/><path d="M32 49a26 26 0 0 1 36 0" opacity=".75"/><path d="M42 60a12 12 0 0 1 16 0"/></g><circle cx="50" cy="72" r="6" fill="url(#lg)"/><path d="M50 78v12" stroke="url(#lg)" stroke-width="5" stroke-linecap="round"/>';
  return s;
}
export { append };
