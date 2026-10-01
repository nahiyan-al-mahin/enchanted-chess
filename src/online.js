// online.js
// The browser's side of online play. This is the only file that talks to
// the game server; main.js just gets told what happened through "handlers"
// (functions it passes in, which we call when news arrives).
//
// What happens when the page opens:
//  1. Connect to the server with Socket.IO. In development the address is
//     the same as the page (localhost:5173) and Vite's proxy passes it on
//     to the real server (see vite.config.js).
//  2. No ?room= in the address? Ask the server to create a room, then
//     change the address bar to http://.../?room=abc123 (without reloading).
//  3. Join the room, sending our secret playerId. The server replies with
//     our colour and every move played so far, so we can draw the board.
//  4. From then on the server pushes 'move' and 'presence' messages.
//
// If the connection drops, Socket.IO reconnects by itself; every time it
// (re)connects we join again, and the reply puts the board right.

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
let room = null;

// Reads ?room=abc123 from the address bar (or null if missing or odd).
function roomFromUrl() {
  const name = new URLSearchParams(location.search).get('room');
  return name && /^[a-z0-9]{3,16}$/i.test(name) ? name : null;
}

// The link to send to a friend.
export const inviteLink = () => `${location.origin}${location.pathname}?room=${room}`;

// Asks the server to play a move. Nothing happens on the board until the
// server answers with 'move' (accepted) or 'move-rejected'.
export function sendMove({ from, to, promotion }) {
  socket.emit('move', { from, to, promotion });
}

// Asks the server for the whole game again (joining again does exactly that).
let join = null;
export const resync = () => join?.();

// handlers: { onStatus, onJoined, onMove, onRejected, onPresence, onReplaced }
export function connectOnline(handlers) {
  room = roomFromUrl();
  socket = io(); // same address as the page; the proxy forwards it
  handlers.onStatus('connecting');

  join = () => {
    socket.emit('join', { room, playerId }, (reply) => {
      if (reply.error) return handlers.onStatus('error', reply.error);
      handlers.onJoined(reply); // { room, color, moves, fen }
    });
  };

  socket.on('connect', () => {
    handlers.onStatus('connected');
    if (room) return join();
    socket.emit('create-room', (reply) => {
      room = reply.room;
      // Put the room in the address bar so refreshing (or sharing) keeps it.
      history.replaceState(null, '', `?room=${room}`);
      join();
    });
  });

  socket.on('disconnect', () => handlers.onStatus('lost'));
  socket.on('connect_error', () => handlers.onStatus('unreachable'));
  socket.on('move', handlers.onMove);
  socket.on('move-rejected', handlers.onRejected);
  socket.on('presence', handlers.onPresence);
  socket.on('replaced', handlers.onReplaced);
}
