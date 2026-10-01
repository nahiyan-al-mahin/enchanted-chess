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
//                         (reply: { room, color, moves, settings, status, result, presence })
//                         (or { error, ended: true } if that game is over for you)
//   browser -> server   'exit-game' {}  (reply: { ok })               leave the room for good
//   browser -> server   'move' { from, to, promotion? }               "I'd like to play this"
//   server  -> everyone 'move' { from, to, promotion, san, fen }      accepted: play it
//   server  -> sender   'move-rejected' { from, to, reason }          not allowed
//   server  -> everyone 'presence' { status, w, b, spectators }       who is here, with names
//   server  -> everyone 'game-over' { winner, reason, names }         the game has ended
//   server  -> browser  'replaced'                                    your seat was opened in another tab
//
// A room's status:
//   'waiting'  the creator is waiting for an opponent; they may cancel freely
//   'active'   both players have sat down; leaving now LOSES the game
//   'over'     finished (checkmate, draw, someone left or didn't come back)
//
// Seats: the room's creator takes the side they chose; the next person to
// join takes the other side; anyone after that watches. Each browser tab
// has a secret random "playerId"; a seat stays reserved for that id even
// while its owner is disconnected, so refreshing puts you back in your seat.
// In an active game a disconnected player has GRACE_SECONDS to come back,
// otherwise their opponent wins by abandonment.

import express from 'express';
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { Server } from 'socket.io';
import { Chess } from 'chess.js';

// The port can be changed with the PORT environment variable
// (e.g. `PORT=4000 npm run server`); otherwise it's 3050.
const PORT = process.env.PORT || 3050;
const GRACE_SECONDS = Number(process.env.GRACE_SECONDS) || 60; // time to come back after a disconnect
const EMPTY_ROOM_LIFETIME = 2 * 60 * 60 * 1000; // forget rooms nobody has visited for 2 hours

const app = express();
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const httpServer = createServer(app);
const io = new Server(httpServer);

// All games, by room code (like "K7QX"):
//   room -> { chess, seats: { w, b }, settings: { time }, status, result, cleanupTimer }
//   seat = { playerId, name, socketId, exited, graceTimer, graceUntil }
//     socketId   null while that player is disconnected
//     exited     true once they chose "Exit game": they may never sit here again
//     graceUntil time (ms) by which a disconnected player must be back
//   settings.time = minutes per player (0 = no clock)
const rooms = new Map();

// Which room each player is in the middle of an ACTIVE game in:
// playerId -> room code. While a player is listed here, the server won't
// let them create or join any other room.
const activeGames = new Map();

const TIME_CONTROLS = [0, 5, 10, 15];
const SIDE_NAMES = { w: 'Ivory', b: 'Obsidian' };
const other = (color) => (color === 'w' ? 'b' : 'w');

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

// Who is in the room. For each side: { state, name, graceLeft }, where
// state is 'empty' (nobody has taken the seat yet), 'online', 'offline'
// (taken, but disconnected right now) or 'exited' (left the game for good).
// graceLeft = milliseconds a disconnected player has left to come back.
function presenceOf(code) {
  const room = rooms.get(code);
  const seatInfo = (seat) => ({
    state: !seat ? 'empty' : seat.exited ? 'exited' : seat.socketId ? 'online' : 'offline',
    name: seat?.name ?? null,
    graceLeft: seat?.graceUntil ? Math.max(0, seat.graceUntil - Date.now()) : null,
  });
  const everyone = io.sockets.adapter.rooms.get(code)?.size ?? 0;
  const players = ['w', 'b'].filter((c) => room.seats[c]?.socketId).length;
  return { status: room.status, w: seatInfo(room.seats.w), b: seatInfo(room.seats.b), spectators: everyone - players };
}
const sendPresence = (code) => io.to(code).emit('presence', presenceOf(code));

// Forget a room nobody is in after a while, to free memory.
// (Joining the room cancels this timer.)
function scheduleCleanup(code) {
  const room = rooms.get(code);
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    rooms.delete(code);
    console.log(`[${code}] room removed (empty for 2 hours)`);
  }, EMPTY_ROOM_LIFETIME);
}

