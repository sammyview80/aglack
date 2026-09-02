/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  server: {
    // Pinned, not left to Vite's default "walk to the next free port"
    // behavior. rust_gateway's CORS allow-list (FRONTEND_ORIGIN, see
    // rust_gateway/.env.example) is a single exact-string origin — if
    // Vite silently lands on 5174/5175/5176 because 5173 was already
    // taken by a stale process, every browser request gets a CORS error
    // that looks like a gateway bug but is actually just a port mismatch
    // (see docs/troubleshooting.md's "Cross-origin mismatch" entry — this
    // exact failure has recurred multiple times). strictPort makes that
    // failure loud and immediate (Vite refuses to start) instead of
    // silent and one port number away from working.
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
