/* Testes unitários das regras.  node test/engine.test.js */
'use strict';
const { ticTacToe, rps, checkers } = require('../game-engine');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗ FALHOU:', n); } };
const empty = () => Array.from({ length: 8 }, () => Array(8).fill(null));
const W = (king = false) => ({ color: 1, king }), B = (king = false) => ({ color: 2, king });

console.log('\n● X Vs O');
let g = ticTacToe.create();
[[4,'X'],[0,'O'],[2,'X'],[6,'O'],[3,'X'],[5,'O'],[1,'X'],[7,'O'],[8,'X']].forEach(([c, s]) => ticTacToe.move(g, s, { cell: c }));
ok(g.winner === 'draw', 'empate com tabuleiro cheio');
g = ticTacToe.create();
ok(!ticTacToe.move(g, 'X', { cell: 9 }).ok && !ticTacToe.move(g, 'X', { cell: 'a' }).ok && !ticTacToe.move(g, 'X', { cell: 1.5 }).ok, 'rejeita células inválidas (9, "a", 1.5)');
[[0,'X'],[3,'O'],[1,'X'],[4,'O'],[2,'X']].forEach(([c, s]) => ticTacToe.move(g, s, { cell: c }));
ok(g.winner === 'X' && g.winningLine.join() === '0,1,2', 'linha horizontal');
g = ticTacToe.create(); [[0,'X'],[1,'O'],[4,'X'],[2,'O'],[8,'X']].forEach(([c, s]) => ticTacToe.move(g, s, { cell: c }));
ok(g.winner === 'X' && g.winningLine.join() === '0,4,8', 'diagonal');

console.log('\n● Pedra, Papel e Tesoura');
const outcomes = { 'rock,scissors': 'X', 'scissors,rock': 'O', 'paper,rock': 'X', 'rock,paper': 'O', 'scissors,paper': 'X', 'paper,scissors': 'O', 'rock,rock': 'draw', 'paper,paper': 'draw', 'scissors,scissors': 'draw' };
let allOk = true;
for (const [k, w] of Object.entries(outcomes)) { const [x, o] = k.split(','); const r = rps.create(); rps.move(r, 'X', { choice: x }); rps.move(r, 'O', { choice: o }); if (r.winner !== w) allOk = false; }
ok(allOk, 'as 9 combinações dão o resultado certo');

console.log('\n● Damas');
g = checkers.create();
ok(checkers.legalMoves(g, 2).length === 7, 'pretas também têm 7 jogadas na abertura');
// captura múltipla
g = { type: 'checkers', board: empty(), turn: 1, winner: null, mustContinue: null, quiet: 0 };
g.board[7][0] = W(); g.board[6][1] = B(); g.board[4][3] = B(); g.board[0][7] = B();
g.board[5][0] = null; g.board[7][0] = null; g.board[5][0] = W();
g.board[4][1] = B(); g.board[2][3] = B(); g.board[6][1] = null; g.board[4][3] = null;
let r1 = checkers.move(g, 'X', { from: { r: 5, c: 0 }, to: { r: 3, c: 2 } });
ok(r1.ok && g.mustContinue && g.mustContinue.r === 3 && g.turn === 1, 'após capturar, tem de continuar a saltar (mustContinue)');
let bad = checkers.move(g, 'X', { from: { r: 3, c: 2 }, to: { r: 2, c: 1 } });
ok(!bad.ok, 'não pode fazer um passo simples a meio de uma sequência');
let r2 = checkers.move(g, 'X', { from: { r: 3, c: 2 }, to: { r: 1, c: 4 } });
ok(r2.ok && g.board[2][3] === null && g.board[4][1] === null, 'segunda captura remove as duas peças');
// promoção e fim de turno
g = { type: 'checkers', board: empty(), turn: 1, winner: null, mustContinue: null, quiet: 0 };
g.board[1][2] = W(); g.board[2][5] = B();
checkers.move(g, 'X', { from: { r: 1, c: 2 }, to: { r: 0, c: 1 } });
ok(g.board[0][1].king === true && g.turn === 2, 'peão que chega ao fim vira dama e passa a vez');
// dama move para trás
g = { type: 'checkers', board: empty(), turn: 1, winner: null, mustContinue: null, quiet: 0 };
g.board[4][3] = W(true); g.board[0][1] = B();
ok(checkers.legalMoves(g, 1).some(m => m.to.r === 5), 'dama pode andar para trás');
g.board[4][3] = W(false);
ok(!checkers.legalMoves(g, 1).some(m => m.to.r === 5), 'peão não anda para trás');
// vitória por falta de jogadas
g = { type: 'checkers', board: empty(), turn: 1, winner: null, mustContinue: null, quiet: 0 };
g.board[2][1] = W(); g.board[1][0] = B();
checkers.move(g, 'X', { from: { r: 2, c: 1 }, to: { r: 0, c: 3 }, }); 
ok(!g.winner, 'salto inexistente não ganha o jogo');
g = { type: 'checkers', board: empty(), turn: 1, winner: null, mustContinue: null, quiet: 0 };
g.board[2][3] = W(); g.board[1][4] = B();
let r3 = checkers.move(g, 'X', { from: { r: 2, c: 3 }, to: { r: 0, c: 5 } });
ok(r3.ok && g.winner === 'X', 'capturar a última peça adversária ganha');
// empate por 50 jogadas de dama sem progresso
g = { type: 'checkers', board: empty(), turn: 1, winner: null, mustContinue: null, quiet: 49 };
g.board[7][0] = W(true); g.board[0][7] = B(true);
checkers.move(g, 'X', { from: { r: 7, c: 0 }, to: { r: 6, c: 1 } });
ok(g.winner === 'draw', 'empate após 50 jogadas só com damas');
// passTurn
g = checkers.create(); checkers.passTurn(g); ok(g.turn === 2, 'timeout passa a vez nas Damas');
console.log(`\nResultado: ${pass} passaram, ${fail} falharam`); process.exit(fail ? 1 : 0);
