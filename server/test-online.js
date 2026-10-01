// server/test-online.js
// Automatic check of the game server, using pretend players. It connects
// through the Vite proxy, so it also checks that the proxy works.
// Needs both `npm run server` and `npm run dev` running.
// Run with: npm run test:server

import { io } from 'socket.io-client';

const URL = process.env.URL || 'http://localhost:5173';
let failures = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A pretend player: a connection, an id, and an inbox of every message received.
function player(playerId, name = playerId.split('-')[0]) {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const inbox = [];
  socket.onAny((event, data) => inbox.push({ event, data }));
  const join = (room, as = name) => new Promise((resolve) => socket.emit('join', { room, playerId, name: as }, resolve));
  const create = (side, time) => new Promise((resolve) => socket.emit('create-room', { playerId, name, side, time }, resolve));
  const exit = () => new Promise((resolve) => socket.emit('exit-game', {}, resolve));
  const last = (event) => inbox.filter((m) => m.event === event).at(-1)?.data;
  return { socket, inbox, join, create, exit, last, playerId };
}

// --- Step 1: the server referees moves ------------------------------------
const ivory = player('ivory-player-0001');
const obsidian = player('obsidian-player-01');
await wait(500);
check(ivory.socket.connected && obsidian.socket.connected, 'players connect through the Vite proxy');

// --- Step 2: rooms and seats ----------------------------------------------
check((await ivory.create('w', 7)).error?.includes('time'), 'server refuses a time control that is not offered');
check((await ivory.join('ZZZZ')).error?.includes('no game'), 'joining a code that does not exist is refused');
check((await obsidian.join('ABCD', '   ')).error?.includes('name'), 'a blank name is refused');

const created = await ivory.create('w', 10);
const room = created.room;
check(/^[A-Z2-9]{4}$/.test(room) && created.color === 'w', `server created room ${room} with Ivory for the creator`);

const r1 = await ivory.join(room.toLowerCase()); // codes work in lower case too
check(r1.color === 'w' && r1.settings.time === 10, 'creator sits as Ivory; the room remembers the 10 minute clock');
check(r1.presence.w.name === 'ivory' && r1.presence.b.state === 'empty', 'join reply says who is here (just the creator)');
ivory.socket.emit('move', { from: 'e2', to: 'e4' });
await wait(200);
check(ivory.last('move-rejected')?.reason?.includes('opponent'), 'no moves until an opponent arrives');

const r2 = await obsidian.join(room);
check(r2.color === 'b', 'second player is Obsidian');
const watcher = player('spectator-player-1');
await wait(300);
const r3 = await watcher.join(room);
check(r3.color === null, 'third person is a spectator');
await wait(200);
check(ivory.last('presence')?.w.state === 'online' && ivory.last('presence')?.b.state === 'online', 'presence: both players online');
check(ivory.last('presence')?.b.name === 'obsidian', "presence: includes the opponent's name");
check(ivory.last('presence')?.spectators === 1, 'presence: one spectator');

obsidian.socket.emit('move', { from: 'e7', to: 'e5' });
await wait(200);
check(obsidian.last('move-rejected')?.reason === "It's not your turn.", 'Obsidian cannot move on Ivory\'s turn');

watcher.socket.emit('move', { from: 'e2', to: 'e4' });
await wait(200);
check(watcher.last('move-rejected')?.reason === 'Spectators cannot move.', 'spectators cannot move');

ivory.socket.emit('move', { from: 'e2', to: 'e4' });
await wait(200);
check([ivory, obsidian, watcher].every((p) => p.last('move')?.san === 'e4'), 'legal move is sent to everyone in the room');

obsidian.inbox.length = ivory.inbox.length = 0;
obsidian.socket.emit('move', { from: 'e7', to: 'e3' });
await wait(200);
check(obsidian.last('move-rejected')?.reason === 'Illegal move.', 'illegal move is rejected...');
check(!ivory.inbox.some((m) => m.event === 'move' || m.event === 'move-rejected'), '...and only the sender hears about it');

obsidian.socket.emit('move', { from: 'e7', to: 'e5' });
await wait(200);

// --- Step 4: reconnecting -------------------------------------------------
obsidian.socket.close(); // like closing or refreshing the tab
await wait(300);
check(ivory.last('presence')?.b.state === 'offline', 'when Obsidian leaves, Ivory is told they disconnected');
check(ivory.last('presence')?.b.graceLeft > 0, `...with a countdown (${Math.round(ivory.last('presence')?.b.graceLeft / 1000)}s to come back)`);
ivory.socket.emit('move', { from: 'g1', to: 'f3' });
await wait(200);
check(ivory.last('move-rejected')?.reason === 'Your opponent is disconnected.', 'no moves while the opponent is away');

