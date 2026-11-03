// Sons gerados no aparelho (WebAudio) — nada para baixar, funciona offline.
let ctx = null;
let sirenTimer = null;
export function unlock() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (_) {}
}
['pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, unlock, { once: false, passive: true }));

function tone(freq, dur, type = 'sine', vol = 0.15, when = 0) {
  if (!ctx || ctx.state !== 'running') return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  const t0 = ctx.currentTime + when;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
export const beep = {
  msg() { tone(880, 0.12, 'sine', 0.12); tone(1320, 0.14, 'sine', 0.1, 0.1); },
  sent() { tone(660, 0.07, 'sine', 0.06); },
  alert() { tone(520, 0.18, 'square', 0.1); tone(780, 0.22, 'square', 0.1, 0.2); tone(520, 0.18, 'square', 0.1, 0.45); },
};
export function startSiren() {
  if (sirenTimer) return;
  const cycle = () => { tone(900, 0.45, 'sawtooth', 0.12); tone(600, 0.45, 'sawtooth', 0.12, 0.5); };
  cycle();
  sirenTimer = setInterval(cycle, 1000);
}
export function stopSiren() { clearInterval(sirenTimer); sirenTimer = null; }
export const sirenOn = () => !!sirenTimer;
export function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} }
