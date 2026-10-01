// main.js
// The entry point. It sets up the 3D scene, keeps the 3D pieces in sync
// with the chess.js game, handles clicks, and runs the animation loop.
//
// Golden rule: chess.js decides what is legal. The 3D scene only *shows*
// what chess.js says. We never write chess rules ourselves.
//
// Online (the normal mode): a click only *asks* the server for a move.
// The board changes when the server announces the move to both players.
// Local (add ?local to the address): both sides play on this screen, as in
// milestone 1, with Undo available.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Chess } from 'chess.js';

import { createBoard, squareToPosition, positionToSquare, faceLabels } from './board.js';
import { createPiece } from './pieces.js';
import { SmashEffects } from './smash.js';
import { tween, updateTweens, easeInOut } from './tween.js';
import { playMoveSound, playSmashSound, unlockAudio } from './sound.js';
import { updateHud, askPromotion, showOnlinePanel, askConfirm, showGameOver, updateRematch, hideGameOver } from './ui.js';
import { initMusic } from './music.js';
import {
  connectOnline,
  createRoom,
  joinRoom,
  sendMove,
  exitGame,
  ask,
  inviteLink,
  resync,
  roomFromUrl,
  savedSession,
  forgetSession,
} from './online.js';
import { initIntro, showIntro, hideIntro, introScreen, introError, setIntroBusy, copyToClipboard } from './intro.js';

// ---------------------------------------------------------------------------
// 1. Renderer, scene, camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0b14);
scene.fog = new THREE.Fog(0x0d0b14, 26, 55);

// "Sitting at the table" view: the camera looks down at about 45 degrees,
// so we see the statues partly from the side while the whole board fits.
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
const TARGET = new THREE.Vector3(0, 0.6, 0); // aim at the statues' middle, not the board surface
const LOOK_DOWN = THREE.MathUtils.degToRad(45); // angle below the horizon
const START_DISTANCE = 13.5;

// OrbitControls lets the player drag to rotate and scroll to zoom.
// Its "polar angle" is measured from straight overhead, so looking 40-50
// degrees down means a polar angle of 40-50 degrees too (90 - 50 = 40).
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.target.copy(TARGET);
controls.minDistance = 10;
controls.maxDistance = 30;
controls.minPolarAngle = THREE.MathUtils.degToRad(40); // steepest: 50 degrees down
controls.maxPolarAngle = THREE.MathUtils.degToRad(50); // flattest: 40 degrees down

// On narrow screens (like a phone held upright) the board is wider than
// the view, so the camera needs to back off to keep the whole board visible.
function distanceToFitBoard() {
  const halfWidth = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  return Math.max(START_DISTANCE, 6.2 / Math.tan(halfWidth));
}
camera.position.set(0, Math.sin(LOOK_DOWN), Math.cos(LOOK_DOWN)).multiplyScalar(distanceToFitBoard()).add(TARGET);

// ---------------------------------------------------------------------------
// 2. Lights: cold moonlight from above plus two warm flickering torches
// ---------------------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0x8a9cc8, 0x1a1410, 0.6));

const moon = new THREE.DirectionalLight(0xc8d6ff, 1.8);
moon.position.set(5, 14, 4);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
Object.assign(moon.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 50 });
moon.shadow.bias = -0.0005;
scene.add(moon);

const torches = [new THREE.Vector3(-6.5, 5, -5), new THREE.Vector3(6.5, 5, -5)].map((p) => {
  const light = new THREE.PointLight(0xff9a4a, 40, 20, 2);
  light.position.copy(p);
  scene.add(light);
  return light;
});

// Slowly drifting magic sparks for atmosphere.
const motes = (() => {
  const n = 200;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 24;
    pos[i * 3 + 1] = Math.random() * 8;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 24;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0xffd98a, size: 0.05, transparent: true, opacity: 0.6 })
  );
  scene.add(points);
  return points;
})();

scene.add(createBoard());

// ---------------------------------------------------------------------------
// 3. Game state
// ---------------------------------------------------------------------------
const chess = new Chess();
const smash = new SmashEffects(scene);

// pieceAt maps a square like "e2" to the 3D piece standing on it.
const pieceAt = new Map();

let selected = null; // the square the player has picked, e.g. "e2"
let busy = false; // true while a move is animating (ignore clicks)

const isLocal = new URLSearchParams(location.search).has('local');

