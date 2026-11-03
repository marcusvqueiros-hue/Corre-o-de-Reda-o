#!/usr/bin/env node
// Gera os ícones PNG do PWA sem dependências (rasterização própria + zlib).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const CY = [25, 227, 255], VI = [138, 92, 255];

// desenha em coordenadas 0..1; "scale" encolhe o desenho (zona segura do ícone maskable)
function sample(u, v, { full, scale }) {
  // fundo
  const d = Math.hypot(u - 0.5, v - 0.38);
  let col = mix([20, 34, 74], [4, 7, 15], Math.min(1, d / 0.85));
  let a = 255;
  if (!full) { // cantos arredondados
    const r = 0.22, x = Math.abs(u - 0.5) - (0.5 - r), y = Math.abs(v - 0.5) - (0.5 - r);
    const dist = Math.hypot(Math.max(x, 0), Math.max(y, 0)) - r;
    a = dist > 0 ? 0 : 255;
  }
  const px = 0.5 + (u - 0.5) / scale, py = 0.5 + (v - 0.5) / scale;
  const t = Math.min(1, Math.max(0, (px + py) / 2));
  const g = mix(CY, VI, t);
  const over = (cov, alpha = 1) => { if (cov > 0) col = mix(col, g, Math.min(1, cov * alpha)); };
  // arcos do sinal (centro em 0.5,0.645)
  const cx = 0.5, cy = 0.645, dx = px - cx, dy = py - cy, r = Math.hypot(dx, dy);
  const ang = Math.atan2(dx, -dy); // 0 = para cima
  const arcs = [[0.3, 0.42], [0.2, 0.75], [0.1, 1]];
  for (const [rad, al] of arcs) if (Math.abs(ang) < 0.78 && Math.abs(r - rad) < 0.021) over(1, al);
  if (r < 0.052) over(1);
  if (Math.abs(px - 0.5) < 0.021 && py > 0.66 && py < 0.8) over(1);
  return [col[0], col[1], col[2], a];
}

function render(size, opts, ss = 3) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const p = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, opts);
      r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
    }
    const o = (y * size + x) * 4, n = ss * ss;
    buf[o] = a ? Math.round(r / a) : 0; buf[o + 1] = a ? Math.round(g / a) : 0; buf[o + 2] = a ? Math.round(b / a) : 0; buf[o + 3] = Math.round(a / n);
  }
  return png(size, size, buf);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), render(192, { full: false, scale: 1 }));
fs.writeFileSync(path.join(out, 'icon-512.png'), render(512, { full: false, scale: 1 }));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), render(512, { full: true, scale: 0.72 }));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), render(180, { full: true, scale: 0.9 }));
console.log('ícones gerados em', out);
