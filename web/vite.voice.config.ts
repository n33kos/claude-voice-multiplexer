import { defineConfig } from 'vite'

// The LiveKit voice entry (mic in) as its own classic script, served at
// /sdk/vmux-voice.js beside vmux-client.js, with livekit-client bundled in:
//   <script src="http://localhost:3100/sdk/vmux-client.js"></script>
//   <script src="http://localhost:3100/sdk/vmux-voice.js"></script>
//   const { VoiceClient } = window.VmuxVoice
// Separate so pages that only listen don't download LiveKit.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/sdk',
    emptyOutDir: false,
    lib: {
      entry: 'sdk/src/voice/index.ts',
      name: 'VmuxVoice',
      formats: ['iife'],
      fileName: () => 'vmux-voice.js',
    },
  },
})
