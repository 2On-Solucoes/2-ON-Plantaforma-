/**
 * 2 ON Streaming — salas de 2 pessoas (anfitrião + convidado) e sinalização WebRTC.
 * Corre dentro do mesmo WebSocket de games.js (a ligação já vem autenticada com session-auth).
 *
 * cliente → servidor: create-room, join-room, rejoin-room, leave-room, offer, answer, ice-candidate,
 *                     chat, control, control-request, control-granted, control-denied, control-revoked,
 *                     reaction, typing, app-ping
 * servidor → cliente: room-created, room-joined, presence, peer-joined, peer-left, peer-disconnected-temp,
 *                     left-room, error, app-pong + as mensagens reencaminhadas
 *
 * O servidor é a autoridade: valida quem está na sala, o papel (host/viewer) e só deixa o convidado
 * controlar a reprodução depois de o anfitrião autorizar.
 */
'use strict';
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const GRACE_MS = Number(process.env.STREAM_GRACE_MS) || 60000;     // tempo para reconectar
const EMPTY_ROOM_MS = 10 * 60 * 1000;
const MAX_ROOMS = 2000;
const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 32 * 1024;

const TYPES = new Set(['create-room', 'join-room', 'rejoin-room', 'leave-room', 'offer', 'answer', 'ice-candidate',
  'chat', 'control', 'control-request', 'control-granted', 'control-denied', 'control-revoked',
  'reaction', 'typing', 'app-ping']);

const cleanName = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, 24);
const cleanCode = v => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* Copia JSON "limpo": sem chaves perigosas, profundidade e tamanho limitados. */
function sanitize(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map(v => sanitize(v, depth + 1));
  if (isObj(value)) {
    const out = {};
    for (const k of Object.keys(value).slice(0, 40)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = sanitize(value[k], depth + 1);
    }
    return out;
  }
  return null;
}

