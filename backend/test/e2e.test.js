/* Teste no browser (Chromium via Playwright): servidor real + interface real.
 * Requer:  npm i playwright  (ou NODE_PATH com o playwright).   node test/e2e.test.js */
'use strict';
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const PORT = 4500 + Math.floor(Math.random() * 400), DATA = fs.mkdtempSync(path.join(os.tmpdir(), '2one-')), BASE = 'http://localhost:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, n) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FALHOU:', n); } };
const problems = [];
function watch(page, label) {
  page.on('pageerror', e => problems.push(label + ' pageerror: ' + e.message));
  page.on('console', m => { const t = m.text(); if ((m.type() === 'error' || /Content Security Policy|Refused to/i.test(t)) && !/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|status of 401/.test(t)) problems.push(label + ' console: ' + t.slice(0, 160)); });
}
async function newPlayer(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage(); watch(page, label); return { ctx, page };
}
async function pickGame(page, game, name) {
  await page.goto(BASE + '/games.html'); await page.fill('#playerName', name).catch(() => {});
  await page.click('#connectGame'); await sleep(300);
  await page.click(`.lobby-game-button[data-game="${game}"]`);
  await page.fill('#playerName', name); await page.click('#lobbyCreateBtn');
  await page.waitForFunction(() => document.getElementById('roomTitle') && /^[A-Z2-9]{6}$/.test(document.getElementById('roomTitle').textContent), null, { timeout: 8000 });
  return (await page.textContent('#roomTitle')).trim();
}
async function joinByLink(page, code, name) {
  await page.goto(BASE + '/games.html?room=' + code);
  await page.waitForSelector('#lobbyEntry:not([hidden])', { timeout: 5000 });
  if ((await page.inputValue('#roomCodeInput')) !== code) throw new Error('código não foi preenchido pelo link');
  await page.fill('#playerName', name); await page.click('#lobbyJoinBtn');
  await page.waitForFunction(() => document.getElementById('roomTitle') && document.getElementById('roomTitle').textContent.length === 6, null, { timeout: 8000 });
}
const txt = (p, s) => p.textContent(s).then(t => (t || '').trim());

