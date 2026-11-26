/* Testes de ponta a ponta: arranca o servidor e joga com clientes WebSocket reais.  node test/games.test.js */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const PORT = 3300 + Math.floor(Math.random() * 500);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), '2on-'));
const BASE = 'http://localhost:' + PORT;
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FALHOU:', name); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function session(name) {
  const r = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  return r.json();
}
class Client {
  constructor(name) { this.name = name; this.inbox = []; this.waiters = []; }
  async open(token) {
    const s = token ? null : await session(this.name);
    this.sess = s || { token }; 
    this.ws = new WebSocket('ws://localhost:' + PORT);
    this.ws.onmessage = e => { const m = JSON.parse(e.data); let used = false; this.waiters = this.waiters.filter(w => { if (used) return true; const r = w(m); if (r) used = true; return !r; }); if (!used) this.inbox.push(m); };
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.send({ type: 'session-auth', token: this.sess.token });
    return this.wait('session-ready');
  }
  send(o) { this.ws.send(JSON.stringify({ actionId: Math.random().toString(36).slice(2), ...o })); }
  wait(type, pred = () => true, ms = 3000) {
    const found = this.inbox.find(m => m.type === type && pred(m)); if (found) { this.inbox.splice(this.inbox.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout à espera de ' + type + ' (' + this.name + ')')), ms);
      this.waiters.push(m => { if (m.type === type && pred(m)) { clearTimeout(t); res(m); return true; } return false; });
    });
  }
  async state(pred, ms = 3000) { const m = await this.wait('game-state', m => pred(m.state), ms); return m.state; }
  drain() { this.inbox.length = 0; }
  close() { try { this.ws.close(); } catch {} }
}

