// vite.config.js
// During development the game page comes from Vite (port 5173) and the
// game server runs separately (port 3050). The proxy forwards anything
// under /socket.io from Vite to the server, so the browser only ever talks
// to one address and doesn't need to know where the server lives.
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3050', // must match the port in server/index.js
        ws: true, // also forward the live WebSocket connection
      },
    },
  },
});
