// Mapa tático em <canvas>: funciona 100% offline (grade + anéis de radar); usa tiles quando existirem (cache/rede/servidor local).
import { STATUS, fmtDist } from './util.js';

const TILE = 256;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const worldSize = (z) => TILE * 2 ** z;
const lngX = (lng, z) => ((lng + 180) / 360) * worldSize(z);
const latY = (lat, z) => {
  const s = Math.sin((clamp(lat, -85.05, 85.05) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(z);
};
const xLng = (x, z) => (x / worldSize(z)) * 360 - 180;
const yLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / worldSize(z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000];

export class MapView {
  constructor(container, opts = {}) {
    this.el = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Mapa de localização');
    this.el.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.lat = opts.lat ?? -15.78; this.lng = opts.lng ?? -47.93; this.z = opts.z ?? 4;
    this.markers = []; this.me = null; this.trail = null; this.origin = null; this.selected = null;
    this.showTiles = opts.tiles !== false; this.showTrail = true; this.showLabels = true; this.showAcc = true;
    this.tileUrls = opts.tileUrls || [];
    this.tiles = new Map();
    this.onSelect = opts.onSelect || (() => {});
    this.onMove = opts.onMove || (() => {});
    this.pulse = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) && !opts.still;
    this.hits = []; this.dirty = true; this.dead = false; this.anim = null;
    this.pointers = new Map(); this.gesture = null; this.moved = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.filterOk = 'filter' in this.ctx;
    this._bind();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(this.el);
    this._resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  destroy() { this.dead = true; this.ro.disconnect(); this.canvas.remove(); }
  invalidate() { this.dirty = true; }

  // ---------- API ----------
  setMarkers(list) { this.markers = list; this.dirty = true; }
  setMe(p) { this.me = p; this.dirty = true; }
  setTrail(pts) { this.trail = pts; this.dirty = true; }
  setOrigin(p) { this.origin = p; this.dirty = true; }
  setSelected(id) { this.selected = id; this.dirty = true; }
  setTileUrls(u) { this.tileUrls = u || []; this.tiles.clear(); this.dirty = true; }
  set(opt) { Object.assign(this, opt); this.dirty = true; }
  get center() { return { lat: this.lat, lng: this.lng, z: this.z }; }

  flyTo(lat, lng, z = this.z, ms = 650) {
    const from = { lat: this.lat, lng: this.lng, z: this.z, t: performance.now() };
    // interpola em coordenadas de mundo do zoom de destino para evitar saltos
    this.anim = { from, to: { lat, lng, z }, ms };
    this.dirty = true;
  }

  fit(points, pad = 120) {
    const pts = points.filter((p) => p && Number.isFinite(p.lat));
    if (!pts.length) return;
    if (pts.length === 1) return this.flyTo(pts[0].lat, pts[0].lng, Math.max(this.z, 16));
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const p of pts) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng); }
    const w = Math.max(40, this.w - pad * 2), h = Math.max(40, this.h - pad * 2);
    let z = 19;
    for (; z > 1; z -= 0.25) {
      const dx = lngX(maxLng, z) - lngX(minLng, z), dy = latY(minLat, z) - latY(maxLat, z);
      if (dx <= w && dy <= h) break;
    }
    this.flyTo((minLat + maxLat) / 2, (minLng + maxLng) / 2, Math.min(z, 17));
  }

  zoomBy(dz, sx = this.w / 2, sy = this.h / 2) {
    const z = clamp(this.z + dz, 2, 19);
    this._zoomAt(z, sx, sy);
  }

  // ---------- geometria ----------
  project(lat, lng) {
    const cx = lngX(this.lng, this.z), cy = latY(this.lat, this.z);
    return [this.w / 2 + lngX(lng, this.z) - cx, this.h / 2 + latY(lat, this.z) - cy];
  }
  unproject(sx, sy) {
    const cx = lngX(this.lng, this.z), cy = latY(this.lat, this.z);
    return { lat: yLat(cy + sy - this.h / 2, this.z), lng: xLng(cx + sx - this.w / 2, this.z) };
  }
  metersPerPx(lat = this.lat) { return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** this.z; }

  _zoomAt(z, sx, sy) {
    const before = this.unproject(sx, sy);
    this.z = z;
    const cx = lngX(before.lng, z), cy = latY(before.lat, z);
    this.lng = xLng(cx - (sx - this.w / 2), z);
    this.lat = yLat(cy - (sy - this.h / 2), z);
    this.dirty = true;
    this.onMove(this.center);
  }

  // ---------- interação ----------
  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.anim = null;
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      this.moved = 0; this.downAt = performance.now(); this.downPos = { x: e.offsetX, y: e.offsetY };
      if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.gesture = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.z }; }
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.pointers.size === 1) {
        const cx = lngX(this.lng, this.z) - dx, cy = latY(this.lat, this.z) - dy;
        this.lng = xLng(cx, this.z); this.lat = clamp(yLat(cy, this.z), -84, 84);
        this.dirty = true; this.onMove(this.center);
      } else if (this.pointers.size === 2 && this.gesture) {
        p.x = e.offsetX; p.y = e.offsetY;
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this._zoomAt(clamp(this.gesture.z + Math.log2(d / this.gesture.d), 2, 19), (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      p.x = e.offsetX; p.y = e.offsetY;
    });
    const up = (e) => {
      const had = this.pointers.delete(e.pointerId);
      this.gesture = null;
      if (had && e.type === 'pointerup' && this.moved < 8 && performance.now() - this.downAt < 450) this._tap(e.offsetX, e.offsetY);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.anim = null; this.zoomBy(-e.deltaY / 380, e.offsetX, e.offsetY); }, { passive: false });
    c.addEventListener('dblclick', (e) => this.flyToZoom(e.offsetX, e.offsetY));
  }
  flyToZoom(sx, sy) { const p = this.unproject(sx, sy); this.flyTo(p.lat, p.lng, Math.min(19, this.z + 1.5), 350); }

  _tap(x, y) {
    let best = null, bd = 28;
    for (const h of this.hits) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h.id; } }
    this.selected = best;
    this.dirty = true;
    this.onSelect(best);
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, Math.round(r.width)); this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = this.w * this.dpr; this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.h + 'px';
    this.dirty = true;
  }

  // ---------- tiles ----------
  _tile(z, x, y) {
    const n = 2 ** z;
    if (y < 0 || y >= n) return null;
    x = ((x % n) + n) % n;
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) { t.used = performance.now(); return t.ok ? t.img : null; }
    if (!this.tileUrls.length) return null;
    t = { img: new Image(), ok: false, i: 0, used: performance.now() };
    const load = () => {
      if (t.i >= this.tileUrls.length) { t.fail = performance.now(); return; }
      t.img.src = this.tileUrls[t.i].replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
    };
    t.img.onload = () => { t.ok = true; this.dirty = true; };
    t.img.onerror = () => { t.i++; load(); };
    this.tiles.set(key, t);
    load();
    if (this.tiles.size > 360) {
      const old = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, 80);
      for (const [k] of old) this.tiles.delete(k);
    }
    return null;
  }

  // ---------- desenho ----------
  _loop(now) {
    if (this.dead) return;
    if (this.anim) {
      const a = this.anim, k = clamp((now - a.from.t) / a.ms, 0, 1), e = 1 - (1 - k) ** 3;
      this.z = a.from.z + (a.to.z - a.from.z) * e;
      const zz = a.to.z;
      const x = lngX(a.from.lng, zz) + (lngX(a.to.lng, zz) - lngX(a.from.lng, zz)) * e;
      const y = latY(a.from.lat, zz) + (latY(a.to.lat, zz) - latY(a.from.lat, zz)) * e;
      // converte do espaço do zoom de destino para o zoom atual
      this.lng = xLng(x, zz); this.lat = yLat(y, zz);
      if (k >= 1) { this.anim = null; this.z = a.to.z; this.lat = a.to.lat; this.lng = a.to.lng; this.onMove(this.center); }
      this.dirty = true;
    }
    const animated = this.pulse && (this.me || this.markers.some((m) => m.status === 'sos' || m.id === this.selected));
    if (this.dirty || animated) { this._draw(now); this.dirty = false; }
    requestAnimationFrame(this._loop);
  }

  _draw(now) {
    const { ctx, w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#050a16'); bg.addColorStop(1, '#0a1328');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

    this._grid();
    if (this.showTiles && this.tileUrls.length) this._tiles();
    this._rings();
    if (this.showTrail && this.trail && this.trail.length > 1) this._trail();
    this._markers(now);
    this._scale();
  }

  _grid() {
    const { ctx, w, h } = this;
    const step = 64 * 2 ** (this.z - Math.round(this.z) );
    const cx = lngX(this.lng, this.z), cy = latY(this.lat, this.z);
    ctx.strokeStyle = 'rgba(80,140,255,0.07)'; ctx.lineWidth = 1; ctx.beginPath();
    const ox = ((w / 2 - cx) % step + step) % step, oy = ((h / 2 - cy) % step + step) % step;
    for (let x = ox; x < w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    for (let y = oy; y < h; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
  }

  _tiles() {
    const { ctx, w, h } = this;
    const Z = clamp(Math.round(this.z), 0, 19);
    const scale = 2 ** (this.z - Z), ts = TILE * scale;
    const ctX = lngX(this.lng, Z) / TILE, ctY = latY(this.lat, Z) / TILE;
    const x0 = Math.floor(ctX - w / 2 / ts), x1 = Math.floor(ctX + w / 2 / ts);
    const y0 = Math.floor(ctY - h / 2 / ts), y1 = Math.floor(ctY + h / 2 / ts);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 80) return;
    ctx.save();
    if (this.filterOk) ctx.filter = 'invert(1) hue-rotate(190deg) saturate(.7) brightness(.82) contrast(.95)';
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const img = this._tile(Z, tx, ty);
      if (!img) continue;
      const sx = w / 2 + (tx - ctX) * ts, sy = h / 2 + (ty - ctY) * ts;
      ctx.drawImage(img, Math.floor(sx), Math.floor(sy), Math.ceil(ts) + 1, Math.ceil(ts) + 1);
    }
    ctx.restore();
    if (!this.filterOk) { ctx.fillStyle = 'rgba(4,10,28,.55)'; ctx.fillRect(0, 0, w, h); }
  }

  _rings() {
    const o = this.origin;
    if (!o) return;
    const { ctx } = this;
    const [ox, oy] = this.project(o.lat, o.lng);
    const mpp = this.metersPerPx(o.lat);
    const target = 110 * mpp;
    const step = NICE.find((n) => n >= target) || NICE[NICE.length - 1];
    ctx.save();
    ctx.strokeStyle = 'rgba(25,227,255,0.16)'; ctx.fillStyle = 'rgba(25,227,255,0.55)';
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace'; ctx.lineWidth = 1;
    // rótulos ficam sobre a linha que liga a origem ao centro da tela, para aparecerem sempre que possível
    const ang = Math.atan2(this.h / 2 - oy, this.w / 2 - ox);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    for (let i = 1; i <= 12; i++) {
      const r = (step * i) / mpp;
      if (r > Math.hypot(this.w, this.h) * 1.2 + 50) break;
      ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.stroke();
      const lx = ox + Math.cos(ang) * r, ly = oy + Math.sin(ang) * r;
      if (lx > 4 && lx < this.w - 60 && ly > 14 && ly < this.h - 4) ctx.fillText(fmtDist(step * i), lx + 4, ly - 4);
    }
    ctx.beginPath(); ctx.moveTo(ox - 14, oy); ctx.lineTo(ox + 14, oy); ctx.moveTo(ox, oy - 14); ctx.lineTo(ox, oy + 14); ctx.stroke();
    ctx.restore();
  }

  _trail() {
    const { ctx } = this;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const pts = this.trail.map((p) => this.project(p[1], p[2]));
    for (let i = 1; i < pts.length; i++) {
      const a = 0.15 + 0.75 * (i / pts.length);
      ctx.strokeStyle = `rgba(138,92,255,${a})`; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(pts[i - 1][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(200,170,255,.9)';
    for (let i = 0; i < pts.length; i += Math.ceil(pts.length / 40)) { ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], 2, 0, 7); ctx.fill(); }
    ctx.restore();
  }

  _markers(now) {
    const { ctx, w, h } = this;
    this.hits = [];
    const t = now / 1000;
    const mpp = this.metersPerPx();
    const list = this.markers;
    // precisão (círculo) do selecionado e do "eu"
    ctx.save();
    const drawAcc = (m, col) => {
      if (!this.showAcc || !m.acc || m.acc < 3) return;
      const [x, y] = this.project(m.lat, m.lng);
      const r = m.acc / mpp;
      if (r < 6 || r > 600) return;
      ctx.fillStyle = col.replace('1)', '0.08)'); ctx.strokeStyle = col.replace('1)', '0.35)');
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
    };
    if (this.me) drawAcc(this.me, 'rgba(120,200,255,1)');
    const sel = list.find((m) => m.id === this.selected);
    if (sel) drawAcc(sel, 'rgba(255,255,255,1)');
    ctx.restore();

    const edge = [];
    for (const m of list) {
      const [x, y] = this.project(m.lat, m.lng);
      if (x < -30 || y < -30 || x > w + 30 || y > h + 30) { if (m.status === 'sos') edge.push([m, x, y]); continue; }
      this._pin(m, x, y, t);
      this.hits.push({ id: m.id, x, y });
    }
    if (this.me) {
      const [x, y] = this.project(this.me.lat, this.me.lng);
      this._me(x, y, t);
      this.hits.push({ id: '__me', x, y });
    }
    // setas para SOS fora da tela
    for (const [m, x, y] of edge) {
      const cx = w / 2, cy = h / 2, ang = Math.atan2(y - cy, x - cx);
      const ex = clamp(cx + Math.cos(ang) * 9999, 24, w - 24), ey = clamp(cy + Math.sin(ang) * 9999, 70, h - 90);
      const k = Math.min(Math.abs((ex - cx) / Math.cos(ang) || 1e9), Math.abs((ey - cy) / Math.sin(ang) || 1e9));
      const px = cx + Math.cos(ang) * k, py = cy + Math.sin(ang) * k;
      ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
      ctx.fillStyle = '#ff3b5c'; ctx.shadowColor = '#ff3b5c'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-8, -8); ctx.lineTo(-4, 0); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill();
      ctx.restore();
      this.hits.push({ id: m.id, x: px, y: py });
    }
  }

  _pin(m, x, y, t) {
    const { ctx } = this;
    const st = STATUS[m.status] || STATUS.unknown;
    const col = m.stale ? '#6b7a99' : st.color;
    const sel = m.id === this.selected;
    ctx.save();
    if (m.status === 'sos' && this.pulse) {
      for (let i = 0; i < 2; i++) {
        const k = ((t * 0.9 + i * 0.5) % 1);
        ctx.strokeStyle = `rgba(255,59,92,${0.7 * (1 - k)})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 12 + k * 34, 0, 7); ctx.stroke();
      }
    }
    ctx.shadowColor = col; ctx.shadowBlur = m.stale ? 0 : 14;
    ctx.fillStyle = '#060c1c'; ctx.beginPath(); ctx.arc(x, y, sel ? 13 : 11, 0, 7); ctx.fill();
    ctx.lineWidth = sel ? 3.5 : 2.5; ctx.strokeStyle = col;
    if (m.stale || !m.online) ctx.setLineDash([3, 3]);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fill();
    if (m.role === 'admin') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(x - 3.5, y - 3.5, 7, 7); }
    if (this.showLabels && (this.z >= 11 || sel || m.status === 'sos')) {
      const label = m.name.length > 16 ? m.name.slice(0, 15) + '…' : m.name;
      ctx.font = '600 11px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(5,10,24,.8)'; ctx.strokeStyle = 'rgba(120,180,255,.25)'; ctx.lineWidth = 1;
      const bx = x - tw / 2 - 6, by = y + 17;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, tw + 12, 18, 9) : ctx.rect(bx, by, tw + 12, 18); ctx.fill(); ctx.stroke();
      ctx.fillStyle = m.stale ? '#8fa0c4' : '#e6f0ff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillText(label, x, by + 9.5);
    }
    ctx.restore();
  }

  _me(x, y, t) {
    const { ctx } = this;
    ctx.save();
    if (this.pulse) { const k = (t * 0.7) % 1; ctx.strokeStyle = `rgba(80,170,255,${0.5 * (1 - k)})`; ctx.beginPath(); ctx.arc(x, y, 8 + k * 22, 0, 7); ctx.stroke(); }
    ctx.shadowColor = '#4aa8ff'; ctx.shadowBlur = 12;
    ctx.fillStyle = '#4aa8ff'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    if (this.me && Number.isFinite(this.me.hdg) && (this.me.spd || 0) > 0.8) {
      ctx.translate(x, y); ctx.rotate((this.me.hdg * Math.PI) / 180);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(5, -9); ctx.lineTo(-5, -9); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  _scale() {
    const { ctx, h } = this;
    const mpp = this.metersPerPx();
    const m = NICE.find((n) => n / mpp >= 60) || 1000;
    const px = m / mpp;
    ctx.save();
    ctx.strokeStyle = 'rgba(230,240,255,.8)'; ctx.fillStyle = 'rgba(230,240,255,.85)'; ctx.lineWidth = 1.5;
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    const x = 14, y = h - 92;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
    ctx.fillText(fmtDist(m), x, y - 9);
    ctx.restore();
  }
}
