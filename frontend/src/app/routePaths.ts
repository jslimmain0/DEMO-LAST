import { matchPath } from 'react-router-dom'

export const routePaths = {
  workspaces: '/workspaces', resources: '/resources',
  dashboard: '/flows', flow: '/flows/:id', executions: '/executions',
  mocks: '/mocks', mock: '/mocks/:id', protocols: '/protocols', protocol: '/protocols/:id',
  plugins: '/plugins', plugin: '/plugins/:id', admin: '/admin',
} as const

/** 첫 진입과 공간 쿼리 보충이 같은 경로로 이동하도록 정규화한다. */
export function workspaceLocation(pathname: string, search: string, hash = '') {
  return { pathname: Object.values(routePaths).some(path => matchPath(path, pathname)) ? pathname : routePaths.dashboard, search, hash }
}
