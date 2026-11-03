import { h, ic, uuid } from './util.js';
import { S, join, setPref, refreshInfo, on } from './state.js';
import { field, logoSvg } from './ui.js';

export function renderJoin(root) {
  let adminMode = false;
  const name = h('input', { class: 'input', id: 'j-name', placeholder: 'Como devemos te chamar?', maxLength: 40, autocomplete: 'name', value: S.session?.me?.name || '' });
  const code = h('input', { class: 'input', id: 'j-code', placeholder: 'Código fornecido pelo comando', autocomplete: 'off', inputMode: 'text' });
  const pass = h('input', { class: 'input', id: 'j-pass', type: 'password', placeholder: 'Senha do administrador', autocomplete: 'current-password' });
  const server = h('input', { class: 'input', placeholder: 'ex.: 192.168.0.10:8443 (vazio = este endereço)', value: S.prefs.serverUrl, autocapitalize: 'off', spellcheck: false });
  const consent = h('input', { type: 'checkbox', id: 'j-consent', checked: S.prefs.consent });
  const err = h('div', { class: 'err', role: 'alert' }, S.authError || '');
  const codeField = field('Código de acesso', code);
  const passField = field('Senha do administrador', pass);
  const consentBox = h('label', { class: 'consent' }, consent,
    h('span', null, h('b', null, 'Compartilhar minha localização. '), 'O comando verá onde você está e seu status para poder ajudar. Você pode pausar a qualquer momento em Ajustes.'));
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'ENTRAR NO ENLACE');
  const toggleAdmin = h('button', { type: 'button', class: 'linkbtn', onclick: () => { adminMode = !adminMode; sync(); } }, 'Sou administrador');

  const sync = () => {
    passField.classList.toggle('hidden', !adminMode);
    codeField.classList.toggle('hidden', adminMode || !S.info?.needsCode);
    consentBox.classList.toggle('hidden', adminMode);
    toggleAdmin.textContent = adminMode ? 'Entrar como usuário' : 'Sou administrador';
    btn.textContent = adminMode ? 'ENTRAR COMO COMANDO' : 'ENTRAR NO ENLACE';
  };
  sync();
  const offInfo = on('info', sync);

  const form = h('form', {
    class: 'panel', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!name.value.trim()) { err.textContent = 'Informe seu nome.'; name.focus(); return; }
      if (!adminMode && !consent.checked) { err.textContent = 'Para participar é preciso aceitar compartilhar a localização com o comando.'; return; }
      btn.disabled = true; btn.textContent = 'CONECTANDO…';
      try {
        setPref('serverUrl', server.value.trim());
        setPref('consent', adminMode ? S.prefs.consent : true);
        if (!adminMode) setPref('share', true);
        await join({ name: name.value, code: code.value, adminPassword: adminMode ? pass.value : '' });
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false; sync();
      }
    },
  },
    h('div', { class: 'logo' }, logoSvg(76), h('h1', null, 'ELO'), h('div', { class: 'tag' }, 'Comunicação de emergência · funciona sem internet')),
    field('Seu nome', name),
    codeField, passField, consentBox,
    h('details', { class: 'adv' }, h('summary', null, 'Opções avançadas'), field('Endereço do servidor', server, 'Só altere se o comando informar outro endereço.')),
    err, btn,
    h('div', { style: { textAlign: 'center', marginTop: '14px', fontSize: '13px' } }, toggleAdmin),
    !window.isSecureContext && h('p', { class: 'mut', style: { fontSize: '12.5px', marginTop: '14px' } }, '⚠ Conexão não segura: GPS e uso offline ficam desativados. Peça o link HTTPS ao comando.'));

  root.replaceChildren(h('div', { class: 'join' }, form));
  refreshInfo().then(() => sync());
  setTimeout(() => name.focus(), 50);
  return offInfo;
}
