// ==================== Math Battle — Live Bridge Server ====================
// A small, PERSISTENT Node.js process (deploy to Render/Railway/Fly — NOT Vercel).
//
// Why this has to be a persistent process and not a Vercel serverless function:
//  1. Listening to TikTok LIVE means holding one long-lived connection open
//     indefinitely. Serverless functions are invoked per-request and torn down
//     (10s-60s on Vercel's Hobby plan, longer on Pro, but never "forever") — a
//     TikTok listener started inside one would die with the function.
//  2. A `new WebSocketServer(...)` inside a serverless handler doesn't work either:
//     each invocation may land on a fresh, stateless container, so previously
//     connected clients and any in-memory room state disappear between requests.
// A tiny always-on Node service sidesteps both problems for free-tier-friendly cost.
//
// Responsibilities:
//  - Accept a WebSocket connection from the Math Battle HOST device (index.html's
//    LiveBridge class) and one from each Live Dashboard device (live.html).
//  - Relay game state from the host to every dashboard watching the same room code.
//  - Optionally connect to a TikTok LIVE room (via tiktok-live-connector) and turn
//    chat / gifts / likes / follows into `tiktok_event` messages + queued TTS lines
//    for the dashboard to speak (Web Speech API, client-side, ducking its own BGM).
//
// Honesty note: TikTok has no official public LIVE API. tiktok-live-connector is a
// well-maintained reverse-engineering project; TikTok can change things at any time
// and break it. As of this writing it also needs a signing backend (Euler Stream) —
// see README.md for the free-tier signup. Treat the TikTok half as "best effort".

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as TTLC from 'tiktok-live-connector';
import { getRandomPhrase, createTtsQueue, getPoseForCategory } from './commentator.js';

const PORT = process.env.PORT || 8080;
const EULER_API_KEY = process.env.EULERSTREAM_API_KEY || '';

// ---- tiny helpers ----
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_e) { /* client gone, ignore */ }
  }
}
function log(...args) { console.log(new Date().toISOString(), ...args); }
function errText(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (err.reason) return String(err.reason);
  try { return JSON.stringify(err); } catch (_e) { return String(err); }
}

// ---- room registry (in-memory; fine, because this process never sleeps mid-connection) ----
/** @type {Map<string, Room>} */
const rooms = new Map();

// DJ-style filler chatter: when the narrator has been silent for a while and the
// queue is idle, say something appropriate to the current game phase so the
// narration keeps going throughout the stream instead of only reacting to events.
const FILLER_CHECK_MS = 4000;
const FILLER_MIN_MS = 6000;
const FILLER_MAX_MS = 12000;
function nextFillerThreshold() {
  return FILLER_MIN_MS + Math.random() * (FILLER_MAX_MS - FILLER_MIN_MS);
}

function getRoom(code) {
  if (!rooms.has(code)) {
    const room = {
      code,
      gameSocket: null,
      dashboards: new Set(),
      lastGameState: null,
      tiktok: { username: null, connection: null, connected: false, connecting: false, viewerCount: 0 },
      lastSpeakAt: Date.now(),
      fillerThreshold: nextFillerThreshold(),
    };
    room.tts = createTtsQueue((text, pose) => {
      room.lastSpeakAt = Date.now();
      broadcastDashboards(room, { type: 'tts_speak', text, pose });
    });
    room.fillerTimer = setInterval(() => tryFillerChatter(room), FILLER_CHECK_MS);
    rooms.set(code, room);
  }
  return rooms.get(code);
}

// Picks a random line from `category` and pushes it (with its mascot pose) onto the
// room's TTS queue. Centralizing this here means every call site automatically gets
// the right pose without having to look it up itself.
function speakLine(room, category, priority, ...args) {
  const text = getRandomPhrase(category, ...args);
  if (!text) return;
  room.tts.push(text, priority, getPoseForCategory(category));
}

function pickFillerCategory(room) {
  const gs = room.lastGameState || {};
  let pool;
  if (gs.phase === 'playing') pool = ['filler_playing', 'filler_playing', 'filler_playing', 'filler_engage', 'howToPlay'];
  else if (gs.phase === 'result') pool = ['filler_result', 'filler_engage'];
  else if (gs.phase === 'final') pool = ['filler_engage'];
  else pool = ['filler_lobby', 'filler_lobby', 'filler_engage', 'howToPlay'];
  return pool[Math.floor(Math.random() * pool.length)];
}

