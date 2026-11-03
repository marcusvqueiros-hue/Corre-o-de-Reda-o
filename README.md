# ELO — Comunicação de Emergência (PWA offline‑first)

Chat estilo WhatsApp pensado para **queda de internet, de energia e catástrofes**, com um diferencial:
o **administrador (comando) vê num mapa onde cada pessoa está**, em tempo real, com status, bateria, trilha e alarme de **SOS**.

- **Zero dependências** (só Node.js ≥ 18). Nada de `npm install`: funciona onde não há internet.
- **PWA** instalável, abre mesmo sem rede, visual escuro/futurista.
- **Local‑first**: tudo é salvo no aparelho; mensagens e posições feitas sem sinal são enviadas sozinhas quando a conexão volta.

---

## Como a parte "offline" funciona (e o que ela NÃO é)

Um navegador **não consegue** falar de celular para celular sem uma rede em comum (não há Bluetooth/Wi‑Fi Direct em PWA).
Por isso o ELO usa a arquitetura que realmente funciona em campo:

```
 [celulares]  ──Wi‑Fi local──►  [roteador / hotspot]  ──►  [SERVIDOR ELO]  (notebook, Raspberry Pi, celular c/ Termux)
   PWA instalado                   SEM internet                node server/index.js
```

| Situação | O que acontece |
|---|---|
| Internet caiu, **Wi‑Fi local funciona** | Tudo funciona normalmente (chat, mapa, SOS). É o cenário principal. |
| Celular **fora do alcance** do Wi‑Fi | O app continua abrindo (cache), mostra o histórico, guarda mensagens e posições GPS e **sincroniza ao reconectar**. |
| Servidor **desligou** (falta de energia) | Idem acima; ao religar, os dados persistem (journal + snapshot) e todos reconectam sozinhos. |
| Nenhuma rede/aparelho servidor | Nenhum app web resolve isso. Para esse caso use rádio mesh (ex.: LoRa/Meshtastic) em complemento. |

O **GPS funciona sem internet** (satélite). O **mapa é um radar tático em canvas** (grade + anéis de distância + marcadores), que não precisa de nenhum arquivo externo. Se houver *tiles* (ver abaixo), eles aparecem ao fundo.

> **Dica de resiliência:** deixe o servidor num notebook/Raspberry com **power bank/nobreak** e um roteador a bateria. Em celular, ligue o hotspot e rode o servidor via Termux.

---

## Início rápido

```bash
node server/index.js
```

Na primeira execução o servidor imprime os endereços e **gera a senha do administrador** (anote!). Para definir a sua:

```bash
ADMIN_PASSWORD='minha-senha' ACCESS_CODE='1234' node server/index.js
```

1. No celular do administrador abra o endereço, toque em **"Sou administrador"** e entre com a senha.
2. Os demais abrem o endereço, informam o nome (e o código, se houver) e **aceitam compartilhar a localização**.

### HTTPS local (obrigatório para GPS e modo offline)

Navegadores só liberam **Service Worker** e **GPS** em HTTPS. O ELO gera automaticamente uma **autoridade certificadora local** (`data/tls/ca.pem`) e um certificado com os IPs da rede. Faça **uma vez, antes da emergência**:

1. Em cada aparelho abra `http://IP-DO-SERVIDOR:8080` → baixe e **instale o certificado** (passo a passo na própria página: Android, iPhone, Windows/macOS).
2. Abra `https://IP-DO-SERVIDOR:8443` e **instale o app** (menu do navegador → *Instalar app*).

Sem instalar o certificado ainda dá para usar o **modo básico** (`http://IP:8080/app`): o chat funciona, mas sem GPS e sem cache offline do app.

> Use **IP fixo** para o servidor (reserva de DHCP no roteador). Se o IP mudar, o servidor gera novo certificado sozinho; a CA continua a mesma, então os aparelhos seguem confiando.

### Checklist de preparação

- [ ] Servidor num aparelho com bateria/nobreak; IP fixo; `node server/index.js` iniciando junto com o boot (systemd/Termux:Boot).
- [ ] Todos instalaram o **certificado** e o **app**, e deram permissão de **localização** e **notificações**.
- [ ] Teste: desligue a internet do roteador e confirme que o chat e o mapa seguem funcionando.
- [ ] Administrador anotou a senha e o código de acesso em papel.

---

## Modo nuvem (Vercel + Supabase)

Com internet, o mesmo app roda **sem servidor próprio**: a interface fica na Vercel (HTTPS de verdade, sem instalar certificado) e as mensagens/posições ficam no Supabase.

- `public/js/config.js` aponta para o projeto Supabase. Deixe `CONFIG = {}` (ou use o servidor local, que já entrega um `config.js` vazio) para voltar ao modo local.
- O backend é `supabase/migrations/*.sql`: tabelas num schema **privado** (`elo`) e funções RPC que validam token, papel e visibilidade (DM só para os dois lados; localização só para o admin, ou todos se o admin ligar).
- Sincronização por *polling* adaptativo (2,5 s em primeiro plano, 15 s em segundo plano). Fila de envio e fila de GPS continuam funcionando: sem internet, tudo fica salvo e é enviado ao voltar.
- Senha do administrador: guardada só como hash no banco; troque em *Ajustes › Administração*.
- A chave `sb_publishable_…` é pública por projeto; a segurança está nas funções RPC (limite de tentativas na senha do admin incluído).
- **Trade-off:** o modo nuvem **precisa de internet**. Para o cenário sem internet (queda geral) use o modo servidor local.
- Testes: `node test/cloud-shim.test.js` (transporte) e `node test/e2e-cloud.js` (interface com Chromium).

