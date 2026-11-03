// Utilitários de DOM, tempo, geografia e ícones. Nunca usa innerHTML com dados de usuário.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch (_) { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const add = (el, ...kids) => append(el, kids);
export const $ = (s, r = document) => r.querySelector(s);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

const ICONS = {
  chat: 'M4 5h16v11H9l-5 4z',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z M9 4v14 M15 6v14',
  users: 'M8 11a3 3 0 100-6 3 3 0 000 6z M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6 M16 11a3 3 0 100-6 M17 14c2.8.3 5 2.7 5 6',
  radar: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 16a4 4 0 100-8 4 4 0 000 8z M12 12l6-6',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  send: 'M22 2 11 13 M22 2l-7 20-4-9-9-4z',
  image: 'M3 5h18v14H3z M8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M21 15l-5-5L5 19',
  pin: 'M12 22s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12z M12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  back: 'M15 5l-7 7 7 7',
  alert: 'M12 3 2 20h20z M12 10v5 M12 18v.5',
  signal: 'M4 20v-3 M9 20v-7 M14 20V9 M19 20V4',
  slash: 'M3 3l18 18',
  check: 'M4 12l5 5L20 6',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 7v5l3 2',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  crosshair: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 2v4 M12 18v4 M2 12h4 M18 12h4',
  layers: 'M12 3 2 8l10 5 10-5z M2 13l10 5 10-5',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
  bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4z M10 21h4',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  battery: 'M3 8h15v8H3z M21 11v2',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  logout: 'M9 21H4V3h5 M16 17l5-5-5-5 M21 12H9',
  mega: 'M3 11v2l12 5V6z M15 9a3 3 0 010 6 M6 14v5',
  nav: 'M3 11 21 3l-8 18-2-8z',
  trail: 'M4 19c4 0 3-7 8-7s4-7 8-7 M4 19h.01 M20 5h.01',
};
export function ic(name, size = 20, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  s.append(p);
  return s;
}

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));

export const dmChannel = (a, b) => 'dm:' + [a, b].sort().join(':');
export const dmOther = (ch, me) => ch.split(':').slice(1).find((x) => x !== me);

const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export function fmtDay(ts) {
  const d = new Date(ts), n = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, n)) return 'Hoje';
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (same(d, y)) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}
export function ago(ts, now = Date.now()) {
  if (!ts) return 'nunca';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'agora';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}
export const initials = (n) => (String(n).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
export function hashColor(id) {
  let x = 0;
  for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${x % 360} 85% 62%)`;
}

export function haversine(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, R = 6371000;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function bearing(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
export const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : m < 10000 ? `${(m / 1000).toFixed(2)} km` : `${(m / 1000).toFixed(1)} km`);
export const compass = (deg) => ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8];
export const fmtCoord = (lat, lng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

export const STATUS = {
  unknown: { label: 'Sem status', color: '#19e3ff' },
  safe: { label: 'Estou bem', color: '#2dffa4' },
  help: { label: 'Preciso de ajuda', color: '#ffc933' },
  injured: { label: 'Ferido', color: '#ff7a3d' },
  sos: { label: 'SOS', color: '#ff3b5c' },
};

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function download(filename, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Redimensiona/comprime imagens no aparelho para caber em redes ruins (~100 KB).
export async function compressImage(file, maxDim = 720, limit = 150000) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('imagem inválida');
  const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.7, out = c.toDataURL('image/jpeg', q);
  while (out.length > limit && q > 0.25) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
  if (out.length > limit) throw new Error('imagem grande demais');
  return out;
}