// Everything we know about the online game (unused in local mode).
const net = {
  connection: 'connecting', // 'connecting' | 'connected' | 'lost' | 'unreachable' | 'error'
  joined: false, // has the server given us a seat yet?
  color: null, // 'w', 'b', or null for a spectator
  presence: null, // { w: { state, name }, b: { state, name }, spectators } from the server
  settings: null, // { time } chosen when the room was created
  status: null, // the room: 'waiting' | 'active' | 'over' (decided by the server)
  result: null, // { winner, reason, names } once the game is over
  graceDeadline: { w: null, b: null }, // when a disconnected player runs out of time (local clock)
  offer: null, // an open offer: { type: 'draw' | 'takeback', from: 'w' | 'b' }
  rematch: { w: false, b: false }, // who has asked for a rematch
  clock: null, // { w, b, running, at }: ms left (as of `at`, local time); null = no clock
  waiting: false, // true after we've asked for a move, until the server answers
  notice: '', // a short message such as "It's not your turn."
};

// Can the person at this screen move right now?
function canIMove() {
  if (isLocal) return true;
  const opponent = net.presence?.[net.color === 'w' ? 'b' : 'w'];
  return (
    net.connection === 'connected' &&
    net.status === 'active' &&
    net.color === chess.turn() &&
    opponent?.state === 'online' &&
    !net.waiting
  );
}

// Removes all 3D pieces and rebuilds them from chess.js.
// Used for "New game" and "Undo".
function rebuildPieces() {
  for (const piece of pieceAt.values()) piece.removeFromParent();
  pieceAt.clear();
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const piece = createPiece(cell.type, cell.color);
      piece.position.copy(squareToPosition(cell.square));
      scene.add(piece);
      pieceAt.set(cell.square, piece);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Highlights: selected square, legal move markers, last move, check
// ---------------------------------------------------------------------------
const highlightGroup = new THREE.Group();
scene.add(highlightGroup);

const tileGeo = new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2);
const dotGeo = new THREE.CircleGeometry(0.13, 24).rotateX(-Math.PI / 2);
const ringGeo = new THREE.RingGeometry(0.36, 0.46, 32).rotateX(-Math.PI / 2);

const glow = (color, opacity) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
const mats = {
  selected: glow(0x7fd4ff, 0.45),
  lastMove: glow(0xe8c77a, 0.25),
  check: glow(0xff3b2f, 0.55),
  move: glow(0x9fe8ff, 0.8),
  capture: glow(0xff5a4a, 0.85),
};

function addMarker(geo, mat, square, y = 0.01) {
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(squareToPosition(square)).setY(y);
  highlightGroup.add(m);
}

function refreshHighlights() {
  highlightGroup.clear();

  const history = chess.history({ verbose: true });
  const last = history[history.length - 1];
  if (last) {
    addMarker(tileGeo, mats.lastMove, last.from);
    addMarker(tileGeo, mats.lastMove, last.to);
  }

  if (chess.inCheck()) {
    const king = chess.findPiece({ type: 'k', color: chess.turn() })[0];
    if (king) addMarker(tileGeo, mats.check, king, 0.012);
  }

  if (selected) {
    addMarker(tileGeo, mats.selected, selected, 0.014);
    for (const move of chess.moves({ square: selected, verbose: true })) {
      const isCapture = move.flags.includes('c') || move.flags.includes('e');
      addMarker(isCapture ? ringGeo : dotGeo, isCapture ? mats.capture : mats.move, move.to, 0.016);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Clicking: select a piece, then click a highlighted square to move
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// Works out which square the mouse is over. Pieces are checked first,
// because a tall piece can visually cover the square behind it.
function squareUnderPointer(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  let pieceSquare = null;
  const hits = raycaster.intersectObjects([...pieceAt.values()], true);
  if (hits.length) {
    let obj = hits[0].object;
    while (obj && !obj.userData.isPiece) obj = obj.parent;
    for (const [square, piece] of pieceAt) if (piece === obj) pieceSquare = square;
  }

  let boardSquare = null;
  const point = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(boardPlane, point)) boardSquare = positionToSquare(point.x, point.z);

  // Tall statues can stand in front of a square you want to move to.
  // If you clicked an enemy statue you can't capture, but the board point
  // behind it is a legal move, the board square wins.
  if (pieceSquare && selected && chess.get(pieceSquare).color !== chess.turn()) {
    const targets = chess.moves({ square: selected, verbose: true }).map((m) => m.to);
    if (!targets.includes(pieceSquare) && targets.includes(boardSquare)) return boardSquare;
  }
  return pieceSquare ?? boardSquare;
}

async function onSquareClicked(square) {
  if (busy || chess.isGameOver() || !canIMove()) return;

  const piece = chess.get(square);

  // Clicking one of your own pieces selects it (or switches selection).
  if (piece && piece.color === chess.turn()) {
    selected = selected === square ? null : square;
    refreshHighlights();
    return;
  }

  // Otherwise, if something is selected, try to move there.
  if (selected) {
    const candidates = chess.moves({ square: selected, verbose: true }).filter((m) => m.to === square);
    if (candidates.length) {
      let promotion;
      if (candidates.some((m) => m.promotion)) promotion = await askPromotion();
      const move = { from: selected, to: square, promotion };
      if (isLocal) await tryMove(move);
      else requestMove(move); // online: ask the server; it will tell us when to play it
      return;
    }
  }

  selected = null;
  refreshHighlights();
}

// Distinguish a click from a drag (dragging rotates the camera).
let downAt = null;
canvas.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  unlockAudio();
});
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6) return; // it was a drag
  const square = squareUnderPointer(e);
  if (square) onSquareClicked(square);
});

