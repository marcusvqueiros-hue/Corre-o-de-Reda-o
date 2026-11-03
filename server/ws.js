'use strict';
// Implementação mínima e robusta de WebSocket (RFC 6455), sem dependências.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024; // 1 MB

class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    this.fragLen = 0;
    this.closed = false;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15000);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.on('end', () => this._finish());
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    try {
      while (this._parse()) { /* consome todos os quadros completos */ }
    } catch (e) {
      this.close(1002);
    }
  }

  _parse() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      const hi = b.readUInt32BE(2);
      const lo = b.readUInt32BE(6);
      if (hi !== 0) { this.close(1009); return false; }
      len = lo;
      off = 10;
    }
    if (!masked) { this.close(1002); return false; }
    if (len > MAX_PAYLOAD) { this.close(1009); return false; }
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);

    if (op >= 0x8) {
      if (!fin || len > 125) { this.close(1002); return false; }
      if (op === 0x8) { this.close(1000); }
      else if (op === 0x9) this._frame(0xa, payload);
      else if (op === 0xa) this.emit('pong');
      return true;
    }
    if (op === 0x1 || op === 0x2) {
      this.fragOp = op;
      this.frag = [payload];
      this.fragLen = payload.length;
    } else if (op === 0x0) {
      this.frag.push(payload);
      this.fragLen += payload.length;
      if (this.fragLen > MAX_PAYLOAD) { this.close(1009); return false; }
    } else {
      this.close(1002);
      return false;
    }
    if (fin) {
      const full = this.frag.length === 1 ? this.frag[0] : Buffer.concat(this.frag);
      const wasText = this.fragOp === 0x1;
      this.frag = [];
      this.fragLen = 0;
      if (wasText) this.emit('message', full.toString('utf8'));
    }
    return true;
  }

  _frame(op, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    if (this.socket.writableLength > 8 * 1024 * 1024) { this.socket.destroy(); return false; } // cliente lento: não acumula memória
    try {
      this.socket.write(Buffer.concat([head, payload]));
      return true;
    } catch (_) {
      return false;
    }
  }

  send(str) { return this._frame(0x1, Buffer.from(str, 'utf8')); }
  ping() { return this._frame(0x9, Buffer.alloc(0)); }
  get bufferedBytes() { return this.socket.writableLength || 0; }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._frame(0x8, p);
    setTimeout(() => this.socket.destroy(), 200).unref();
    this._finish();
  }
}

function accept(req, socket, onConnect) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );
  onConnect(new WSConn(socket), req);
}

module.exports = { accept, WSConn };
