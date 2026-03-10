import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4200',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:4200',
        ws: true,
      },
    },
  },
})
