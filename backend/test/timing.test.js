/* Testes de tempo: turno esgotado e tolerância de reconexão (servidor com tempos curtos). */
'use strict';
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 4000 + Math.floor(Math.random() * 400), DATA = fs.mkdtempSync(path.join(os.tmpdir(), '2ont-')), BASE = 'http://localhost:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, n) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FALHOU:', n); } };
async function mk(n, token) {
  const s = token ? { token } : await (await fetch(BASE + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n }) })).json();
  const ws = new WebSocket('ws://localhost:' + PORT), log = [];
  ws.onmessage = e => log.push(JSON.parse(e.data)); await new Promise(r => ws.onopen = r);
  const send = o => ws.send(JSON.stringify({ actionId: Math.random() + '', ...o }));
  send({ type: 'session-auth', token: s.token }); await sleep(100);
  return { ws, log, send, token: s.token, last: t => [...log].reverse().find(m => m.type === t) };
}
(async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_PASSWORD: 'SenhaForte123', TURN_SECONDS: '1', GRACE_MS: '1200' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/health'); break; } catch { await sleep(100); } }
  try {
    console.log('\n● Tempo de jogada esgotado');
    const a = await mk('A'), b = await mk('B');
    a.send({ type: 'game-create', gameType: 'tictactoe', name: 'A' }); await sleep(150);
    const code = a.last('game-created').roomCode;
    b.send({ type: 'game-join', roomCode: code, name: 'B' }); await sleep(150);
    a.send({ type: 'game-move', cell: 0 }); await sleep(200);          // X joga; vez de O
    ok(a.last('game-state').state.turn === 'O' && a.last('game-state').state.turnStartedAt > 0, 'relógio arranca na vez do adversário');
    await sleep(1700);
    const to = a.last('game-timeout');
    ok(to && to.state.turn === 'X', 'após 1 s sem jogar, a vez passa (game-timeout)');
    await sleep(1400);
    ok(a.log.filter(m => m.type === 'game-timeout').length >= 2, 'continua a passar a vez');
    await sleep(5000);
    const st = a.last('game-state') || {}; const fin = [...a.log].reverse().find(m => m.state && m.state.winner);
    ok(fin && fin.state.winner, '3 tempos esgotados seguidos = derrota (' + (fin ? fin.state.winner : '—') + ')');

    console.log('\n● Reconexão: tolerância e desistência');
    const c = await mk('C'), d = await mk('D');
    c.send({ type: 'game-create', gameType: 'rps', name: 'C' }); await sleep(150);
    const code2 = c.last('game-created').roomCode;
    d.send({ type: 'game-join', roomCode: code2, name: 'D' }); await sleep(150);
    d.ws.close(); await sleep(300);
    ok(c.last('game-disconnected') && c.last('game-disconnected').state.disconnected === 'O', 'adversário marcado como desligado');
    c.send({ type: 'game-move', choice: 'rock' }); await sleep(150);
    ok(c.log.some(m => m.type === 'game-info' && /reconexão/.test(m.message)), 'não se joga enquanto o adversário reconecta');
    await sleep(1500);
    ok(c.last('game-left') && c.last('game-left').symbol === 'O', 'passado o prazo, o adversário é removido');
    const w = [...c.log].reverse().find(m => m.state && m.state.winner === 'X'); ok(!!w, 'quem ficou ganha por desistência');
    const rk = await (await fetch(BASE + '/api/games/ranking')).json(); ok(rk.ranking.some(p => p.name === 'C' && p.wins === 1), 'vitória por desistência conta no ranking');
  } catch (e) { fail++; console.log('  ✗ ERRO:', e.message); }
  srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\nResultado: ${pass} passaram, ${fail} falharam`); process.exit(fail ? 1 : 0);
})();
