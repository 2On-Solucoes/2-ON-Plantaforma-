/**
 * Regras dos jogos (funções puras, sem rede). Servidor-autoritativo:
 * o cliente só envia intenções; tudo é validado aqui.
 */
'use strict';

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const other = s => (s === 'X' ? 'O' : 'X');

/* ---------------- X Vs O ---------------- */
const ticTacToe = {
  create: () => ({ type: 'tictactoe', board: Array(9).fill(null), turn: null, winner: null, winningLine: null }),
  move(g, sym, m) {
    if (g.winner) return { ok: false, error: 'A partida já terminou.' };
    const cell = m && m.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) return { ok: false, error: 'Jogada inválida.' };
    if (g.turn && g.turn !== sym) return { ok: false, error: 'Não é a tua vez.' };
    if (g.board[cell]) return { ok: false, error: 'Essa casa já está ocupada.' };
    g.board[cell] = sym;
    for (const l of LINES) {
      if (g.board[l[0]] && g.board[l[0]] === g.board[l[1]] && g.board[l[0]] === g.board[l[2]]) {
        g.winner = sym; g.winningLine = l; g.turn = null; return { ok: true, last: { cell } };
      }
    }
    if (g.board.every(Boolean)) { g.winner = 'draw'; g.turn = null; return { ok: true, last: { cell } }; }
    g.turn = other(sym);
    return { ok: true, last: { cell } };
  },
  passTurn(g) { if (!g.winner && g.turn) g.turn = other(g.turn); else if (!g.winner) g.turn = 'O'; }
};

/* ---------------- Pedra, Papel e Tesoura ---------------- */
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const rps = {
  create: () => ({ type: 'rps', choices: { X: null, O: null }, winner: null, revealed: null, turn: null }),
  move(g, sym, m) {
    if (g.winner) return { ok: false, error: 'A ronda já terminou.' };
    const c = m && m.choice;
    if (!BEATS[c]) return { ok: false, error: 'Escolha inválida.' };
    if (g.choices[sym]) return { ok: false, error: 'Já escolheste nesta ronda.' };
    g.choices[sym] = c;
    if (g.choices.X && g.choices.O) {
      const x = g.choices.X, o = g.choices.O;
      g.winner = x === o ? 'draw' : (BEATS[x] === o ? 'X' : 'O');
      g.revealed = { X: x, O: o };
    }
    return { ok: true };
  }
};

/* ---------------- Damas (regras inglesas, captura obrigatória) ----------------
 * color 1 = brancas (X), começam em baixo e sobem; color 2 = pretas (O), descem.
 * Peões movem/capturam só para a frente; damas (♛) em todas as diagonais.
 * Captura obrigatória; capturas múltiplas com a mesma peça (mustContinue).
 */
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const checkers = {
  create() {
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 !== 1) continue;
      if (r < 3) board[r][c] = { color: 2, king: false };
      else if (r > 4) board[r][c] = { color: 1, king: false };
    }
    return { type: 'checkers', board, turn: 1, winner: null, mustContinue: null, quiet: 0 };
  },
  dirs(p) {
    const fwd = p.color === 1 ? -1 : 1;
    return p.king ? [[fwd, -1], [fwd, 1], [-fwd, -1], [-fwd, 1]] : [[fwd, -1], [fwd, 1]];
  },
  capturesFor(g, r, c) {
    const p = g.board[r][c], out = [];
    if (!p) return out;
    for (const [dr, dc] of checkers.dirs(p)) {
      const mr = r + dr, mc = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
      if (!inB(lr, lc)) continue;
      const mid = g.board[mr][mc];
      if (mid && mid.color !== p.color && !g.board[lr][lc])
        out.push({ from: { r, c }, to: { r: lr, c: lc }, capture: { r: mr, c: mc } });
    }
    return out;
  },
  stepsFor(g, r, c) {
    const p = g.board[r][c], out = [];
    if (!p) return out;
    for (const [dr, dc] of checkers.dirs(p)) {
      const nr = r + dr, nc = c + dc;
      if (inB(nr, nc) && !g.board[nr][nc]) out.push({ from: { r, c }, to: { r: nr, c: nc } });
    }
    return out;
  },
  legalMoves(g, color) {
    if (g.winner) return [];
    if (g.mustContinue) return checkers.capturesFor(g, g.mustContinue.r, g.mustContinue.c);
    let caps = [], steps = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = g.board[r][c];
      if (!p || p.color !== color) continue;
      caps = caps.concat(checkers.capturesFor(g, r, c));
      steps = steps.concat(checkers.stepsFor(g, r, c));
    }
    return caps.length ? caps : steps;
  },
  move(g, sym, m) {
    if (g.winner) return { ok: false, error: 'A partida já terminou.' };
    const color = sym === 'X' ? 1 : 2;
    if (g.turn !== color) return { ok: false, error: 'Não é a tua vez.' };
    const f = m && m.from, t = m && m.to;
    if (![f && f.r, f && f.c, t && t.r, t && t.c].every(Number.isInteger)) return { ok: false, error: 'Jogada inválida.' };
    const mv = checkers.legalMoves(g, color).find(x => x.from.r === f.r && x.from.c === f.c && x.to.r === t.r && x.to.c === t.c);
    if (!mv) return { ok: false, error: checkers.legalMoves(g, color).some(x => x.capture) ? 'Tens de capturar.' : 'Essa jogada não é válida.' };
    const piece = g.board[mv.from.r][mv.from.c];
    g.board[mv.from.r][mv.from.c] = null;
    g.board[mv.to.r][mv.to.c] = piece;
    let promoted = false;
    if (mv.capture) g.board[mv.capture.r][mv.capture.c] = null;
    if (!piece.king && ((color === 1 && mv.to.r === 0) || (color === 2 && mv.to.r === 7))) { piece.king = true; promoted = true; }
    g.quiet = (mv.capture || !piece.king || promoted) ? 0 : g.quiet + 1;
    g.mustContinue = null;
    if (mv.capture && !promoted && checkers.capturesFor(g, mv.to.r, mv.to.c).length) {
      g.mustContinue = { r: mv.to.r, c: mv.to.c };               // continua a saltar
    } else {
      g.turn = color === 1 ? 2 : 1;
      if (!checkers.legalMoves(g, g.turn).length) { g.winner = sym; g.turn = null; }   // sem peças ou sem jogadas
      else if (g.quiet >= 50) { g.winner = 'draw'; g.turn = null; }
    }
    return { ok: true, last: { from: mv.from, to: mv.to, capture: mv.capture || null } };
  },
  passTurn(g) {
    if (g.winner) return;
    g.mustContinue = null;
    g.turn = g.turn === 1 ? 2 : 1;
    if (!checkers.legalMoves(g, g.turn).length) { g.winner = g.turn === 1 ? 'O' : 'X'; g.turn = null; }
  }
};

const GAMES = { tictactoe: ticTacToe, rps, checkers };
module.exports = { GAMES, ticTacToe, rps, checkers, other };
