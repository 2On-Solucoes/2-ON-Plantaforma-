/* Testes do painel principal (frontend/index.html + home.css + home.js) num browser real. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');

const FE = path.join(__dirname, '..', '..', 'frontend');
const PORT = 5200 + Math.floor(Math.random() * 300), BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(c ? '  ✓' : '  ✗ FALHOU:', n); };
const section = t => console.log('\n● ' + t);

/* --- utilitários de cor (WCAG) --- */
const hex = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(x => x + x).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lum = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

(async () => {
  const css = fs.readFileSync(path.join(FE, 'home.css'), 'utf8');
  const html = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
  const tok = name => (css.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{3,6})')) || [])[1];

  section('Paleta original da 2-ON SOLUÇÕES');
  const ORIGINAL = ['#060d15', '#0a1520', '#0f1c2a', '#142433', '#1a2d40', '#f4f7fb', '#c5d0de', '#8b9cb3', '#2ee59d', '#03150f', '#5b9dff', '#04101f', '#ff6b7a', '#b4c2d6', '#fff', '#000'];
  const used = [...new Set((css.match(/#[0-9a-fA-F]{3,6}\b/g) || []).map(s => s.toLowerCase()))];
  const foreign = used.filter(c => !ORIGINAL.includes(c));
  ok(foreign.length === 0, 'só usa cores da paleta original' + (foreign.length ? ' (fora da paleta: ' + foreign.join(', ') + ')' : ''));
  ok(tok('bg') === '#060d15' && tok('accent') === '#2ee59d' && tok('blue') === '#5b9dff', 'fundo #060d15 · verde #2ee59d (Games) · azul #5b9dff (Streaming)');
  ok(!/#ff4d12|#ff8a3d|#f6f4f1/i.test(css), 'sem vestígios do laranja do modelo');

  section('Contraste (WCAG AA ≥ 4,5:1 para texto)');
  const pairs = [['ink', 'bg'], ['ink-secondary', 'bg'], ['muted', 'bg'], ['muted', 'surface'], ['accent-ink', 'accent'], ['blue-ink', 'blue'], ['accent', 'surface'], ['blue', 'surface'], ['danger', 'surface']];
  for (const [fg, bg] of pairs) { const r = contrast(tok(fg), tok(bg)); ok(r >= 4.5, `${fg} sobre ${bg}: ${r.toFixed(1)}:1`); }

  section('Animações: só propriedades baratas');
  const ALLOWED = new Set(['transform', 'opacity', 'translate', 'scale', 'stroke-dashoffset']);
  const kfs = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
  ok(kfs.length >= 6, `${kfs.length} @keyframes encontrados`);
  for (const [, name, body] of kfs) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map(m => m[1]);
    const bad = props.filter(p => !ALLOWED.has(p));
    ok(bad.length === 0, `@keyframes ${name} usa só ${[...new Set(props)].join('/')}` + (bad.length ? ' ✗ ' + bad : ''));
  }
  ok(/prefers-reduced-motion:\s*reduce/.test(css), 'tem regra para "movimento reduzido"');
  ok(!/!important[^;]*;[^}]*will-change/.test(css) && (css.match(/will-change/g) || []).length <= 2, 'will-change usado com moderação');

  section('HTML semântico');
  ok((html.match(/<h1\b/g) || []).length === 1, 'exatamente um <h1>');
  ok(/<main\b/.test(html) && /<header\b/.test(html) && /<footer\b/.test(html) && /<nav\b/.test(html), 'landmarks: header, nav, main, footer');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  ok(new Set(ids).size === ids.length, 'ids únicos');
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map(m => m[1]);
  ok(anchors.every(a => ids.includes(a)), 'todas as âncoras #… têm destino');
  ok(/<svg[^>]*role="img"/.test(html) && /<title id="diagram-title"/.test(html), 'diagrama acessível (role=img + título)');
  ok(!/<img\b(?![^>]*\balt=)/.test(html), 'todas as imagens têm alt (ou não há imagens)');

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: data, ADMIN_PASSWORD: 'SenhaForte123' }, stdio: 'ignore' });
  await sleep(1200);
  const browser = await chromium.launch();
  const problems = [];
  const watch = (p, l) => {
    p.on('pageerror', e => problems.push(`${l} pageerror: ${e.message}`));
    p.on('console', m => { const t = m.text(); if ((m.type() === 'error' || /Content Security Policy|Refused to/i.test(t)) && !/ERR_NAME_NOT_RESOLVED|ERR_INTERNET|fonts\.g/i.test(t)) problems.push(`${l} console: ${t.slice(0, 140)}`); });
  };
  const scrollThrough = async (p, step) => {
    const total = await p.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y <= total; y += step) { await p.evaluate(v => window.scrollTo({ top: v, behavior: 'instant' }), y); await sleep(140); }
  };

  try {
    section('Carregamento, revelação e rolagem');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => { window.__cls = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
    const p = await ctx.newPage(); watch(p, 'mobile');
    await p.goto(BASE + '/', { waitUntil: 'load' }); await sleep(900);
    ok(await p.evaluate(() => document.documentElement.classList.contains('js')), 'html.js definido antes da pintura');
    const before = await p.evaluate(() => document.querySelectorAll('[data-reveal]:not(.is-revealed)').length);
    ok(before > 5, `elementos abaixo da dobra começam escondidos (${before})`);
    const stagger = await p.evaluate(() => [...document.querySelectorAll('.features [data-reveal]')].map(e => e.style.getPropertyValue('--i')).join(','));
    ok(stagger === '0,1,2,3,4,5', 'escalonamento por grupo: --i = ' + stagger);
    await scrollThrough(p, 480);
    const left = await p.evaluate(() => document.querySelectorAll('[data-reveal]:not(.is-revealed)').length);
    ok(left === 0, 'todos os blocos são revelados ao rolar');
    ok(await p.evaluate(() => document.querySelector('.steps').classList.contains('is-revealed')), 'grupo dos passos marcado como revelado');
    const prog = await p.evaluate(() => document.querySelector('[data-scroll-progress]').style.transform);
    ok(/scaleX\((0\.9|1)/.test(prog), 'barra de progresso chega ao fim: ' + prog);
    ok((await p.evaluate(() => window.__cls)) < 0.1, 'deslocamento de layout (CLS) < 0,1: ' + (await p.evaluate(() => window.__cls)).toFixed(3));

    section('Navegação');
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await sleep(300);
    const toggle = await p.$('[data-nav-toggle]');
    ok((await toggle.getAttribute('aria-expanded')) === 'false', 'menu fechado: aria-expanded=false');
    await toggle.click(); await sleep(300);
    ok((await toggle.getAttribute('aria-expanded')) === 'true' && await p.evaluate(() => document.querySelector('[data-nav]').classList.contains('is-open')), 'menu abre: aria-expanded=true');
    await p.keyboard.press('Escape'); await sleep(200);
    ok(!(await p.evaluate(() => document.querySelector('[data-nav]').classList.contains('is-open'))) && await p.evaluate(() => document.activeElement === document.querySelector('[data-nav-toggle]')), 'Escape fecha o menu e devolve o foco ao botão');
    await toggle.click(); await p.click('[data-nav] a[href="#como"]'); await sleep(1000);
    ok(!(await p.evaluate(() => document.querySelector('[data-nav]').classList.contains('is-open'))), 'escolher uma secção fecha o menu');
    await toggle.click(); await sleep(250);
    ok(await p.evaluate(() => document.querySelector('[data-nav] a[href="#como"]').getAttribute('aria-current') === 'true'), 'scrollspy marca "Como funciona" como atual');
    await p.keyboard.press('Escape');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sem scroll horizontal');
    await ctx.close();

    section('Responsivo (sem scroll horizontal)');
    for (const w of [320, 390, 768, 1024, 1280, 1920]) {
      const c = await browser.newContext({ viewport: { width: w, height: 900 } }); const pg = await c.newPage();
      await pg.goto(BASE + '/', { waitUntil: 'load' }); await sleep(250);
      ok(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `largura ${w}px`);
      await c.close();
    }

    section('Estado do servidor e ações');
    const d = await browser.newPage({ viewport: { width: 1280, height: 800 } }); watch(d, 'desktop');
    await d.goto(BASE + '/', { waitUntil: 'load' }); await sleep(900);
    ok((await d.getAttribute('#serverStatus', 'data-state')) === 'online', 'estado do servidor: data-state=online');
    ok((await d.textContent('#infoVersion')).startsWith('v'), 'versão apresentada');
    ok(await d.evaluate(() => getComputedStyle(document.querySelector('[data-nav]')).display === 'flex'), 'navegação visível no computador');
    // cartão com holofote
    const card = await d.$('.area-card--green'); await card.scrollIntoViewIfNeeded(); await sleep(900);
    const box = await card.boundingBox(); await d.mouse.move(box.x + 60, box.y + 40); await sleep(200);
    ok(await card.evaluate(el => el.style.getPropertyValue('--sx') !== ''), 'holofote do cartão segue o cursor');
    ok((await d.evaluate(() => getComputedStyle(document.querySelector('.area-card--blue .area-card__icon')).color)) === 'rgb(91, 157, 255)', 'Streaming = azul #5b9dff');
    ok((await d.evaluate(() => getComputedStyle(document.querySelector('.area-card--green .area-card__icon')).color)) === 'rgb(46, 229, 157)', 'Games = verde #2ee59d');
    ok((await d.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(6, 13, 21)', 'fundo do corpo = #060d15');
    await d.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await sleep(300);
    await d.keyboard.press('Tab');
    ok(await d.evaluate(() => document.activeElement.classList.contains('skip-link')), '1.º foco do teclado = "Saltar para as áreas"');
    await d.click('a.btn--green'); await d.waitForURL('**/games.html'); ok(true, '"Entrar nos Games" abre games.html');
    await d.goBack(); await sleep(300);
    await d.click('a.btn--blue'); await d.waitForURL('**/streaming/'); ok(true, '"Entrar no Streaming" abre o Streaming');
    await d.goto(BASE + '/'); await sleep(500);
    await d.evaluate(() => document.getElementById('openSuggest').scrollIntoView({ block: 'center' })); await sleep(600);
    await d.click('#openSuggest'); await sleep(400);
    ok(await d.evaluate(() => !!document.getElementById('on-suggest-modal')), '"Enviar sugestão" abre o formulário');
    await d.close();

    section('Movimento reduzido');
    const rc = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }); const rp = await rc.newPage(); watch(rp, 'reduced');
    await rp.goto(BASE + '/', { waitUntil: 'load' }); await sleep(600);
    ok((await rp.evaluate(() => document.querySelectorAll('[data-reveal]:not(.is-revealed)').length)) === 0, 'conteúdo revelado de imediato');
    ok((await rp.evaluate(() => [...document.querySelectorAll('[data-reveal]')].every(e => getComputedStyle(e).opacity === '1'))), 'nada fica transparente');
    const running = await rp.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect && a.effect.getTiming().iterations === Infinity).length);
    ok(running === 0, 'nenhuma animação infinita ativa (' + running + ')');
    await rc.close();

    section('Sem JavaScript');
    const nc = await browser.newContext({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false }); const np = await nc.newPage();
    await np.goto(BASE + '/', { waitUntil: 'load' }); await sleep(900);
    const hidden = await np.evaluate(() => [...document.querySelectorAll('[data-reveal]')].filter(e => getComputedStyle(e).opacity !== '1').length);
    ok(hidden === 0, 'todo o conteúdo visível sem JS (escondidos: ' + hidden + ')');
    await nc.close();

    section('Animações em execução (computador)');
    const ac = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const ap = await ac.newPage();
    await ap.goto(BASE + '/', { waitUntil: 'load' }); await sleep(1500);
    const names = await ap.evaluate(() => [...new Set(document.getAnimations().map(a => a.animationName).filter(Boolean))].sort());
    ok(['drift-a', 'drift-b', 'flow', 'float', 'pulse'].every(n => names.includes(n)), 'hero/diagrama animados: ' + names.join(', '));
    await ap.screenshot({ path: process.env.SHOTS ? path.join(process.env.SHOTS, 'home-desktop.png') : '/tmp/home-desktop.png' });
    await ac.close();
  } catch (e) { fail++; console.log('  ✗ ERRO:', e.message); }

  section('Consola');
  ok(problems.length === 0, 'sem erros de JavaScript nem violações de CSP'); if (problems.length) console.log(problems.join('\n'));
  await browser.close(); srv.kill(); fs.rmSync(data, { recursive: true, force: true });
  console.log(`\nResultado: ${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
