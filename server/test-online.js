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
  const last = (event) => inbox.filter((m) => m.event === event).at(-1)?.data;
  return { socket, inbox, join, create, last, playerId };
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
ivory.socket.emit('move', { from: 'g1', to: 'f3' });
await wait(200);
check(ivory.last('move-rejected')?.reason === 'Your opponent is disconnected.', 'no moves while the opponent is away');

const back = player('obsidian-player-01'); // same id = same browser tab after a refresh
await wait(300);
const r4 = await back.join(room);
check(r4.color === 'b', 'after refreshing, Obsidian gets the same colour back');
check(r4.moves.map((m) => m.from + m.to).join(' ') === 'e2e4 e7e5', 'and receives the moves so far (e4 e5)');
await wait(200);
check(ivory.last('presence')?.b.state === 'online', 'and Ivory is told they are back');

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

for (const p of [ivory, watcher, back, stranger]) p.socket.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
