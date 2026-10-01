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
  const ask = (event, data = {}) => new Promise((resolve) => socket.emit(event, data, resolve));
  const last = (event) => inbox.filter((m) => m.event === event).at(-1)?.data;
  const got = (event) => inbox.some((m) => m.event === event); // for messages that carry no data
  return { socket, inbox, join, create, exit, ask, last, got, playerId };
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

// --- Resign -----------------------------------------------------------------
const rs1 = player('resigner-player-01', 'Rae');
const rs2 = player('resign-winner-0001', 'Eli');
const rw = player('resign-watcher-001', 'Viv');
await wait(400);
const resignRoom = (await rs1.create('w', 0)).room;
await rs1.join(resignRoom);
check((await rs1.ask('resign')).error !== undefined, 'nobody can resign before the game has started');
await rs2.join(resignRoom);
await rw.join(resignRoom);
check((await rw.ask('resign')).error !== undefined, 'a spectator cannot resign');
check((await rs1.ask('resign')).ok === true, 'a player can resign');
await wait(200);
const resigned = rs2.last('game-over');
check(resigned?.winner === 'b' && resigned?.reason === 'resigned' && resigned?.names.w === 'Rae', 'the opponent wins: "Rae resigned"');
check((await rs1.ask('resign')).error !== undefined, 'you cannot resign a game that is already over');
check((await rs1.join(resignRoom)).status === 'over', 'resigning is not leaving: the resigner can still see the result');

// --- Draw offers -------------------------------------------------------------
const d1 = player('draw-offerer-00001', 'Dee');
const d2 = player('draw-answerer-0001', 'Fin');
await wait(400);
const drawRoom = (await d1.create('w', 0)).room;
await d1.join(drawRoom);
await d2.join(drawRoom);
check((await d1.ask('offer', { type: 'draw' })).ok === true, 'a player can offer a draw');
await wait(200);
check(d2.last('offer')?.status === 'pending' && d2.last('offer')?.from === 'w', 'the opponent is told about the offer');
check((await d1.ask('answer-offer', { accept: true })).error !== undefined, 'you cannot accept your own offer');
check((await d2.ask('offer', { type: 'draw' })).error?.includes('already'), 'only one open offer at a time');
await d2.ask('answer-offer', { accept: false });
await wait(200);
check(d1.last('offer')?.status === 'declined', 'Decline: the offerer is told');
check((await d1.ask('offer', { type: 'draw' })).error?.includes('once per move'), 'the same player cannot offer again on the same move');
d1.socket.emit('move', { from: 'e2', to: 'e4' });
await wait(200);
check((await d2.ask('offer', { type: 'draw' })).ok === true, 'after a move, a new offer is allowed');
d1.inbox.length = 0;
d2.socket.emit('move', { from: 'e7', to: 'e5' });
await wait(200);
check(d1.last('offer')?.status === 'expired', 'playing a move instead of answering lets the offer lapse');
check((await d1.ask('offer', { type: 'draw' })).ok === true, 'a new move allows a new offer');
await wait(100);
check((await d2.ask('answer-offer', { accept: true })).ok === true, 'Accept works');
await wait(200);
check(d1.last('game-over')?.winner === null && d1.last('game-over')?.reason === 'agreed', 'accepting a draw ends the game: "Draw agreed"');

// --- Takebacks ---------------------------------------------------------------
const t1 = player('takeback-asker-001', 'Tam');
const t2 = player('takeback-other-001', 'Ula');
await wait(400);
const tbRoom = (await t1.create('w', 0)).room;
await t1.join(tbRoom);
await t2.join(tbRoom);
check((await t1.ask('offer', { type: 'takeback' })).error?.includes('nothing to take back'), 'no takeback before you have moved');
t1.socket.emit('move', { from: 'e2', to: 'e4' });
await wait(200);
await t1.ask('offer', { type: 'takeback' });
await wait(150);
check(t2.last('offer')?.type === 'takeback' && t2.last('offer')?.status === 'pending', 'the opponent is asked to allow the takeback');
await t2.ask('answer-offer', { accept: false });
await wait(150);
check(t1.last('offer')?.status === 'declined' && !t1.last('takeback'), 'Decline: nothing is undone');
check((await t1.ask('offer', { type: 'takeback' })).error?.includes('one takeback per move'), 'only one takeback request per move');
t2.socket.emit('move', { from: 'e7', to: 'e5' });
await wait(200);
await t1.ask('offer', { type: 'takeback' }); // Ula has already replied: both moves come back
await wait(150);
await t2.ask('answer-offer', { accept: true });
await wait(200);
const tb = t2.last('takeback');
check(tb?.moves.length === 0 && tb?.fen.includes(' w '), "accepted after the reply: Tam's move and Ula's reply are undone, Tam to move");
t1.socket.emit('move', { from: 'd2', to: 'd4' });
await wait(200);
check(t2.last('move')?.san === 'd4', 'play carries on from the earlier position');
await t1.ask('offer', { type: 'takeback' }); // Ula hasn't replied yet: only Tam's move comes back
await wait(150);
await t2.ask('answer-offer', { accept: true });
await wait(200);
check(t1.last('takeback')?.moves.length === 0, 'accepted before the reply: only the last move is undone');

