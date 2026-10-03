import { defineConfig } from 'vite'

// The client SDK as one classic script, served by the relay at
// /sdk/vmux-client.js so any page can load it without a bundler:
//   <script src="http://localhost:3100/sdk/vmux-client.js"></script>
//   const { RelayClient, SpeechPlayer } = window.VmuxClient
// (Classic, not a module, so cross-origin pages need no CORS.)  The LiveKit
// voice entry isn't included; bundle @vmux/client/voice yourself if needed.
export default defineConfig({
  publicDir: false, // the app's public/ is already in dist/
  build: {
    outDir: 'dist/sdk',
    emptyOutDir: false,
    lib: {
      entry: 'sdk/src/index.ts',
      name: 'VmuxClient',
      formats: ['iife'],
      fileName: () => 'vmux-client.js',
    },
  },
})