function tryFillerChatter(room) {
  if (!room.gameSocket) return; // no active game connected — nothing to comment on
  if (!room.tts.isIdle()) return; // never pile up behind a real announcement
  if (Date.now() - room.lastSpeakAt < room.fillerThreshold) return;
  const gs = room.lastGameState || {};
  speakLine(room, pickFillerCategory(room), 'low', gs.round, gs.rounds);
  room.fillerThreshold = nextFillerThreshold();
}

function broadcastDashboards(room, obj) {
  for (const ws of room.dashboards) safeSend(ws, obj);
}

// ---- TikTok LIVE connection (best-effort, one per room) ----
function startTikTok(room, usernameRaw) {
  const username = String(usernameRaw || '').replace(/^@/, '').trim();
  if (!username) return;
  if (room.tiktok.connected || room.tiktok.connecting) return;

  room.tiktok.username = username;
  room.tiktok.connecting = true;

  // The package renamed WebcastPushConnection -> TikTokLiveConnection at v2; accept either
  // so this keeps working whichever major version ends up installed.
  const Connection = TTLC.TikTokLiveConnection || TTLC.WebcastPushConnection;
  if (!Connection) {
    room.tiktok.connecting = false;
    broadcastDashboards(room, { type: 'tiktok_status', connected: false, username, error: 'tiktok-live-connector: no connector class exported by this version' });
    return;
  }

  const opts = {};
  if (EULER_API_KEY) opts.signApiKey = EULER_API_KEY;

  let conn;
  try {
    conn = new Connection(username, opts);
  } catch (err) {
    room.tiktok.connecting = false;
    broadcastDashboards(room, { type: 'tiktok_status', connected: false, username, error: errText(err) });
    return;
  }
  room.tiktok.connection = conn;

  const nick = (d) => (d && d.user && (d.user.nickname || d.user.uniqueId)) || 'ผู้ชม';

  conn.on('chat', (d) => {
    const nickname = nick(d);
    const comment = String((d && d.comment) || '').trim();
    broadcastDashboards(room, { type: 'tiktok_event', event: 'chat', user: { nickname }, text: comment });
    const low = comment.toLowerCase();
    if (low.startsWith('!join') || low.startsWith('!play')) {
      const roomCode = (room.lastGameState && room.lastGameState.roomCode) || room.code;
      speakLine(room, 'joinInstructions', 'high', nickname, roomCode);
    }
  });

  conn.on('gift', (d) => {
    const nickname = nick(d);
    const details = d && d.giftDetails;
    const giftName = (details && details.giftName) || (d && d.gift && d.gift.name) || 'ของขวัญ';
    const repeatCount = (d && d.repeatCount) || 1;
    // Streakable gifts (giftType 1) refire on every tap; only announce once the streak ends
    // (repeatEnd === true) or immediately for non-streakable gifts, so the narrator doesn't spam.
    const isMidStreak = details && details.giftType === 1 && d.repeatEnd === false;
    broadcastDashboards(room, { type: 'tiktok_event', event: 'gift', user: { nickname }, giftName, repeatCount, midStreak: !!isMidStreak });
    if (!isMidStreak) speakLine(room, 'gift', 'normal', nickname, giftName);
  });

  conn.on('like', (d) => {
    const nickname = nick(d);
    const likeCount = (d && d.likeCount) || 1;
    broadcastDashboards(room, { type: 'tiktok_event', event: 'like', user: { nickname }, likeCount });
    // Likes fire very frequently on a busy stream — only narrate occasionally so the
    // commentator doesn't talk over everything else.
    if (Math.random() < 0.12) speakLine(room, 'like', 'low', nickname, likeCount);
  });

  conn.on('member', (d) => {
    const nickname = nick(d);
    broadcastDashboards(room, { type: 'tiktok_event', event: 'member', user: { nickname } });
    if (Math.random() < 0.25) speakLine(room, 'viewerJoin', 'low', nickname);
  });

  conn.on('follow', (d) => {
    const nickname = nick(d);
    broadcastDashboards(room, { type: 'tiktok_event', event: 'follow', user: { nickname } });
    speakLine(room, 'follow', 'normal', nickname);
  });

  conn.on('share', (d) => {
    const nickname = nick(d);
    broadcastDashboards(room, { type: 'tiktok_event', event: 'share', user: { nickname } });
  });

  conn.on('roomUser', (d) => {
    const vc = d && d.viewerCount;
    if (typeof vc === 'number' && vc !== room.tiktok.viewerCount) {
      room.tiktok.viewerCount = vc;
      broadcastDashboards(room, { type: 'viewer_count', count: vc });
    }
  });

  conn.on('connected', () => {
    room.tiktok.connecting = false;
    room.tiktok.connected = true;
    log('[tiktok]', username, 'connected for room', room.code);
    broadcastDashboards(room, { type: 'tiktok_status', connected: true, username });
    speakLine(room, 'welcome', 'high');
  });

  conn.on('disconnected', () => {
    room.tiktok.connected = false;
    log('[tiktok]', username, 'disconnected, will retry in 8s');
    broadcastDashboards(room, { type: 'tiktok_status', connected: false, username, error: 'disconnected' });
    setTimeout(() => {
      if (!room.tiktok.connected) { room.tiktok.connecting = false; startTikTok(room, username); }
    }, 8000);
  });

  conn.on('error', (err) => {
    log('[tiktok] error', username, errText(err));
    broadcastDashboards(room, { type: 'tiktok_status', connected: false, username, error: errText(err) });
  });

  const connectPromise = typeof conn.connect === 'function' ? conn.connect() : Promise.reject(new Error('connect() not found on connector'));
  Promise.resolve(connectPromise).catch((err) => {
    room.tiktok.connecting = false;
    log('[tiktok] connect() failed for', username, errText(err));
    broadcastDashboards(room, { type: 'tiktok_status', connected: false, username, error: errText(err) });
  });
}

