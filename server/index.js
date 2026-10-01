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
//   browser -> server   'resign' {}     (reply: { ok } or { error })  give up: the opponent wins
//   browser -> server   'offer' { type }  (reply: { ok } or { error }) offer a draw / ask for a takeback
//   browser -> server   'answer-offer' { accept }  (reply: { ok } or { error })
//   server  -> everyone 'offer' { type, from, status }                status: 'pending' | 'accepted' |
//                                                                     'declined' | 'expired'
//   server  -> everyone 'takeback' { moves, fen }                     a takeback was accepted: redraw
//   browser -> server   'rematch' {}  (reply: { ok } or { error })    "I'd like a rematch"
//   server  -> everyone 'rematch' { w, b }                            who has asked for a rematch
//   server  -> everyone 'rematch-started'                             new game, colours swapped: join again
//   server  -> everyone 'clock' { w, b, running }                     milliseconds left each; whose clock runs
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
// How many milliseconds one "minute" on the chess clocks lasts. Always a real
// minute, except in quick automatic tests (e.g. MINUTE_MS=1000).
const MINUTE_MS = Number(process.env.MINUTE_MS) || 60_000;
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

// ---------------------------------------------------------------------------
// Chess clocks. The server is the only timekeeper:
//   room.clock = { w, b, running, since, alarm }
//     w, b     milliseconds each player had left when their clock last stopped
//     running  whose clock is ticking ('w' | 'b'), or null when paused
//     since    when the running clock started (Date.now())
//     alarm    a timer that fires the moment the running player runs out
// Clocks only run while the game is active AND both players are connected.
// ---------------------------------------------------------------------------
function newClock(minutes) {
  return minutes ? { w: minutes * MINUTE_MS, b: minutes * MINUTE_MS, running: null, since: null, alarm: null } : null;
}

// Time left for each player right now: { w, b, running } (ms).
function clockNow(room) {
  const c = room.clock;
  if (!c) return null;
  const left = { w: c.w, b: c.b };
  if (c.running) left[c.running] = Math.max(0, left[c.running] - (Date.now() - c.since));
  return { ...left, running: c.running };
}
const sendClock = (code) => rooms.get(code).clock && io.to(code).emit('clock', clockNow(rooms.get(code)));

// Stop the running clock, keeping the time that was used.
function pauseClock(room) {
  const c = room.clock;
  if (!c?.running) return;
  c[c.running] = Math.max(0, c[c.running] - (Date.now() - c.since));
  c.running = null;
  clearTimeout(c.alarm);
}

// Start the clock of whoever is to move, if the game is live and both
// players are here.
function resumeClock(code) {
  const room = rooms.get(code);
  const c = room.clock;
  if (!c || c.running || room.status !== 'active') return;
  if (!room.seats.w?.socketId || !room.seats.b?.socketId) return;
  const color = room.chess.turn();
  c.running = color;
  c.since = Date.now();
  c.alarm = setTimeout(() => flag(code, color), c[color]);
}

// A player's time ran out. They lose, unless their opponent has only a
// king left: a bare king can't checkmate, so then it's a draw.
function flag(code, color) {
  const room = rooms.get(code);
  if (!room || room.status !== 'active') return;
  pauseClock(room);
  room.clock[color] = 0;
  const winner = other(color);
  const winnerPieces = room.chess.board().flat().filter((sq) => sq?.color === winner);
  console.log(`[${code}] ${room.seats[color].name} ran out of time`);
  if (winnerPieces.length === 1) endGame(code, null, 'timeout-insufficient', { flagged: color });
  else endGame(code, winner, 'timeout');
}

