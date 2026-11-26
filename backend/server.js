/**
 * 2 ON — Backend (sem dependências externas: só módulos nativos do Node 18+)
 *
 *  GET  /api/status | /api/version | /api/notifications | /ice-servers | /health
 *  POST /api/session                      sessão (token guardado e validado no servidor)
 *  POST /api/suggestions                  receber sugestões
 *  POST /api/admin/login                  devolve um token de sessão (expira em 8 h)
 *  POST /api/admin/logout
 *  POST /api/admin/version | /api/admin/notify
 *  GET  /api/admin/suggestions
 *  POST /api/admin/suggestions/:id/read | /api/admin/suggestions/:id/delete
 *  (as rotas /api/admin/* exigem  Authorization: Bearer <token>)
 *
 * Partidas em tempo real (WebSocket): ver games.js e game-engine.js.
 *
 * Variáveis de ambiente (ver README, secção "Segurança"):
 *  PORT, ADMIN_PASSWORD (mín. 8 car.), DATA_DIR, ALLOWED_ORIGINS, TRUST_PROXY_HOPS,
 *  FORCE_HTTPS, DISABLE_CSP, RETENTION_DAYS, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL, TURN_SECRET
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 180;
const TRUST_HOPS = process.env.TRUST_PROXY_HOPS !== undefined ? Number(process.env.TRUST_PROXY_HOPS) : (process.env.RENDER ? 1 : 0);
const FORCE_HTTPS = process.env.FORCE_HTTPS === '1';
const DISABLE_CSP = process.env.DISABLE_CSP === '1';
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const PLAYER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

// ---------- palavra-passe do admin: nunca por defeito ----------
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
let passwordGenerated = false;
if (ADMIN_PASSWORD.length < 8) {
  if (ADMIN_PASSWORD) console.warn('AVISO: ADMIN_PASSWORD tem menos de 8 caracteres — ignorada.');
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  passwordGenerated = true;
}

const FILES = {
  version: path.join(DATA_DIR, 'version.json'),
  suggestions: path.join(DATA_DIR, 'suggestions.json'),
  notifications: path.join(DATA_DIR, 'notifications.json')
};
fs.mkdirSync(DATA_DIR, { recursive: true });
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
if (!fs.existsSync(FILES.version)) writeJSON(FILES.version, {
  version: '1.0.0', versionCode: 1, force: false, title: '2 ON',
  message: 'Estás na versão mais recente.',
  downloadUrl: 'https://play.google.com/store/apps/details?id=com.twoon.platform', changelog: []
});
if (!fs.existsSync(FILES.suggestions)) writeJSON(FILES.suggestions, []);
if (!fs.existsSync(FILES.notifications)) writeJSON(FILES.notifications, []);

// retenção: apaga sugestões antigas (privacidade)
function purgeOldSuggestions() {
  const limit = Date.now() - RETENTION_DAYS * 86400000;
  const list = readJSON(FILES.suggestions, []);
  const kept = list.filter(s => !s.createdAt || Date.parse(s.createdAt) >= limit);
  if (kept.length !== list.length) { writeJSON(FILES.suggestions, kept); console.log(`[retenção] ${list.length - kept.length} sugestões antigas apagadas`); }
}
purgeOldSuggestions();
setInterval(purgeOldSuggestions, 24 * 3600 * 1000).unref();

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};
const ALLOWED_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']
  .concat((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)));

function clientIp(req) {
  if (TRUST_HOPS > 0) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xf.length >= TRUST_HOPS) return xf[xf.length - TRUST_HOPS];
  }
  return req.socket.remoteAddress || '?';
}
function corsHeaders(req, pathname) {
  // O Admin nunca aceita pedidos de outras origens.
  if (pathname.startsWith('/api/admin/')) return {};
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) return {
    'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };
  return {};
}
function securityHeaders(req, pathname) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': pathname.startsWith('/admin') ? 'DENY' : 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
  if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted)
    h['Strict-Transport-Security'] = 'max-age=15552000; includeSubDomains';
  if (!DISABLE_CSP) h['Content-Security-Policy'] = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https://i.ytimg.com https://img.youtube.com",
    "media-src 'self' blob: data:",
    "connect-src 'self' ws: wss: https://www.youtube.com",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    pathname.startsWith('/admin') ? "frame-ancestors 'none'" : "frame-ancestors 'self'"
  ].join('; ');
  return h;
}
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function bearer(req) { const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || ''); return m ? m[1] : ''; }
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Pedido demasiado grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(o && typeof o === 'object' ? o : {}); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const hits = new Map();
function limited(key, max) {                         // N pedidos por minuto
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 60000).unref();
const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const cleanText = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

// ---------- sessões (em memória) ----------
const adminSessions = new Map();   // token -> expira
const playerSessions = new Map();  // token -> { playerId, name, exp }
function pruneSessions() {
  const now = Date.now();
  for (const [t, e] of adminSessions) if (e < now) adminSessions.delete(t);
  for (const [t, s] of playerSessions) if (s.exp < now) playerSessions.delete(t);
  while (playerSessions.size > 20000) playerSessions.delete(playerSessions.keys().next().value);
}
setInterval(pruneSessions, 10 * 60 * 1000).unref();
function isAdmin(req) {
  const t = bearer(req); const exp = adminSessions.get(t);
  if (!t || !exp) return false;
  if (exp < Date.now()) { adminSessions.delete(t); return false; }
  return true;
}
function validDownloadUrl(u) { return /^(https?:\/\/|market:\/\/)[^\s<>"']+$/i.test(u); }

let games = null;      // servidor de partidas (ligado mais abaixo)

// ---------- API ----------
async function handleApi(req, res, pathname) {
  const m = req.method, ip = clientIp(req);

  if (pathname === '/api/status' && m === 'GET') {
    const v = readJSON(FILES.version, {});
    return sendJSON(res, 200, { ok: true, version: v.version || '1.0.0', name: '2 ON Backend' });
  }
  if (pathname === '/api/version' && m === 'GET') return sendJSON(res, 200, readJSON(FILES.version, {}));
  if (pathname === '/api/notifications' && m === 'GET')
    return sendJSON(res, 200, { notifications: readJSON(FILES.notifications, []).slice(0, 30) });

  if (pathname === '/api/session' && m === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const name = cleanText(b.name, 40) || 'Jogador';
    const existing = playerSessions.get(bearer(req));
    if (existing && existing.exp > Date.now()) {
      existing.name = name; existing.exp = Date.now() + PLAYER_SESSION_MS;
      return sendJSON(res, 200, { playerId: existing.playerId, token: bearer(req), name });
    }
    if (limited('sess:' + ip, 30)) return sendJSON(res, 429, { error: 'Demasiados pedidos. Tenta daqui a um minuto.' });
    const token = 't_' + crypto.randomBytes(24).toString('hex'), playerId = 'p_' + newId();
    playerSessions.set(token, { playerId, name, exp: Date.now() + PLAYER_SESSION_MS });
    return sendJSON(res, 200, { playerId, token, name });
  }

  if (pathname === '/api/suggestions' && m === 'POST') {
    if (limited('sug:' + ip, 10)) return sendJSON(res, 429, { error: 'Demasiados pedidos. Tenta daqui a um minuto.' });
    const b = await readBody(req);
    const text = cleanText(b.text, 2000);
    if (text.length < 3) return sendJSON(res, 400, { error: 'Sugestão demasiado curta' });
    const list = readJSON(FILES.suggestions, []);
    const item = {
      id: newId(), text, name: cleanText(b.name, 80) || null, contact: cleanText(b.contact, 120) || null,
      source: cleanText(b.source, 20) || 'app', createdAt: new Date().toISOString(), read: false
    };
    list.unshift(item);
    writeJSON(FILES.suggestions, list.slice(0, 500));
    console.log('[suggestion] nova sugestão');
    return sendJSON(res, 200, { ok: true, id: item.id });
  }

  // ----- admin -----
  if (pathname.startsWith('/api/admin/')) {
    if (pathname === '/api/admin/login' && m === 'POST') {
      if (limited('login:' + ip, 8) || limited('login:*', 60))
        return sendJSON(res, 429, { error: 'Demasiadas tentativas. Aguarda um minuto.' });
      const b = await readBody(req);
      if (!safeEqual(b.password || '', ADMIN_PASSWORD)) {
        console.warn('[login] tentativa falhada de', ip);
        return sendJSON(res, 401, { error: 'Palavra-passe incorreta' });
      }
      pruneSessions();
      const token = 'a_' + crypto.randomBytes(24).toString('hex');
      adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
      return sendJSON(res, 200, { ok: true, token, expiresIn: ADMIN_SESSION_MS / 1000 });
    }
    if (!isAdmin(req)) return sendJSON(res, 401, { error: 'Não autorizado' });

    if (pathname === '/api/admin/logout' && m === 'POST') { adminSessions.delete(bearer(req)); return sendJSON(res, 200, { ok: true }); }
    if (pathname === '/api/admin/version' && m === 'POST') {
      const b = await readBody(req); const cur = readJSON(FILES.version, {});
      const url = cleanText(b.downloadUrl, 500);
      if (url && !validDownloadUrl(url)) return sendJSON(res, 400, { error: 'Link inválido (usa http:// ou https://).' });
      const changelog = Array.isArray(b.changelog) ? b.changelog : String(b.changelog || '').split('\n');
      const updated = {
        version: /^\d+(\.\d+){0,3}$/.test(String(b.version || '')) ? String(b.version) : (cur.version || '1.0.0'),
        versionCode: Number(b.versionCode) || cur.versionCode || 1,
        force: !!b.force,
        title: cleanText(b.title, 120) || 'Nova versão disponível',
        message: cleanText(b.message, 500),
        downloadUrl: url || cur.downloadUrl || '',
        changelog: changelog.map(s => cleanText(s, 200)).filter(Boolean).slice(0, 30),
        updatedAt: new Date().toISOString()
      };
      writeJSON(FILES.version, updated);
      console.log('[version] Atualizada para', updated.version);
      return sendJSON(res, 200, { ok: true, version: updated });
    }
    if (pathname === '/api/admin/notify' && m === 'POST') {
      const b = await readBody(req);
      const title = cleanText(b.title, 120), body = cleanText(b.body, 500);
      if (!title || !body) return sendJSON(res, 400, { error: 'Título e mensagem obrigatórios' });
      const list = readJSON(FILES.notifications, []);
      const item = { id: newId(), title, body, type: ['info', 'update', 'alert'].includes(b.type) ? b.type : 'info', createdAt: new Date().toISOString() };
      list.unshift(item); writeJSON(FILES.notifications, list.slice(0, 100));
      console.log('[notify]', item.title);
      return sendJSON(res, 200, { ok: true, notification: item, message: 'Notificação registada. (Push real requer Firebase — ver README)' });
    }
    if (pathname === '/api/admin/suggestions' && m === 'GET') {
      const list = readJSON(FILES.suggestions, []);
      return sendJSON(res, 200, { suggestions: list, total: list.length });
    }
    const mm = pathname.match(/^\/api\/admin\/suggestions\/([\w-]+)\/(read|delete)$/);
    if (mm && m === 'POST') {
      const list = readJSON(FILES.suggestions, []);
      const i = list.findIndex(x => x.id === mm[1]);
      if (i === -1) return sendJSON(res, 404, { error: 'Não encontrada' });
      if (mm[2] === 'read') list[i].read = true; else list.splice(i, 1);
      writeJSON(FILES.suggestions, list);
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 404, { error: 'Rota não encontrada' });
  }

  // ----- compatibilidade com Games/Streaming (sem multiplayer neste backend) -----
  if (pathname === '/api/games/ranking' && m === 'GET') return sendJSON(res, 200, { ranking: games ? games.ranking() : [] });
  if (pathname === '/api/games/profile/me' && m === 'GET') {
    const ps = playerSessions.get(bearer(req));
    return sendJSON(res, 200, games && ps ? games.profile(ps.playerId, ps.name) : { name: 'Jogador', wins: 0, losses: 0, draws: 0, games: 0 });
  }
  if (pathname === '/api/games/championships' && m === 'GET') return sendJSON(res, 200, { championships: [] });
  if (pathname.startsWith('/api/games/')) return sendJSON(res, 503, { error: 'Campeonatos ainda não estão disponíveis neste servidor.' });
  return sendJSON(res, 404, { error: 'Rota não encontrada' });
}

function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  const urls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (urls.length) {
    if (process.env.TURN_SECRET) {                   // credenciais temporárias (coturn use-auth-secret)
      const username = String(Math.floor(Date.now() / 1000) + 3600);
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      list.push({ urls, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      list.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  }
  return list;
}

// ---------- ficheiros estáticos ----------
function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    const ext = path.extname(file).toLowerCase(), base = path.basename(file);
    const noCache = ext === '.html' || base === 'sw.js' || base === 'manifest.json';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      ...(base === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {})
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}
function notFound(req, res) {
  const index = path.join(FRONTEND_DIR, 'index.html');
  if ((req.headers.accept || '').includes('text/html') && fs.existsSync(index)) {
    res.writeHead(404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    return fs.createReadStream(index).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Ficheiro não encontrado');
}
const BLOCKED_EXT = new Set(['.md', '.map', '.example']);
function handleStatic(req, res, pathname) {
  if (!fs.existsSync(FRONTEND_DIR)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Pasta "frontend" não encontrada ao lado de "backend". Faz deploy do projeto completo.');
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return notFound(req, res); }
  if (rel.includes('\0') || rel.split('/').some(s => s.startsWith('.'))) return notFound(req, res);
  const file = path.normalize(path.join(FRONTEND_DIR, rel));
  if (file !== FRONTEND_DIR && !file.startsWith(FRONTEND_DIR + path.sep)) return notFound(req, res);
  if (BLOCKED_EXT.has(path.extname(file).toLowerCase()) || /version\.example\.json$/.test(file)) return notFound(req, res);
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { Location: pathname + '/' }); return res.end(); }
      return serveFile(req, res, path.join(file, 'index.html'));
    }
    if (err && !path.extname(file) && fs.existsSync(file + '.html')) return serveFile(req, res, file + '.html');
    return serveFile(req, res, file);
  });
}

// ---------- servidor ----------
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://x').pathname;
    for (const [k, v] of Object.entries({ ...securityHeaders(req, pathname), ...corsHeaders(req, pathname) })) res.setHeader(k, v);
    if (FORCE_HTTPS && req.headers['x-forwarded-proto'] === 'http' && pathname !== '/health') {
      res.writeHead(301, { Location: 'https://' + req.headers.host + req.url }); return res.end();
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (pathname === '/health') return sendJSON(res, 200, { ok: true });
    if (pathname === '/ice-servers' && req.method === 'GET') return sendJSON(res, 200, iceServers());
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'Método não permitido' });
    return handleStatic(req, res, pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[erro]', e);
    if (!res.headersSent) sendJSON(res, status, { error: status === 500 ? 'Erro interno do servidor' : e.message });
    else res.end();
  }
});
games = require('./games').attach(server, {
  playerSessions, dataDir: DATA_DIR, clientIp,
  isAllowedOrigin: o => ALLOWED_ORIGINS.has(o)
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { games.shutdown(); } catch {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
server.on('clientError', (e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
server.listen(PORT, '0.0.0.0', () => {
  console.log(`2 ON — Backend a correr em http://localhost:${PORT}  (admin: /admin.html)`);
  if (passwordGenerated) {
    console.warn('AVISO: ADMIN_PASSWORD não definida. Palavra-passe TEMPORÁRIA do admin (muda a cada arranque):');
    console.warn('       ' + ADMIN_PASSWORD);
    console.warn('       Define ADMIN_PASSWORD (mín. 8 caracteres) nas variáveis de ambiente.');
  }
});
