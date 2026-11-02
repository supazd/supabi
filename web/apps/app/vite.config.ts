import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In development the Go server runs separately; see the README.
    // The Host header is kept as the browser sent it: the server refuses writes
    // whose Origin is another host.
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: {
    // The Go binary embeds this directory when built with -tags embedweb.
    outDir: fileURLToPath(new URL('../../../internal/webui/dist', import.meta.url)),
    emptyOutDir: true,
  },
})
