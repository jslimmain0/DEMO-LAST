import base from './vite.config.ts'
import { mockApiPlugin } from './dev/mock-api.mjs'

// 별도 포트로 실제 개발 환경의 localStorage와 mock 화면 설정을 분리한다.
export default {
  ...base,
  plugins: [...base.plugins, mockApiPlugin()],
  define: { 'import.meta.env.VITE_FRONTEND_MOCK': JSON.stringify('true') },
  server: { port: 5174, strictPort: true, host: '127.0.0.1', open: '/flows?space=local:local' },
}