// ---- game -> dashboard relay ----
function handleGameMessage(room, msg) {
  // Always relay verbatim first, so the dashboard sees everything even if the
  // commentary logic below doesn't recognise a particular type.
  broadcastDashboards(room, msg);

  if (msg.type === 'game_state' && msg.data) {
    room.lastGameState = msg.data;
    return;
  }
  if (msg.type === 'round_start' && msg.data) {
    speakLine(room, 'roundStart', 'normal', msg.data.round);
    return;
  }
  if (msg.type === 'round_end' && msg.data) {
    const d = msg.data;
    if (d.winnerName) speakLine(room, 'correctAnswer', 'high', d.winnerName, d.winnerScore || 3);
    else if (d.anyCorrect === false) speakLine(room, 'timeUp', 'normal');
    return;
  }
  if (msg.type === 'game_end' && msg.data) {
    const d = msg.data;
    if (d.winnerName) speakLine(room, 'gameEnd', 'high', d.winnerName, d.winnerScore || 0);
    return;
  }
}

// ---- HTTP + WebSocket server ----
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Math Battle Live Bridge is running. See bridge-server/README.md.');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let role = null;
  let roomCode = null;

  // Keep the connection alive through proxies/load balancers.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_e) { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'register_game') {
      roomCode = String(msg.roomCode || '').trim();
      if (!roomCode) return;
      role = 'game';
      const room = getRoom(roomCode);
      room.gameSocket = ws;
      log('[ws] game registered for room', roomCode);
      safeSend(ws, { type: 'registered', role: 'game', roomCode });
      return;
    }

    if (msg.type === 'register_dashboard') {
      roomCode = String(msg.roomCode || '').trim();
      if (!roomCode) return;
      role = 'dashboard';
      const room = getRoom(roomCode);
      room.dashboards.add(ws);
      log('[ws] dashboard registered for room', roomCode);
      safeSend(ws, { type: 'registered', role: 'dashboard', roomCode });
      if (room.lastGameState) safeSend(ws, { type: 'game_state', data: room.lastGameState });
      safeSend(ws, { type: 'tiktok_status', connected: room.tiktok.connected, username: room.tiktok.username });
      if (msg.tiktokUsername) startTikTok(room, msg.tiktokUsername);
      return;
    }

    if (role === 'game' && roomCode) {
      handleGameMessage(getRoom(roomCode), msg);
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    if (role === 'game' && room.gameSocket === ws) {
      room.gameSocket = null;
      log('[ws] game disconnected from room', roomCode);
      broadcastDashboards(room, { type: 'game_disconnected' });
    }
    if (role === 'dashboard') { room.dashboards.delete(ws); log('[ws] dashboard disconnected from room', roomCode); }
  });

  ws.on('error', () => {});
});

// Ping every connection every 30s; terminate anything that didn't pong back
// (typically a phone that locked its screen mid-broadcast).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_e) {}
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  log('Math Battle Live Bridge listening on port', PORT);
  if (!EULER_API_KEY) log('NOTE: EULERSTREAM_API_KEY is not set — TikTok LIVE connections may be rate-limited or fail. See README.md.');
});
