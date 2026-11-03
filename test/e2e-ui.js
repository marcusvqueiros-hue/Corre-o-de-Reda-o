'use strict';
// Teste de interface com Chromium (requer Playwright instalado globalmente): node test/e2e-ui.js [pasta-de-screenshots]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 19000 + Math.floor(Math.random() * 500);
const HTTP_PORT = PORT + 1;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-ui-'));
const SHOTS = process.argv[2] || path.join(DATA, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch (_) {} }));

(async () => {
  const startSrv = () => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT), HTTP_PORT: String(HTTP_PORT), DATA_DIR: DATA, ADMIN_PASSWORD: 'comando123', TILE_URL: 'off' }, stdio: 'ignore',
    });
    procs.push(p);
    return p;
  };
  let srv = startSrv();
  const BASE = `https://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${HTTP_PORT}/api/info`); break; } catch (_) { await sleep(150); } }

  // O navegador "instala a CA": confia no certificado do servidor (necessário para Service Worker/GPS em HTTPS local)
  const spki = require('child_process').execSync(`openssl x509 -in ${DATA}/tls/server.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`).toString().trim();
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors-spki-list=' + spki] });
  let ok = 0;
  const step = (n) => { ok++; console.log('  ✓', n); };
  const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });

  // ---------- admin (desktop) ----------
  const actx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['geolocation'], geolocation: { latitude: -23.5505, longitude: -46.6333, accuracy: 8 } });
  const admin = await actx.newPage();
  const errors = [];
  admin.on('pageerror', (e) => errors.push('admin: ' + e.message));
  await admin.goto(BASE + '/');
  await admin.waitForSelector('.join .panel');
  await shot(admin, '01-join-admin');
  await admin.fill('#j-name', 'Comando Central');
  await admin.click('text=Sou administrador');
  await admin.fill('#j-pass', 'comando123');
  await admin.click('button[type=submit]');
  await admin.waitForSelector('.shell');
  await admin.waitForSelector('.chip.on', { timeout: 8000 });
  step('admin entra e conecta (chip Online)');

  // ---------- usuário (celular) ----------
  const uctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: -23.5612, longitude: -46.6559, accuracy: 15 } });
  const user = await uctx.newPage();
  user.on('pageerror', (e) => errors.push('user: ' + e.message));
  await user.goto(BASE + '/');
  await user.waitForSelector('.join .panel');
  await user.fill('#j-name', 'Maria Souza');
  await user.click('button[type=submit]');
  await user.waitForSelector('.err:not(:empty)');
  await shot(user, '02-join-consent-required');
  await user.check('#j-consent');
  await user.click('button[type=submit]');
  await user.waitForSelector('.shell');
  await user.waitForSelector('.chip.on', { timeout: 8000 });
  await shot(user, '03-user-chats');
  step('usuário exige consentimento de localização e entra');

  // ---------- chat ----------
  await user.click('.row:has-text("Geral")');
  await user.fill('.composer textarea', 'Olá, estou na Av. Paulista, tudo bem aqui.');
  await user.click('button[aria-label="Enviar"]');
  await user.waitForSelector('.bub.me .tick:not(.read)');
  await admin.click('.tab:has-text("Chats")');
  await admin.waitForSelector('.row:has-text("Olá, estou na Av. Paulista")', { timeout: 6000 });
  step('mensagem do usuário chega ao admin');
  await admin.click('.row:has-text("Geral")');
  await admin.fill('.composer textarea', 'Recebido, Maria. Fique onde está.');
  await admin.keyboard.press('Enter');
  await user.waitForSelector('.bub.them:has-text("Recebido, Maria")', { timeout: 6000 });
  await shot(admin, '04-admin-chat');
  await shot(user, '05-user-chat');
  step('resposta do admin chega ao usuário');

  // ---------- mapa: admin vê a localização ----------
  await admin.click('.tab:has-text("Mapa")');
  await admin.waitForSelector('.map-canvas');
  await sleep(1500);
  await shot(admin, '06-admin-map');
  const txt = await admin.evaluate(() => document.querySelector('.hud')?.textContent);
  assert.ok(/-23\./.test(txt), 'HUD deveria mostrar coordenadas de SP, obteve ' + txt);
  step('mapa do admin centra nas coordenadas recebidas: ' + txt);
  // clica no marcador da Maria (centro do canvas após fit) via API de hit-test: usa o painel Painel
  await admin.click('.tab:has-text("Painel")');
  await admin.waitForSelector('.row:has-text("Maria Souza")');
  await admin.click('.row:has-text("Maria Souza")');
  await admin.click('.sheet .row:has-text("Ver no mapa")');
  await admin.waitForSelector('.msheet:has-text("Maria Souza")');
  await sleep(900);
  const sheetTxt = await admin.textContent('.msheet');
  assert.ok(/-23\.5612/.test(sheetTxt), 'folha do marcador deve exibir a posição da Maria: ' + sheetTxt);
  await shot(admin, '07-admin-map-selected');
  step('admin abre a Maria no mapa e vê posição/precisão');

  // ---------- offline: fila de envio ----------
  srv.kill('SIGTERM'); // queda do servidor / da rede local
  await sleep(900);
  await user.waitForSelector('.chip.off, .chip.wait', { timeout: 15000 });
  await user.fill('.composer textarea', 'Perdi o sinal, mas vou continuar escrevendo.');
  await user.click('button[aria-label="Enviar"]');
  await user.waitForSelector('.bub.me:has-text("Perdi o sinal") .tick svg');
  await user.waitForSelector('.topbar .chip .badge');
  const overflow = await user.evaluate(() => ({ sw: document.querySelector('.shell').scrollWidth, tw: document.querySelector('.topbar').scrollWidth, iw: window.innerWidth, sosRight: document.querySelector('.sos-btn').getBoundingClientRect().right }));
  assert.ok(overflow.sw <= overflow.iw && overflow.sosRight <= overflow.iw, 'layout não pode estourar a largura offline: ' + JSON.stringify(overflow));
  await shot(user, '08-user-offline-queued');
  step('offline: mensagem fica pendente com relógio e chip "na fila"');
  await user.reload().catch(() => {}); // app abre do cache mesmo offline
  await user.waitForSelector('.shell', { timeout: 10000 });
  await user.waitForSelector('.bub.me:has-text("Perdi o sinal")');
  step('offline: app abre do cache (service worker) e mantém o histórico/fila');
  srv = startSrv(); // a rede/servidor volta
  await user.waitForSelector('.chip.on', { timeout: 30000 });
  await admin.click('.tab:has-text("Chats")');
  await admin.click('.row:has-text("Geral")');
  await admin.waitForSelector('.bub.them:has-text("Perdi o sinal")', { timeout: 10000 });
  step('ao reconectar a mensagem é entregue ao admin (sem duplicar)');
  const dupes = await admin.locator('.bub:has-text("Perdi o sinal")').count();
  assert.strictEqual(dupes, 1);

  // ---------- SOS ----------
  await user.click('.sos-btn');
  await user.waitForSelector('.soscard .countdown');
  await shot(user, '09-user-sos-confirm');
  await user.click('text=ENVIAR AGORA');
  await admin.waitForSelector('.soscard:has-text("Maria Souza")', { timeout: 8000 });
  await sleep(500); await shot(admin, '10-admin-sos-alert');
  step('SOS: admin recebe alarme com a Maria');
  await admin.click('.soscard >> text=Fechar');
  await admin.click('.tab:has-text("Painel")');
  await admin.waitForSelector('.stat.alert');
  await shot(admin, '11-admin-dashboard');
  await admin.click('.sositem >> text=Encerrar');
  await admin.waitForSelector('.stat.alert', { state: 'detached', timeout: 5000 });
  step('admin encerra o SOS e o painel atualiza');

  // ---------- configurações e visual mobile ----------
  await user.click('.tab:has-text("Ajustes")');
  await sleep(400);
  await shot(user, '12-user-settings');
  const mp = await user.goto(BASE + '/manifest.webmanifest').then((r) => r.json());
  assert.ok(mp.icons.some((i) => i.purpose === 'maskable'));
  step('manifest PWA válido');

  assert.deepStrictEqual(errors, [], 'erros JS na página: ' + errors.join(' | '));
  step('sem erros JavaScript nas páginas');
  await browser.close();
  srv.kill('SIGTERM');
  await sleep(700);
  console.log(`\n${ok} verificações de interface OK. Screenshots: ${SHOTS}`);
  process.exit(0);
})().catch((e) => { console.error('\nFALHOU:', e); process.exit(1); });
