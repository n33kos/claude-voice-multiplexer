import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const relayPort = process.env.RELAY_PORT || '3100'
const relayTarget = `http://localhost:${relayPort}`

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The client SDK lives in web/sdk so the web build stays self-contained
    // (the daemon's auto-update builds web/ on its own).
    alias: {
      '@vmux/client': fileURLToPath(new URL('./sdk/src/index.ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': relayTarget,
      '/ws': {
        target: `ws://localhost:${relayPort}`,
        ws: true,
      },
    },
  },
})
