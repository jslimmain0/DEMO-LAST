import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css' // 먼저 로드 → 아래 index.css 의 컨트롤/핸들 테마 오버라이드가 캐스케이드에서 이긴다
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
