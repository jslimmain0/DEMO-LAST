import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 개발 서버 5173, /api 는 백엔드(18080)로 프록시 — 동일 오리진처럼 동작(CORS 회피)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:18080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:18080', ws: true },
      // wait 콜백 수신(테스트 콜백 버튼)·내장 Mock 서빙도 백엔드로 — 동일 오리진처럼 동작.
      // 트레일링 슬래시: 프론트 SPA 라우트 '/mocks'(startsWith 매칭)를 삼키지 않게 '/mock/'·'/relay/' 만 프록시.
      '/relay/': { target: 'http://localhost:18080', changeOrigin: true },
      '/mock/': { target: 'http://localhost:18080', changeOrigin: true },
    },
  },
})
