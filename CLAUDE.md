# Enchanted Chess

Top-down 3D wizard-style chess for two friends playing online. Stone pieces
smash each other on capture. Project memory (stack, decisions, roadmap,
progress) lives in memory.md:

@memory.md

## Rules for working on this project
- I'm a beginner building this as a personal project: explain what each change does in plain language.
- Use the stack in memory.md (Vite + Three.js + chess.js, Node.js + Socket.IO for multiplayer). Explain before swapping any library.
- Never write chess rules by hand. Use chess.js, and validate every move on the server.
- Build in small steps: finish and test one milestone before starting the next.
- Keep all art, names, sounds and music original. No film names, characters or assets.
- When I report a bug, ask for the error message or console output, then explain the cause and the fix.
- At the end of each session, update the "Progress log" in memory.md.

## Commands
- `npm install` installs dependencies
- `npm run dev` starts the game at http://localhost:5173
- `npm run build` checks that the project builds