// ---------------------------------------------------------------------------
// 6. Making a move: ask chess.js, then animate what it tells us
// ---------------------------------------------------------------------------
async function tryMove({ from, to, promotion }) {
  if (busy) return false; // wait for the previous move to finish animating
  let move;
  try {
    move = chess.move({ from, to, promotion }); // throws if illegal
  } catch {
    return false;
  }

  busy = true;
  selected = null;
  highlightGroup.clear();

  const mover = pieceAt.get(from);
  pieceAt.delete(from);

  // Which piece gets smashed? Usually the one on the target square,
  // but en passant captures a pawn that sits *beside* the target.
  let victimSquare = null;
  if (move.flags.includes('e')) victimSquare = to[0] + from[1];
  else if (move.flags.includes('c')) victimSquare = to;
  const victim = victimSquare ? pieceAt.get(victimSquare) : null;
  if (victimSquare) pieceAt.delete(victimSquare);

  const animations = [animatePieceMove(mover, from, to, victim)];

  // Castling also moves the rook.
  if (move.flags.includes('k') || move.flags.includes('q')) {
    const rank = from[1];
    const [rookFrom, rookTo] = move.flags.includes('k') ? ['h' + rank, 'f' + rank] : ['a' + rank, 'd' + rank];
    const rook = pieceAt.get(rookFrom);
    pieceAt.delete(rookFrom);
    pieceAt.set(rookTo, rook);
    animations.push(animatePieceMove(rook, rookFrom, rookTo, null));
  }

  await Promise.all(animations);

  // Promotion: swap the pawn for the new piece with a little flash of magic.
  if (move.promotion) {
    mover.removeFromParent();
    const promoted = createPiece(move.promotion, move.color);
    promoted.position.copy(squareToPosition(to));
    scene.add(promoted);
    pieceAt.set(to, promoted);
    await tween(0.35, (t) => promoted.scale.setScalar(0.3 + 0.7 * easeInOut(t)));
  } else {
    pieceAt.set(to, mover);
  }

  busy = false;
  refreshHighlights();
  updateHud(chess);
  return true;
}

// Moves a piece in an arc. If there is a victim, the attacker leaps up
// (higher for taller victims) and slams down onto it, and the victim
// shatters at the moment of impact.
async function animatePieceMove(piece, from, to, victim) {
  const start = squareToPosition(from);
  const end = squareToPosition(to);
  const victimTop = victim ? new THREE.Box3().setFromObject(victim).max.y : 0;
  const height = victim ? Math.max(1.4, victimTop * 0.75 + 0.5) : 0.4;
  const duration = victim ? 0.7 : 0.4;
  let smashed = false;

  await tween(duration, (t) => {
    const e = easeInOut(t);
    piece.position.lerpVectors(start, end, e);
    piece.position.y = Math.sin(Math.PI * t) * height;

    if (victim && !smashed && t > 0.78) {
      smashed = true;
      smash.shatter(victim);
      playSmashSound();
      shake = 0.25;
    }
  });

  if (!victim) playMoveSound();
}

