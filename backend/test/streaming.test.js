/* Testes do Streaming: fluxo do lobby, redundâncias, CSS/JS e responsivo (browser real + servidor de salas simulado). */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');

const FE = path.join(__dirname, '..', '..', 'frontend', 'streaming');
const PORT = 5600 + Math.floor(Math.random() * 300), BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(c ? '  ✓' : '  ✗ FALHOU:', n); };
const section = t => console.log('\n● ' + t);

/* O backend deste pacote não tem salas de Streaming → simulamos o servidor no browser. */
const FAKE_SERVER = () => {
  window.__sent = [];
  window.WebSocket = class extends EventTarget {
    constructor() { super(); this.readyState = 0; setTimeout(() => { this.readyState = 1; const e = new Event('open'); this.onopen && this.onopen(e); this.dispatchEvent(e); }, 15); }
    send(raw) {
      const m = JSON.parse(raw); window.__sent.push(m);
      const reply = o => setTimeout(() => { const e = new MessageEvent('message', { data: JSON.stringify(o) }); this.onmessage && this.onmessage(e); this.dispatchEvent(e); }, 40);
      if (m.type === 'session-auth') reply({ type: 'session-ready' });
      else if (m.type === 'create-room') reply({ type: 'room-created', code: 'K7M2Q', hostName: m.name, hasViewer: false });
      else if (m.type === 'join-room') m.code === 'ZZZZZ' ? reply({ type: 'error', message: 'Sala não encontrada. Confirma o código.' }) : reply({ type: 'room-joined', code: m.code, hostName: 'Ana', viewerName: m.name, hasViewer: true });
      else if (m.type === 'rejoin-room') reply({ type: 'error', expired: true, message: 'A sessão expirou.' });
      else if (m.type === 'leave-room') reply({ type: 'left-room' });
    }
    close() { this.readyState = 3; }
  };
  window.WebSocket.OPEN = 1;
};

const hex = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(x => x + x).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lum = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