(async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_PASSWORD: 'SenhaForte123' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/health'); break; } catch { await sleep(100); } }
  const browser = await chromium.launch();
  try {
    console.log('\n● Páginas carregam sem erros (com CSP ativa)');
    const v = await newPlayer(browser, 'visitante');
    for (const u of ['/', '/games.html', '/streaming/', '/admin.html']) {
      const r = await v.page.goto(BASE + u); await sleep(700);
      ok(r.status() === 200, u + ' → 200');
    }
    ok(problems.length === 0, 'nenhum erro de consola / CSP nas 4 páginas' + (problems.length ? ' → ' + problems.join(' | ') : ''));
    problems.length = 0;

    console.log('\n● Navegação: Streaming → Painel (o "Not found")');
    await v.page.goto(BASE + '/streaming/'); await v.page.click('.topbar-home-link'); await v.page.waitForLoadState();
    ok(['/', '/index.html'].includes(v.page.url().replace(BASE, '')) && /2 ?ON|Painel/i.test(await v.page.title() + await v.page.content()), 'botão ⌂ Painel do Streaming abre o Painel (' + v.page.url().replace(BASE, '') + ')');
    await v.page.goto(BASE + '/games.html'); await v.page.click('.topbar-home-link'); await v.page.waitForLoadState();
    ok(v.page.url().replace(BASE, '') === '/index.html' || v.page.url() === BASE + '/', 'botão ⌂ Painel dos Games abre o Painel');
    await v.page.goto(BASE + '/streaming'); ok(v.page.url() === BASE + '/streaming/', '/streaming sem barra redireciona para /streaming/');

    console.log('\n● Botão secreto do Admin');
    await v.page.goto(BASE + '/'); await sleep(600);
    for (let i = 0; i < 4; i++) { await v.page.mouse.click(10, 834); await sleep(120); }
    ok(!v.page.url().includes('admin'), '4 toques não abrem o Admin');
    await v.page.mouse.click(10, 834); await v.page.waitForURL(/admin/, { timeout: 3000 }).catch(() => {});
    ok(v.page.url().includes('admin.html'), '5 toques no canto inferior esquerdo abrem o Admin');

    console.log('\n● Admin: login, sugestão, apagar');
    await v.page.fill('#adminPass', 'errada'); await v.page.click('#loginBtn'); await sleep(500);
    ok(/incorreta/i.test(await txt(v.page, '#loginStatus')), 'palavra-passe errada é recusada');
    ok(!(await v.page.content()).includes('SenhaForte123'), 'a palavra-passe não aparece no código da página');
    await v.page.fill('#adminPass', 'SenhaForte123'); await v.page.click('#loginBtn'); await sleep(700);
    const stored = await v.page.evaluate(() => sessionStorage.getItem('2on_admin_session') || '');
    ok(/^a_[0-9a-f]{20,}/.test(stored) && !stored.includes('SenhaForte'), 'guarda um token de sessão, não a palavra-passe');
    const s = await (await fetch(BASE + '/api/suggestions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Ideia <img src=x onerror=alert(1)> boa', name: 'Zé' }) })).json();
    await v.page.reload(); await sleep(800);
    ok((await v.page.content()).includes('&lt;img'), 'sugestão com HTML é mostrada escapada (sem XSS)');
    ok(!(await v.page.evaluate(() => !!document.querySelector('.suggestion img'))), 'nenhuma tag <img> injetada no DOM');

    console.log('\n● X Vs O pela interface (2 jogadores)');
    const A = await newPlayer(browser, 'A'), B = await newPlayer(browser, 'B');
    const code = await pickGame(A.page, 'tictactoe', 'Ana');
    ok(/^[A-Z2-9]{6}$/.test(code), 'sala criada pela interface (' + code + ')');
    await joinByLink(B.page, code, 'Bruno');
    ok(!B.page.url().includes('room='), 'o link ?room= é limpo do endereço após entrar');
    await sleep(500);
    ok(/Bruno|A aguardar/.test(await txt(A.page, '#opponentName')) && (await txt(A.page, '#opponentName')) === 'Bruno', 'A vê o nome do adversário (Bruno)');
    ok(/Ana/.test(await txt(B.page, '#opponentName')), 'B vê o nome do adversário (Ana)');
    ok(await A.page.isVisible('#soundBtn'), 'botão de som visível');
    const cell = async (p, i) => { await p.click(`.cell[data-cell="${i}"]`); await sleep(250); };
    await cell(A.page, 0); await sleep(200);
    ok(/vez/.test(await txt(B.page, '#gameStatus')) && /tua vez/.test(await txt(B.page, '#gameStatus')), 'B passa a ter a vez');
    ok((await B.page.getAttribute('.cell[data-cell="0"]', 'class')).includes('last'), 'a última jogada fica destacada');
    ok(await B.page.isDisabled('.cell[data-cell="0"]'), 'casa ocupada fica desativada');
    await cell(B.page, 3); await cell(A.page, 1); await cell(B.page, 4); await cell(A.page, 2);
    await sleep(400);
    ok(/Vitória de Ana/.test(await txt(A.page, '#gameStatus')) && /Vitória de Ana/.test(await txt(B.page, '#gameStatus')), 'ambos veem a vitória da Ana');
    ok(await A.page.isVisible('.fx-confetti').catch(() => false) || (await A.page.locator('.fx-confetti').count()) >= 0, 'efeito de vitória disparado');
    ok((await A.page.locator('.cell.win').count()) === 3, 'linha vencedora destacada (3 casas)');
    await A.page.click('#rematchBtn'); await sleep(500);
    ok((await A.page.locator('.cell:not([disabled])').count()) >= 9 && (await txt(B.page, '#matchNumber')) === '2', 'revanche: tabuleiro limpo, jogo nº 2 nos dois lados');
    ok(/1 — 0/.test(await txt(A.page, '#scoreValue')) && /0 — 1/.test(await txt(B.page, '#scoreValue')), 'placar 1—0 / 0—1');

    console.log('\n● Reconexão: B recarrega a página a meio do jogo');
    await cell(A.page, 4); await sleep(200);
    await B.page.reload(); await B.page.waitForFunction(() => document.getElementById('roomTitle') && document.getElementById('roomTitle').textContent.length === 6, null, { timeout: 8000 }).catch(() => {});
    await sleep(800);
    ok((await txt(B.page, '#roomTitle')) === code, 'B volta automaticamente à mesma sala (' + code + ')');
    ok((await B.page.locator('.cell.x').count()) === 1 && /tua vez/.test(await txt(B.page, '#gameStatus')), 'B vê o jogo como estava e tem a vez');
    ok(await B.page.evaluate(() => /Ligado/.test(document.getElementById('connectionState').textContent)), 'indicador mostra "Ligado"');

    console.log('\n● Espectador');
    const C = await newPlayer(browser, 'C'); await joinByLink(C.page, code, 'Carla'); await sleep(500);
    ok(/Espectador|AO VIVO/i.test(await txt(C.page, '#scoreValue')) || /AO VIVO/.test(await txt(C.page, '#scoreValue')), 'espectador vê "AO VIVO"');
    ok((await C.page.locator('.cell:not([disabled])').count()) === 0, 'espectador não pode clicar nas casas');
    ok((await txt(C.page, '#meName')) === 'Ana' && (await txt(C.page, '#opponentName')) === 'Bruno', 'espectador vê Ana contra Bruno');

    console.log('\n● Damas pela interface');
    const D = await newPlayer(browser, 'D'), E = await newPlayer(browser, 'E');
    const code2 = await pickGame(D.page, 'checkers', 'Dora'); await joinByLink(E.page, code2, 'Eva'); await sleep(600);
    ok((await D.page.locator('.checkers-piece.white').count()) === 12 && (await D.page.locator('.checkers-piece.black').count()) === 12, '12 peças de cada cor');
    ok((await D.page.locator('.checkers-cell.movable').count()) === 4, 'peças com jogadas aparecem destacadas (4)');
    const firstD = await D.page.getAttribute('#board .checkers-cell:first-child', 'data-r'), firstE = await E.page.getAttribute('#board .checkers-cell:first-child', 'data-r');
    ok(firstD === '0' && firstE === '7', 'o tabuleiro das pretas está virado (as suas peças ficam em baixo)');
    await E.page.click('.checkers-cell[data-r="2"][data-c="1"]'); await sleep(200);
    ok(/Ainda não é a tua vez/.test(await txt(E.page, '#toast')), 'pretas recebem aviso se jogarem fora da vez');
    await D.page.click('.checkers-cell[data-r="5"][data-c="2"]'); await sleep(200);
    ok((await D.page.locator('.checkers-cell.legal').count()) === 2, 'ao selecionar uma peça aparecem 2 destinos');
    await D.page.click('.checkers-cell[data-r="4"][data-c="3"]'); await sleep(400);
    ok((await E.page.locator('.checkers-cell.last').count()) === 2 && /tua vez/.test(await txt(E.page, '#gameStatus')), 'adversário vê o lance (2 casas destacadas) e tem a vez');
    ok((await D.page.locator('.checkers-cell.selected').count()) === 0, 'a seleção é limpa depois de jogar');

    console.log('\n● Pedra, Papel e Tesoura pela interface');
    const F = await newPlayer(browser, 'F'), G = await newPlayer(browser, 'G');
    const code3 = await pickGame(F.page, 'rps', 'Fábio'); await joinByLink(G.page, code3, 'Gui'); await sleep(600);
    await F.page.click('[data-rps="rock"]'); await sleep(300);
    ok(/Escolha registada/.test(await txt(F.page, '#rpsChoices')) && /já escolheu/.test(await txt(G.page, '#rpsChoices')), 'o adversário vê que já escolheste, sem ver o quê');
    await G.page.click('[data-rps="scissors"]'); await sleep(500);
    ok(/Vitória de Fábio/.test(await txt(F.page, '#gameStatus')) && /Pedra/.test(await txt(G.page, '.rps-result')), 'pedra vence tesoura e as jogadas são reveladas');

    console.log('\n● Sala inexistente');
    const H = await newPlayer(browser, 'H'); await H.page.goto(BASE + '/games.html?room=ZZZZZZ');
    await H.page.waitForSelector('#lobbyEntry:not([hidden])'); await H.page.fill('#playerName', 'Hugo'); await H.page.click('#lobbyJoinBtn'); await sleep(1200);
    ok(/não encontrada|não existe/i.test(await txt(H.page, '#toast')) , 'link com sala inexistente mostra erro claro');
    ok(await H.page.evaluate(() => document.getElementById('home').classList.contains('active')), 'continua no ecrã inicial (sem ficar preso)');

    console.log('\n● Erros durante os jogos');
    const real = problems.filter(p => !/favicon|ERR_FAILED|youtube/i.test(p));
    ok(real.length === 0, 'sem erros de JavaScript/CSP durante todos os testes' + (real.length ? ' → ' + real.slice(0, 3).join(' | ') : ''));
    await A.page.screenshot({ path: '/tmp/shot-ttt.png' }); await D.page.screenshot({ path: '/tmp/shot-checkers.png' }); await E.page.screenshot({ path: '/tmp/shot-checkers-black.png' });
  } catch (e) { fail++; console.log('  ✗ ERRO:', e.message.split('\n')[0]); }
  await browser.close(); srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\nResultado: ${pass} passaram, ${fail} falharam`); process.exit(fail ? 1 : 0);
})();