// ---------------------------------------------------------------------------
// 7. Buttons
// ---------------------------------------------------------------------------
document.getElementById('btn-new').addEventListener('click', () => {
  if (busy || !isLocal) return; // online, new games start from the title screen
  chess.reset();
  selected = null;
  rebuildPieces();
  refreshHighlights();
  updateHud(chess);
});

document.getElementById('btn-undo').addEventListener('click', () => {
  if (busy) return;
  chess.undo();
  selected = null;
  rebuildPieces();
  refreshHighlights();
  updateHud(chess);
});

// Puts the camera on Ivory's side (1) or Obsidian's side (-1), either
// swinging round smoothly or jumping straight there.
let viewSide = 1;
function setViewSide(side, animate = true) {
  viewSide = side;
  faceLabels(side); // board letters and numbers read the right way up from this side
  const startAngle = Math.atan2(camera.position.x, camera.position.z);
  const targetAngle = viewSide === 1 ? 0 : Math.PI;
  let delta = targetAngle - startAngle;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest way round
  const radius = Math.hypot(camera.position.x, camera.position.z);
  const y = camera.position.y;
  const placeAt = (a) => camera.position.set(Math.sin(a) * radius, y, Math.cos(a) * radius);
  if (!animate) return placeAt(targetAngle);
  tween(0.8, (t) => placeAt(startAngle + delta * easeInOut(t)));
}
document.getElementById('btn-flip').addEventListener('click', () => setViewSide(-viewSide));

// ---------------------------------------------------------------------------
// 8. Online play: the title screen, and reacting to what the server says
// ---------------------------------------------------------------------------
const SIDE_NAMES = { w: 'Ivory', b: 'Obsidian' };
const otherSide = (color) => (color === 'w' ? 'b' : 'w');

// Messages from the server are handled strictly one after another: if the
// opponent's move arrives while ours is still animating, it waits its turn.
let serverQueue = Promise.resolve();
const inOrder = (job) => (serverQueue = serverQueue.then(job).catch((err) => console.error(err)));

// Ask the server to play a move. The board doesn't change yet.
function requestMove(move) {
  net.waiting = true;
  selected = null;
  refreshHighlights();
  sendMove(move);
  renderOnline();
}

// Sets up the board from the server's list of moves (on join and reconnect).
function loadGame(moves) {
  chess.reset();
  for (const move of moves) chess.move(move);
  selected = null;
  rebuildPieces();
  refreshHighlights();
  updateHud(chess);
  renderOnline();
}

// Shows a short message in the online panel (for a few seconds, or until
// replaced if seconds is 0).
let noticeTimer = null;
function notify(text, seconds = 4) {
  net.notice = text;
  clearTimeout(noticeTimer);
  if (seconds) noticeTimer = setTimeout(() => notify('', 0), seconds * 1000);
  renderOnline();
}

