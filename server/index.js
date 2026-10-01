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
//   browser -> server   'create-room'  (reply: { room })            make a new room
//   browser -> server   'join' { room, playerId }                   enter a room
//                         (reply: { color, moves, presence })       your seat + the game so far
//   browser -> server   'move' { from, to, promotion? }             "I'd like to play this"
//   server  -> everyone 'move' { from, to, promotion, san, fen }    accepted: play it
//   server  -> sender   'move-rejected' { from, to, reason }        not allowed
//   server  -> everyone 'presence' { w, b, spectators }             who is connected
//   server  -> browser  'replaced'                                  your seat was opened in another tab
//
// Seats: the first player in a room gets Ivory ('w'), the second Obsidian
// ('b'), anyone else watches. Each browser tab has a secret random
// "playerId"; a seat stays reserved for that id even while its owner is
// disconnected, so refreshing the page puts you straight back in your seat.

import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
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

// All games, by room name:
//   room -> { chess, seats: { w: seat|null, b: seat|null }, cleanupTimer }
//   seat = { playerId, socketId }   (socketId is null while that player is disconnected)
const rooms = new Map();

// Check everything a browser sends, so nobody can send junk.
const isValidRoom = (room) => typeof room === 'string' && /^[a-z0-9]{3,16}$/i.test(room);
const isValidPlayerId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
const isSquare = (s) => typeof s === 'string' && /^[a-h][1-8]$/.test(s);

function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, { chess: new Chess(), seats: { w: null, b: null }, cleanupTimer: null });
  return rooms.get(name);
}

// A short random room name like "k3x9qa" that isn't already in use.
function newRoomName() {
  let name;
  do name = randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  while (name.length < 6 || rooms.has(name));
  return name;
}

// Which colour (if any) does this connection play in this room?
function colorOf(room, socketId) {
  for (const color of ['w', 'b']) if (room.seats[color]?.socketId === socketId) return color;
  return null;
}

// Tell everyone in the room who is here: 'empty' (nobody has taken the seat
// yet), 'online', or 'offline' (taken, but that player is disconnected).
function presenceOf(name) {
  const room = rooms.get(name);
  const seatState = (seat) => (!seat ? 'empty' : seat.socketId ? 'online' : 'offline');
  const everyone = io.sockets.adapter.rooms.get(name)?.size ?? 0;
  const players = ['w', 'b'].filter((c) => room.seats[c]?.socketId).length;
  return { w: seatState(room.seats.w), b: seatState(room.seats.b), spectators: everyone - players };
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

  socket.on('create-room', (reply) => {
    if (typeof reply !== 'function') return;
    const name = newRoomName();
    getRoom(name);
    scheduleCleanup(name); // in case nobody ever joins it
    console.log(`[${name}] room created`);
    reply({ room: name });
  });

  socket.on('join', (data, reply) => {
    if (typeof reply !== 'function') return;
    if (!isValidRoom(data?.room)) return reply({ error: 'Invalid room name.' });
    if (!isValidPlayerId(data?.playerId)) return reply({ error: 'Invalid player id.' });

    if (roomName) leaveRoom();
    roomName = data.room;
    const room = getRoom(roomName);
    clearTimeout(room.cleanupTimer);
    socket.join(roomName); // Socket.IO "rooms" let us message everyone in a game at once

    // Find this player's seat: their old one if they're coming back,
    // otherwise the first free one. If both are taken, they spectate.
    const { seats } = room;
    let color = ['w', 'b'].find((c) => seats[c]?.playerId === data.playerId) ?? null;
    if (!color) color = !seats.w ? 'w' : !seats.b ? 'b' : null;
    if (color) {
      // Same player open in another tab? The newest tab takes over the seat.
      const oldSocketId = seats[color]?.socketId;
      if (oldSocketId && oldSocketId !== socket.id) io.to(oldSocketId).emit('replaced');
      seats[color] = { playerId: data.playerId, socketId: socket.id };
    }

    const label = { w: 'Ivory', b: 'Obsidian' }[color] ?? 'a spectator';
    console.log(`[${roomName}] ${socket.id} joined as ${label}`);

    // Reply with everything needed to draw the game as it is right now.
    const moves = room.chess.history({ verbose: true }).map(({ from, to, promotion }) => ({ from, to, promotion }));
    reply({ room: roomName, color, moves, fen: room.chess.fen() });
    sendPresence(roomName);
  });

  socket.on('move', (data) => {
    const reject = (reason) => socket.emit('move-rejected', { from: data?.from, to: data?.to, reason });

    if (!roomName) return reject('Join a room first.');
    if (!isSquare(data?.from) || !isSquare(data?.to)) return reject('Bad move format.');
    const promotion = ['q', 'r', 'b', 'n'].includes(data.promotion) ? data.promotion : undefined;

    const room = getRoom(roomName);
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
