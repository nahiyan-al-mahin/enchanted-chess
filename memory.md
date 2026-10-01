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
  (title screen). `?local` = offline hot-seat mode with Undo, no intro.
- main.js keeps a `pieceAt` Map (square -> 3D piece) in sync with chess.js;
  every move goes through `tryMove()`, which asks chess.js first, then animates.
  Online, clicks call `requestMove()` (asks server); `tryMove()` runs only
  when the server broadcasts 'move'. Server messages run one at a time
  through the `inOrder` queue. If the local FEN differs from the server's
  after a move, the client re-joins to resync.
- src/online.js is the only file using Socket.IO on the client. Player
  identity = random id in sessionStorage (per tab, survives refresh).
  sessionStorage 'enchanted-chess-session' = {room, name} lets a refresh
  skip the name prompt and rejoin. Player name remembered in localStorage.
- src/intro.js: title screen overlay (screens: connecting, menu, create,
  join, invite, lobby). Only handles DOM; calls actions from main.js.
  Board auto-rotates (OrbitControls.autoRotate) while the intro is open.
- board.js `faceLabels(side)` turns the a-h/1-8 labels; called by
  setViewSide(), so labels follow the camera side (incl. Flip view).
- server/index.js: rooms Map (key = 4-char code like K7QX, no O/0/I/1) ->
  { chess, seats {w,b: {playerId, name, socketId}}, settings {time} }.
  Rooms are created ONLY by create-room {playerId,name,side,time}; the
  server resolves side 'random' and reserves the creator's seat. join
  {room,playerId,name} errors for unknown codes (codes case-insensitive).
  presence = { w: {state,name}, b: {state,name}, spectators }.
  Seats stay reserved while disconnected (reconnect). Events: create-room
  (ack), join (ack: color, moves, settings, status, result, presence, or
  {error, ended}), exit-game {} (ack), move / move-rejected, presence
  {status,w,b,spectators}, game-over {winner,reason,names}, replaced.
- Room status (server-enforced): 'waiting' -> 'active' (both seats taken)
  -> 'over'. Rules: moves only while active. `activeGames` Map (playerId
  -> room) blocks create-room/join elsewhere while a game is active.
  exit-game: waiting = room deleted; active = leaver loses ('left'),
  seat.exited so they can never rejoin; over = just leave. Disconnect in
  an active game = grace timer (GRACE_SECONDS env, default 60) -> opponent
  wins ('abandoned'). Grace also starts at game start for an absent
  creator. Finished rooms: only non-exited seat holders may rejoin to view;
  everyone else gets {ended:true} -> intro 'ended' screen.
- In-game requests (all ack { ok } | { error }, all checked by the server):
  resign {}; offer {type:'draw'|'takeback'}; answer-offer {accept};
  rematch {}. One open offer at a time (room.offer); room.offerPly limits
  each player to one offer of each kind per ply; a move lets an offer
  expire. Takeback undoes the asker's last move (2 plies if the opponent
  already replied) and broadcasts 'takeback' {moves, fen}. Rematch: both
  must ask after 'over'; seats swap, fresh chess + clocks, 'rematch-started'
  -> clients resync() and turn the camera. Not possible once a player exited.
- Clocks: room.clock {w,b,running,since,alarm}; server-only timekeeping;
  run only while active AND both players connected (paused during the
  disconnect grace); 'clock' {w,b,running} broadcast on every change;
  flag() = 'timeout' loss, or 'timeout-insufficient' draw if the winner
  has a bare king. MINUTE_MS env shortens clock minutes for tests.
- Game over reasons: checkmate, stalemate, insufficient, threefold,
  fifty-moves, left, abandoned, resigned, agreed, timeout,
  timeout-insufficient (result.flagged = who ran out).
- Client: online HUD hides New game/Undo, shows "Game menu" (Exit game /
  Stop watching). Styled askConfirm() + game over panel (View board / Main
  menu / New game -> /?new opens Create screen) in ui.js. A tab with a
  saved session is always sent back into its game, even from the main page.
  Moves are refused unless it's your turn and the opponent is online.
  Rooms live in memory only: restarting the server ends all games.
- Production: `npm run build` then `npm start` (= node server/index.js).
  Express serves dist/ (index.html no-cache; fingerprinted assets cached
  1 year) + Socket.IO + /health on process.env.PORT (default 3050). If
  dist/ is missing, '/' explains to run the build. Client connects with
  io() (same origin, nothing hard-coded). package.json engines node >=20.
  Render settings: Build `npm install --include=dev && npm run build`
  (vite is a devDependency), Start `npm start`. Free tier sleeps when
  idle and games live in memory, so a spin-down ends games in progress.
- Tests: `npm run test:server` (server/test-online.js, needs server + dev).
  It waits out the real grace period once and a 5-"minute" clock, so run
  the server with GRACE_SECONDS=4 MINUTE_MS=1000 for a fast run (~20 s).
- Dev helpers in the browser console: `enchanted.tryMove(...)` (local only),
  `enchanted.requestMove({from:'e2',to:'e4'})`, `enchanted.net`.
- Headless-Chrome testing gotcha: only the newest window is "visible"; others
  get 0 animation frames, so give each test player its own Chrome process.

## Roadmap
1. Local 3D board with full rules + smash effect (DONE 2026-10-01)
2. Online play: Socket.IO server, rooms via share link, server-side validation (DONE 2026-10-02)
3. Duel polish: intro page, draw/resign/leave/takeback menu, game over +
   rematch, clocks, labels facing each player (DONE 2026-10-02, pending the
   user's own testing)
4. More magic: better sculpts, idle/attack animations, original music, settings
5. Deploy server + client (PREPARED 2026-10-02 for Render free web
   service; not yet deployed)

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
- 2026-10-02: Milestone 3, step 1 of 4 done (intro page): title screen
  with name, Create game room (side Ivory/Obsidian/Random + time None/5/
  10/15, stored for step 4), 4-char room codes, lobby with copy code/link
  and "Waiting for opponent...", Join with code, invite link -> name
  prompt, names in HUD, refresh rejoins without prompt. Board labels now
  face the player's side. test-online.js 27/27. Next: step 2 (in-game
  menu: draw offer, resign, leave, takeback), step 3 (game over panel +
  rematch with colours swapped), step 4 (server-tracked clocks).
- 2026-10-02: Committed step 1 (66a8afe, branch milestone-3). Added the
  "no abandoning a started game" rules (see Code notes): Exit game with
  confirm, opponent sees "<name> left the game. You win!" + basic game over
  panel, leaver can't rejoin (old link -> "This game has ended"), 60 s
  reconnect countdown visible to the opponent, abandonment win. Game over
  panel already covers step 3 except Rematch. test-online.js 41/41 (run
  test servers with GRACE_SECONDS small; test waits for the real grace).
- 2026-10-02: Milestone 3 complete. Audit found resign, draw offer,
  takeback, rematch and clocks missing; built them one at a time, server
  test after each (47 -> 58 -> 65 -> 75 -> 85 checks, all pass). Bug caught
  by the tests: clock resume wasn't broadcast after a reconnect (fixed).
  Server code changed: the user must restart `npm run server`.
- 2026-10-02: Milestone 3 committed (c3a6dde). Prepared Render deployment
  (see Code notes). Verified like production on PORT=3070 (the user's dev
  servers held 3050): headers, socket handshake, no localhost in the
  bundle, and two headless tabs playing Fool's mate by clicking the 3D
  board (camera projection maths; dev shortcuts are absent in production).