(async () => {
  const css = fs.readFileSync(path.join(FE, 'streaming.css'), 'utf8');
  const html = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(FE, 'streaming.js'), 'utf8');
  const tok = n => (css.match(new RegExp('--' + n + ':\\s*(#[0-9a-fA-F]{3,6})')) || [])[1];

  section('Estrutura e redundâncias (código)');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  ok(new Set(ids).size === ids.length, 'ids únicos no HTML');
  ok(!html.includes('screen-welcome') && !html.includes('screen-home'), 'ecrãs duplicados (boas-vindas + início) eliminados → um só lobby');
  ok(!/call-volume-row|host-stage-code|viewer-stage-code|host-install-quick/.test(html + js), 'controlos duplicados removidos (volume, código da sala, instalar)');
  ok(!/<img\b[^>]*icon\.svg/.test(html), 'sem imagem do logótipo (marca em texto, não quebra)');
  ok((html.match(/href="\.\.\/index\.html"/g) || []).length === 1, 'um único link para o painel (antes: marca + botão)');
  ok(!/style="/.test(html), 'sem estilos inline no HTML');
  ok(!/Vê o mesmo vídeo, ao mesmo tempo, em telefones diferentes<\/p>\s*<\/header>/.test(html), 'tagline repetida no cabeçalho removida');
  const used = new Set([...js.matchAll(/getElementById\(\s*['"]([\w-]+)['"]/g)].map(m => m[1]));
  const dyn = new Set([...js.matchAll(/\.id\s*=\s*['"]([^'"]+)/g)].map(m => m[1]).concat(['qr-code']));
  const miss = [...used].filter(i => !ids.includes(i) && !dyn.has(i));
  ok(miss.length === 0, 'todo getElementById do JS existe no HTML' + (miss.length ? ' (faltam: ' + miss + ')' : ''));
  const classes = new Set(); for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c => classes.add(c));
  const selText = [...css.matchAll(/([^{}]+)\{/g)].map(m => m[1]).join(' ');
  const NO_RULE_OK = new Set(['action-btn', 'action-btn-accent', 'dots', 'choice-card--blue', 'icon', 'js']);
  const norule = [...classes].filter(c => !NO_RULE_OK.has(c) && !new RegExp('\\.' + c.replace(/[-_]/g, m => '\\' + m) + '(?![\\w-])').test(selText));
  ok(norule.length === 0, 'toda a classe do HTML tem regra no CSS' + (norule.length ? ' (sem regra: ' + norule + ')' : ''));

  section('Cores originais, contraste e animações (CSS)');
  const ORIGINAL = ['#060d15', '#0a1520', '#0f1c2a', '#142433', '#1a2d40', '#f4f7fb', '#c5d0de', '#8b9cb3', '#2ee59d', '#03150f', '#5b9dff', '#04101f', '#ff6b7a', '#ffc14d', '#b4c2d6', '#a78bfa', '#000', '#fff'];
  const foreign = [...new Set((css.match(/#[0-9a-fA-F]{3,6}\b/g) || []).map(s => s.toLowerCase()))].filter(c => !ORIGINAL.includes(c));
  ok(foreign.length === 0, 'só cores da paleta original' + (foreign.length ? ' (fora: ' + foreign + ')' : ''));
  for (const [fg, bg] of [['ink', 'bg'], ['ink-secondary', 'bg'], ['muted', 'bg'], ['muted', 'surface'], ['blue-ink', 'blue'], ['accent-ink', 'accent'], ['blue', 'surface'], ['accent', 'surface'], ['danger', 'surface']]) {
    const r = contrast(tok(fg), tok(bg)); ok(r >= 4.5, `contraste ${fg}/${bg}: ${r.toFixed(1)}:1`);
  }
  const ALLOWED = new Set(['transform', 'opacity', 'translate', 'scale']);
  const kfs = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  ok(kfs.length >= 8, kfs.length + ' @keyframes');
  for (const [, n, body] of kfs) { const bad = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]).filter(p => !ALLOWED.has(p)); ok(bad.length === 0, `@keyframes ${n} só usa transform/opacity` + (bad.length ? ' ✗ ' + bad : '')); }
  const imp = css.split('\n').filter(l => l.includes('!important'));
  ok(imp.length <= 4 && imp.every(l => /animation-play-state|animation:|transition:|scroll-behavior/.test(l)), '!important só para pausar/desligar animações (' + imp.length + ' linhas)');
  const btnRule = (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/(?:^|\n)button\s*\{([^}]*)\}/) || [])[1] || '';
  ok(!/padding|radius|shadow|text-transform|letter-spacing|background:\s*var/.test(btnRule), '<button> global é só reset (o visual vem do sistema .btn)');

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: data, ADMIN_PASSWORD: 'SenhaForte123' }, stdio: 'ignore' });
  await sleep(1200);
  const browser = await chromium.launch();
  const problems = [];
  const watch = (p, l) => {
    p.on('pageerror', e => problems.push(`${l} pageerror: ${e.message}`));
    p.on('console', m => { const t = m.text(); if ((m.type() === 'error' || /Content Security Policy|Refused to/i.test(t)) && !/ERR_NAME_NOT_RESOLVED|ERR_INTERNET|fonts\.g|Failed to load resource/i.test(t)) problems.push(`${l} console: ${t.slice(0, 140)}`); });
  };
  const newPage = async (opts = {}, setup) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...opts });
    await ctx.addInitScript(FAKE_SERVER); if (setup) await ctx.addInitScript(setup);
    const p = await ctx.newPage(); watch(p, 'streaming'); return { ctx, p };
  };
  const visibleViews = p => p.evaluate(() => [...document.querySelectorAll('[data-lobby-view]')].filter(v => !v.hidden).map(v => v.dataset.lobbyView));
  const shot = (p, n) => p.screenshot({ path: path.join(process.env.SHOTS || '/tmp', n + '.png') });

  try {
    section('Lobby: escolher → criar | entrar');
    let { ctx, p } = await newPage();
    await p.goto(BASE + '/streaming/', { waitUntil: 'load' }); await sleep(900);
    ok(JSON.stringify(await visibleViews(p)) === '["choose"]', 'início: só a escolha (dois cartões)');
    ok((await p.$$('.choice-card')).length === 2 && (await p.$$('.back-btn:visible')).length === 0, 'dois cartões e nenhum botão "Voltar" na escolha');
    await shot(p, 'st-choose');
    await p.click('[data-lobby-go="create"]'); await sleep(450);
    ok(JSON.stringify(await visibleViews(p)) === '["create"]', '"Criar sessão" mostra APENAS o painel de criar');
    ok(await p.isVisible('#host-name') && !(await p.isVisible('#viewer-name')) && !(await p.isVisible('#input-code')), 'campo do nome visível; campos de entrar escondidos');
    ok(await p.isVisible('[data-lobby-view="create"] .back-btn'), 'botão "Voltar ao Streaming" presente');
    ok(await p.evaluate(() => location.hash) === '#criar', 'o endereço passa a #criar');
    await sleep(100); ok(await p.evaluate(() => document.activeElement.id) === 'host-name', 'foco no campo do nome');
    await shot(p, 'st-create');
    await p.click('[data-lobby-view="create"] .back-btn'); await sleep(400);
    ok(JSON.stringify(await visibleViews(p)) === '["choose"]', '"Voltar" regressa à escolha');
    ok(await p.evaluate(() => document.activeElement.dataset.lobbyGo) === 'create', 'foco devolvido ao cartão de onde saiu');
    await p.click('[data-lobby-go="join"]'); await sleep(450);
    ok(JSON.stringify(await visibleViews(p)) === '["join"]', '"Entrar com código" mostra APENAS o painel de entrar');
    ok(await p.isVisible('#input-code') && await p.isVisible('#viewer-name') && !(await p.isVisible('#host-name')), 'campos de entrar visíveis; campo de criar escondido');
    await shot(p, 'st-join');
    await p.click('#btn-join'); await sleep(200);
    ok(/nome/.test(await p.textContent('#error-join')), 'validação: pede o nome primeiro');
    await p.fill('#viewer-name', 'Beto'); await p.click('#btn-join'); await sleep(200);
    ok(/5 letras/.test(await p.textContent('#error-join')) && await p.getAttribute('#input-code', 'aria-invalid') === 'true', 'validação: pede o código de 5 caracteres (campo marcado inválido)');
    await p.fill('#input-code', 'ab-c1d2efg'); ok(await p.inputValue('#input-code') === 'ABC1D', 'código: maiúsculas, só letras/números, máx. 5');
    await p.keyboard.press('Escape'); await sleep(350);
    ok(JSON.stringify(await visibleViews(p)) === '["choose"]', 'Escape volta à escolha');
    await p.click('[data-lobby-go="create"]'); await sleep(350);
    await p.goBack(); await sleep(350);
    ok(JSON.stringify(await visibleViews(p)) === '["choose"]', 'botão "voltar" do browser/Android volta à escolha (não sai do Streaming)');
    ok((await p.evaluate(() => location.pathname)) === '/streaming/', 'continua no Streaming');
    await ctx.close();

    section('Criar sessão → sala → sair');
    ({ ctx, p } = await newPage());
    await p.goto(BASE + '/streaming/', { waitUntil: 'load' }); await sleep(700);
    await p.click('[data-lobby-go="create"]'); await sleep(300);
    await p.click('#btn-create'); await sleep(150);
    ok(/nome/.test(await p.textContent('#error-create')), 'criar sem nome: erro claro');
    await p.fill('#host-name', '  Tomás   Silva '); await p.click('#btn-create');
    ok(await p.getAttribute('#btn-create', 'aria-busy') === 'true' && (await p.textContent('#btn-create')).includes('A criar'), 'botão mostra "A criar…" enquanto espera');
    await p.waitForSelector('#screen-host.active', { timeout: 3000 }); await sleep(500);
    ok(await p.evaluate(() => !document.getElementById('screen-lobby').classList.contains('active')), 'o lobby desaparece quando a sala abre');
    ok((await p.textContent('#room-code')) === 'K7M2Q' && (await p.textContent('#topbar-room-code')) === 'K7M2Q', 'código K7M2Q mostrado (cartão + etiqueta do topo)');
    ok((await p.evaluate(() => window.__sent.find(m => m.type === 'create-room').name)) === 'Tomás Silva', 'nome limpo (espaços normalizados) enviado ao servidor');
    ok(await p.isVisible('#topbar-room-chip'), 'etiqueta da sala visível no cabeçalho');
    await shot(p, 'st-host');
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.click('[data-action="leave"]'); await sleep(900);
    ok(await p.evaluate(() => document.getElementById('screen-lobby').classList.contains('active')) && JSON.stringify(await visibleViews(p)) === '["choose"]', 'sair da sala devolve à escolha do lobby');
    ok(!(await p.isVisible('#topbar-room-chip')), 'etiqueta da sala escondida');
    await p.click('[data-lobby-go="create"]'); await sleep(300);
    ok(await p.inputValue('#host-name') === 'Tomás Silva', 'nome lembrado no próximo uso');
    await ctx.close();

    section('Entrar: erro do servidor e sucesso');
    ({ ctx, p } = await newPage());
    await p.goto(BASE + '/streaming/', { waitUntil: 'load' }); await sleep(700);
    await p.click('[data-lobby-go="join"]'); await sleep(300);
    await p.fill('#viewer-name', 'Beto'); await p.fill('#input-code', 'ZZZZZ'); await p.click('#btn-join');
    await p.waitForFunction(() => document.getElementById('error-join').textContent.length > 0, null, { timeout: 3000 });
    ok(/Sala não encontrada/.test(await p.textContent('#error-join')), 'código inexistente: erro do servidor aparece no painel');
    ok(await p.getAttribute('#btn-join', 'aria-busy') === 'false' && !(await p.isDisabled('#btn-join')), 'botão volta a estar disponível');
    ok(JSON.stringify(await visibleViews(p)) === '["join"]', 'continua no painel de entrar');
    await p.fill('#input-code', 'k7m2q'); await p.keyboard.press('Enter');
    await p.waitForSelector('#screen-viewer.active', { timeout: 3000 }); await sleep(400);
    ok((await p.textContent('#viewer-code')).trim() === 'K7M2Q', 'Enter submete e entra na sala');
    await shot(p, 'st-viewer');
    await ctx.close();

    section('Link de convite');
    ({ ctx, p } = await newPage());
    await p.goto(BASE + '/streaming/?room=K7M2Q&role=viewer', { waitUntil: 'load' }); await sleep(900);
    ok(JSON.stringify(await visibleViews(p)) === '["join"]' && (await p.inputValue('#input-code')) === 'K7M2Q', 'link de convite abre "Entrar" com o código já preenchido');
    ok(!(await p.evaluate(() => window.__sent.some(m => m.type === 'join-room' || m.type === 'rejoin-room'))), 'não entra sozinho como "Tu": pede o nome primeiro');
    ok(!(await p.evaluate(() => location.search)).includes('room='), 'endereço limpo (sem room=…)');
    await ctx.close();
    ({ ctx, p } = await newPage({}, () => { try { localStorage.setItem('assistir_juntos_session_v1', JSON.stringify({ code: 'K7M2Q', role: 'viewer' })); } catch {} }));
    await p.goto(BASE + '/streaming/?room=K7M2Q&role=viewer', { waitUntil: 'load' }); await sleep(900);
    ok(await p.evaluate(() => window.__sent.some(m => m.type === 'rejoin-room')), 'com sessão guardada nessa sala (recarregar), volta a entrar automaticamente');
    await ctx.close();

    section('Responsivo (todas as vistas, sem scroll horizontal)');
    for (const w of [320, 390, 768, 1280]) {
      const c = await newPage({ viewport: { width: w, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
      await c.p.goto(BASE + '/streaming/', { waitUntil: 'load' }); await sleep(500);
      const res = [];
      for (const v of ['choose', 'create', 'join']) {
        if (v !== 'choose') { await c.p.evaluate(x => document.querySelector(`[data-lobby-go="${x}"]`) || 0, v); await c.p.evaluate(() => document.dispatchEvent(new CustomEvent('lobby:reset'))); await c.p.evaluate(x => document.dispatchEvent(new CustomEvent('lobby:show', { detail: { view: x } })), v); }
        await sleep(200);
        res.push(await c.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      }
      ok(res.every(Boolean), `largura ${w}px: escolha, criar e entrar`);
      await c.ctx.close();
    }

    section('Movimento reduzido e sem JavaScript');
    ({ ctx, p } = await newPage({ reducedMotion: 'reduce' }));
    await p.goto(BASE + '/streaming/', { waitUntil: 'load' }); await sleep(500);
    ok((await p.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)) === 0, 'nenhuma animação ativa com "movimento reduzido"');
    await ctx.close();
    const nj = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false }); const np = await nj.newPage();
    await np.goto(BASE + '/streaming/', { waitUntil: 'load' }); await sleep(500);
    ok(await np.isVisible('.choice-card--green') && await np.isVisible('.lobby-intro__title'), 'sem JavaScript o lobby continua legível');
    await nj.close();

    section('Animações em execução');
    ({ ctx, p } = await newPage({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }));
    await p.goto(BASE + '/streaming/', { waitUntil: 'load' }); await sleep(900);
    const names = await p.evaluate(() => [...new Set(document.getAnimations().map(a => a.animationName).filter(Boolean))]);
    ok(['rise', 'drift-a', 'drift-b'].every(n => names.includes(n)), 'entrada e luzes de fundo animadas: ' + names.join(', '));
    await shot(p, 'st-desktop'); await ctx.close();
  } catch (e) { fail++; console.log('  ✗ ERRO:', e.message); }

  section('Consola');
  ok(problems.length === 0, 'sem erros de JavaScript nem violações de CSP'); if (problems.length) console.log(problems.join('\n'));
  await browser.close(); srv.kill(); fs.rmSync(data, { recursive: true, force: true });
  console.log(`\nResultado: ${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
