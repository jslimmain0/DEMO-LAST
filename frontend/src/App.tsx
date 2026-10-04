import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router-dom'
import { appBase } from './lib/appBase'
import { AuthProvider } from './auth/AuthContext'
import { WorkspaceProvider } from './app/WorkspaceContext'
import { routePaths, workspaceLocation } from './app/routePaths'
import { Toasts } from './components/toast'
import { applyTheme, getTheme } from './design/theme'
import { Admin } from './routes/Admin'
import { Dashboard } from './routes/Dashboard'
import { Editor } from './routes/Editor'
import { Executions } from './routes/Executions'
import { MockServers } from './routes/MockServers'
import { MockServerEditor } from './routes/MockServerEditor'
import { Protocols } from './routes/Protocols'
import { Plugins } from './routes/Plugins'
import { Workspaces } from './routes/Workspaces'
import { Resources } from './routes/Resources'
import { UnsavedNavigationProvider } from './components/UnsavedNavigation'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

function WorkspaceRedirect() {
  const location = useLocation()
  return <Navigate to={workspaceLocation(location.pathname, location.search, location.hash)} replace />
}

function WorkspaceLayout() {
  return <UnsavedNavigationProvider><WorkspaceProvider><Outlet /></WorkspaceProvider></UnsavedNavigationProvider>
}
const router = createBrowserRouter([{ element: <WorkspaceLayout />, children: [
  { path: '/', element: <WorkspaceRedirect /> },
  { path: routePaths.workspaces, element: <Workspaces /> },
  { path: routePaths.resources, element: <Resources /> },
  { path: routePaths.dashboard, element: <Dashboard /> },
  { path: routePaths.flow, element: <Editor /> },
  { path: routePaths.executions, element: <Executions /> },
  { path: routePaths.mocks, element: <MockServers /> },
  { path: routePaths.mock, element: <MockServerEditor /> },
  { path: routePaths.protocols, element: <Protocols /> },
  { path: routePaths.protocol, element: <Protocols /> },
  { path: routePaths.plugins, element: <Plugins /> },
  { path: routePaths.plugin, element: <Plugins /> },
  { path: routePaths.admin, element: <Admin /> },
  { path: '*', element: <WorkspaceRedirect /> },
] }], { basename: appBase() || undefined })

export default function App() {
  useEffect(() => {
    applyTheme(getTheme())
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toasts />
      </AuthProvider>
    </QueryClientProvider>
  )
}