// "0:42" from a number of milliseconds.
function mmss(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
// Time left on a player's chess clock right now (ms), counting down
// smoothly between the server's updates.
function clockLeft(color) {
  const c = net.clock;
  if (!c) return null;
  return Math.max(0, c[color] - (c.running === color ? Date.now() - c.at : 0));
}
const setClock = (clock) => (net.clock = clock ? { ...clock, at: Date.now() } : null);

const graceLeft = (color) => (net.graceDeadline[color] ? Math.max(0, net.graceDeadline[color] - Date.now()) : null);

// How the game ended, from this player's point of view: { title, text }.
function describeResult({ winner, reason, names }) {
  const me = net.color;
  const youWin = !!me && winner === me;
  const youLose = !!me && !!winner && winner !== me;
  const winnerName = names[winner] ?? SIDE_NAMES[winner];
  const loserName = winner ? (names[otherSide(winner)] ?? SIDE_NAMES[otherSide(winner)]) : null;
  const title = !winner ? 'Draw' : youWin ? 'Victory' : youLose ? 'Defeat' : `${winnerName} wins`;
  const text = {
    checkmate: youWin ? 'Checkmate. You win!' : `Checkmate. ${winnerName} wins.`,
    resigned: youWin
      ? `${loserName} resigned. You win!`
      : youLose
        ? 'You resigned.'
        : `${loserName} resigned. ${winnerName} wins.`,
    left: youWin
      ? `${loserName} left the game. You win!`
      : youLose
        ? 'You left the game.'
        : `${loserName} left the game. ${winnerName} wins.`,
    abandoned: youWin
      ? `${loserName} didn't come back in time. You win by abandonment.`
      : youLose
        ? "You didn't come back in time, so you lost by abandonment."
        : `${loserName} didn't come back in time. ${winnerName} wins by abandonment.`,
    agreed: 'Draw agreed.',
    stalemate: 'Stalemate. The game is a draw.',
    insufficient: 'Not enough pieces left to checkmate. The game is a draw.',
    threefold: 'The same position came up three times. The game is a draw.',
    'fifty-moves': 'Fifty moves without a capture or pawn move. The game is a draw.',
    timeout: youWin
      ? `${loserName} ran out of time. You win!`
      : youLose
        ? 'You ran out of time.'
        : `${loserName} ran out of time. ${winnerName} wins.`,
    'timeout-insufficient': `${names[net.result?.flagged] ?? 'A player'} ran out of time, but the other side has only a king left and can't checkmate. The game is a draw.`,
  }[reason];
  return { title, text };
}

function showResultPanel() {
  const { title, text } = describeResult(net.result);
  showGameOver(title, text, {
    menu: () => leaveRoom(''),
    newGame: () => leaveRoom('?new'), // straight to "Create game room"
    async rematch() {
      const reply = await ask('rematch');
      if (reply.error) updateRematch({ show: true, label: 'Rematch', disabled: true, note: reply.error });
    },
  });
  renderRematch();
}

// Keeps the Rematch button in step with who has asked.
function renderRematch() {
  if (!net.result) return;
  const me = net.color;
  if (!me) return updateRematch({ show: false, label: '', disabled: true, note: '' }); // spectators
  const them = net.presence?.[otherSide(me)];
  const name = them?.name ?? 'Your opponent';
  if (them?.state === 'exited') {
    return updateRematch({ show: true, label: 'Rematch', disabled: true, note: `${name} has left, so a rematch isn't possible.` });
  }
  if (net.rematch[me]) {
    return updateRematch({ show: true, label: 'Rematch asked', disabled: true, note: `Waiting for ${name} to accept the rematch...` });
  }
  if (net.rematch[otherSide(me)]) {
    return updateRematch({ show: true, label: 'Accept rematch', disabled: false, calling: true, note: `${name} wants a rematch! Colours will swap.` });
  }
  updateRematch({ show: true, label: 'Rematch', disabled: false, note: '' });
}

// The status line: whose turn it is, who's missing, or how the game ended.
function onlineStatus() {
  if (net.result) return describeResult(net.result).text;
  const p = net.presence;
  if (!p) return '';
  if (!net.color) return 'You are watching this game.';
  const opponent = p[otherSide(net.color)];
  if (opponent.state === 'empty') return 'Waiting for opponent... Send them the invite link.';
  if (opponent.state === 'offline') {
    const left = graceLeft(otherSide(net.color));
    return left === null
      ? 'Opponent disconnected. Waiting for them to come back...'
      : `${opponent.name} disconnected. They have ${mmss(left)} to come back, or you win.`;
  }
  if (net.waiting) return 'Sending move...';
  return chess.turn() === net.color ? 'Your turn.' : "Opponent's turn.";
}

function renderOnline() {
  if (isLocal) return;
  const p = net.presence;
  const players =
    net.joined && p
      ? ['w', 'b'].map((c) => ({
          color: c,
          name: p[c].name,
          you: c === net.color,
          state: p[c].state,
          countdown: p[c].state === 'offline' && graceLeft(c) !== null ? mmss(graceLeft(c)) : null,
          clock: net.clock ? mmss(clockLeft(c)) : null,
          clockState: !net.clock ? '' : clockLeft(c) < 30_000 ? 'low' : net.clock.running === c ? 'running' : '',
        }))
      : [];
  const status =
    {
      connecting: 'Connecting to the game server...',
      unreachable: "Can't reach the game server. Is it running? (npm run server)",
      lost: 'Connection lost. Reconnecting...',
    }[net.connection] ?? onlineStatus();
  showOnlinePanel({ players, status, notice: net.notice });
}

// Keep the "come back" countdowns and the running chess clock ticking on screen.
setInterval(() => {
  if (graceLeft('w') !== null || graceLeft('b') !== null || net.clock?.running) renderOnline();
}, 250);

// The server sends how many milliseconds each disconnected player has
// left; turn that into a deadline on this computer's clock.
function applyPresence(presence) {
  net.presence = presence;
  net.status = presence.status;
  for (const c of ['w', 'b']) {
    const left = presence[c].graceLeft;
    net.graceDeadline[c] = left === null ? null : Date.now() + left;
  }
}

// Stores what the server told us when we (re)joined, and redraws the board.
function applyJoin(reply) {
  net.joined = true;
  net.room = reply.room;
  net.color = reply.color;
  net.settings = reply.settings;
  net.result = reply.result;
  net.offer = reply.offer ?? null;
  net.rematch = reply.rematch ?? { w: false, b: false };
  setClock(reply.clock);
  applyPresence(reply.presence);
  if (!net.result) hideGameOver();
  hideOfferPrompt();
  if (net.offer && net.color && net.offer.from !== net.color) showOfferPrompt(net.offer);
  net.waiting = false;
  inOrder(() => {
    loadGame(reply.moves);
    if (net.result) showResultPanel();
  });
}

// After joining: wait in the lobby until there's an opponent, then play.
function enterRoom(reply) {
  applyJoin(reply);
  history.replaceState(null, '', `?room=${reply.room}`); // so refreshing keeps the room
  if (reply.status === 'waiting' && reply.color) {
    const time = reply.settings.time ? `${reply.settings.time} minutes each` : 'no clock';
    showIntro('lobby', {
      code: reply.room,
      link: inviteLink(reply.room),
      summary: `You play ${SIDE_NAMES[reply.color]} · ${time}`,
    });
  } else {
    startPlaying();
  }
}

// A join attempt came back: go in, or explain why not.
function handleJoinReply(reply) {
  if (reply.ended) {
    history.replaceState(null, '', location.pathname);
    return showIntro('ended');
  }
  if (reply.error) {
    if (introScreen() === 'connecting') showIntro('menu');
    setIntroBusy(false);
    return introError(reply.error);
  }
  enterRoom(reply);
}

// Hide the title screen and swing the camera to our own side of the table.
function startPlaying() {
  hideIntro();
  controls.autoRotate = false;
  setViewSide(net.color === 'b' ? -1 : 1, false);
  renderOnline();
}

// Leave the room for good (the server is told first), then go to the
// title screen. `then` is added to the address, e.g. '?new'.
async function leaveRoom(then = '') {
  await exitGame();
  location.href = location.pathname + then;
}

// "Exit game" in the game menu. In an active game this loses the game,
// so ask first.
async function onExitClicked() {
  closeGameMenu();
  if (net.color && net.status === 'active') {
    const sure = await askConfirm('Leave and lose this game?', 'Leave and lose', 'Stay');
    if (!sure) return;
  }
  leaveRoom('');
}

// ---- Offers (draw, takeback) ----
const OFFER_WORDS = {
  draw: { theyOffer: (n) => `${n} offers a draw.`, mine: 'draw offer', made: 'Draw offered.' },
  takeback: { theyOffer: (n) => `${n} asks to take back their last move.`, mine: 'takeback request', made: 'Takeback requested.' },
};
const offerPrompt = document.getElementById('offer-prompt');
const opponentName = () => net.presence?.[otherSide(net.color)]?.name ?? 'Your opponent';

function hideOfferPrompt() {
  offerPrompt.classList.add('hidden');
}

// The opponent made us an offer: show Accept / Decline.
function showOfferPrompt(offer) {
  offerPrompt.querySelector('.offer-text').textContent = OFFER_WORDS[offer.type].theyOffer(opponentName());
  offerPrompt.classList.remove('hidden');
  const answer = (accept) => async () => {
    hideOfferPrompt();
    const reply = await ask('answer-offer', { accept });
    if (reply.error) notify(reply.error);
  };
  offerPrompt.querySelector('.offer-yes').onclick = answer(true);
  offerPrompt.querySelector('.offer-no').onclick = answer(false);
}

// News about an offer from the server ('pending', 'accepted', 'declined', 'expired').
function onOfferNews({ type, from, status }) {
  const mine = from === net.color;
  const words = OFFER_WORDS[type];
  net.offer = status === 'pending' ? { type, from } : null;
  if (status === 'pending') {
    if (mine) notify(`${words.made} Waiting for ${opponentName()} to answer...`, 0);
    else if (net.color) showOfferPrompt({ type, from });
    else notify(`${SIDE_NAMES[from]} made a ${words.mine}.`);
    return;
  }
  hideOfferPrompt();
  if (!mine) return notify('');
  if (status === 'declined') notify(`${opponentName()} declined your ${words.mine}.`);
  if (status === 'expired') notify(`Your ${words.mine} lapsed because a move was played.`);
  if (status === 'accepted') notify(`${opponentName()} accepted your ${words.mine}.`);
}

async function makeOffer(type) {
  closeGameMenu();
  const reply = await ask('offer', { type });
  if (reply.error) notify(reply.error);
}

// "Resign": ask first, then ask the server. The result arrives as 'game-over'.
async function onResignClicked() {
  closeGameMenu();
  if (!(await askConfirm('Resign this game?', 'Resign', 'Keep playing'))) return;
  const reply = await ask('resign');
  if (reply.error) notify(reply.error);
}

const menuButton = document.getElementById('btn-menu');
const gameMenu = document.getElementById('game-menu');
function closeGameMenu() {
  gameMenu.classList.add('hidden');
  menuButton.setAttribute('aria-expanded', 'false');
}

// Show only the menu options that make sense right now. Buttons marked
// data-for="player-active" are for the two players during a live game.
// (The server checks everything again; this just keeps the menu tidy.)
function updateGameMenu() {
  const playing = !!net.color && net.status === 'active';
  for (const b of gameMenu.querySelectorAll('[data-for="player-active"]')) b.hidden = !playing;
  document.getElementById('btn-exit').textContent = net.color ? 'Exit game' : 'Stop watching';
}

async function startOnline() {
  // Online, "New game" and "Undo" don't exist: new games start from the
  // title screen or the game over panel, and leaving goes through the menu.
  document.getElementById('btn-new').classList.add('hidden');
  document.getElementById('btn-undo').classList.add('hidden');
  menuButton.classList.remove('hidden');
  menuButton.addEventListener('click', () => {
    updateGameMenu();
    const open = gameMenu.classList.toggle('hidden') === false;
    menuButton.setAttribute('aria-expanded', String(open));
  });
  document.getElementById('btn-exit').addEventListener('click', onExitClicked);
  document.getElementById('btn-resign').addEventListener('click', onResignClicked);
  document.getElementById('btn-draw').addEventListener('click', () => makeOffer('draw'));
  document.getElementById('btn-takeback').addEventListener('click', () => makeOffer('takeback'));
  document.getElementById('btn-invite').addEventListener('click', (e) => copyToClipboard(inviteLink(), e.currentTarget));

  // While the title screen is up, the board slowly turns behind it.
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  // What the title screen's buttons do. Every one of them is a request to
  // the server; the server decides the room code, the sides and the seats.
  initIntro({
    async create({ name, side, time }) {
      setIntroBusy(true);
      const room = await createRoom({ name, side, time });
      if (room.error) return joinFailed(room.error);
      handleJoinReply(await joinRoom(room.room, name));
    },
    async join({ name, code }) {
      setIntroBusy(true);
      handleJoinReply(await joinRoom(code, name));
    },
    async acceptInvite({ name }) {
      setIntroBusy(true);
      handleJoinReply(await joinRoom(roomFromUrl(), name));
    },
    cancel: () => leaveRoom(''), // closes the waiting room on the server
  });

  connectOnline({
    onStatus(status) {
      net.connection = status;
      if (status !== 'connected') net.waiting = false;
      if (introScreen()) introError(status === 'unreachable' ? "Can't reach the game server. Is it running? (npm run server)" : '');
      renderOnline();
    },

    // We rejoined after a dropped connection (or asked for the game again).
    onJoined(reply) {
      if (reply.error) {
        // The room is gone (e.g. the server restarted) or the game is over
        // for us: back to the title screen.
        forgetSession();
        history.replaceState(null, '', location.pathname);
        net.joined = false;
        controls.autoRotate = true;
        if (reply.ended) return showIntro('ended');
        showIntro('menu');
        introError(reply.error);
        return;
      }
      applyJoin(reply);
    },

    // A move the server accepted: now we animate it, with the usual tryMove().
    onMove(move) {
      inOrder(async () => {
        const ok = await tryMove(move);
        net.waiting = false;
        // Our copy should now match the server's exactly. If it somehow
        // doesn't, ask the server for the whole game again.
        if (!ok || chess.fen() !== move.fen) {
          console.warn('Board out of sync with the server; reloading the game.');
          resync();
        }
        renderOnline();
      });
    },

    onRejected({ reason }) {
      net.waiting = false;
      notify(reason);
    },

    onPresence(presence) {
      applyPresence(presence);
      renderRematch(); // e.g. the opponent just left: no rematch possible
      // Waiting in the lobby and the opponent just arrived? Let's play.
      if (introScreen() === 'lobby' && presence.status !== 'waiting') startPlaying();
      renderOnline();
    },

    // The server says the game is over. Show the panel after any move
    // that's still animating (so a checkmate is seen first).
    onOffer: onOfferNews,

    // The server's clock times: always trust these over our own countdown.
    onClock(clock) {
      setClock(clock);
      renderOnline();
    },

    onRematch(asked) {
      net.rematch = asked;
      renderRematch();
    },

    // Both said yes: a fresh game in the same room, colours swapped. Join
    // again to get our new colour and the empty board.
    async onRematchStarted() {
      const before = net.color;
      net.result = null;
      hideGameOver();
      await resync();
      if (net.color && net.color !== before) {
        setViewSide(net.color === 'b' ? -1 : 1);
        notify(`Rematch! Colours swapped: you are ${SIDE_NAMES[net.color]} now.`);
      }
    },

    // A takeback was accepted: redraw the board from the server's move list
    // (after any move that's still animating).
    onTakeback({ moves }) {
      net.waiting = false;
      inOrder(() => loadGame(moves));
    },

    onGameOver(result) {
      net.result = result;
      net.status = 'over';
      net.offer = null;
      hideOfferPrompt();
      selected = null;
      refreshHighlights();
      inOrder(() => {
        showResultPanel();
        renderOnline();
      });
    },

    onReplaced() {
      net.color = null;
      notify('This game was opened in another tab, so this tab is now only watching.', 0);
    },
  });

  // Which screen to start on:
  //  - this tab is in a game (e.g. after a refresh, or going back to the
  //    main page mid-game): go straight back into that game. You can't
  //    start another one until it's finished or you've used Exit game.
  //  - opened an invite link: ask for a name, then join
  //  - came from "New game" on the game over panel: "Create game room"
  //  - otherwise: the main menu
  const urlRoom = roomFromUrl();
  const saved = savedSession();
  if (saved && (!urlRoom || urlRoom === saved.room)) {
    showIntro('connecting');
    const reply = await joinRoom(saved.room, saved.name);
    if (reply.error && !reply.ended) forgetSession();
    handleJoinReply(reply);
  } else if (urlRoom) {
    showIntro('invite', { code: urlRoom });
  } else if (new URLSearchParams(location.search).has('new')) {
    history.replaceState(null, '', location.pathname);
    showIntro(document.getElementById('intro-name').value ? 'create' : 'menu');
  } else {
    showIntro('menu');
  }
}

// ---------------------------------------------------------------------------
// 9. Main loop
// ---------------------------------------------------------------------------
let shake = 0; // camera shake strength, set when something smashes
const shakeOffset = new THREE.Vector3();
const timer = new THREE.Timer();

function frame(timestamp) {
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.05); // avoid huge jumps after tab switch
  const time = timer.getElapsed();

  // Undo last frame's shake before the controls update the camera.
  camera.position.sub(shakeOffset);

  updateTweens(dt);
  smash.update(dt);
  controls.update();

  // Torches flicker, sparks drift.
  torches.forEach((light, i) => {
    light.intensity = 40 + Math.sin(time * 9 + i * 2) * 4 + Math.sin(time * 23 + i) * 3;
  });
  motes.rotation.y = time * 0.02;

  // Apply camera shake that fades quickly.
  shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  camera.position.add(shakeOffset);
  shake *= 0.88;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // If the window got too narrow for the board, back the camera off.
  const offset = camera.position.clone().sub(controls.target);
  const needed = distanceToFitBoard();
  if (offset.length() < needed) camera.position.copy(controls.target).add(offset.setLength(needed));
});

rebuildPieces();
refreshHighlights();
updateHud(chess);
initMusic([...document.querySelectorAll('.music-toggle')]);
if (!isLocal) startOnline();
frame();

// Handy for testing in the browser console during development:
//   enchanted.tryMove({ from: 'e2', to: 'e4' })
//   enchanted.requestMove({ from: 'e2', to: 'e4' })   (online: ask the server)
if (import.meta.env.DEV) window.enchanted = { chess, tryMove, requestMove, net, camera, isBusy: () => busy };
