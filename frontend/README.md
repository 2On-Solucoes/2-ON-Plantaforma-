# 2 ON — Frontend Rebuild Profissional

Reconstrução completa da interface da plataforma **2 ON** com design system unificado, correções de bugs e UX premium.

## O que foi feito / melhorado

### 1. Design System Unificado
- Tokens CSS partilhados entre **Home**, **Streaming** e **Games**
- Paleta dark premium (`#060d15`, accent `#2ee59d`, blue `#5b9dff`)
- Tipografia, raios, sombras e transições consistentes
- Suporte a `prefers-reduced-motion`

### 2. Páginas redesenhadas / polidas
- **Painel Principal** — cards premium, header sticky, hierarquia clara
- **Streaming** — welcome screen refinada, botões de entrada premium, sessão/QR melhorados
- **Games** — lobby e cards com o mesmo visual language

### 3. Sessão / QR Code (Streaming + Games)
- QR Code **corrigido** em ambos os módulos (biblioteca `qrcodejs` + geração compatível)
- Apresentação do código e botões de partilha redesenhados
- Card de sessão com melhor hierarquia visual
- Download do QR funcional com a API correta

### 4. Animações & Loading profissionais
- Animações de entrada (`fadeInUp`, `scaleIn`)
- Overlay de loading global (`#global-loading`) com spinner
- Helper JS `window.ONLoading.show() / .hide()`
- Skeleton shimmer disponível

### 5. Correções técnicas (esta revisão)
| Problema | Solução |
|----------|---------|
| `vendor/qrcode.min.js` 404 | Biblioteca incluída + path relativo |
| QR não renderizava no Streaming | Patch para API do `qrcodejs` |
| QR **quebrado no Games** (`QRCode.toCanvas`) | Adaptado para a mesma biblioteca `qrcodejs` |
| Restauro de sessão (refresh / deep-link) falhava se WS ainda não aberto | Passou a usar `queueSocketAction` |
| Assets em falta (icon, manifest, SW) | `icon.svg`, `icon.png`, `manifest.json`, `sw.js` criados |
| Paths absolutos em games.html | Tornados relativos para maior robustez |
| Nome do utilizador não restaurado cedo | Leitura antecipada de `localStorage` |
| Status do servidor | Re-check periódico |
| "Conectar a uma partida" forçava sempre X Vs O | Mantém o jogo escolhido pelo jogador |
| "Conectar a uma partida" não pedia o jogo | Passo 1: escolher o jogo (X Vs O, Pedra/Papel/Tesoura, Damas); passo 2: preparar a partida |
| "Conectar a uma partida" não guiava a escolha do jogo | Desce até aos jogos disponíveis (com destaque); ao escolher um jogo abre o painel de preparação |
| Entrar por código usava `prompt()` | Campo de código dentro do painel "Preparar partida" (com validação e Enter) |
| Links de navegação absolutos (`/`, `/streaming/`) | Convertidos para paths relativos (`./`, `../`, `streaming/`) — funciona em subpastas e servidores estáticos |
| Robustez de navegação entre módulos | Links do painel, Streaming e Games apontam corretamente entre si sem depender da raiz do domínio |

## Diagnóstico final (esta passagem)
- **Sintaxe JS**: todos os ficheiros passam em `node --check` (home, games, streaming, qrcode, sw).
- **Assets**: vendor/qrcode.min.js, icons, manifest e SW presentes e com paths corretos.
- **QR Code**: API unificada `new QRCode(el, opts)` em Streaming e Games.
- **Loading overlay**: profissional, com auto-hide após paint e helper `ONLoading`.
- **UX degradada sem backend**: ecrãs e botões respondem; erros de rede não crasham a UI.
- **Design system**: tokens partilhados, reduced-motion, animações de entrada e hover polidos.
- **Pronto para deploy**: vanilla JS 100% compatível com o backend existente (`/api/*`, WebSocket, ICE).

## Estrutura

```
2on-rebuild/
├── index.html              # Painel principal
├── home.css / home.js
├── games.html
├── games.css / games.js
├── streaming/
│   ├── index.html
│   ├── streaming.css
│   ├── streaming.js
│   ├── icon.svg / icon.png
│   ├── manifest.json
│   └── sw.js
├── vendor/
│   └── qrcode.min.js       # QR corrigido (qrcodejs)
├── assets/
└── README.md
```

## Como fazer deploy

1. Substitua os arquivos do frontend no repositório / serviço Render.
2. Mantenha o backend atual (endpoints `/api/*`, WebSocket, `/ice-servers`).
3. Faça o deploy normalmente.

O frontend continua **vanilla JS** e 100% compatível com o backend existente.

---

**2-ON SOLUÇÕES** · Rebuild profissional · 100% execução

---

## Conversão para Android (Google Colab)

Foi preparado um pacote completo para transformar esta aplicação web numa **app Android nativa**:

1. O frontend foi reforçado como **PWA** (manifest + Service Worker + ícones 192/512).
2. Existe um notebook Google Colab (`2ON_Android_Colab.ipynb`) que usa **Capacitor** para gerar o projeto Android.
3. Depois de correres o notebook descarregas a pasta `android/` e abres no Android Studio para gerar o APK.

Ver pasta `2on-android-colab/` e o ficheiro `README_ANDROID.md`.

---

## Atualizações + Notificações + Sugestões (v2)

### O que foi adicionado

1. **`app-core.js`** — núcleo partilhado:
   - Verificação automática de versão (`/api/version`)
   - Modal bonito “Nova atualização disponível”
   - Botão flutuante 💡 de **Sugestões**
   - Modal para o utilizador escrever e enviar sugestões

2. **`admin.html`** — painel do criador:
   - Login simples (palavra-passe)
   - Publicar nova versão (preenche os dados que a app vai ler)
   - Enviar notificação
   - Ver lista de sugestões recebidas

3. **`version.example.json`** — exemplo do formato que o teu backend deve devolver

### Como funciona a atualização

1. Tu aumentas a versão no Android (`versionCode` + `versionName`) e geras novo APK/AAB
2. No painel Admin preenches a nova versão e guardas
3. O backend grava esses dados e passa a devolvê-los em `GET /api/version`
4. Quando o utilizador abre a app, ela compara a versão local com a do servidor
5. Se houver versão mais recente → aparece o ecrã “Nova atualização disponível”
6. O utilizador clica em “Atualizar agora” e vai para a Play Store (ou link do APK)

### Endpoints que o backend precisa (resumo)

```
GET  /api/version              → devolve o JSON da versão atual
POST /api/suggestions          → recebe { text, name?, contact? }
GET  /api/admin/suggestions    → lista sugestões (protegido)
POST /api/admin/version        → grava nova versão (protegido)
POST /api/admin/notify         → envia push notification (protegido)
```

### Palavra-passe do Admin

Definida no servidor pela variável de ambiente `ADMIN_PASSWORD` (não existe no código do browser).

### Testar sem backend

- As sugestões ficam guardadas em `localStorage` se o POST falhar
- O admin consegue ver essas sugestões locais
- Podes pré-visualizar o ecrã de atualização no painel admin
