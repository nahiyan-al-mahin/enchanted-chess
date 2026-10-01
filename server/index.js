// server/index.js
// The game server. It is the referee: every player's browser connects to
// it, and it keeps the one true copy of each game.
//
//  - Express is a small web server. Right now it only answers /health;
//    later (milestone 5) it will also serve the built game files.
//  - Socket.IO keeps a live two-way connection open to each browser, so
//    the server can push moves to players the instant they happen.
//  - chess.js runs here too. The server never trusts a browser: every move
//    is checked by the server's own chess.js before anyone sees it.
//
// Messages (Socket.IO "events"). Some use an "acknowledgement": the sender
// passes a callback, and the server answers it directly, like a reply.
//
//   browser -> server   'create-room' { playerId, name, side, time }   make a new room
//                         (reply: { room, color })                    side 'random' is decided here
//   browser -> server   'join' { room, playerId, name }               enter a room
//                         (reply: { room, color, moves, settings, presence })
//   browser -> server   'move' { from, to, promotion? }               "I'd like to play this"
//   server  -> everyone 'move' { from, to, promotion, san, fen }      accepted: play it
//   server  -> sender   'move-rejected' { from, to, reason }          not allowed
//   server  -> everyone 'presence' { w, b, spectators }               who is here, with names
//   server  -> browser  'replaced'                                    your seat was opened in another tab
//
// Seats: the room's creator takes the side they chose; the next person to
// join takes the other side; anyone after that watches. Each browser tab
// has a secret random "playerId"; a seat stays reserved for that id even
// while its owner is disconnected, so refreshing puts you back in your seat.

import express from 'express';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { Server } from 'socket.io';
import { Chess } from 'chess.js';

// The port can be changed with the PORT environment variable
// (e.g. `PORT=4000 npm run server`); otherwise it's 3050.
const PORT = process.env.PORT || 3050;
const EMPTY_ROOM_LIFETIME = 2 * 60 * 60 * 1000; // forget rooms nobody has visited for 2 hours

const app = express();
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const httpServer = createServer(app);
const io = new Server(httpServer);

// All games, by room code (like "K7QX"):
//   room -> { chess, seats: { w: seat|null, b: seat|null }, settings: { time }, cleanupTimer }
//   seat = { playerId, name, socketId }   (socketId is null while that player is disconnected)
//   settings.time = minutes per player (0 = no clock)
const rooms = new Map();

const TIME_CONTROLS = [0, 5, 10, 15];

// Check everything a browser sends, so nobody can send junk.
const roomCode = (room) => (typeof room === 'string' ? room.trim().toUpperCase() : '');
const isValidRoom = (code) => /^[A-Z0-9]{4,8}$/.test(code);
const isValidPlayerId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
const isSquare = (s) => typeof s === 'string' && /^[a-h][1-8]$/.test(s);

// Player names: printable characters only, single spaces, at most 20 long.
function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// A 4-character room code like "K7QX" that isn't already in use. Letters
// and digits that look alike (O/0, I/1) are left out so codes are easy to read out.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRoomCode() {
  let code;
  do code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  while (rooms.has(code));
  return code;
}

// Which colour (if any) does this connection play in this room?
function colorOf(room, socketId) {
  for (const color of ['w', 'b']) if (room.seats[color]?.socketId === socketId) return color;
  return null;
}

// Who is in the room. For each side: { state, name }, where state is
// 'empty' (nobody has taken the seat yet), 'online', or 'offline' (taken,
// but that player is disconnected right now).
function presenceOf(name) {
  const room = rooms.get(name);
  const seatInfo = (seat) => ({
    state: !seat ? 'empty' : seat.socketId ? 'online' : 'offline',
    name: seat?.name ?? null,
  });
  const everyone = io.sockets.adapter.rooms.get(name)?.size ?? 0;
  const players = ['w', 'b'].filter((c) => room.seats[c]?.socketId).length;
  return { w: seatInfo(room.seats.w), b: seatInfo(room.seats.b), spectators: everyone - players };
}
const sendPresence = (name) => io.to(name).emit('presence', presenceOf(name));

// Forget a room nobody is in after a while, to free memory.
// (Joining the room cancels this timer.)
function scheduleCleanup(name) {
  const room = rooms.get(name);
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    rooms.delete(name);
    console.log(`[${name}] room removed (empty for 2 hours)`);
  }, EMPTY_ROOM_LIFETIME);
}