function createStreaming({ log = console } = {}) {
  const rooms = new Map();   // código → { code, host, viewer, controlGranted, emptySince }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const anyone = (room.host && room.host.conn) || (room.viewer && room.viewer.conn);
      if (anyone) { room.emptySince = null; continue; }
      if (!room.emptySince) room.emptySince = now;
      else if (now - room.emptySince > EMPTY_ROOM_MS) closeRoom(room);
    }
  }, 60000);
  sweeper.unref();

  /* ---------- utilitários ---------- */
  function genCode() {
    for (let i = 0; i < 50; i++) {
      let c = '';
      for (let k = 0; k < CODE_LENGTH; k++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }
  const err = (conn, message, extra) => conn.send(Object.assign({ type: 'error', message }, extra || {}));
  const seatOf = (room, role) => (role === 'host' ? room.host : room.viewer);
  const peerSeat = (room, role) => (role === 'host' ? room.viewer : room.host);
  const sendTo = (seat, msg) => { if (seat && seat.conn) seat.conn.send(msg); };

  function presence(room) {
    return {
      type: 'presence',
      code: room.code,
      hostName: room.host ? room.host.name : '',
      viewerName: room.viewer ? room.viewer.name : '',
      hasViewer: !!room.viewer
    };
  }
  function roomInfo(room, extra) {
    return Object.assign({
      code: room.code,
      hostName: room.host ? room.host.name : '',
      viewerName: room.viewer ? room.viewer.name : '',
      hasViewer: !!room.viewer
    }, extra || {});
  }
  function bind(conn, room, role) {
    conn.streamCode = room.code;
    conn.streamRole = role;
  }
  function unbind(conn) {
    conn.streamCode = null;
    conn.streamRole = null;
  }
  function currentRoom(conn) {
    const room = conn.streamCode ? rooms.get(conn.streamCode) : null;
    if (!room) return null;
    const seat = seatOf(room, conn.streamRole);
    if (!seat || seat.conn !== conn) return null;
    return room;
  }
  function closeRoom(room) {
    for (const role of ['host', 'viewer']) {
      const seat = seatOf(room, role);
      if (!seat) continue;
      clearTimeout(seat.grace);
      if (seat.conn) unbind(seat.conn);
    }
    rooms.delete(room.code);
  }

  /* Remove uma pessoa da sala (saiu ou esgotou o tempo de reconexão). */
  function removeSeat(room, role, notifyPeer = true) {
    const seat = seatOf(room, role);
    if (!seat) return;
    clearTimeout(seat.grace);
    if (seat.conn) unbind(seat.conn);
    if (role === 'host') {
      if (notifyPeer) sendTo(room.viewer, { type: 'peer-left' });
      closeRoom(room);
    } else {
      room.viewer = null;
      room.controlGranted = false;
      if (notifyPeer) {
        sendTo(room.host, { type: 'peer-left' });
        sendTo(room.host, presence(room));
      }
    }
  }

  /* ---------- ações ---------- */
  function createRoom(conn, m) {
    // idempotente: se já és anfitrião de uma sala aberta, devolve a mesma
    const mine = currentRoom(conn);
    if (mine && conn.streamRole === 'host') {
      return conn.send(Object.assign({ type: 'room-created' }, roomInfo(mine)));
    }
    if (mine) removeSeat(mine, conn.streamRole);
    if (rooms.size >= MAX_ROOMS) return err(conn, 'O servidor está cheio. Tenta daqui a pouco.');
    const code = genCode();
    if (!code) return err(conn, 'Não foi possível criar a sala. Tenta outra vez.');
    const name = cleanName(m.name) || conn.name || 'Anfitrião';
    const room = {
      code, controlGranted: false, emptySince: null,
      host: { playerId: conn.playerId, name, conn, grace: null },
      viewer: null
    };
    rooms.set(code, room);
    bind(conn, room, 'host');
    conn.send(Object.assign({ type: 'room-created' }, roomInfo(room)));
  }

  function joinRoom(conn, m) {
    const code = cleanCode(m.code);
    const room = rooms.get(code);
    if (!code || !room) return err(conn, 'Sala não encontrada. Confirma o código.');
    if (room.host.playerId === conn.playerId) return err(conn, 'Já és o anfitrião desta sala.');
    if (room.viewer && room.viewer.playerId === conn.playerId) return rejoinRoom(conn, { code, role: 'viewer', name: m.name });
    if (room.viewer) return err(conn, 'Esta sala já tem duas pessoas.');
    const mine = currentRoom(conn);
    if (mine) removeSeat(mine, conn.streamRole);
    const name = cleanName(m.name) || conn.name || 'Convidado';
    room.viewer = { playerId: conn.playerId, name, conn, grace: null };
    room.controlGranted = false;
    bind(conn, room, 'viewer');
    conn.send(Object.assign({ type: 'room-joined' }, roomInfo(room)));
    sendTo(room.host, presence(room));
    sendTo(room.host, { type: 'peer-joined' });
  }

  function rejoinRoom(conn, m) {
    const code = cleanCode(m.code);
    const role = m.role === 'host' ? 'host' : m.role === 'viewer' ? 'viewer' : null;
    const room = rooms.get(code);
    const seat = room && role ? seatOf(room, role) : null;
    if (!room || !seat || seat.playerId !== conn.playerId) {
      return err(conn, 'A sessão expirou. Cria ou entra numa nova sala.', { expired: true });
    }
    const name = cleanName(m.name);
    if (name) seat.name = name;
    clearTimeout(seat.grace);
    const same = seat.conn === conn;
    if (seat.conn && !same) unbind(seat.conn);   // ligação antiga fica de parte
    seat.conn = conn;
    bind(conn, room, role);
    conn.send(Object.assign({ type: role === 'host' ? 'room-created' : 'room-joined' }, roomInfo(room, { rejoined: true })));
    if (!same) {
      const other = peerSeat(room, role);
      if (other && other.conn) {
        other.conn.send(presence(room));
        other.conn.send({ type: 'peer-joined', rejoined: true });
      }
    }
  }

  function leaveRoom(conn) {
    const room = currentRoom(conn);
    if (room) removeSeat(room, conn.streamRole);
    unbind(conn);
    conn.send({ type: 'left-room' });
  }

  /* ---------- reencaminhamento ---------- */
  function relay(conn, m) {
    const room = currentRoom(conn);
    if (!room) return;
    const role = conn.streamRole;
    const peer = peerSeat(room, role);
    const out = (msg) => { if (peer && peer.conn) peer.conn.send(msg); };
    const bytes = v => { try { return JSON.stringify(v).length; } catch { return Infinity; } };

    switch (m.type) {
      case 'offer':
        if (!isObj(m.offer) || typeof m.offer.sdp !== 'string' || bytes(m.offer) > MAX_SIGNAL_BYTES) return;
        return out({ type: 'offer', offer: { type: String(m.offer.type || 'offer').slice(0, 16), sdp: m.offer.sdp } });
      case 'answer':
        if (!isObj(m.answer) || typeof m.answer.sdp !== 'string' || bytes(m.answer) > MAX_SIGNAL_BYTES) return;
        return out({ type: 'answer', answer: { type: String(m.answer.type || 'answer').slice(0, 16), sdp: m.answer.sdp } });
      case 'ice-candidate':
        if (m.candidate !== null && (!isObj(m.candidate) || bytes(m.candidate) > 8 * 1024)) return;
        return out({ type: 'ice-candidate', candidate: m.candidate === null ? null : sanitize(m.candidate) });
      case 'chat': {
        const now = Date.now();
        conn.stChat = (conn.stChat || []).filter(t => now - t < 10000);
        if (conn.stChat.length >= 15) return;
        conn.stChat.push(now);
        const text = String(m.text == null ? '' : m.text).trim().slice(0, 1000);
        if (!text) return;
        return out({ type: 'chat', text });
      }
      case 'control': {
        if (role === 'viewer' && !room.controlGranted) return;       // só com autorização do anfitrião
        if (typeof m.action !== 'string' || m.action.length > 40 || bytes(m) > MAX_CONTROL_BYTES) return;
        const msg = sanitize(m);
        msg.type = 'control';
        return out(msg);
      }
      case 'control-request':
        if (role !== 'viewer') return;
        return out({ type: 'control-request', name: room.viewer ? room.viewer.name : 'A outra pessoa' });
      case 'control-granted':
        if (role !== 'host') return;
        room.controlGranted = true;
        return out({ type: 'control-granted' });
      case 'control-denied':
        if (role !== 'host') return;
        room.controlGranted = false;
        return out({ type: 'control-denied' });
      case 'control-revoked':
        if (role !== 'host') return;
        room.controlGranted = false;
        return out({ type: 'control-revoked' });
      case 'reaction': {
        const emoji = String(m.emoji == null ? '' : m.emoji).slice(0, 16);
        if (!emoji) return;
        return out({ type: 'reaction', emoji });
      }
      case 'typing':
        return out({ type: 'typing' });
      default:
    }
  }

  /* ---------- ponto de entrada ---------- */
  function handle(conn, m) {
    if (!TYPES.has(m.type)) return false;
    switch (m.type) {
      case 'create-room': createRoom(conn, m); break;
      case 'join-room': joinRoom(conn, m); break;
      case 'rejoin-room': rejoinRoom(conn, m); break;
      case 'leave-room': leaveRoom(conn); break;
      case 'app-ping': conn.send({ type: 'app-pong', t: typeof m.t === 'number' ? m.t : null }); break;
      default: relay(conn, m);
    }
    return true;
  }

  function onClose(conn) {
    const room = currentRoom(conn);
    if (!room) return;
    const role = conn.streamRole;
    const seat = seatOf(room, role);
    seat.conn = null;
    unbind(conn);
    sendTo(peerSeat(room, role), { type: 'peer-disconnected-temp' });
    clearTimeout(seat.grace);
    seat.grace = setTimeout(() => {
      const r = rooms.get(room.code);
      if (r && seatOf(r, role) === seat && !seat.conn) removeSeat(r, role);
    }, GRACE_MS);
    seat.grace.unref();
  }

  function shutdown() {
    clearInterval(sweeper);
    for (const room of rooms.values()) { for (const r of ['host', 'viewer']) { const s = seatOf(room, r); if (s) clearTimeout(s.grace); } }
    rooms.clear();
  }

  return { handle, onClose, shutdown, _rooms: rooms };
}

module.exports = { createStreaming };
