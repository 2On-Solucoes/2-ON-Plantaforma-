/* Interface dos Games num browser real, com dois jogadores no servidor de partidas. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const PORT = 6300 + Math.floor(Math.random() * 300), BASE = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(c ? '  ✓' : '  ✗ FALHOU:', n); };

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-'));
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: data, ADMIN_PASSWORD: 'SenhaForte123' }, stdio: 'ignore' });
  await sleep(1200);
  const browser = await chromium.launch(); const problems = [];
  const spy = () => { window.__vib = 0; window.__beeps = 0; const v = navigator.vibrate; navigator.vibrate = function () { window.__vib++; return true; };
    const AC = window.AudioContext || window.webkitAudioContext; if (AC) { const o = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__beeps++; return o.apply(this, arguments); }; } };
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await c.addInitScript(spy); const p = await c.newPage();
    p.on('pageerror', e => problems.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED|Failed to load resource|fonts\.g/i.test(m.text())) problems.push('console: ' + m.text().slice(0, 120)); }); return { c, p }; };
  try {
    console.log('\n● Marca e cabeçalho');
    const A = await mk(); await A.p.goto(BASE + '/games.html'); await sleep(1200);
    ok((await A.p.textContent('.topbar-brand__mark')).trim() === '2·ON', 'marca "2·ON" (antes dizia "2O")');
    ok((await A.p.textContent('.topbar-brand__name')).trim() === 'Games', 'nome da área: Games');
    ok(await A.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sem scroll horizontal');
    ok(await A.p.evaluate(() => getComputedStyle(document.querySelector('.topbar-brand__mark')).webkitTextFillColor === 'rgba(0, 0, 0, 0)'), 'marca em gradiente, como no painel e no Streaming');

    console.log('\n● Partida real entre dois jogadores (X Vs O)');
    await A.p.click('#connectGame'); await sleep(500); await A.p.click('[data-game="tictactoe"]'); await sleep(300);
    await A.p.fill('#teamName', ''); await A.p.fill('#playerName', 'Ana'); await A.p.click('#lobbyCreateBtn');
    await A.p.waitForSelector('#play.active', { timeout: 5000 }); await sleep(500);
    const code = (await A.p.textContent('#roomTitle')).trim(); ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code), 'sala criada com código ' + code);
    const B = await mk(); await B.p.goto(BASE + '/games.html'); await sleep(1000);
    await B.p.click('#connectGame'); await sleep(400); await B.p.click('[data-game="tictactoe"]'); await sleep(300);
    await B.p.fill('#playerName', 'Beto'); await B.p.fill('#roomCodeInput', code); await B.p.click('#lobbyJoinBtn');
    await B.p.waitForSelector('#play.active', { timeout: 5000 }); await sleep(600);
    ok((await A.p.textContent('#gameStatus')).length > 0 && await A.p.evaluate(() => document.querySelectorAll('.cell').length === 9), 'tabuleiro 3×3 nos dois ecrãs');
    const before = await B.p.evaluate(() => ({ b: window.__beeps, v: window.__vib }));
    await A.p.click('.cell >> nth=4'); await sleep(700);
    ok(await B.p.evaluate(() => document.querySelectorAll('.cell')[4].textContent.trim() !== ''), 'jogada de A aparece no ecrã de B em tempo real');
    const after = await B.p.evaluate(() => ({ b: window.__beeps, v: window.__vib }));
    ok(after.b > before.b || after.v > before.v, 'B recebe feedback (som ou vibração) quando o adversário joga');
    await B.p.click('.cell >> nth=0'); await sleep(500);
    ok(await A.p.evaluate(() => document.querySelectorAll('.cell')[0].textContent.trim() !== ''), 'resposta de B aparece no ecrã de A');
    // botão de som persistente
    await A.p.click('#soundBtn'); const muted = await A.p.evaluate(() => localStorage.getItem('2on_muted')); await A.p.reload(); await sleep(900);
    ok(muted === '1' || muted === '0', 'botão de som guarda a preferência (2on_muted=' + muted + ')');
    await A.c.close(); await B.c.close();
  } catch (e) { fail++; console.log('  ✗ ERRO:', e.message); }
  console.log('\n● Consola'); ok(problems.length === 0, 'sem erros de JavaScript'); if (problems.length) console.log(problems.join('\n'));
  await browser.close(); srv.kill(); fs.rmSync(data, { recursive: true, force: true });
  console.log(`\nResultado: ${pass} passaram, ${fail} falharam`); process.exit(fail ? 1 : 0);
})();