(async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_PASSWORD: 'SenhaForte123' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/health'); break; } catch { await sleep(100); } }
  try {
    console.log('\n● Ligação e sessão');
    const a = new Client('Ana'), b = new Client('Bruno');
    await a.open(); await b.open();
    ok(true, 'dois clientes autenticados por WebSocket');
    const bad = new Client('Mau'); bad.sess = { token: 'x' };
    bad.ws = new WebSocket('ws://localhost:' + PORT); bad.ws.onmessage = e => bad.inbox.push(JSON.parse(e.data));
    await new Promise(r => bad.ws.onopen = r); bad.send({ type: 'session-auth', token: 'invalido' }); await sleep(200);
    ok(bad.inbox.some(m => m.type === 'session-required'), 'token inválido é recusado');
    bad.send({ type: 'game-create', gameType: 'tictactoe', name: 'x' }); await sleep(200);
    ok(!bad.inbox.some(m => m.type === 'game-created'), 'sem autenticação não cria salas'); bad.close();
    a.send({ type: 'ping', t: 1 }); ok((await a.wait('pong')).t === 1, 'ping/pong');

    console.log('\n● X Vs O');
    a.send({ type: 'game-create', gameType: 'tictactoe', name: 'Ana', teamName: 'Alpha' });
    const created = await a.wait('game-created');
    ok(/^[A-HJ-NP-Z2-9]{6}$/.test(created.roomCode), 'código da sala válido (' + created.roomCode + ')');
    ok(created.symbol === 'X' && created.state.players.O === false, 'criador é X e aguarda adversário');
    b.send({ type: 'game-join', roomCode: created.roomCode.toLowerCase(), name: 'Bruno' });
    const joined = await b.wait('game-joined');
    ok(joined.symbol === 'O' && joined.state.names.X === 'Ana', 'segundo jogador entra como O');
    await a.state(s => s.players.O);
    ok(true, 'criador recebe o estado com o adversário');
    a.drain(); b.drain();
    b.send({ type: 'game-move', cell: 4 });
    let sa = await a.state(s => s.board[4] === 'O');
    ok(sa.turn === 'X', 'quem toca primeiro começa e a vez passa ao outro');
    a.send({ type: 'game-move', cell: 4 }); ok(/ocupada/.test((await a.wait('game-info')).message), 'rejeita casa ocupada');
    b.send({ type: 'game-move', cell: 0 }); ok(/vez/.test((await b.wait('game-info')).message), 'rejeita jogar fora da vez');
    a.drain(); b.drain();
    for (const [p, cell] of [[a, 0], [b, 1], [a, 3], [b, 2], [a, 6]]) { p.send({ type: 'game-move', cell }); await sleep(60); }
    // O:4,1,2 não forma linha; X:0,3,6 forma coluna
    const fin = await a.state(s => s.winner); a.drain();
    ok(fin.winner === 'X' && fin.winningLine.join() === '0,3,6', 'vitória detetada (coluna 0-3-6)');
    ok(fin.score.X === 1, 'placar atualizado');
    a.send({ type: 'game-move', cell: 5 }); ok(/terminou/.test((await a.wait('game-info')).message), 'não joga depois do fim');
    a.send({ type: 'game-reset' }); const re = await b.state(s => s.matchNumber === 2);
    ok(re.winner === null && re.board.every(c => c === null) && re.score.X === 1, 'revanche limpa o tabuleiro e mantém o placar');

    console.log('\n● Estatísticas');
    const rk = await (await fetch(BASE + '/api/games/ranking')).json();
    ok(rk.ranking.length === 2 && rk.ranking[0].name === 'Ana' && rk.ranking[0].wins === 1, 'ranking: Ana 1 vitória');
    const pf = await (await fetch(BASE + '/api/games/profile/me', { headers: { Authorization: 'Bearer ' + b.sess.token } })).json();
    ok(pf.losses === 1 && pf.games === 1, 'perfil do Bruno: 1 derrota');

    console.log('\n● Espectador, saída e sala inexistente');
    const c = new Client('Carla'); await c.open();
    c.send({ type: 'game-join', roomCode: created.roomCode, name: 'Carla' });
    const sp = await c.wait('game-joined'); ok(sp.spectator === true && sp.symbol === 'S', 'terceiro jogador entra como espectador');
    c.drain(); c.send({ type: 'game-move', cell: 0 }); ok(/espectadores/.test((await c.wait('game-info')).message), 'espectador não joga');
    c.send({ type: 'game-join', roomCode: 'ZZZZZZ' }); const e404 = await c.wait('game-error'); ok(e404.code === 'room-not-found', 'sala inexistente → erro claro');
    c.close();

    console.log('\n● Reconexão (30 s de tolerância)');
    b.drain(); a.drain();
    b.close();
    const dc = await a.wait('game-disconnected'); ok(dc.state.disconnected === 'O', 'adversário vê "reconectando"');
    const b2 = new Client('Bruno'); await b2.open(b.sess.token);
    b2.send({ type: 'game-rejoin', roomCode: created.roomCode, name: 'Bruno' });
    const rj = await b2.wait('game-rejoined'); ok(rj.symbol === 'O' && rj.state.disconnected === null, 'volta ao mesmo lugar (O) após reconectar');
    ok((await a.state(s => s.disconnected === null)).players.O === true, 'criador vê o adversário de volta');

    console.log('\n● Sair a meio = derrota; sala é limpa');
    b2.send({ type: 'game-move', cell: 4 }); await a.state(s => s.board[4] === 'O');
    b2.send({ type: 'game-leave' });
    const left = await a.wait('game-left'); ok(left.symbol === 'O', 'criador é avisado da saída');
    const aft = await a.state(s => s.winner); ok(aft.winner === 'X', 'quem fica ganha');
    a.send({ type: 'game-leave' }); await sleep(100);
    const d = new Client('Dani'); await d.open(); d.send({ type: 'game-join', roomCode: created.roomCode }); ok((await d.wait('game-error')).code === 'room-not-found', 'sala vazia é eliminada'); d.close();

    console.log('\n● Pedra, Papel e Tesoura');
    const r1 = new Client('R1'), r2 = new Client('R2'); await r1.open(); await r2.open();
    r1.send({ type: 'game-create', gameType: 'rps', name: 'R1' }); const rc = await r1.wait('game-created');
    r2.send({ type: 'game-join', roomCode: rc.roomCode, name: 'R2' }); await r2.wait('game-joined');
    await sleep(200); r1.drain(); r2.drain();
    r1.send({ type: 'game-move', choice: 'rock' });
    const hidden = await r2.state(s => s.rps && s.rps.choices.X);
    ok(hidden.rps.myChoice === null && hidden.rps.revealedChoices === null, 'escolha do adversário fica oculta');
    r1.send({ type: 'game-move', choice: 'paper' }); ok(/Já escolheste/.test((await r1.wait('game-info')).message), 'não deixa mudar a escolha');
    r2.send({ type: 'game-move', choice: 'scissors' });
    const rr = await r1.state(s => s.winner);
    ok(rr.winner === 'X' && rr.rps.revealedChoices.O === 'scissors', 'pedra vence tesoura e revela as escolhas');
    r1.send({ type: 'game-move', choice: 'banana' }); r1.drain();
    r1.send({ type: 'game-reset' }); await r1.state(s => s.matchNumber === 2 && !s.winner); await sleep(200); r1.drain(); r2.drain();
    r1.send({ type: 'game-move', choice: 'rock' }); r2.send({ type: 'game-move', choice: 'rock' });
    ok((await r1.state(s => s.winner)).winner === 'draw', 'empate quando as escolhas são iguais');

    console.log('\n● Damas');
    const k1 = new Client('K1'), k2 = new Client('K2'); await k1.open(); await k2.open();
    k1.send({ type: 'game-create', gameType: 'checkers', name: 'K1' }); const kc = await k1.wait('game-created');
    ok(kc.state.board.flat().filter(p => p && p.color === 1).length === 12 && kc.state.turn === 1, 'tabuleiro inicial: 12 peças brancas, brancas começam');
    k2.send({ type: 'game-join', roomCode: kc.roomCode, name: 'K2' }); await k2.wait('game-joined');
    let ks = await k1.state(s => s.players.O);
    ok(ks.checkers.legalTargets.length === 7, '7 jogadas legais na abertura');
    await sleep(200); k2.drain(); k1.drain();
    k2.send({ type: 'game-move', from: { r: 2, c: 1 }, to: { r: 3, c: 0 } }); ok(/vez/.test((await k2.wait('game-info')).message), 'pretas não jogam na vez das brancas');
    k1.send({ type: 'game-move', from: { r: 5, c: 0 }, to: { r: 3, c: 2 } }); ok(/não é válida/.test((await k1.wait('game-info')).message), 'salto sem captura é rejeitado');
    k1.send({ type: 'game-move', from: { r: 5, c: 2 }, to: { r: 4, c: 3 } }); await k2.state(s => s.turn === 2);
    k2.send({ type: 'game-move', from: { r: 2, c: 5 }, to: { r: 3, c: 4 } }); await k1.state(s => s.turn === 1);
    ks = (await k1.state(s => true, 500).catch(() => null)) || ks;
    await sleep(200); k1.drain();
    // brancas em (4,3) podem capturar (3,4) → (2,5)? (2,5) ficou livre → captura obrigatória
    k1.send({ type: 'game-move', from: { r: 5, c: 0 }, to: { r: 4, c: 1 } });
    ok(/capturar/.test((await k1.wait('game-info')).message), 'captura obrigatória é imposta');
    k1.send({ type: 'game-move', from: { r: 4, c: 3 }, to: { r: 2, c: 5 }, }); const afterCap = await k2.state(s => s.board[3][4] === null && s.board[2][5] && s.board[2][5].color === 1 || s.turn === 2);
    ok(afterCap.board[3][4] === null, 'peça capturada é removida');
    // jogo termina: simular desistência por saída
    k2.send({ type: 'game-leave' }); const kleft = await k1.state(s => s.winner); ok(kleft.winner === 'X', 'saída das pretas dá vitória às brancas');

    console.log('\n● Chat');
    const t1 = new Client('T1'), t2 = new Client('T2'); await t1.open(); await t2.open();
    t1.send({ type: 'global-chat-join' }); t2.send({ type: 'global-chat-join' }); await t1.wait('global-chat-history'); await t2.wait('global-chat-history');
    t1.send({ type: 'global-chat', text: '  olá <b>mundo</b>  ' });
    const g1 = await t2.wait('global-chat'), g2 = await t1.wait('global-chat');
    ok(g1.message.text === 'olá bmundo/b' && g1.message.isMe === false && g2.message.isMe === true, 'mensagem limpa e flag isMe por destinatário');
    t1.send({ type: 'global-chat', text: 'spam' }); ok(/Aguarda/.test((await t1.wait('game-chat-error')).message), 'limite de velocidade no chat');

    console.log('\n● Voz (sinalização)');
    const v1 = new Client('V1'), v2 = new Client('V2'); await v1.open(); await v2.open();
    v1.send({ type: 'game-create', gameType: 'tictactoe', name: 'V1' }); const vc = await v1.wait('game-created');
    v2.send({ type: 'game-join', roomCode: vc.roomCode, name: 'V2' }); await v2.wait('game-joined');
    v1.send({ type: 'game-voice', signal: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } } });
    ok((await v2.wait('game-voice')).signal.type === 'offer', 'oferta WebRTC chega ao outro jogador');
    v1.send({ type: 'game-voice', signal: { type: 'hack' } }); await sleep(150); ok(!v2.inbox.some(m => m.type === 'game-voice'), 'sinais desconhecidos são descartados');

    console.log('\n● Segurança do WebSocket');
    const evil = new WebSocket('ws://localhost:' + PORT, { headers: { Origin: 'https://evil.example' } });
    const evilResult = await new Promise(r => { evil.onopen = () => r('aberto'); evil.onerror = () => r('recusado'); evil.onclose = () => r('recusado'); });
    ok(evilResult === 'recusado', 'origem não autorizada é recusada');
    const big = new Client('Big'); await big.open(); big.ws.send('x'.repeat(300000)); await sleep(300);
    ok(big.ws.readyState > 1, 'mensagem gigante fecha a ligação');
    const flood = new Client('Flood'); await flood.open(); for (let i = 0; i < 150; i++) flood.ws.send('{"type":"ping"}'); await sleep(400);
    ok(flood.ws.readyState > 1, 'inundação de mensagens fecha a ligação');
  } catch (e) { fail++; console.log('  ✗ ERRO:', e.message); }
  srv.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\nResultado: ${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
