// Servidor del modo online: sirve la versión web del simulador, guarda la
// biblioteca de cartas publicada y gestiona las salas por WebSocket.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
// En Railway, si hay un volumen montado, la biblioteca se guarda ahí
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'server-data'),
);
const LIB_DIR = path.join(DATA_DIR, 'library');
const IMG_DIR = path.join(LIB_DIR, 'images');
const LIB_FILE = path.join(LIB_DIR, 'library.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

fs.mkdirSync(IMG_DIR, { recursive: true });

// ---------------- Historial de partidas ----------------

let results = loadResults();

function loadResults() {
  try {
    const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveResult(result) {
  results.push(result);
  if (results.length > 5000) results = results.slice(-5000);
  fs.writeFile(RESULTS_FILE, JSON.stringify(results), (err) => {
    if (err) console.error('No se pudo guardar el historial:', err.message);
  });
}

// ---------------- Biblioteca de cartas ----------------

let library = loadLibrary();

function loadLibrary() {
  try {
    const data = JSON.parse(fs.readFileSync(LIB_FILE, 'utf8'));
    return {
      deckNames: data.deckNames || {},
      templates: Array.isArray(data.templates) ? data.templates : [],
      backs: data.backs || {},
      updatedAt: data.updatedAt || 0,
    };
  } catch {
    return { deckNames: {}, templates: [], backs: {}, updatedAt: 0 };
  }
}

function publicLibrary() {
  return {
    deckNames: library.deckNames,
    templates: library.templates.map((t) => ({
      id: t.id,
      name: t.name,
      deckId: t.deckId,
      backType: t.backType,
      quantity: t.quantity,
      isSpecial: !!t.isSpecial,
      isLife: !!t.isLife,
      imageUrl: t.image ? `/media/${t.image}?v=${library.updatedAt}` : undefined,
    })),
    backs: Object.fromEntries(
      Object.entries(library.backs).map(([k, file]) => [k, `/media/${file}?v=${library.updatedAt}`]),
    ),
    updatedAt: library.updatedAt,
  };
}

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,120}$/;

function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const given = String(req.headers['x-admin-key'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------- HTTP ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function cors(res) {
  // La app de escritorio (file://) también habla con este servidor
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
}

function sendJson(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveFile(res, filePath, cacheControl) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    cors(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/health') return sendJson(res, 200, { ok: true, rooms: rooms.size });

  if (pathname === '/api/results' && req.method === 'GET') return sendJson(res, 200, { results });

  // Mensajes de voz de una sala (solo los conoce quien tiene el código de la sala)
  if (pathname === '/api/audio' && req.method === 'GET') {
    const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
    const clip = room?.audios?.get(String(url.searchParams.get('id') || ''));
    if (!clip) return sendJson(res, 404, { error: 'No existe ese audio.' });
    cors(res);
    res.writeHead(200, { 'Content-Type': clip.mime, 'Content-Length': clip.data.length, 'Cache-Control': 'private, max-age=86400' });
    res.end(clip.data);
    return;
  }

  if (pathname === '/api/library' && req.method === 'GET') {
    return sendJson(res, 200, publicLibrary());
  }

  if (pathname === '/api/admin/check' && req.method === 'GET') {
    if (!ADMIN_KEY) return sendJson(res, 503, { error: 'El servidor no tiene ADMIN_KEY configurada' });
    return isAdmin(req) ? sendJson(res, 200, { ok: true }) : sendJson(res, 401, { error: 'Clave incorrecta' });
  }

  // Subida de una imagen de la biblioteca (solo con la clave de administrador)
  if (pathname.startsWith('/api/library/images/') && req.method === 'PUT') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'Clave de administrador incorrecta' });
    const name = pathname.slice('/api/library/images/'.length);
    if (!SAFE_NAME.test(name) || !/\.(webp|png|jpe?g)$/i.test(name)) {
      return sendJson(res, 400, { error: 'Nombre de imagen no válido' });
    }
    try {
      const body = await readBody(req, MAX_IMAGE_BYTES);
      fs.writeFileSync(path.join(IMG_DIR, name), body);
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 413, { error: 'Imagen demasiado grande' });
    }
  }

  // Sustituye los datos de la biblioteca (mazos, cartas y reversos)
  if (pathname === '/api/library' && req.method === 'PUT') {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'Clave de administrador incorrecta' });
    try {
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
      const deckNames = {};
      for (const [k, v] of Object.entries(body.deckNames || {})) {
        if (SAFE_NAME.test(k)) deckNames[k] = String(v).slice(0, 60);
      }
      const templates = (Array.isArray(body.templates) ? body.templates : [])
        .filter((t) => t && SAFE_NAME.test(t.id) && deckNames[t.deckId] && SAFE_NAME.test(t.image || ''))
        .map((t) => ({
          id: t.id,
          name: String(t.name || '').slice(0, 120),
          deckId: t.deckId,
          backType: t.backType === 'backB' ? 'backB' : 'backA',
          quantity: Math.max(1, Math.min(60, Number(t.quantity) || 1)),
          isSpecial: !!t.isSpecial,
          isLife: !!t.isLife,
          image: t.image,
        }));
      const backs = {};
      for (const [k, file] of Object.entries(body.backs || {})) {
        if (SAFE_NAME.test(k) && SAFE_NAME.test(String(file))) backs[k] = String(file);
      }
      const missing = [...templates.map((t) => t.image), ...Object.values(backs)].filter(
        (f) => !fs.existsSync(path.join(IMG_DIR, f)),
      );
      if (missing.length) return sendJson(res, 400, { error: `Faltan imágenes: ${missing.slice(0, 5).join(', ')}` });

      library = { deckNames, templates, backs, updatedAt: Date.now() };
      fs.writeFileSync(LIB_FILE, JSON.stringify(library, null, 2));

      // Borrar imágenes que ya no se usan
      const used = new Set([...templates.map((t) => t.image), ...Object.values(backs)]);
      for (const f of fs.readdirSync(IMG_DIR)) if (!used.has(f)) fs.unlinkSync(path.join(IMG_DIR, f));

      return sendJson(res, 200, publicLibrary());
    } catch (err) {
      console.error(err);
      return sendJson(res, 400, { error: 'Datos de biblioteca no válidos' });
    }
  }

  if (pathname.startsWith('/media/')) {
    const name = pathname.slice('/media/'.length);
    if (!SAFE_NAME.test(name)) {
      res.writeHead(404);
      res.end();
      return;
    }
    return serveFile(res, path.join(IMG_DIR, name), 'public, max-age=31536000, immutable');
  }

  // Versión web del simulador (compilada con `npm run build`)
  const filePath = path.join(DIST_DIR, pathname);
  if (filePath.startsWith(DIST_DIR) && pathname !== '/' && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const cache = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return serveFile(res, filePath, cache);
  }
  const indexPath = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return serveFile(res, indexPath, 'no-cache');
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Servidor de Aeterna Duellum en marcha (falta compilar la web con npm run build).');
}

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Error interno' });
  });
});

