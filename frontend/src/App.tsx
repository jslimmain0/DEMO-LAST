import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthCallback } from './auth/AuthCallback'
import { AuthProvider } from './auth/AuthContext'
import { Toasts, toast } from './components/toast'
import { applyTheme, getTheme } from './design/theme'
import { Dashboard } from './routes/Dashboard'
import { Editor } from './routes/Editor'
import { Executions } from './routes/Executions'
import { MockServers } from './routes/MockServers'
import { MockServerEditor } from './routes/MockServerEditor'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

export default function App() {
  useEffect(() => {
    applyTheme(getTheme())
    // AI OAuth 연결 콜백 복귀(?ai=connected|error) — 토스트 + URL 정리
    const p = new URLSearchParams(window.location.search)
    const ai = p.get('ai')
    if (ai === 'connected') toast('AI 를 연결했습니다.', 'ok')
    else if (ai === 'error') toast('AI 연결에 실패했습니다. 설정을 확인하세요.', 'error')
    if (ai) {
      p.delete('ai')
      const qs = p.toString()
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/flows" replace />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/flows" element={<Dashboard />} />
            <Route path="/flows/:id" element={<Editor />} />
            <Route path="/executions" element={<Executions />} />
            <Route path="/mocks" element={<MockServers />} />
            <Route path="/mocks/:id" element={<MockServerEditor />} />
            <Route path="*" element={<Navigate to="/flows" replace />} />
          </Routes>
        </BrowserRouter>
        <Toasts />
      </AuthProvider>
    </QueryClientProvider>
  )
}
