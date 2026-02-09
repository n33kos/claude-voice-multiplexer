import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const relayPort = process.env.RELAY_PORT || '3100'
const relayTarget = `http://localhost:${relayPort}`

export default defineConfig({
  plugins: [react()],
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
