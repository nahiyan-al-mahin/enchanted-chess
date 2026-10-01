# Enchanted Chess: project memory

## Goal
Top-down 3D, wizard-style multiplayer chess web game for two friends playing
online. Carved stone pieces smash each other on capture. All art, names,
sounds and music are original (no film names, characters or assets).

## Stack (decided 2026-10-01)
- Client: Vite 8 + Three.js 0.186 (plain JavaScript, ES modules, no framework)
- Rules: chess.js 1.4. Never hand-write chess rules.
- Multiplayer (milestone 2): Node.js + Express 5 + Socket.IO 4.8. Server
  keeps its own chess.js game per room and validates every move.
- Art: pieces built procedurally from Three.js shapes; stone textures painted
  on a canvas; sounds generated with Web Audio. No external asset files.

## Naming
- Sides: Ivory (white) and Obsidian (black). Blue rune rings for Ivory,
  violet for Obsidian.

## Code
- Source: /mnt/project-files/enchanted-chess (zip: enchanted-chess-milestone1.zip)
- Run: `npm install`; terminal 1 `npm run server` (port 3050, PORT env
  overrides); terminal 2 `npm run dev`; open http://localhost:5173
  (creates a room). `?local` = offline hot-seat mode with Undo.
- main.js keeps a `pieceAt` Map (square -> 3D piece) in sync with chess.js;
  every move goes through `tryMove()`, which asks chess.js first, then animates.
  Online, clicks call `requestMove()` (asks server); `tryMove()` runs only
  when the server broadcasts 'move'. Server messages run one at a time
  through the `inOrder` queue. If the local FEN differs from the server's
  after a move, the client re-joins to resync.
- src/online.js is the only file using Socket.IO on the client. Player
  identity = random id in sessionStorage (per tab, survives refresh).
- server/index.js: rooms Map -> { chess, seats {w,b: {playerId, socketId}} }.
  Seats stay reserved while disconnected (reconnect). Events: create-room
  (ack), join (ack: color, moves), move / move-rejected, presence, replaced.
  Moves are refused unless it's your turn and the opponent is online.
  Rooms live in memory only: restarting the server ends all games.
- Tests: `npm run test:server` (server/test-online.js, needs server + dev).
- Dev helpers in the browser console: `enchanted.tryMove(...)` (local only),
  `enchanted.requestMove({from:'e2',to:'e4'})`, `enchanted.net`.
- Headless-Chrome testing gotcha: only the newest window is "visible"; others
  get 0 animation frames, so give each test player its own Chrome process.

## Roadmap
1. Local 3D board with full rules + smash effect (DONE 2026-10-01)
2. Online play: Socket.IO server, rooms via share link, server-side validation (DONE 2026-10-02)
3. Duel polish: clocks, resign/draw, rematch, reconnect, per-player orientation
4. More magic: better sculpts, idle/attack animations, original music, settings
5. Deploy server + client

## Progress log
- 2026-10-01: Milestone 1 done. Tested in headless Chromium: click-to-move,
  capture smash, en passant, castling, promotion picker, Fool's mate
  checkmate detection, no console errors.
- 2026-10-01: Redesigned pieces as tall carved statues (~2x height): spear
  soldier pawn, fortress rook, armoured horse knight, hooded bishop with
  staff, crowned queen with sceptre, armoured king with planted sword.
  Ivory = marble texture, Obsidian = granite texture (painted on canvas).
  Each piece type is welded into one geometry (BufferGeometryUtils) for speed.
  Camera raised/steeper, capture leap scales with victim height, smash makes
  more chunks for taller pieces, clicks on a blocking enemy statue fall
  through to a legal square behind it. Checked with headless Chrome
  screenshots (no console errors, capture smash works).
- 2026-10-01: "At the table" camera: 45 degrees down (OrbitControls polar
  limits 40-50 deg), distance 13.5 (zoom 10-30), backs off automatically on
  narrow screens so the board stays in view. Flip view unchanged and works.
  Added src/music.js: original A-minor waltz (music-box bell melody with
  random variations each loop, oom-pah-pah accompaniment, string pad, echo),
  generated with Web Audio and sharing sound.js's AudioContext. Starts on
  first click; HUD "Music: on/off" button saved in localStorage
  ("enchanted-chess-music"). Verified in headless Chrome: no errors,
  toggle and saved choice work.
- 2026-10-01: Milestone 2, step 1 of 4 done (server). Added Express 5 +
  Socket.IO 4.8 (+ socket.io-client). server/index.js on port 3050 (PORT env overrides) keeps
  one chess.js game per room; events: join -> state, move -> move (to
  room) or move-rejected (sender only). vite.config.js proxies /socket.io
  to :3050 (Vite must be restarted after creating the config). Scripts:
  `npm run server`, `npm run test:server`.
- 2026-10-02: Milestone 2 done (steps 2-4: rooms + invite link, client
  wired to server, reconnect). server/test-online.js: 19/19 pass. Multi-
  browser headless e2e (2 players, spectator, capture, refresh, Fool's
  mate result, ?local): 26/26 pass, no console errors. Known for milestone
  3: board labels read upside-down from Obsidian's side; no rematch yet
  (New game online = new room); games lost if the server restarts.
  Committed on branch milestone-2-online (1fe7f75), not yet merged to main.