## Recursos

**Para todos**
- Conversa geral, mensagens diretas, fotos (comprimidas no aparelho p/ ~100 KB), envio de localização, recibos (⏳ pendente · ✓ enviada · ✓✓ lida).
- **Botão SOS** (confirmação de 5 s) → alerta com localização para o comando e o grupo; funciona também na fila offline.
- Status rápido: *Estou bem* / *Preciso de ajuda* / *Ferido*.
- Modo economia de bateria, tela ligada, texto grande, sons/vibração/notificações.

**Para o administrador**
- **Mapa** com todos os usuários: cor por status, pulso de SOS, anel de precisão, "sem sinal" (>15 min), trilha de deslocamento, distância/rumo, filtros (Atenção/Online/Sem sinal), setas para SOS fora da tela.
- **Painel**: contadores, chamados SOS, aviso geral para todos, pedir posição de todos, bloquear pessoas.
- Canal de **Avisos do comando** (somente o admin publica), mensagem fixa no topo, código de acesso, opção de **mostrar o mapa a todos**.
- Exportação: **GeoJSON** (posições + trilhas) e **CSV** (mensagens).

---

## Mapas offline (opcional)

- Sem configuração: radar tático (100% offline).
- Com internet: tiles OpenStreetMap são exibidos e **ficam em cache** conforme você navega (somente o que foi visto). Respeite a [política de uso de tiles do OSM](https://operations.osmfoundation.org/policies/tiles/); não faça download em massa.
- Para uso offline robusto, gere/baixe tiles de uma fonte que permita e coloque em `data/tiles/{z}/{x}/{y}.png`. Eles são servidos em `/tiles/…` e têm prioridade.
- `TILE_URL=off` desativa tiles remotos; `TILE_URL=https://seu-servidor/{z}/{x}/{y}.png` usa outro provedor.

## Configuração (variáveis de ambiente)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `8443` (TLS) / `8080` | Porta HTTPS (ou HTTP se `TLS=off`) |
| `HTTP_PORT` | `8080` | Porta HTTP (página do certificado / modo básico) |
| `TLS` | `auto` | `off` desativa HTTPS (use atrás de um proxy HTTPS) |
| `ADMIN_PASSWORD` | gerada | Senha do administrador |
| `ACCESS_CODE` | vazio | Código exigido dos usuários (também editável no app) |
| `DATA_DIR` | `./data` | Dados, certificados e tiles |
| `EXTRA_IPS` / `EXTRA_HOSTS` | — | IPs/nomes extras no certificado |
| `TILE_URL` | OSM | Modelo de URL de tiles, ou `off` |

**Com internet disponível** (nuvem/VPS): `TLS=off PORT=8080 node server/index.js` atrás de Caddy/nginx com HTTPS e suporte a WebSocket em `/ws`. A mesma base de código atende a rede local e a internet.

## Privacidade e segurança

- A localização só é enviada após **consentimento explícito** na entrada; o usuário pode pausar em *Ajustes* a qualquer momento, e o app mostra o estado do GPS.
- O administrador vê **posição, bateria e status**. Mensagens diretas **não são entregues a terceiros**, mas **ficam armazenadas no servidor** (não há criptografia ponta a ponta).
- Senha de admin com `scrypt`; tokens aleatórios guardados só como hash; limite de tentativas; validação de tamanho/tipo de tudo que chega; CSP restritiva; sem `innerHTML` com dados de usuário.
- Proteja o Wi‑Fi com WPA2/WPA3 e defina um **código de acesso**. Quem tiver o endereço e o código entra.
- Os dados ficam em `data/` (não versionado). Faça backup de `data/snapshot.json`.

## Limitações conhecidas

- **Segundo plano**: celulares suspendem GPS/rede de páginas em segundo plano (principalmente iPhone). Use *Manter tela ligada* para rastreamento contínuo, ou o app aberto. Notificações do sistema só chegam enquanto o app estiver vivo (Web Push exige internet).
- Alcance = alcance do Wi‑Fi. Para áreas grandes, use mais pontos de acesso na mesma rede.
- iOS: instalar o certificado exige confirmar "confiança total" nos Ajustes.

## Estrutura

```
server/   index.js (HTTP/HTTPS, API) · ws.js (WebSocket RFC 6455) · hub.js (protocolo) · store.js (journal+snapshot) · tls.js (CA local)
public/   index.html · sw.js · manifest · css/ · js/ (state, net, db, geo, map, views…) · icons/
test/     protocol.test.js (servidor) · e2e-ui.js (interface, Chromium/Playwright)
scripts/  make-icons.js
```

## Testes

```bash
npm test                 # protocolo do servidor (sem dependências)
node test/e2e-ui.js      # interface completa com Chromium (requer Playwright instalado)
```

O teste de interface cobre: entrada (com consentimento), chat, mapa com posição, **servidor cai → app abre do cache → mensagem fica na fila → entrega sem duplicar**, SOS e painel.