// --- Rematch -------------------------------------------------------------------
const m1 = player('rematch-player-0001', 'Max');
const m2 = player('rematch-player-0002', 'Noa');
await wait(400);
const mRoom = (await m1.create('w', 0)).room;
await m1.join(mRoom);
await m2.join(mRoom);
check((await m1.ask('rematch')).error?.includes('not over'), 'no rematch while the game is still going');
await m2.ask('resign');
await wait(150);
const askedOk = (await m1.ask('rematch')).ok === true;
await wait(150);
check(askedOk && m2.last('rematch')?.w === true, 'after the game, Max asks for a rematch and Noa is told');
check(!m1.got('rematch-started'), 'one request is not enough');
await m2.ask('rematch');
await wait(200);
check(m1.got('rematch-started') && m2.got('rematch-started'), 'when both ask, the rematch starts');
const mAgain1 = await m1.join(mRoom);
const mAgain2 = await m2.join(mRoom);
check(mAgain1.color === 'b' && mAgain2.color === 'w', 'colours are swapped: Max is Obsidian, Noa is Ivory');
check(mAgain1.status === 'active' && mAgain1.moves.length === 0 && !mAgain1.result, 'it is a fresh game');
m2.socket.emit('move', { from: 'e2', to: 'e4' });
await wait(150);
check(m1.last('move')?.san === 'e4', 'Noa (now Ivory) moves first');
check((await m1.create('w', 0)).error?.includes('still playing'), 'the rematch counts as an active game again');
await m1.exit();
await wait(150);
check(m2.last('game-over')?.reason === 'left', 'leaving the rematch loses it, like any game');
check((await m2.ask('rematch')).error?.includes('has left'), 'no rematch with a player who has left');

// --- Clocks ------------------------------------------------------------------
// The test server counts a clock "minute" as MINUTE_MS (1 second in tests),
// so a 5 minute game lasts 5 seconds here.
const c1 = player('clock-player-00001', 'Cy');
const c2 = player('clock-player-00002', 'Di');
await wait(400);
const cRoom = (await c1.create('w', 5)).room;
const cj1 = await c1.join(cRoom);
check(cj1.clock?.w > 0 && cj1.clock?.w === cj1.clock?.b && cj1.clock?.running === null, "a timed room has equal clocks that don't run before the opponent arrives");
const fiveMinutes = cj1.clock.w;
await c2.join(cRoom);
await wait(300);
const startJoin = await c2.join(cRoom);
check(startJoin.clock?.running === 'w' && startJoin.clock.w < fiveMinutes, "when the game starts, Ivory's clock runs");
c1.socket.emit('move', { from: 'e2', to: 'e4' });
await wait(200);
const afterMove = c2.last('clock');
check(afterMove?.running === 'b' && afterMove.b === fiveMinutes && afterMove.w < fiveMinutes, "after Ivory moves, Obsidian's clock runs and Ivory's stops");
c2.socket.close(); // Di disconnects
await wait(300);
const paused = c1.last('clock');
check(paused?.running === null, 'both clocks pause while a player is disconnected');
const c2back = player('clock-player-00002', 'Di');
await wait(300);
await c2back.join(cRoom);
await wait(200);
check(c1.last('clock')?.running === 'b', 'and run again when they are back');
const noClock = await c1.create('w', 0);
check(noClock.error?.includes('still playing'), '(the clock game is a normal active game)');
console.log(`      (waiting ${Math.round(c1.last('clock').b / 1000)}s for Di's clock to run out...)`);
await wait(c1.last('clock').b + 800);
const timeout = c1.last('game-over');
check(timeout?.winner === 'w' && timeout?.reason === 'timeout', 'running out of time loses the game');
check(c1.last('clock')?.b === 0 && c1.last('clock')?.running === null, 'the clocks stop, showing 0:00 for the loser');
c2back.socket.emit('move', { from: 'e7', to: 'e5' });
await wait(150);
check(c2back.last('move-rejected')?.reason === 'The game is over.', 'no moves after running out of time');
const untimed = player('untimed-player-001', 'Ed');
await wait(300);
const untimedRoom = (await untimed.create('w', 0)).room;
check((await untimed.join(untimedRoom)).clock === null, 'a room with no time control has no clock');
await untimed.exit();
untimed.socket.close();

// --- Cancelling the waiting room is fine ---------------------------------
const lonely = player('lonely-player-0001', 'Ola');
await wait(300);
const lobby = (await lonely.create('w', 0)).room;
await lonely.join(lobby);
await lonely.exit();
check((await late.join(lobby)).error?.includes('no game'), 'cancelling before anyone joins just closes the room');
check(!(await lonely.create('w', 0)).error, 'and the creator may start another');

for (const p of [ivory, watcher, back, stranger, p1, p2, late, q1, q2again, lonely, rs1, rs2, rw, d1, d2, t1, t2, m1, m2, c1, c2back]) p.socket.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