io.on('connection', (socket) => {
  // Each connection remembers which room it is in.
  let roomName = null;

  // A new room. The creator's chosen side is reserved for them straight
  // away; they actually sit down when they 'join' right after this.
  socket.on('create-room', (data, reply) => {
    if (typeof reply !== 'function') return;
    const name = cleanName(data?.name);
    if (!isValidPlayerId(data?.playerId)) return reply({ error: 'Invalid player id.' });
    if (!name) return reply({ error: 'Please enter your name.' });
    if (!['w', 'b', 'random'].includes(data.side)) return reply({ error: 'Please choose a side.' });
    if (!TIME_CONTROLS.includes(data.time)) return reply({ error: 'Please choose a time control.' });

    // "Random" is decided here on the server, so nobody can rig it.
    const color = data.side === 'random' ? (randomInt(2) ? 'w' : 'b') : data.side;
    const code = newRoomCode();
    const room = { chess: new Chess(), seats: { w: null, b: null }, settings: { time: data.time }, cleanupTimer: null };
    room.seats[color] = { playerId: data.playerId, name, socketId: null };
    rooms.set(code, room);
    scheduleCleanup(code); // in case nobody ever joins it
    console.log(`[${code}] room created by ${name} (${color === 'w' ? 'Ivory' : 'Obsidian'}, ${data.time || 'no'} min clock)`);
    reply({ room: code, color });
  });

  socket.on('join', (data, reply) => {
    if (typeof reply !== 'function') return;
    const code = roomCode(data?.room);
    const name = cleanName(data?.name);
    if (!isValidRoom(code)) return reply({ error: 'Room codes are 4 letters or numbers, like K7QX.' });
    if (!isValidPlayerId(data?.playerId)) return reply({ error: 'Invalid player id.' });
    if (!name) return reply({ error: 'Please enter your name.' });
    const room = rooms.get(code);
    if (!room) return reply({ error: `There is no game with the code ${code}. It may have ended, or the server was restarted.` });

    if (roomName && roomName !== code) leaveRoom(); // rejoining the same room isn't leaving
    roomName = code;
    clearTimeout(room.cleanupTimer);
    socket.join(roomName); // Socket.IO "rooms" let us message everyone in a game at once

    // Find this player's seat: their old one if they're coming back,
    // otherwise the free one. If both are taken, they spectate.
    const { seats } = room;
    let color = ['w', 'b'].find((c) => seats[c]?.playerId === data.playerId) ?? null;
    if (!color) color = !seats.w ? 'w' : !seats.b ? 'b' : null;
    if (color) {
      // Same player open in another tab? The newest tab takes over the seat.
      const oldSocketId = seats[color]?.socketId;
      if (oldSocketId && oldSocketId !== socket.id) io.to(oldSocketId).emit('replaced');
      seats[color] = { playerId: data.playerId, name, socketId: socket.id };
    }

    const label = { w: 'Ivory', b: 'Obsidian' }[color] ?? 'a spectator';
    console.log(`[${roomName}] ${name} joined as ${label}`);

    // Reply with everything needed to draw the game as it is right now.
    const moves = room.chess.history({ verbose: true }).map(({ from, to, promotion }) => ({ from, to, promotion }));
    reply({ room: roomName, color, moves, fen: room.chess.fen(), settings: room.settings, presence: presenceOf(roomName) });
    sendPresence(roomName);
  });

  socket.on('move', (data) => {
    const reject = (reason) => socket.emit('move-rejected', { from: data?.from, to: data?.to, reason });

    const room = rooms.get(roomName);
    if (!room) return reject('Join a room first.');
    if (!isSquare(data?.from) || !isSquare(data?.to)) return reject('Bad move format.');
    const promotion = ['q', 'r', 'b', 'n'].includes(data.promotion) ? data.promotion : undefined;

    const { chess } = room;
    const color = colorOf(room, socket.id);
    if (!color) return reject('Spectators cannot move.');
    if (chess.isGameOver()) return reject('The game is over.');
    if (chess.turn() !== color) return reject("It's not your turn.");
    const opponent = room.seats[color === 'w' ? 'b' : 'w'];
    if (!opponent) return reject('Waiting for an opponent to join.');
    if (!opponent.socketId) return reject('Your opponent is disconnected.');

    // The referee's decision: chess.js throws an error if the move is illegal.
    // (Because it's this player's turn, chess.js also makes sure they are
    // moving one of their own pieces.)
    let move;
    try {
      move = chess.move({ from: data.from, to: data.to, promotion });
    } catch {
      return reject('Illegal move.');
    }

    // Legal: tell everyone in the room (including the sender) to play it.
    io.to(roomName).emit('move', {
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      san: move.san,
      fen: chess.fen(),
    });
    console.log(`[${roomName}] ${move.san}${chess.isGameOver() ? ' (game over)' : ''}`);
  });

  // Leaving (closing the tab, losing connection, or joining another room):
  // keep the seat reserved, but mark the player as disconnected.
  function leaveRoom() {
    const room = rooms.get(roomName);
    const name = roomName;
    roomName = null;
    socket.leave(name);
    if (!room) return;
    const color = colorOf(room, socket.id);
    if (color) room.seats[color].socketId = null;
    console.log(`[${name}] ${socket.id} left`);
    sendPresence(name);

    if (!io.sockets.adapter.rooms.get(name)?.size) scheduleCleanup(name);
  }

  socket.on('disconnect', () => {
    if (roomName) leaveRoom();
  });
});

// If the port can't be used, explain why instead of crashing with a long error.
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use, probably by another program or an`);
    console.error('Enchanted Chess server that is still running in another terminal.');
    console.error('Close that program, or start this one on another port, for example:');
    console.error('  PowerShell:  $env:PORT=3060; npm run server');
    console.error('  Git Bash:    PORT=3060 npm run server');
    console.error('(If you change the port, update the proxy target in vite.config.js too.)\n');
  } else {
    console.error('The server could not start:', err.message);
  }
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Enchanted Chess server listening on http://localhost:${PORT}`);
});
