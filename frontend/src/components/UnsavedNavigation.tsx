import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useBlocker, useNavigate, type NavigateOptions } from 'react-router-dom'
import { Modal } from './Modal'
import { ActionButton } from './ActionButton'

interface Draft { dirty: boolean; saving?: boolean; label?: string; blockedReason?: string }
interface Guard {
  register: (key: symbol, draft: Draft | null) => void
  navigateSaved: (to: string, options?: NavigateOptions) => void
}
const Context = createContext<Guard | null>(null)

/** One router blocker owns all active editors; cancelling never changes their data. */
export function UnsavedNavigationProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<symbol, Draft>())
  const permitted = useRef<string | null>(null)
  const [, setRevision] = useState(0)
  const navigate = useNavigate()
  const register = useCallback((key: symbol, draft: Draft | null) => {
    if (draft) drafts.current.set(key, draft)
    else drafts.current.delete(key)
    setRevision(value => value + 1)
  }, [])
  const active = () => [...drafts.current.values()].filter(draft => draft.dirty || draft.saving || draft.blockedReason)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const target = nextLocation.pathname + nextLocation.search + nextLocation.hash
    if (permitted.current === target) { permitted.current = null; return false }
    if (currentLocation.pathname + currentLocation.search + currentLocation.hash === target) return false
    return active().length > 0
  })
  const navigateSaved = useCallback((to: string, options?: NavigateOptions) => {
    permitted.current = to
    navigate(to, options)
    permitted.current = null
  }, [navigate])
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!active().length) return
      event.preventDefault(); event.returnValue = ''
    }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [])
  const saving = active().some(draft => draft.saving)
  const blockedReason = active().find(draft => draft.blockedReason)?.blockedReason
  return <Context.Provider value={{ register, navigateSaved }}>{children}
    {blocker.state === 'blocked' && <Modal ariaLabel="편집 중 변경" onClose={() => blocker.reset()} width={480} card={{ padding: 24, overflowY: 'auto' }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>{blockedReason ? '이동하기 전에 확인하세요' : saving ? '저장 중입니다' : '저장하지 않은 변경이 있습니다'}</h2>
      <p style={{ fontSize: 13, lineHeight: 1.7 }}>{blockedReason || (saving ? '저장이 끝난 뒤 다시 이동하세요. 현재 편집은 유지됩니다.' : `${active().map(draft => draft.label || '현재 편집').join(' · ')}의 미저장 변경을 버리고 이동할까요?`)}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' }}><ActionButton variant="primary" onClick={() => blocker.reset()}>계속 편집</ActionButton>{!saving && !blockedReason && <ActionButton variant="danger" onClick={() => blocker.proceed()}>변경 버리고 이동</ActionButton>}</div>
    </Modal>}
  </Context.Provider>
}

export function useUnsavedNavigation({ dirty, saving = false, label = '현재 편집', blockedReason }: Draft) {
  const guard = useContext(Context)
  if (!guard) throw new Error('편집 이동 보호가 라우터에 연결되지 않았습니다.')
  const key = useRef(Symbol('editor-draft'))
  const register = guard.register
  useEffect(() => {
    const editorKey = key.current
    register(editorKey, { dirty, saving, label, blockedReason })
    return () => register(editorKey, null)
  }, [register, dirty, saving, label, blockedReason])
  return { navigateSaved: guard.navigateSaved }
}