const back = player('obsidian-player-01'); // same id = same browser tab after a refresh
await wait(300);
const r4 = await back.join(room);
check(r4.color === 'b', 'after refreshing, Obsidian gets the same colour back');
check(r4.moves.map((m) => m.from + m.to).join(' ') === 'e2e4 e7e5', 'and receives the moves so far (e4 e5)');
await wait(200);
check(ivory.last('presence')?.b.state === 'online' && ivory.last('presence')?.b.graceLeft === null, 'and Ivory is told they are back (countdown stopped)');
check(!ivory.inbox.some((m) => m.event === 'game-over'), 'coming back in time does not end the game');

// --- A started game can't be abandoned for a new one ----------------------
check((await ivory.create('w', 0)).error?.includes('still playing'), 'mid-game, the server refuses to create a new room');
const otherRoom = (await watcher.create('w', 0)).room;
check((await ivory.join(otherRoom)).error?.includes('still playing'), 'mid-game, the server refuses to join another room');

const stranger = player('someone-else-0001');
await wait(300);
check((await stranger.join(room)).color === null, 'a new person still only gets to watch');

// --- Random side is decided by the server --------------------------------
const sides = new Set();
for (let i = 0; i < 12; i++) sides.add((await stranger.create('random', 0)).color);
check(sides.has('w') && sides.has('b'), 'choosing Random gives Ivory sometimes and Obsidian other times');
const darkRoom = (await stranger.create('b', 5)).room;
check((await stranger.join(darkRoom)).color === 'b', 'choosing Obsidian seats the creator as Obsidian');
check((await watcher.join(darkRoom)).color === 'w', 'and the friend who joins gets Ivory');

// --- Exit game: the leaver loses at once and can't come back -------------
const p1 = player('leaver-player-0001', 'Lena');
const p2 = player('stayer-player-0001', 'Sam');
const late = player('latecomer-player-01', 'Kit');
await wait(400);
const exitRoom = (await p1.create('w', 0)).room;
await p1.join(exitRoom);
await p2.join(exitRoom);
p1.socket.emit('move', { from: 'e2', to: 'e4' });
await wait(200);
await p1.exit();
await wait(200);
const over = p2.last('game-over');
check(over?.winner === 'b' && over?.reason === 'left' && over?.names.w === 'Lena', 'Exit game: opponent is told "Lena left the game" and wins');
check((await p1.join(exitRoom)).ended === true, 'the leaver cannot rejoin ("This game has ended")');
check((await late.join(exitRoom)).ended === true, 'nobody new can join a finished game');
const p2back = await p2.join(exitRoom);
check(p2back.status === 'over' && p2back.result?.reason === 'left', 'the winner can still look at the finished game');
p2.socket.emit('move', { from: 'e7', to: 'e5' });
await wait(200);
check(p2.last('move-rejected')?.reason === 'The game is over.', 'no moves after the game is over');
check(!(await p1.create('w', 0)).error, 'after the game ends, the leaver may start a new game');

// --- Disconnect and don't come back: abandonment ------------------------
const q1 = player('stays-player-00001', 'Ana');
const q2 = player('vanishes-player-01', 'Ben');
await wait(400);
const goneRoom = (await q1.create('b', 0)).room;
await q1.join(goneRoom);
await q2.join(goneRoom);
await wait(200);
q2.socket.close(); // closed tab / lost wifi
await wait(300);
const grace = q1.last('presence')?.w.graceLeft;
console.log(`      (waiting ${Math.round(grace / 1000)}s for Ben's time to run out...)`);
await wait(grace + 800);
const abandoned = q1.last('game-over');
check(abandoned?.winner === 'b' && abandoned?.reason === 'abandoned', 'not back in time: the opponent wins by abandonment');
const q2again = player('vanishes-player-01', 'Ben');
await wait(300);
const late2 = await q2again.join(goneRoom);
check(late2.status === 'over' && late2.result?.reason === 'abandoned', 'coming back too late shows the finished game');

// --- Cancelling the waiting room is fine ---------------------------------
const lonely = player('lonely-player-0001', 'Ola');
await wait(300);
const lobby = (await lonely.create('w', 0)).room;
await lonely.join(lobby);
await lonely.exit();
check((await late.join(lobby)).error?.includes('no game'), 'cancelling before anyone joins just closes the room');
check(!(await lonely.create('w', 0)).error, 'and the creator may start another');

for (const p of [ivory, watcher, back, stranger, p1, p2, late, q1, q2again, lonely]) p.socket.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
