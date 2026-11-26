/**
 * 2-ON GAMES — servidor de partidas em tempo real (WebSocket sem dependências).
 *
 * Protocolo (compatível com frontend/games.js):
 *  cliente → servidor: session-auth, ping, global-chat-join, global-chat, game-create, game-join,
 *                      game-rejoin, game-leave, game-move, game-reset, game-chat,
 *                      game-voice, game-voice-ready, game-voice-state
 *  servidor → cliente: session-ready/required, pong, global-chat-history, global-chat,
 *                      game-created/joined/rejoined, game-state, game-timeout, game-disconnected,
 *                      game-left, game-info, game-error, game-chat-error, game-chat, game-voice*
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GAMES, checkers, other } = require('./game-engine');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // sem 0/1/I/O (confusão visual)
const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 30;
const MAX_TIMEOUTS = 3;              // 3 tempos esgotados seguidos = derrota
const GRACE_MS = Number(process.env.GRACE_MS) || 30000;              // tempo para o adversário reconectar
const EMPTY_ROOM_MS = 10 * 60 * 1000;
const MAX_FRAME = 256 * 1024;

function attach(server, opts) {
  const { playerSessions, dataDir, isAllowedOrigin, clientIp, log = console } = opts;
  const rooms = new Map();           // código → sala
  const conns = new Set();
  const globalChat = [];
  const statsFile = path.join(dataDir, 'stats.json');
  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch { stats = {}; }
  let saveTimer = null;
  const saveStats = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { const tmp = statsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(stats)); fs.renameSync(tmp, statsFile); } catch (e) { log.error('[stats]', e.message); }
    }, 1500);
    saveTimer.unref();
  };

  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  const newId = () => crypto.randomUUID();

  /* ================= WebSocket (RFC 6455, mínimo e robusto) ================= */
  function frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    return Buffer.concat([head, payload]);
  }
  function makeParser(onText, onControl, onFail) {
    let buf = Buffer.alloc(0), frags = [], fragLen = 0;
    return chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = !!(buf[0] & 0x80), op = buf[0] & 0x0f, masked = !!(buf[1] & 0x80);
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; if (buf.readUInt32BE(2) !== 0) return onFail(1009); len = buf.readUInt32BE(6); off = 10; }
        if (!masked) return onFail(1002);
        if (len > MAX_FRAME) return onFail(1009);
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (op >= 8) { if (!fin || len > 125) return onFail(1002); onControl(op, payload); continue; }
        if (op === 1 || op === 0) {
          if (op === 0 && !frags.length) return onFail(1002);
          frags.push(payload); fragLen += payload.length;
          if (fragLen > MAX_FRAME) return onFail(1009);
          if (fin) { const text = Buffer.concat(frags).toString('utf8'); frags = []; fragLen = 0; onText(text); }
        } else if (op !== 2) return onFail(1002);
      }
    };
  }

  server.on('upgrade', (req, socket) => {
    try {
      const url = new URL(req.url, 'http://x');
      const key = req.headers['sec-websocket-key'];
      const origin = req.headers.origin;
      const sameOrigin = origin && (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
      if (url.pathname !== '/' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
        return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
      if (origin && !sameOrigin && !isAllowedOrigin(origin)) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const ip = clientIp(req);
      let sameIp = 0; for (const c of conns) if (c.ip === ip) sameIp++;
      if (conns.size >= 2000 || sameIp >= 30) return socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      socket.setNoDelay(true);
      newConn(socket, ip);
    } catch { try { socket.destroy(); } catch {} }
  });

  function newConn(socket, ip) {
    const conn = { id: newId(), socket, ip, playerId: null, name: 'Jogador', authed: false, roomCode: null, symbol: null,
      globalJoined: false, actions: new Map(), lastSeen: Date.now(), lastChatAt: 0, chatBurst: [], msgTimes: [], closed: false };
    conns.add(conn);
    conn.send = obj => { if (!conn.closed && socket.writable) { try { socket.write(frame(1, Buffer.from(JSON.stringify(obj)))); } catch {} } };
    conn.close = (code = 1000) => {
      if (conn.closed) return;
      try { const b = Buffer.alloc(2); b.writeUInt16BE(code); socket.write(frame(8, b)); } catch {}
      try { socket.end(); } catch {}
      setTimeout(() => { try { socket.destroy(); } catch {} }, 1000).unref();
      onClose(conn);
    };
    const parse = makeParser(
      text => { conn.lastSeen = Date.now(); onMessage(conn, text); },
      (op, payload) => {
        conn.lastSeen = Date.now();
        if (op === 9) { try { socket.write(frame(10, payload)); } catch {} }
        else if (op === 8) conn.close(1000);
      },
      code => conn.close(code)
    );
    socket.on('data', d => { try { parse(d); } catch (e) { log.error('[ws]', e.message); conn.close(1011); } });
    socket.on('close', () => onClose(conn));
    socket.on('error', () => onClose(conn));
    setTimeout(() => { if (!conn.authed) conn.close(1008); }, 10000).unref();   // sem autenticação em 10 s
  }
  function onClose(conn) {
    if (conn.closed) return;
    conn.closed = true; conns.delete(conn);
    detach(conn, 'disconnect');
  }
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const c of conns) {
      if (now - c.lastSeen > 70000) { c.close(1001); continue; }
      try { c.socket.write(frame(9, Buffer.alloc(0))); } catch {}
    }
  }, 25000);
  heartbeat.unref();

  /* ================= Mensagens ================= */
  function onMessage(conn, text) {
    const now = Date.now();
    conn.msgTimes = conn.msgTimes.filter(t => now - t < 10000); conn.msgTimes.push(now);
    if (conn.msgTimes.length > 120) return conn.close(1008);           // inundação
    let m; try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;

    if (m.type === 'session-auth') {
      const s = playerSessions.get(String(m.token || ''));
      if (!s || s.exp < now) return conn.send({ type: 'session-required' });
      conn.authed = true; conn.playerId = s.playerId; conn.name = s.name || 'Jogador';
      return conn.send({ type: 'session-ready', playerId: conn.playerId, name: conn.name });
    }
    if (!conn.authed) return conn.send({ type: 'session-required' });
    if (m.type === 'ping') return conn.send({ type: 'pong', t: m.t || null });

    // idempotência: o cliente repete ações após reconexão
    if (m.actionId) {
      const id = String(m.actionId).slice(0, 64);
      if (conn.actions.has(id)) return replayDuplicate(conn, m);
      conn.actions.set(id, true);
      if (conn.actions.size > 300) conn.actions.delete(conn.actions.keys().next().value);
    }
    switch (m.type) {
      case 'global-chat-join': conn.globalJoined = true; return conn.send({ type: 'global-chat-history', messages: globalChat.slice(-60).map(x => view(x, conn)) });
      case 'global-chat': return chat(conn, m, 'global');
      case 'game-create': return createRoom(conn, m);
      case 'game-join': return joinRoom(conn, m);
      case 'game-rejoin': return rejoin(conn, m);
      case 'game-leave': return leaveRoom(conn, true);
      case 'game-move': return move(conn, m);
      case 'game-reset': return rematch(conn);
      case 'game-chat': return chat(conn, m, 'game');
      case 'game-voice': case 'game-voice-ready': case 'game-voice-state': return relayVoice(conn, m);
      case 'championship-watch': return;
      case 'championship-chat': return conn.send({ type: 'game-info', message: 'Os campeonatos ainda não estão disponíveis neste servidor.' });
      default: return;
    }
  }
  function replayDuplicate(conn, m) {
    const room = rooms.get(conn.roomCode);
    if (!room) return;
    if (m.type === 'game-create' || m.type === 'game-join') return conn.send({ type: m.type === 'game-create' ? 'game-created' : 'game-joined', roomCode: room.code, symbol: conn.symbol, spectator: conn.symbol === 'S', state: stateFor(room, conn.symbol) });
    conn.send({ type: 'game-state', state: stateFor(room, conn.symbol) });
  }
  const err = (conn, message, code) => conn.send({ type: 'game-error', message, code });

  /* ================= Salas ================= */
  function genCode() {
    for (let i = 0; i < 50; i++) {
      let c = ''; for (let k = 0; k < 6; k++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }
  function seatOf(room, playerId) { return ['X', 'O'].find(s => room.seats[s] && room.seats[s].playerId === playerId) || null; }
  function members(room) {
    const list = [];
    for (const s of ['X', 'O']) if (room.seats[s] && room.seats[s].conn) list.push(room.seats[s].conn);
    for (const c of room.spectators) list.push(c);
    return list;
  }
  function stateFor(room, viewerSymbol) {
    const g = room.game, type = g.type;
    const st = {
      gameType: type, roomCode: room.code, matchNumber: room.matchNumber, winner: g.winner, turn: g.turn,
      players: { X: !!room.seats.X, O: !!room.seats.O },
      names: { X: room.seats.X ? room.seats.X.name : null, O: room.seats.O ? room.seats.O.name : null },
      teams: { X: room.seats.X ? room.seats.X.team : '', O: room.seats.O ? room.seats.O.team : '' },
      score: room.score, disconnected: room.disconnected || null,
      turnStartedAt: room.turnStartedAt || null, turnSeconds: TURN_SECONDS, serverTime: Date.now(),
      spectators: room.spectators.size, lastMove: room.lastMove || null
    };
    if (type === 'tictactoe') { st.board = g.board; st.winningLine = g.winningLine; }
    else if (type === 'checkers') {
      st.board = g.board;
      const color = g.turn;
      st.checkers = { mustContinue: g.mustContinue, legalTargets: color && !g.winner ? checkers.legalMoves(g, color) : [] };
    } else if (type === 'rps') {
      const mine = viewerSymbol === 'X' || viewerSymbol === 'O' ? g.choices[viewerSymbol] : null;
      st.rps = { myChoice: mine, choices: { X: !!g.choices.X, O: !!g.choices.O }, revealedChoices: g.winner ? g.revealed : null };
    }
    return st;
  }
  function broadcast(room, type = 'game-state', extra) {
    for (const c of members(room)) c.send({ type, state: stateFor(room, c.symbol), ...(extra || {}) });
  }
  function clearTimers(room) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  function armTurn(room) {
    clearTimers(room);
    const g = room.game;
    room.turnStartedAt = null;
    if (g.type === 'rps' || g.winner || !g.turn || room.disconnected || !room.seats.X || !room.seats.O) return;
    room.turnStartedAt = Date.now();
    room.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_SECONDS * 1000 + 300);
    room.turnTimer.unref();
  }
  function symbolOfTurn(g) { return g.type === 'checkers' ? (g.turn === 1 ? 'X' : 'O') : g.turn; }
  function onTurnTimeout(room) {
    const g = room.game; if (g.winner || !rooms.has(room.code)) return;
    const loser = symbolOfTurn(g);
    room.timeouts[loser] = (room.timeouts[loser] || 0) + 1;
    if (room.timeouts[loser] >= MAX_TIMEOUTS) { finish(room, other(loser)); broadcast(room); return; }
    GAMES[g.type].passTurn(g);
    if (g.winner) { finish(room, g.winner); }
    armTurn(room);
    broadcast(room, 'game-timeout');
  }
  // regista resultado (uma só vez) e atualiza estatísticas
  function finish(room, winner) {
    const g = room.game;
    if (!g.winner) { g.winner = winner; g.turn = null; if (g.type === 'checkers') g.mustContinue = null; }
    if (room.finished) return;
    room.finished = true;
    clearTimers(room); room.turnStartedAt = null;
    if (g.winner === 'X' || g.winner === 'O') room.score[g.winner]++;
    const X = room.seats.X, O = room.seats.O;
    if (X && O && X.playerId !== O.playerId) {
      for (const [seat, s] of [['X', X], ['O', O]]) {
        const st = stats[s.playerId] || (stats[s.playerId] = { name: s.name, wins: 0, losses: 0, draws: 0 });
        st.name = s.name;
        if (g.winner === 'draw') st.draws++; else if (g.winner === seat) st.wins++; else st.losses++;
      }
      saveStats();
    }
  }
  function attachSeat(room, conn, symbol) {
    conn.roomCode = room.code; conn.symbol = symbol;
    if (symbol === 'S') room.spectators.add(conn); else room.seats[symbol].conn = conn;
    room.lastActive = Date.now();
  }
  function detach(conn, reason) {
    const room = rooms.get(conn.roomCode);
    if (!room) { conn.roomCode = null; conn.symbol = null; return; }
    const sym = conn.symbol;
    if (sym === 'S') { room.spectators.delete(conn); }
    else if (room.seats[sym] && room.seats[sym].conn === conn) {
      room.seats[sym].conn = null;
      if (reason === 'disconnect') {
        const g = room.game, bothSeated = room.seats.X && room.seats.O;
        if (bothSeated && !g.winner) {
          room.disconnected = sym; clearTimers(room); room.turnStartedAt = null;
          clearTimeout(room.seats[sym].grace);
          room.seats[sym].grace = setTimeout(() => forfeitAfterGrace(room, sym), GRACE_MS);
          room.seats[sym].grace.unref();
          broadcast(room, 'game-disconnected');
        }
      }
    }
    conn.roomCode = null; conn.symbol = null;
    room.lastActive = Date.now();
  }
  function forfeitAfterGrace(room, sym) {
    if (!rooms.has(room.code) || room.seats[sym] == null || room.seats[sym].conn) return;
    room.disconnected = null;
    if (!room.game.winner && room.seats.X && room.seats.O) finish(room, other(sym));
    removeSeat(room, sym);
    for (const c of members(room)) c.send({ type: 'game-left', symbol: sym });
    broadcast(room);
    maybeDelete(room);
  }
  function removeSeat(room, sym) {
    if (room.seats[sym]) clearTimeout(room.seats[sym].grace);
    room.seats[sym] = null;
  }
  function maybeDelete(room) {
    if (!room.seats.X && !room.seats.O) { clearTimers(room); rooms.delete(room.code); for (const c of room.spectators) { c.roomCode = null; c.symbol = null; c.send({ type: 'game-info', message: 'A sala foi encerrada.' }); } }
  }

  function leaveCurrent(conn) { if (conn.roomCode) leaveRoom(conn, false); }
  function createRoom(conn, m) {
    leaveCurrent(conn);
    const gameType = ['tictactoe', 'checkers', 'rps'].includes(m.gameType) ? m.gameType : null;
    if (!gameType) return err(conn, 'Jogo inválido.', 'bad-game');
    if (rooms.size >= 5000) return err(conn, 'Servidor cheio. Tenta mais tarde.', 'full');
    const code = genCode(); if (!code) return err(conn, 'Não foi possível criar a sala.');
    conn.name = clean(m.name, 24) || conn.name || 'Jogador';
    const room = { code, game: GAMES[gameType].create(), seats: { X: { playerId: conn.playerId, name: conn.name, team: clean(m.teamName, 40), conn: null, grace: null }, O: null },
      spectators: new Set(), score: { X: 0, O: 0 }, matchNumber: 1, timeouts: {}, disconnected: null, finished: false,
      turnStartedAt: null, turnTimer: null, lastActive: Date.now(), createdAt: Date.now(), lastMove: null };
    rooms.set(code, room);
    attachSeat(room, conn, 'X');
    conn.send({ type: 'game-created', roomCode: code, symbol: 'X', spectator: false, state: stateFor(room, 'X') });
  }
  function joinRoom(conn, m) {
    const code = clean(m.roomCode, 12).toUpperCase();
    const room = rooms.get(code);
    if (!room) return err(conn, 'Sala não encontrada. Confirma o código.', 'room-not-found');
    conn.name = clean(m.name, 24) || conn.name || 'Jogador';
    const mine = seatOf(room, conn.playerId);
    if (mine) return takeOverSeat(conn, room, mine, 'game-joined');
    if (conn.roomCode && conn.roomCode !== code) leaveCurrent(conn);
    if (!room.seats.O) {
      room.seats.O = { playerId: conn.playerId, name: conn.name, team: clean(m.teamName, 40), conn: null, grace: null };
      attachSeat(room, conn, 'O');
      conn.send({ type: 'game-joined', roomCode: code, symbol: 'O', spectator: false, state: stateFor(room, 'O') });
      for (const c of members(room)) if (c !== conn) c.send({ type: 'game-info', message: `🎮 ${conn.name} entrou na partida.` });
      armTurn(room); broadcast(room);
      return;
    }
    if (!room.seats.X) {                                                       // lugar X ficou livre
      room.seats.X = { playerId: conn.playerId, name: conn.name, team: clean(m.teamName, 40), conn: null, grace: null };
      attachSeat(room, conn, 'X');
      conn.send({ type: 'game-joined', roomCode: code, symbol: 'X', spectator: false, state: stateFor(room, 'X') });
      armTurn(room); broadcast(room);
      return;
    }
    if (room.spectators.size >= 30) return err(conn, 'A sala está cheia.', 'room-full');
    attachSeat(room, conn, 'S');
    conn.send({ type: 'game-joined', roomCode: code, symbol: 'S', spectator: true, state: stateFor(room, 'S') });
    broadcast(room);
  }
  function takeOverSeat(conn, room, sym, type) {
    const seat = room.seats[sym];
    if (seat.conn && seat.conn !== conn) { seat.conn.send({ type: 'game-info', message: 'Entraste nesta partida noutro dispositivo.' }); seat.conn.roomCode = null; seat.conn.symbol = null; }
    clearTimeout(seat.grace);
    seat.name = conn.name || seat.name;
    attachSeat(room, conn, sym);
    const wasDisc = room.disconnected === sym;
    if (wasDisc) room.disconnected = null;
    conn.send({ type, roomCode: room.code, symbol: sym, spectator: false, state: stateFor(room, sym) });
    if (wasDisc) { armTurn(room); for (const c of members(room)) if (c !== conn) c.send({ type: 'game-info', message: `✅ ${seat.name} voltou à partida.` }); }
    broadcast(room);
  }
  function rejoin(conn, m) {
    const room = rooms.get(clean(m.roomCode, 12).toUpperCase());
    if (!room) return err(conn, 'A partida já não existe.', 'room-not-found');
    conn.name = clean(m.name, 24) || conn.name;
    const mine = seatOf(room, conn.playerId);
    if (mine) return takeOverSeat(conn, room, mine, 'game-rejoined');
    if (conn.symbol === 'S' && conn.roomCode === room.code) return;
    attachSeat(room, conn, 'S');
    conn.send({ type: 'game-rejoined', roomCode: room.code, symbol: 'S', spectator: true, state: stateFor(room, 'S') });
  }
  function leaveRoom(conn, voluntary) {
    const room = rooms.get(conn.roomCode);
    if (!room) { conn.roomCode = null; conn.symbol = null; return; }
    const sym = conn.symbol;
    if (sym === 'S') { room.spectators.delete(conn); conn.roomCode = null; conn.symbol = null; broadcast(room); return; }
    const g = room.game;
    if (room.seats.X && room.seats.O && !g.winner) finish(room, other(sym));       // sair a meio = derrota
    if (room.disconnected === sym) room.disconnected = null;
    conn.roomCode = null; conn.symbol = null;
    removeSeat(room, sym);
    for (const c of members(room)) c.send({ type: 'game-left', symbol: sym });
    armTurn(room); broadcast(room); maybeDelete(room);
  }
  function move(conn, m) {
    const room = rooms.get(conn.roomCode);
    if (!room || conn.symbol === 'S' || !conn.symbol) return conn.send({ type: 'game-info', message: '👀 Os espectadores não podem jogar.' });
    if (!room.seats.X || !room.seats.O) return conn.send({ type: 'game-info', message: '⏳ Aguarda o adversário.' });
    if (room.disconnected) return conn.send({ type: 'game-info', message: '📡 Aguarda a reconexão do adversário.' });
    const g = room.game;
    const res = GAMES[g.type].move(g, conn.symbol, m);
    if (!res.ok) { conn.send({ type: 'game-info', message: res.error }); return conn.send({ type: 'game-state', state: stateFor(room, conn.symbol) }); }
    room.timeouts[conn.symbol] = 0;
    room.lastMove = res.last ? { by: conn.symbol, ...res.last } : null;
    room.lastActive = Date.now();
    if (g.winner) finish(room, g.winner);
    armTurn(room);
    broadcast(room);
  }
  function rematch(conn) {
    const room = rooms.get(conn.roomCode);
    if (!room || conn.symbol === 'S') return;
    if (!room.game.winner) return conn.send({ type: 'game-info', message: 'A partida ainda não terminou.' });
    if (!room.seats.X || !room.seats.O) return conn.send({ type: 'game-info', message: 'O adversário já saiu da sala.' });
    room.game = GAMES[room.game.type].create(); room.matchNumber++; room.finished = false; room.timeouts = {}; room.lastMove = null;
    armTurn(room); broadcast(room);
    for (const c of members(room)) if (c !== conn) c.send({ type: 'game-info', message: '🔁 Revanche iniciada.' });
  }

  /* ================= Chat e voz ================= */
  function view(msg, conn) { return { id: msg.id, name: msg.name, text: msg.text, at: msg.at, scope: 'general', isMe: msg.pid === conn.playerId }; }
  function chat(conn, m, kind) {
    const now = Date.now();
    conn.chatBurst = conn.chatBurst.filter(t => now - t < 10000);
    const text = clean(m.text, 300);
    if (!text) return;
    if (now - conn.lastChatAt < 600 || conn.chatBurst.length >= 8) return conn.send({ type: 'game-chat-error', message: 'Aguarda um momento antes de enviar outra mensagem.' });
    if (kind === 'game' && m.scope === 'team') return conn.send({ type: 'game-chat-error', message: '👥 O chat da equipa está disponível nos campeonatos.' });
    conn.lastChatAt = now; conn.chatBurst.push(now);
    const msg = { id: newId(), name: conn.name, text, at: new Date().toISOString(), pid: conn.playerId };
    globalChat.push(msg); if (globalChat.length > 100) globalChat.shift();
    for (const c of conns) if (c.authed && (c.globalJoined || c === conn)) c.send({ type: 'global-chat', message: view(msg, c) });
  }
  function relayVoice(conn, m) {
    const room = rooms.get(conn.roomCode);
    if (!room || conn.symbol === 'S' || !conn.symbol) return;
    const peer = room.seats[other(conn.symbol)];
    if (!peer || !peer.conn) return;
    if (m.type === 'game-voice') {
      const s = m.signal; if (!s || !['offer', 'answer', 'ice'].includes(s.type)) return;
      peer.conn.send({ type: 'game-voice', signal: s });
    } else if (m.type === 'game-voice-state') peer.conn.send({ type: 'game-voice-state', enabled: m.enabled !== false });
    else peer.conn.send({ type: 'game-voice-ready' });
  }

  /* ================= Limpeza e API REST ================= */
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const anyone = members(room).length > 0;
      if (!anyone && now - room.lastActive > EMPTY_ROOM_MS) { clearTimers(room); for (const s of ['X', 'O']) if (room.seats[s]) clearTimeout(room.seats[s].grace); rooms.delete(room.code); }
    }
  }, 60000);
  sweeper.unref();

  function ranking() {
    const list = Object.values(stats).map(s => {
      const games = s.wins + s.losses + s.draws;
      return { name: s.name, wins: s.wins, losses: s.losses, draws: s.draws, games, rate: games ? Math.round((s.wins / games) * 100) : 0 };
    }).filter(s => s.games > 0);
    list.sort((a, b) => b.wins - a.wins || b.rate - a.rate || a.games - b.games);
    return list.slice(0, 20);
  }
  function profile(playerId, fallbackName) {
    const s = stats[playerId];
    if (!s) return { name: fallbackName || 'Jogador', wins: 0, losses: 0, draws: 0, games: 0 };
    return { name: s.name, wins: s.wins, losses: s.losses, draws: s.draws, games: s.wins + s.losses + s.draws };
  }
  function shutdown() { clearInterval(heartbeat); clearInterval(sweeper); for (const c of [...conns]) c.close(1001); }
  return { ranking, profile, shutdown, _rooms: rooms };
}
module.exports = { attach };