// ---------------- Salas (WebSocket) ----------------

const rooms = new Map(); // code -> { game, sockets: { p1?: ws, p2?: ws } }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastState(room, fx) {
  for (const seat of room.game.seats) {
    send(room.sockets[seat], { t: 'state', state: room.game.viewFor(seat), fx });
  }
}

function attach(ws, room, seat) {
  const old = room.sockets[seat];
  if (old && old !== ws) {
    send(old, { t: 'kicked', message: 'Has abierto esta partida en otra ventana.' });
    old.close();
  }
  room.sockets[seat] = ws;
  room.game.players[seat].connected = true;
  room.game.players[seat].visible = true; // la ventana avisa enseguida si no está a la vista
  ws.room = room;
  ws.seat = seat;
}

// Mensaje de voz: el audio se guarda aparte (los últimos de la sala) y en el chat solo va su ficha
const VOICE_MAX_SECONDS = 60;
const VOICE_MAX_BYTES = 700 * 1024;
const VOICE_KEEP = 40;
function receiveVoice(room, seat, msg) {
  const m = /^data:(audio\/[\w.+-]+)(?:;[^,]*)?;base64,(.+)$/.exec(String(msg.data || ''));
  if (!m) throw new Error('Audio no válido.');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || data.length > VOICE_MAX_BYTES) throw new Error('El audio es demasiado largo.');
  const dur = Math.max(0.1, Math.min(VOICE_MAX_SECONDS, Number(msg.dur) || 0));
  const wave = (Array.isArray(msg.wave) ? msg.wave : []).slice(0, 64).map((v) => Math.max(0, Math.min(1, Number(v) || 0)));
  const id = crypto.randomUUID();
  room.audios = room.audios || new Map();
  room.audios.set(id, { mime: m[1], data });
  while (room.audios.size > VOICE_KEEP) room.audios.delete(room.audios.keys().next().value);
  const game = room.game;
  game.addLog(`${game.nameOf(seat)}: mensaje de voz`, 'chat', seat);
  game.log[game.log.length - 1].audio = { id, dur: Math.round(dur * 10) / 10, wave };
  game.bump();
  broadcastState(room);
}

