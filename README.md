# 2 ON — Sistema Completo (Frontend + Backend + Admin)

Tudo funcional num só pacote:

- **Frontend** (Home, Streaming, Games) com PWA
- **Verificação de atualizações** + ecrã “Nova atualização disponível”
- **Botão de Sugestões** (utilizador escreve → tu lês)
- **Painel Admin** para:
  - Publicar novas versões
  - Enviar notificações
  - Ler sugestões
- **Backend mínimo** em Node.js (guarda dados em JSON)

---

## Arranque rápido (local)

### 1. Requisitos
- Node.js 18+ (https://nodejs.org)

### 2. Instalar e correr

```bash
cd 2on-clean/backend
npm start          # sem dependências: não precisa de npm install
```

Abre no browser:
- App:        http://localhost:3000
- Admin:      http://localhost:3000/admin.html
- Password:   a que definires em `ADMIN_PASSWORD` (mín. 8 caracteres). Se não definires, o servidor gera uma temporária e mostra-a nos logs ao arrancar.

---

## Acesso rápido ao Admin

Na página inicial, toca **5 vezes seguidas** (em menos de 3 segundos) no canto inferior esquerdo do ecrã: abre o painel de administrador (`/admin.html`).

---

## Como enviar uma atualização do aplicativo

1. No Android Studio aumenta `versionCode` e `versionName` e gera o novo APK/AAB.
2. Publica na Play Store (ou coloca o APK online).
3. Abre o **Admin** → secção “Publicar atualização”.
4. Preenche:
   - Versão (ex: `1.1.0`)
   - Título e mensagem
   - Link da Play Store ou do APK
   - Changelog
   - (Opcional) marcar “Forçar atualização”
5. Clica **Guardar versão**.
6. Na próxima vez que os utilizadores abrirem a app, aparece o ecrã de atualização.

---

## Como funcionam as sugestões

1. O utilizador clica no botão 💡 (canto inferior direito).
2. Escreve a sugestão (+ nome/contacto opcional) e envia.
3. Tu abres o Admin → secção “Sugestões dos utilizadores” e lês tudo.

As sugestões ficam guardadas em `backend/data/suggestions.json`.

---

## Notificações

- No Admin podes registar notificações (ficam guardadas e a app pode mostrá-las).
- **Push real** (notificação no telemóvel com a app fechada) precisa de Firebase Cloud Messaging.
  - Ver secção “Firebase (opcional)” mais abaixo.

---

## Estrutura

```
2on-full/
├── frontend/               ← App web completa
│   ├── index.html
│   ├── admin.html          ← O teu painel
│   ├── app-core.js         ← Atualizações + Sugestões
│   ├── games.html / streaming/
│   └── ...
├── backend/
│   ├── server.js           ← API + serve o frontend
│   ├── package.json
│   └── data/               ← Criado automaticamente (version.json, suggestions.json…)
└── README.md
```

---

## Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/status` | Estado do servidor |
| GET | `/api/version` | Versão atual (usada pela app) |
| POST | `/api/suggestions` | Utilizador envia sugestão |
| GET | `/api/notifications` | Lista de notificações |
| POST | `/api/admin/version` | Admin grava nova versão |
| POST | `/api/admin/notify` | Admin cria notificação |
| GET | `/api/admin/suggestions` | Admin lista sugestões |
| POST | `/api/admin/suggestions/:id/read` · `/delete` | Marcar como lida / eliminar |
| POST | `/api/admin/login` · `/logout` | Sessão do Admin |

Faz login em `POST /api/admin/login` (`{"password":"…"}`) e usa o token devolvido (válido 8 h) em todas as rotas `/api/admin/*`:
```
Authorization: Bearer <token>
```

---

## Deploy (produção)

### Opção A — Render / Railway / Fly.io
1. Faz upload desta pasta.
2. Root directory: **deixa vazio** (raiz do projeto — o servidor precisa da pasta `frontend` ao lado de `backend`)
3. Build: *(vazio)*
4. Start: `npm start`  (usa o `package.json` da raiz)
5. Define `ADMIN_PASSWORD` em Environment (obrigatório) e, se quiseres dados persistentes, `DATA_DIR`.

### Opção B — VPS / qualquer servidor Node
```bash
PORT=3000 ADMIN_PASSWORD=sua-password-forte npm start
```

O frontend é servido automaticamente pelo mesmo servidor.

---

## Firebase (opcional — Push Notifications reais)

Para notificações chegarem com a app fechada:

1. Cria projeto em https://console.firebase.google.com
2. Ativa **Cloud Messaging**
3. No Capacitor adiciona o plugin `@capacitor/push-notifications`
4. No `server.js` (função de notify) chama a API do FCM com a server key

Posso preparar o código Firebase completo se precisares.

---

## Android (Capacitor)

Usa o notebook Colab ou o projeto Capacitor que já preparamos anteriormente.
Aponta o `server.url` do Capacitor para o URL do teu backend em produção, ou deixa os ficheiros locais e as chamadas `/api/*` vão para o domínio onde a app está alojada.

---

## Segurança

- **Muda a palavra-passe** do admin (`ADMIN_PASSWORD` no ambiente ou no código).
- Em produção usa HTTPS.
- O painel admin tem `noindex` e fica atrás de password.

---

**2-ON SOLUÇÕES** · Sistema completo e funcional


---

## Correções desta versão

- **Servidor sem dependências:** `server.js` usa só módulos nativos do Node 18+ (já não depende de `express`, `cors` nem `body-parser`).
- **"Not found" / erros de rota:** rotas `/api/*` inexistentes devolvem JSON 404 (antes devolviam a página HTML); `/streaming` redireciona para `/streaming/`; `/admin` abre o painel; adicionados `/ice-servers` e `/health`.
- **Segurança:** palavra-passe do Admin validada no servidor (já não está no código do browser); proteção contra acesso a ficheiros fora de `frontend/`; limite de pedidos em login e sugestões.
- **Sugestões offline:** as sugestões guardadas sem ligação agora são reenviadas automaticamente.
- **Service worker:** páginas carregam da rede primeiro (já não ficam presas numa versão antiga); a API nunca passa pela cache.
- **Atalho para o Admin:** toca 10 vezes seguidas (intervalo máximo de 2 s entre toques) na marca **2·ON** do Painel principal para abrir o painel administrativo. A palavra-passe continua a ser pedida.
- **Limitação:** este backend não inclui multiplayer em tempo real (salas, WebSocket). Games e Streaming abrem, mas criar/entrar em salas precisa de um backend com WebSocket.


## Segurança

**Variáveis de ambiente (Render → Environment):**

| Variável | Para quê |
|---|---|
| `ADMIN_PASSWORD` | Palavra-passe do Admin (**obrigatória em produção**, mín. 8 caracteres) |
| `DATA_DIR` | Pasta dos dados. No Render o disco é efémero: monta um *Persistent Disk* e aponta para ele (ex.: `/var/data`) |
| `TRUST_PROXY_HOPS` | Nº de proxies à frente do servidor (Render: `1`, já é o valor por defeito se `RENDER` existir). Necessário para o limite de pedidos por IP |
| `ALLOWED_ORIGINS` | Origens extra autorizadas a chamar a API (separadas por vírgula). `capacitor://localhost` e `https://localhost` já vêm incluídas. O Admin nunca aceita CORS |
| `RETENTION_DAYS` | Dias até apagar sugestões antigas (por defeito 180) |
| `FORCE_HTTPS=1` | Redireciona HTTP → HTTPS |
| `DISABLE_CSP=1` | Desliga a Content-Security-Policy (só se algo legítimo for bloqueado) |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | TURN próprio para o Streaming (ou `TURN_SECRET` para credenciais temporárias coturn) |

**Notas:**
- O servidor de multiplayer (salas, WebSocket) não faz parte deste pacote. Ele **tem de validar** no servidor o código da sala, o papel (host/viewer) e todas as mensagens — o cliente não é de confiança.
- Sem TURN configurado, o Streaming usa só STUN (pode falhar atrás de alguns NATs/redes móveis).
- A pasta `preview/` é só uma demonstração com backend simulado: **não a publiques** junto com o site.


## Jogos (2-ON GAMES)

**Arquitetura:** o servidor é a autoridade — o cliente só envia intenções (`game-move`, `game-create`…) e o servidor valida tudo.

| Ficheiro | Função |
|---|---|
| `backend/game-engine.js` | Regras puras: X Vs O, Damas (captura obrigatória, capturas múltiplas, damas ♛, empate por 50 lances) e Pedra-Papel-Tesoura |
| `backend/games.js` | WebSocket (RFC 6455 sem dependências), salas, reconexão (30 s), tempo de jogada (30 s, 3 falhas seguidas = derrota), espectadores, chat, sinalização de voz, ranking/perfil |
| `frontend/games.js` | Interface: heartbeat, reconexão automática, efeitos (sons/vibração/confetis), destaques, tabuleiro virado para as pretas |

**Ligação:** o cliente envia `ping` a cada 15 s e reconecta se não houver `pong` em 45 s; reconecta ao voltar à aba, ao recuperar a internet e ao regressar do histórico. Jogadas feitas offline **não** ficam em fila (ficariam obsoletas). O servidor ignora ações repetidas (`actionId`) e fecha ligações com origem não autorizada, mensagens gigantes ou inundação.

**Testes** (`npm test`; precisam só de Node 18+):
- `backend/test/engine.test.js` — regras dos 3 jogos
- `backend/test/games.test.js` — ponta a ponta por WebSocket (salas, reconexão, chat, voz, segurança)
- `backend/test/timing.test.js` — tempo de jogada e tolerância de reconexão
- `backend/test/e2e.test.js` — browser real (Chromium) com dois jogadores; requer `npm i playwright` (`npm run test:e2e`)

**Ainda não incluído:** campeonatos (criar/entrar/chaves). As rotas respondem 503 com mensagem clara e a lista aparece vazia.


## Painel principal

Ficheiros: `frontend/index.html` · `home.css` · `home.js` (inspirado no modelo `pat-ii-landing.html`, com as **cores originais** da 2-ON SOLUÇÕES).

**CSS (`home.css`)** — organizado em 8 camadas: tokens de design → reset → layout → componentes (BEM) → animações → estados de JS → responsivo → preferências do utilizador. Cores: azul-marinho `#060d15`, verde `#2ee59d` (Games), azul `#5b9dff` (Streaming).

**JavaScript (`home.js`)** — módulos isolados (`ServerStatus`, `Navigation`, `ScrollProgress`, `Reveal`, `PointerEffects`, `PageVisibility`, `SuggestionCta`, `AdminGesture`); sem variáveis globais; ganchos por `data-*`; se um módulo falhar, os outros continuam.

**Animações** — só `transform`/`opacity`/`stroke-dashoffset`; revelar ao rolar com atraso escalonado; pausa em segundo plano; desligadas com "movimento reduzido"; sem JavaScript todo o conteúdo fica visível.

**Testes do painel:** `node backend/test/home.test.js` (cores, contraste WCAG, animações, acessibilidade, responsivo, sem JS, movimento reduzido).

Acesso secreto ao Admin: 5 toques seguidos (em menos de 3 s) no canto inferior esquerdo da página inicial.


## 2 ON Streaming (reestruturado)

**Fluxo do lobby:** escolha (Criar sessão | Entrar com código) → **só** o painel escolhido, com botão **Voltar ao Streaming** (também funciona com Escape e com o botão "voltar" do Android/navegador). Links de convite (`?room=…&role=viewer`) abrem "Entrar" com o código preenchido e pedem o nome.

**Ficheiros (`frontend/streaming/`):**

| Ficheiro | Responsabilidade |
|---|---|
| `index.html` | Marcação semântica; ganchos `data-lobby-*` |
| `lobby.js` | Só a interface do lobby: vistas, validação, foco, histórico. Não conhece a rede |
| `streaming.js` | Rede e sessão (WebSocket, WebRTC, YouTube, chat, voz) |
| `ui.js` | Pausa as animações quando o separador está em segundo plano |
| `streaming.css` | Tokens → base → layout → primitivas → lobby → sessão → chat → animações/responsivo/preferências |

**Contrato entre `lobby.js` e `streaming.js` (eventos no `document`):** `lobby:create {name}`, `lobby:join {name, code}` (emitidos); `lobby:error {message}`, `lobby:reset`, `lobby:show {view, code}` (recebidos).

**Redundâncias eliminadas:** ecrãs de boas-vindas + início fundidos num lobby; link duplicado para o painel; tagline repetida; código da sala mostrado 3×; controlo de volume e botão "Instalar" duplicados; logótipo em imagem (que podia falhar) trocado por marca em texto; CSS de 1134 linhas com regras repetidas e estilos globais substituído por um sistema único (`.btn`, `.field`, `.panel`).

**Testes:** `node backend/test/streaming.test.js` (fluxo do lobby com servidor de salas simulado, redundâncias, paleta, contraste, animações, responsivo, sem JS, movimento reduzido).


## 2-ON GAMES

Marca normalizada (`2·ON` em gradiente + "Games"), igual à do painel e do Streaming. O cliente já inclui heartbeat, reconexão (online/visibilidade/pageshow), relógio sincronizado com o servidor, Damas com peças jogáveis destacadas e tabuleiro virado para as pretas, e efeitos de som/vibração com botão 🔊 (preferência `2on_muted`).

**Testes:** `node backend/test/games-ui.test.js` (interface e partida real entre dois jogadores), `games.test.js` (protocolo), `engine.test.js` (regras), `timing.test.js` (tempos e reconexão), `e2e.test.js` (browser completo).
