// online.js
// The browser's side of online play. This is the only file that talks to
// the game server; main.js just gets told what happened through "handlers"
// (functions it passes in, which we call when news arrives).
//
// How it fits together:
//  1. connectOnline() opens a live Socket.IO connection as soon as the page
//     loads, always to the SAME address the page came from (nothing is
//     hard-coded). In production that's the game server itself; while
//     developing it's Vite, whose proxy passes it on to the game server.
//  2. The intro screen then calls createRoom() and/or joinRoom(). These
//     send a request and wait for the server's reply (an "acknowledgement").
//  3. Once in a room, the server pushes 'move' and 'presence' messages.
//
// If the connection drops, Socket.IO reconnects by itself; every time it
// reconnects we join the same room again, and the reply puts the board right.

import { io } from 'socket.io-client';

// A random id for this browser tab. sessionStorage survives a page refresh
// but is separate for every tab, so two tabs can be two different players.
function getPlayerId() {
  const KEY = 'enchanted-chess-player';
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = fresh();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return fresh(); // storage blocked: still works, just can't survive a refresh
  }
}

const playerId = getPlayerId();
let socket = null;
let current = null; // the room we're in: { room, name }
let handlers = null;

// Reads ?room=K7QX from the address bar (or null if missing or odd).
export function roomFromUrl() {
  const code = new URLSearchParams(location.search).get('room');
  return code && /^[a-z0-9]{4,8}$/i.test(code) ? code.toUpperCase() : null;
}

// The link to send to a friend.
export const inviteLink = (room = current?.room) => `${location.origin}${location.pathname}?room=${room}`;

// Sends a request and waits for the server's reply. If the server doesn't
// answer within 8 seconds, we get an error instead of waiting forever.
function request(event, data) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, data, (err, reply) => {
      resolve(err ? { error: "The game server didn't answer. Is it running?" } : reply);
    });
  });
}

// Make a new room. side: 'w' | 'b' | 'random', time: minutes (0 = no clock).
// Reply: { room, color } or { error }.
export const createRoom = ({ name, side, time }) => request('create-room', { playerId, name, side, time });

// Join a room (as a player if there's a free seat, otherwise as a spectator).
// Reply: { room, color, moves, settings, presence } or { error }.
export async function joinRoom(room, name) {
  const reply = await request('join', { room, name, playerId });
  if (reply.ended) forgetSession(); // that game is over for us: don't try to go back
  if (!reply.error) {
    current = { room: reply.room, name };
    // Remember this tab is in this room, so a refresh can go straight back in.
    try {
      sessionStorage.setItem('enchanted-chess-session', JSON.stringify(current));
    } catch {
      /* ignore */
    }
  }
  return reply;
}

// The room this tab was last in (to rejoin after a refresh), or null.
export function savedSession() {
  try {
    return JSON.parse(sessionStorage.getItem('enchanted-chess-session'));
  } catch {
    return null;
  }
}

export function forgetSession() {
  current = null;
  try {
    sessionStorage.removeItem('enchanted-chess-session');
  } catch {
    /* ignore */
  }
}

// Leave the room for good. In an active game this LOSES the game.
export async function exitGame() {
  const reply = await request('exit-game', {});
  forgetSession();
  return reply;
}

// Any other in-game request ('resign', ...). Reply: { ok } or { error }.
export const ask = (event, data = {}) => request(event, data);

// Asks the server to play a move. Nothing happens on the board until the
// server answers with 'move' (accepted) or 'move-rejected'.
export function sendMove({ from, to, promotion }) {
  socket.emit('move', { from, to, promotion });
}

// Asks the server for the whole game again (joining again does exactly that).
export async function resync() {
  if (current) handlers.onJoined(await joinRoom(current.room, current.name));
}

// handlers: { onStatus, onJoined, onMove, onRejected, onPresence, onGameOver, onOffer, onTakeback, onRematch, onRematchStarted, onClock, onReplaced }
export function connectOnline(h) {
  handlers = h;
  socket = io(); // no address given = the address this page was loaded from
  handlers.onStatus('connecting');

  socket.on('connect', () => {
    handlers.onStatus('connected');
    if (current) resync(); // reconnected after a drop: sit back down
  });
  socket.on('disconnect', () => handlers.onStatus('lost'));
  socket.on('connect_error', () => handlers.onStatus('unreachable'));
  socket.on('move', (m) => handlers.onMove(m));
  socket.on('move-rejected', (m) => handlers.onRejected(m));
  socket.on('presence', (p) => handlers.onPresence(p));
  socket.on('game-over', (result) => handlers.onGameOver(result));
  socket.on('offer', (news) => handlers.onOffer(news));
  socket.on('takeback', (game) => handlers.onTakeback(game));
  socket.on('rematch', (asked) => handlers.onRematch(asked));
  socket.on('rematch-started', () => handlers.onRematchStarted());
  socket.on('clock', (clock) => handlers.onClock(clock));
  socket.on('replaced', () => handlers.onReplaced());
}
