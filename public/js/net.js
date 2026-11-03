// WebSocket resiliente: backoff com jitter, detecção de conexão "morta" e reconexão imediata ao voltar a rede.
export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.state = 'offline';
    this.attempt = 0;
    this.url = '';
    this.want = false;
    this.lastRx = 0;
    this._timer = null;
    this._hb = null;
    window.addEventListener('online', () => this.want && this.state !== 'online' && this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.want && this.state !== 'online') this.reconnectNow();
      else if (!document.hidden && this.state === 'online') this.ping();
    });
  }
  _set(s) { if (this.state !== s) { this.state = s; this.dispatchEvent(new CustomEvent('state', { detail: s })); } }
  start(url) { this.url = url; this.want = true; this.attempt = 0; this._open(); }
  stop() {
    this.want = false;
    clearTimeout(this._timer);
    clearInterval(this._hb);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (_) {} this.ws = null; }
    this._set('offline');
  }
  reconnectNow() {
    clearTimeout(this._timer);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch (_) {} this.ws = null; }
    this.attempt = 0;
    this._open();
  }
  _open() {
    if (!this.want) return;
    this._set('connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch (_) { return this._retry(); }
    this.ws = ws;
    const guard = setTimeout(() => { if (ws.readyState !== 1) { try { ws.close(); } catch (_) {} } }, 10000);
    ws.onopen = () => {
      clearTimeout(guard);
      this.attempt = 0;
      this.lastRx = Date.now();
      this._set('connected');
      clearInterval(this._hb);
      this._hb = setInterval(() => {
        if (Date.now() - this.lastRx > 45000) { try { ws.close(); } catch (_) {} return; }
        this.ping();
      }, 15000);
      this.dispatchEvent(new Event('open'));
    };
    ws.onmessage = (e) => {
      this.lastRx = Date.now();
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      this.dispatchEvent(new CustomEvent('msg', { detail: d }));
    };
    ws.onclose = (e) => {
      clearTimeout(guard);
      clearInterval(this._hb);
      if (this.ws === ws) this.ws = null;
      this._set('offline');
      this.dispatchEvent(new CustomEvent('close', { detail: e.code }));
      if (this.want && e.code !== 4002 && e.code !== 4003) this._retry();
    };
    ws.onerror = () => {};
  }
  _retry() {
    if (!this.want) return;
    const base = Math.min(15000, 800 * 2 ** Math.min(this.attempt++, 5));
    this._timer = setTimeout(() => this._open(), base / 2 + Math.random() * base / 2);
  }
  markReady() { this._set('online'); }
  ping() { this.send({ t: 'ping' }); }
  send(o) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(o)); return true; } catch (_) { return false; }
  }
}