// A player in an active game is disconnected: give them GRACE_SECONDS to
// come back, or their opponent wins by abandonment.
function startGrace(code, color) {
  const seat = rooms.get(code).seats[color];
  if (seat.graceTimer) return;
  seat.graceUntil = Date.now() + GRACE_SECONDS * 1000;
  seat.graceTimer = setTimeout(() => {
    console.log(`[${code}] ${seat.name} did not come back in time`);
    endGame(code, other(color), 'abandoned');
  }, GRACE_SECONDS * 1000);
  console.log(`[${code}] ${seat.name} is disconnected: ${GRACE_SECONDS}s to come back`);
}

function stopGrace(seat) {
  clearTimeout(seat.graceTimer);
  seat.graceTimer = null;
  seat.graceUntil = null;
}

// Ends the game: records the result, frees both players to play elsewhere,
// and tells everyone in the room.
//   winner: 'w' | 'b' | null (draw)
//   reason: 'checkmate' | 'stalemate' | 'insufficient' | 'threefold' |
//           'fifty-moves' | 'left' | 'abandoned'
function endGame(code, winner, reason) {
  const room = rooms.get(code);
  if (!room || room.status === 'over') return;
  room.status = 'over';
  room.result = { winner, reason, names: { w: room.seats.w?.name, b: room.seats.b?.name } };
  for (const c of ['w', 'b']) {
    const seat = room.seats[c];
    if (!seat) continue;
    stopGrace(seat);
    if (activeGames.get(seat.playerId) === code) activeGames.delete(seat.playerId);
  }
  io.to(code).emit('game-over', room.result);
  sendPresence(code);
  console.log(`[${code}] game over: ${winner ? SIDE_NAMES[winner] + ' wins' : 'draw'} (${reason})`);
}

// After a move: did chess.js just end the game?
function checkBoardResult(code) {
  const { chess } = rooms.get(code);
  if (!chess.isGameOver()) return;
  if (chess.isCheckmate()) return endGame(code, other(chess.turn()), 'checkmate');
  if (chess.isStalemate()) return endGame(code, null, 'stalemate');
  if (chess.isInsufficientMaterial()) return endGame(code, null, 'insufficient');
  if (chess.isThreefoldRepetition()) return endGame(code, null, 'threefold');
  endGame(code, null, 'fifty-moves');
}

