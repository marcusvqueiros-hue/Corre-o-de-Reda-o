import { h, ic, add, ago, fmtCoord, download } from './util.js';
import { S, on, emit, setPref, setStatus, rename, admin, logout, exportFile, net } from './state.js';
import { field, toggleRow, toast, confirmDialog } from './ui.js';
import * as geo from './geo.js';
import { db } from './db.js';
import { cloud, backend } from './supa.js';

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; emit('installable'); });
window.addEventListener('appinstalled', () => { installEvt = null; emit('installable'); });

const GEO_TXT = {
  idle: 'Compartilhamento desligado', on: 'GPS ativo', searching: 'Procurando sinal de GPS…',
  denied: 'Bloqueado: libere a localização nas permissões do navegador', unavailable: 'Este aparelho não tem GPS',
  insecure: 'GPS exige HTTPS — abra o endereço seguro do servidor',
};

export function renderSettings(root) {
  const isAdmin = S.me.role === 'admin';
  const page = h('div', { class: 'page narrow' });
  root.replaceChildren(page);

  const name = h('input', { class: 'input', value: S.me.name, maxLength: 40, 'aria-label': 'Seu nome' });
  const geoInfo = h('small', { class: 'mut' });
  const cfgBox = h('div');
  const swInfo = h('small', { class: 'mut' }, 'verificando…');

  function drawGeo() {
    const loc = S.myLoc;
    geoInfo.textContent = `${GEO_TXT[S.geoState] || ''}${loc ? ` · ${fmtCoord(loc.lat, loc.lng)} ±${loc.acc} m · há ${ago(loc.ts)}` : ''}${S.locQueued ? ` · ${S.locQueued} pontos na fila` : ''}`;
  }
  drawGeo();

  const install = h('div');
  function drawInstall() {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    install.replaceChildren(standalone ? h('small', { class: 'mut' }, '✓ Instalado neste aparelho') :
      installEvt ? h('button', { class: 'btn primary block', onclick: async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; drawInstall(); } }, ic('download', 18), 'Instalar o app')
        : h('small', { class: 'mut' }, /iphone|ipad/i.test(navigator.userAgent) ? 'No iPhone: toque em Compartilhar › "Adicionar à Tela de Início".' : 'Use o menu do navegador › "Instalar app" / "Adicionar à tela inicial".'));
  }
  drawInstall();

  navigator.serviceWorker?.getRegistration().then(async (r) => {
    const keys = await caches.keys().catch(() => []);
    swInfo.textContent = r?.active && keys.length ? '✓ Pronto para uso offline' : window.isSecureContext ? 'Preparando cache offline… reabra o app em alguns segundos' : '⚠ Offline indisponível (sem HTTPS)';
  });

  const adminCard = isAdmin && (() => {
    const code = h('input', { class: 'input', value: S.settings.accessCode || '', placeholder: 'vazio = qualquer pessoa pode entrar', maxLength: 40 });
    const group = h('input', { class: 'input', value: S.settings.groupName || 'Geral', maxLength: 30 });
    const pw = h('input', { class: 'input', type: 'password', placeholder: 'Nova senha (mín. 8 caracteres)', autocomplete: 'new-password', maxLength: 72 });
    const motd = h('textarea', { class: 'input', rows: 2, value: S.settings.motd || '', placeholder: 'Mensagem fixa exibida a todos no topo do app', maxLength: 280 });
    return h('div', null, h('div', { class: 'h-sec' }, 'Administração'),
      h('div', { class: 'card' },
        toggleRow('Mapa visível para todos', 'Se ligado, todos veem a posição dos outros. Desligado: só o comando vê.', !!S.settings.shareMap, (v) => admin('setting', { shareMap: v })),
        field('Código de acesso', code), field('Nome do grupo geral', group), field('Mensagem fixa', motd),
        h('button', { class: 'btn primary', onclick: () => { admin('setting', { accessCode: code.value, groupName: group.value, motd: motd.value }); toast('Configurações salvas', 'ok'); } }, 'Salvar'),
        cloud && h('div', { class: 'h-sec', style: { marginTop: '18px' } }, 'Senha do administrador'),
        cloud && h('div', { class: 'row-actions', style: { flexWrap: 'nowrap' } }, pw, h('button', { class: 'btn', onclick: async () => {
          if (pw.value.length < 8) return toast('Use ao menos 8 caracteres', 'err');
          try { await backend.setAdminPassword(S.session.token, pw.value); pw.value = ''; toast('Senha alterada', 'ok'); } catch (e) { toast('Não foi possível alterar a senha', 'err'); }
        } }, 'Alterar')),
        h('div', { class: 'h-sec', style: { marginTop: '18px' } }, 'Exportar dados'),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn', onclick: () => exp('geojson') }, ic('download', 18), 'Posições (GeoJSON)'),
          h('button', { class: 'btn', onclick: () => exp('csv') }, ic('download', 18), 'Mensagens (CSV)'))));
  })();
  async function exp(kind) {
    try { download(kind === 'geojson' ? 'elo-posicoes.geojson' : 'elo-mensagens.csv', await exportFile(kind)); } catch (e) { toast(e.message, 'err'); }
  }

  add(page,
    h('div', { class: 'h-sec', style: { marginTop: 0 } }, 'Perfil'),
    h('div', { class: 'card' },
      field('Nome', h('div', { class: 'row-actions', style: { flexWrap: 'nowrap' } }, name, h('button', { class: 'btn', onclick: () => { if (name.value.trim()) { rename(name.value); toast('Nome atualizado', 'ok'); } } }, 'Salvar'))),
      h('small', { class: 'mut' }, isAdmin ? 'Você é administrador (comando).' : 'Você é participante.')),

    h('div', { class: 'h-sec' }, 'Localização'),
    h('div', { class: 'card' },
      toggleRow('Compartilhar minha localização', 'O comando vê onde você está. Funciona mesmo sem rede: os pontos são enviados quando o sinal voltar.', S.prefs.share, (v) => { setPref('share', v); if (v) setPref('consent', true); }),
      toggleRow('Modo economia de bateria', 'GPS menos frequente (a cada ~90 s) e animações reduzidas.', S.prefs.saver, (v) => setPref('saver', v)),
      toggleRow('Manter tela ligada', 'Evita que o GPS pare em segundo plano. Gasta mais bateria.', S.prefs.wake, (v) => setPref('wake', v)),
      geoInfo),

    h('div', { class: 'h-sec' }, 'Alertas'),
    h('div', { class: 'card' },
      toggleRow('Sons', 'Aviso sonoro de mensagens e SOS.', S.prefs.sound, (v) => setPref('sound', v)),
      toggleRow('Vibração', null, S.prefs.vibrate, (v) => setPref('vibrate', v)),
      toggleRow('Notificações', 'Avisos com o app em segundo plano (enquanto estiver aberto no aparelho).', S.prefs.notif && 'Notification' in window && Notification.permission === 'granted', async (v) => {
        if (v && 'Notification' in window && Notification.permission !== 'granted') { const r = await Notification.requestPermission(); setPref('notif', r === 'granted'); if (r !== 'granted') toast('Permissão negada pelo navegador'); }
        else setPref('notif', v);
      })),

    adminCard,

    h('div', { class: 'h-sec' }, 'Aplicativo'),
    h('div', { class: 'card' }, install, h('div', { style: { height: '10px' } }), swInfo,
      toggleRow('Texto grande', 'Facilita a leitura em situações de estresse.', S.prefs.large, (v) => { setPref('large', v); document.documentElement.classList.toggle('large', v); }),
      h('div', { class: 'setting' }, h('div', { class: 't' }, h('b', null, 'Armazenamento seguro'), h('small', null, 'Pede ao navegador para não apagar o histórico salvo.')),
        h('button', { class: 'btn sm', onclick: async () => { const ok = navigator.storage?.persist ? await navigator.storage.persist() : false; toast(ok ? 'Armazenamento protegido' : 'O navegador não concedeu (o histórico continua salvo normalmente)'); } }, 'Ativar'))),

    h('div', { class: 'h-sec' }, 'Sessão'),
    h('div', { class: 'card' },
      h('p', { class: 'mut', style: { margin: '0 0 12px', fontSize: '13px' } }, 'O servidor guarda mensagens e posições. O administrador pode ver sua localização e status; conversas diretas não são entregues a outras pessoas, mas ficam armazenadas no servidor.'),
      h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog({ title: 'Sair deste aparelho?', text: 'O histórico salvo aqui será apagado. Mensagens ainda na fila serão perdidas.', ok: 'Sair', danger: true })) { geo.stop(); logout(true); } } }, ic('logout', 18), 'Sair e apagar dados locais')),
    h('p', { class: 'mut mono', style: { textAlign: 'center', fontSize: '10px', marginTop: '22px' } }, `ELO v${S.info?.version || '1.0.0'} · ${db.persistent ? 'armazenamento local ativo' : 'armazenamento temporário'}`));

  const offs = [on('myloc', drawGeo), on('outbox', drawGeo), on('installable', drawInstall)];
  return () => offs.forEach((f) => f());
}