const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    try {
      if (msg.t === 'ping') return send(ws, { t: 'pong' });

      if (msg.t === 'create' || msg.t === 'join' || msg.t === 'resume') {
        if (ws.room) return;
        const name = String(msg.name || '').trim().slice(0, 20) || 'Jugador';
        let room;
        let seat;
        let token;

        if (msg.t === 'create') {
          const code = newCode();
          room = { game: new Game(code, { mode: String(msg.mode || 'duel') }), sockets: {} };
          rooms.set(code, room);
          ({ seat, token } = room.game.addPlayer(name));
        } else {
          const code = String(msg.code || '').trim().toUpperCase();
          room = rooms.get(code);
          if (!room) return send(ws, { t: 'error', fatal: true, message: 'No existe ninguna sala con ese código.' });
          if (msg.t === 'resume') {
            seat = room.game.seatForToken(String(msg.token || ''));
            if (!seat) return send(ws, { t: 'error', fatal: true, message: 'No se ha podido recuperar tu sitio en la sala.' });
            token = msg.token;
          } else {
            const added = room.game.addPlayer(name);
            if (!added) return send(ws, { t: 'error', fatal: true, message: 'La sala ya está completa.' });
            ({ seat, token } = added);
          }
        }

        attach(ws, room, seat);
        if (msg.t === 'resume') room.game.addLog(`${room.game.nameOf(seat)} se ha reconectado.`);
        room.game.bump();
        send(ws, { t: 'joined', code: room.game.code, seat, token });
        broadcastState(room);
        return;
      }

      const room = ws.room;
      if (!room) return send(ws, { t: 'error', message: 'No estás en ninguna sala.' });

      // Abandonar la partida: el sitio no se puede recuperar y se avisa al rival
      if (msg.t === 'leave') {
        const game = room.game;
        const player = game.players[ws.seat];
        player.left = true;
        player.connected = false;
        player.token = null;
        delete room.sockets[ws.seat];
        ws.room = null;
        game.addLog(`${player.name} ha abandonado la partida.`);
        game.bump();
        if (game.seats.every((s) => !game.players[s] || game.players[s].left)) rooms.delete(game.code);
        else broadcastState(room);
        ws.close();
        return;
      }
      if (msg.t === 'voice') return receiveVoice(room, ws.seat, msg);
      // Presencia: si el jugador tiene la partida a la vista o la ventana en segundo plano
      if (msg.t === 'visibility') {
        const player = room.game.players[ws.seat];
        const visible = msg.visible !== false;
        if (player.visible === visible) return;
        player.visible = visible;
        room.game.bump();
        broadcastState(room);
        return;
      }
      if (msg.t === 'voiceHeard') {
        const entry = room.game.log.find((e) => e.audio && e.audio.id === msg.id);
        if (!entry || entry.by === ws.seat || entry.audio.heard) return;
        entry.audio.heard = true;
        room.game.bump();
        broadcastState(room);
        return;
      }
      const result = room.game.apply(ws.seat, msg, library);
      if (result.private) send(ws, result.private);
      if (result.result) saveResult(result.result);
      broadcastState(room, result.fx ? { ...result.fx, by: ws.seat } : undefined);
    } catch (err) {
      send(ws, { t: 'error', message: err instanceof Error ? err.message : 'Error' });
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room || room.sockets[ws.seat] !== ws) return;
    delete room.sockets[ws.seat];
    room.game.players[ws.seat].connected = false;
    room.game.addLog(`${room.game.nameOf(ws.seat)} se ha desconectado.`);
    room.game.bump();
    broadcastState(room);
  });
});

// Latido para detectar conexiones caídas y limpieza de salas abandonadas
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.game.seats.some((s) => room.sockets[s]);
    if (!anyone && now - room.game.lastActivity > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Servidor de Aeterna Duellum escuchando en el puerto ${PORT}`);
  console.log(`Datos de la biblioteca en ${DATA_DIR}`);
  if (!ADMIN_KEY) console.log('Aviso: sin ADMIN_KEY no se podrán publicar mazos en el servidor.');
});