io.on('connection', (socket) => {
  // Each connection remembers which room it is in.
  let roomName = null;

  // Is this player in the middle of an active game somewhere else?
  function busyElsewhere(playerId, code) {
    const active = activeGames.get(playerId);
    return active && active !== code
      ? `You are still playing in room ${active}. Finish that game, or use Exit game, first.`
      : null;
  }

  // A new room. The creator's chosen side is reserved for them straight
  // away; they actually sit down when they 'join' right after this.
  socket.on('create-room', (data, reply) => {
    if (typeof reply !== 'function') return;
    const name = cleanName(data?.name);
    if (!isValidPlayerId(data?.playerId)) return reply({ error: 'Invalid player id.' });
    const busy = busyElsewhere(data.playerId, null);
    if (busy) return reply({ error: busy });
    if (!name) return reply({ error: 'Please enter your name.' });
    if (!['w', 'b', 'random'].includes(data.side)) return reply({ error: 'Please choose a side.' });
    if (!TIME_CONTROLS.includes(data.time)) return reply({ error: 'Please choose a time control.' });

    // "Random" is decided here on the server, so nobody can rig it.
    const color = data.side === 'random' ? (randomInt(2) ? 'w' : 'b') : data.side;
    const code = newRoomCode();
    const room = {
      chess: new Chess(),
      seats: { w: null, b: null },
      settings: { time: data.time },
      status: 'waiting',
      result: null,
      cleanupTimer: null,
    };
    room.seats[color] = { playerId: data.playerId, name, socketId: null, exited: false };
    rooms.set(code, room);
    scheduleCleanup(code); // in case nobody ever joins it
    console.log(`[${code}] room created by ${name} (${SIDE_NAMES[color]}, ${data.time || 'no'} min clock)`);
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
    const busy = busyElsewhere(data.playerId, code);
    if (busy) return reply({ error: busy });

    const { seats } = room;
    let color = ['w', 'b'].find((c) => seats[c]?.playerId === data.playerId) ?? null;

    // Someone who chose "Exit game" can never sit down in this game again.
    // Once a game is over, only its two players may still look at it.
    if (color && seats[color].exited) return reply({ error: 'This game has ended.', ended: true });
    if (room.status === 'over' && !color) return reply({ error: 'This game has ended.', ended: true });

    if (roomName && roomName !== code) leaveRoom(); // rejoining the same room isn't leaving
    roomName = code;
    clearTimeout(room.cleanupTimer);
    socket.join(roomName); // Socket.IO "rooms" let us message everyone in a game at once

    // A newcomer takes the free seat, if there is one; otherwise they watch.
    if (!color && room.status === 'waiting') color = !seats.w ? 'w' : !seats.b ? 'b' : null;
    if (color) {
      const seat = seats[color];
      // Same player open in another tab? The newest tab takes over the seat.
      if (seat?.socketId && seat.socketId !== socket.id) io.to(seat.socketId).emit('replaced');
      if (seat) {
        seat.socketId = socket.id;
        seat.name = name;
        stopGrace(seat); // they came back in time
      } else {
        seats[color] = { playerId: data.playerId, name, socketId: socket.id, exited: false };
      }
    }

    // Both seats taken for the first time: the game has started, and from
    // now on neither player may leave it without losing.
    if (room.status === 'waiting' && seats.w && seats.b) {
      room.status = 'active';
      activeGames.set(seats.w.playerId, code);
      activeGames.set(seats.b.playerId, code);
      console.log(`[${code}] game started: ${seats.w.name} (Ivory) vs ${seats.b.name} (Obsidian)`);
      // If the creator closed their tab while waiting, their clock to come back starts now.
      for (const c of ['w', 'b']) if (!seats[c].socketId) startGrace(code, c);
    }

    console.log(`[${roomName}] ${name} joined as ${SIDE_NAMES[color] ?? 'a spectator'}`);

    // Reply with everything needed to draw the game as it is right now.
    const moves = room.chess.history({ verbose: true }).map(({ from, to, promotion }) => ({ from, to, promotion }));
    reply({
      room: roomName,
      color,
      moves,
      fen: room.chess.fen(),
      settings: room.settings,
      status: room.status,
      result: room.result,
      presence: presenceOf(roomName),
    });
    sendPresence(roomName);
  });

  // "Exit game": leave this room for good.
  //  - waiting for an opponent: the room is simply closed
  //  - active game: you lose, straight away, and can't come back
  //  - game already over (or watching): you just leave
  socket.on('exit-game', (data, reply) => {
    const room = rooms.get(roomName);
    const done = () => typeof reply === 'function' && reply({ ok: true });
    if (!room) return done();
    const code = roomName;
    const color = colorOf(room, socket.id);

    if (color && room.status === 'active') {
      room.seats[color].exited = true;
      console.log(`[${code}] ${room.seats[color].name} exited the game`);
      endGame(code, other(color), 'left');
    } else if (color && room.status === 'waiting') {
      rooms.delete(code);
      console.log(`[${code}] room cancelled by its creator`);
    } else if (color) {
      room.seats[color].exited = true; // game over: leaving is fine, but it's final
    }
    leaveRoom();
    done();
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
    if (room.status === 'waiting') return reject('Waiting for an opponent to join.');
    if (room.status === 'over') return reject('The game is over.');
    if (chess.turn() !== color) return reject("It's not your turn.");
    if (!room.seats[other(color)].socketId) return reject('Your opponent is disconnected.');

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
    console.log(`[${roomName}] ${move.san}`);
    checkBoardResult(roomName);
  });

  // Leaving the room: by choice (exit-game), by joining another room, or
  // because the connection dropped (refresh, closed tab, lost wifi).
  function leaveRoom() {
    const code = roomName;
    const room = rooms.get(code);
    roomName = null;
    socket.leave(code);
    if (!room) return;
    const color = colorOf(room, socket.id);
    if (color) {
      const seat = room.seats[color];
      seat.socketId = null;
      // In an active game, an accidental disconnect starts the grace timer.
      if (room.status === 'active' && !seat.exited) startGrace(code, color);
    }
    sendPresence(code);
    if (!io.sockets.adapter.rooms.get(code)?.size) scheduleCleanup(code);
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
