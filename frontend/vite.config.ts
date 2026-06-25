import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 개발 서버 5173, /api 는 백엔드(18080)로 프록시 — 동일 오리진처럼 동작(CORS 회피)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:18080', changeOrigin: true },
    },
  },
})
