import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: 'clients/web',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:' + (process.env.PORT || '3001') },
    fs: {
      strict: true,
      allow: [resolve('clients/web'), resolve('src/contracts'), resolve('node_modules')],
    },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
})
