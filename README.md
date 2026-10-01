# Enchanted Chess

A top-down 3D, wizard-style chess game. Carved stone pieces leap across a
moonlit board and smash each other to rubble on capture. Built with
Three.js (3D), chess.js (rules) and Vite (dev server). Online play with
Node.js + Socket.IO comes in milestone 2.

## Run it

You need Node.js 18 or newer.

```bash
npm install     # downloads three, chess.js and vite
npm run dev     # starts the game at http://localhost:5173
```

Controls: click one of your pieces, then click a glowing marker to move.
Drag to rotate the view, scroll to zoom. "Flip view" swings the camera to
the other side.

## How the code is organised

| File | What it does |
| --- | --- |
| `index.html` | The page: the canvas plus the HUD panel and promotion picker |
| `src/main.js` | Scene, lights, camera, clicks, moves, main loop |
| `src/board.js` | The stone board and the square <-> 3D position helpers |
| `src/pieces.js` | Builds each piece from simple shapes (no model files) |
| `src/materials.js` | Paints the stone texture on a canvas |
| `src/smash.js` | Capture effect: flying stone chunks and dust |
| `src/sound.js` | Move and smash sounds generated with Web Audio |
| `src/tween.js` | Tiny animation helper |
| `src/ui.js` | HUD text, move list, promotion picker |
| `src/style.css` | Styling for the page and HUD |

## Roadmap

1. **Local 3D board (done).** Full rules via chess.js, legal-move markers,
   castling, en passant, promotion, check/checkmate/draw, smash effect.
2. **Online play.** Node.js + Socket.IO server with rooms ("share this link
   with a friend"). The server owns its own chess.js game and validates
   every move; clients only send move requests and draw what the server
   confirms.
3. **Polish the duel.** Clocks, resign/draw offers, rematch, reconnect after
   a dropped connection, board orientation per player.
4. **More magic.** Better piece sculpts, idle animations, piece-specific
   attack moves, ambient music made from scratch, settings menu.
5. **Ship it.** Deploy the server and client (e.g. Render or Fly.io) so
   friends can play from anywhere.