// Ends the game: records the result, frees both players to play elsewhere,
// and tells everyone in the room.
//   winner: 'w' | 'b' | null (draw)
//   reason: 'checkmate' | 'stalemate' | 'insufficient' | 'threefold' |
//           'fifty-moves' | 'left' | 'abandoned' | 'resigned' | 'agreed' |
//           'timeout' | 'timeout-insufficient'
//   extra: more details, e.g. { flagged: 'w' } (who ran out of time)
function endGame(code, winner, reason, extra = {}) {
  const room = rooms.get(code);
  if (!room || room.status === 'over') return;
  pauseClock(room);
  sendClock(code);
  room.status = 'over';
  room.offer = null; // any open offer dies with the game
  room.rematch = { w: false, b: false };
  room.result = { winner, reason, names: { w: room.seats.w?.name, b: room.seats.b?.name }, ...extra };
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
      clock: newClock(data.time),
      status: 'waiting',
      result: null,
      offer: null, // an open offer waiting for an answer: { type: 'draw' | 'takeback', from: 'w' | 'b' }
      offerPly: { draw: { w: -1, b: -1 }, takeback: { w: -1, b: -1 } }, // move number of each player's last offer
      rematch: { w: false, b: false }, // who has asked for a rematch (after the game is over)
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
    resumeClock(roomName); // both players here now? then the clock runs
    sendClock(roomName);

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
      offer: room.offer,
      rematch: room.rematch,
      clock: clockNow(room),
      presence: presenceOf(roomName),
    });
    sendPresence(roomName);
  });

  // "Exit game": leave this room for good.
  //  - waiting for an opponent: the room is simply closed
  //  - active game: you lose, straight away, and can't come back
  //  - game already over (or watching): you just leave
  // Every in-game request below answers with { ok } or { error }.
  const answer = (reply, result) => typeof reply === 'function' && reply(result);

  // The player in this connection's room, if this connection is a player
  // in an active game: { room, color }. Otherwise an error message.
  function activePlayer() {
    const room = rooms.get(roomName);
    const color = room && colorOf(room, socket.id);
    if (!color) return { error: 'Only the two players can do that.' };
    if (room.status !== 'active') return { error: 'There is no game in progress.' };
    return { room, color };
  }

  // "Resign": give up. The opponent wins straight away.
  socket.on('resign', (data, reply) => {
    const { error, room, color } = activePlayer();
    if (error) return answer(reply, { error });
    console.log(`[${roomName}] ${room.seats[color].name} resigned`);
    endGame(roomName, other(color), 'resigned');
    answer(reply, { ok: true });
  });

  // Offers that the opponent must accept: a draw (or a takeback, below).
  // Only one offer can be open at a time, and each player may make each
  // kind of offer only once per move.
  const OFFER_LIMIT = {
    draw: 'You can only offer a draw once per move.',
    takeback: 'You can only ask for one takeback per move.',
  };
  socket.on('offer', (data, reply) => {
    const { error, room, color } = activePlayer();
    if (error) return answer(reply, { error });
    const type = data?.type;
    if (!OFFER_LIMIT[type]) return answer(reply, { error: 'Unknown offer.' });
    if (room.offer) return answer(reply, { error: 'There is already an offer waiting for an answer.' });
    const ply = room.chess.history().length;
    if (room.offerPly[type][color] === ply) return answer(reply, { error: OFFER_LIMIT[type] });
    if (!room.seats[other(color)].socketId) return answer(reply, { error: 'Your opponent is disconnected.' });
    if (type === 'takeback' && !room.chess.history({ verbose: true }).some((m) => m.color === color)) {
      return answer(reply, { error: 'You have not made a move yet, so there is nothing to take back.' });
    }

    room.offer = { type, from: color };
    room.offerPly[type][color] = ply;
    io.to(roomName).emit('offer', { type, from: color, status: 'pending' });
    console.log(`[${roomName}] ${room.seats[color].name} offers: ${type}`);
    answer(reply, { ok: true });
  });

  // The opponent's answer to an open offer.
  socket.on('answer-offer', (data, reply) => {
    const { error, room, color } = activePlayer();
    if (error) return answer(reply, { error });
    const offer = room.offer;
    if (!offer || offer.from === color) return answer(reply, { error: 'There is no offer for you to answer.' });

    room.offer = null;
    const accept = data?.accept === true;
    io.to(roomName).emit('offer', { ...offer, status: accept ? 'accepted' : 'declined' });
    console.log(`[${roomName}] ${room.seats[color].name} ${accept ? 'accepted' : 'declined'}: ${offer.type}`);
    if (accept && offer.type === 'draw') endGame(roomName, null, 'agreed');
    if (accept && offer.type === 'takeback') takeBack(room, offer.from);
    answer(reply, { ok: true });
  });

  // Undo the asker's last move. If the opponent has already replied, that
  // reply is undone too, so it is the asker's turn again.
  function takeBack(room, asker) {
    const undo = room.chess.turn() === asker ? 2 : 1;
    for (let i = 0; i < undo; i++) room.chess.undo();
    room.offerPly = { draw: { w: -1, b: -1 }, takeback: { w: -1, b: -1 } }; // the move count went down
    const moves = room.chess.history({ verbose: true }).map(({ from, to, promotion }) => ({ from, to, promotion }));
    io.to(roomName).emit('takeback', { moves, fen: room.chess.fen() });
    pauseClock(room); // the turn changed: run the right player's clock
    resumeClock(roomName);
    sendClock(roomName);
    console.log(`[${roomName}] takeback: ${undo} move(s) undone`);
  }

  // "Rematch": both players must ask. Then the same room starts a new game
  // with the colours swapped.
  socket.on('rematch', (data, reply) => {
    const room = rooms.get(roomName);
    const color = room && colorOf(room, socket.id);
    if (!color) return answer(reply, { error: 'Only the two players can ask for a rematch.' });
    if (room.status !== 'over') return answer(reply, { error: 'The game is not over yet.' });
    const opponent = room.seats[other(color)];
    if (opponent.exited) return answer(reply, { error: `${opponent.name} has left, so a rematch isn't possible.` });

    room.rematch[color] = true;
    io.to(roomName).emit('rematch', room.rematch);
    console.log(`[${roomName}] ${room.seats[color].name} asks for a rematch`);
    if (room.rematch.w && room.rematch.b) startRematch(roomName);
    answer(reply, { ok: true });
  });

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
      room.rematch = { w: false, b: false };
      io.to(code).emit('rematch', room.rematch);
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
    if (room.clock && clockNow(room)[color] <= 0) {
      flag(roomName, color); // too late: their time was already up
      return reject('Your time ran out.');
    }

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
    // Stop the mover's clock and start the opponent's.
    pauseClock(room);
    resumeClock(roomName);
    sendClock(roomName);
    // Playing a move instead of answering lets an open offer lapse.
    if (room.offer) {
      io.to(roomName).emit('offer', { ...room.offer, status: 'expired' });
      room.offer = null;
    }
    checkBoardResult(roomName);
  });

  function startRematch(code) {
    const room = rooms.get(code);
    const { seats } = room;
    [seats.w, seats.b] = [seats.b, seats.w]; // swap colours
    room.chess = new Chess();
    room.status = 'active';
    room.result = null;
    room.offer = null;
    room.offerPly = { draw: { w: -1, b: -1 }, takeback: { w: -1, b: -1 } };
    room.rematch = { w: false, b: false };
    room.clock = newClock(room.settings.time); // fresh clocks
    activeGames.set(seats.w.playerId, code);
    activeGames.set(seats.b.playerId, code);
    for (const c of ['w', 'b']) if (!seats[c].socketId) startGrace(code, c);
    console.log(`[${code}] rematch: ${seats.w.name} (Ivory) vs ${seats.b.name} (Obsidian)`);
    io.to(code).emit('rematch-started');
    sendPresence(code);
    resumeClock(code);
    sendClock(code);
  }

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
      // In an active game, an accidental disconnect starts the grace timer,
      // and both clocks stop until the player is back.
      if (room.status === 'active' && !seat.exited) {
        startGrace(code, color);
        pauseClock(room);
        sendClock(code);
      }
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
