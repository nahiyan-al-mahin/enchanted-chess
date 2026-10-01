# Enchanted Chess: project memory

## Goal
Top-down 3D, wizard-style multiplayer chess web game for two friends playing
online. Carved stone pieces smash each other on capture. All art, names,
sounds and music are original (no film names, characters or assets).

## Stack (decided 2026-10-01)
- Client: Vite 8 + Three.js 0.186 (plain JavaScript, ES modules, no framework)
- Rules: chess.js 1.4. Never hand-write chess rules.
- Multiplayer (milestone 2): Node.js + Socket.IO. Server keeps its own
  chess.js game per room and validates every move.
- Art: pieces built procedurally from Three.js shapes; stone textures painted
  on a canvas; sounds generated with Web Audio. No external asset files.

## Naming
- Sides: Ivory (white) and Obsidian (black). Blue rune rings for Ivory,
  violet for Obsidian.

## Code
- Source: /mnt/project-files/enchanted-chess (zip: enchanted-chess-milestone1.zip)
- Run: `npm install` then `npm run dev`, open http://localhost:5173
- main.js keeps a `pieceAt` Map (square -> 3D piece) in sync with chess.js;
  every move goes through `tryMove()`, which asks chess.js first, then animates.
- Dev helper in the browser console: `enchanted.tryMove({from:'e2',to:'e4'})`

## Roadmap
1. Local 3D board with full rules + smash effect (DONE 2026-10-01)
2. Online play: Socket.IO server, rooms via share link, server-side validation
3. Duel polish: clocks, resign/draw, rematch, reconnect, per-player orientation
4. More magic: better sculpts, idle/attack animations, original music, settings
5. Deploy server + client

## Progress log
- 2026-10-01: Milestone 1 done. Tested in headless Chromium: click-to-move,
  capture smash, en passant, castling, promotion picker, Fool's mate
  checkmate detection, no console errors.
