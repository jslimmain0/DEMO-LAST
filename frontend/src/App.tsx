import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { applyTheme, getTheme } from './design/theme'
import { Dashboard } from './routes/Dashboard'
import { Editor } from './routes/Editor'
import { Executions } from './routes/Executions'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

export default function App() {
  useEffect(() => {
    applyTheme(getTheme())
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/flows" replace />} />
          <Route path="/flows" element={<Dashboard />} />
          <Route path="/flows/:id" element={<Editor />} />
          <Route path="/executions" element={<Executions />} />
          <Route path="*" element={<Navigate to="/flows" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
