import { useEffect, useRef, useState } from 'react'
import { AppIcon } from './AppIcon'
import { Link } from 'react-router-dom'
import { useWorkspace } from '../app/WorkspaceContext'
import { readWorkspaceNavigation, visitWorkspace, workspaceIdentity, workspaceStorageKey } from '../lib/workspaceNavigation'

export function WorkspaceSwitcher() {
  const scope = useWorkspace()
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside) }
  }, [open])
  const saved = readWorkspaceNavigation(workspaceStorageKey(scope.remoteKey))
  const candidates = [...new Set([...saved.favorites, ...saved.recent])]
    .map(id => scope.workspaces.find(w => workspaceIdentity(w) === id))
    .filter(w => w && workspaceIdentity(w) !== workspaceIdentity(scope.current)).slice(0, 5)
  return <div className="fl-space-switcher" ref={container} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button ref={trigger} className="fl-space-current" title={`${scope.current.name} · ${scope.current.origin === 'local' ? '내 PC' : `서버 · ${scope.current.id}`}`} aria-expanded={open} aria-controls="workspace-quick-switch" onClick={() => setOpen(!open)}>
      <AppIcon name={scope.current.origin === 'local' ? 'monitor' : 'workspace'} size={17} />
      <b title={scope.current.name}>{scope.current.origin === 'local' ? '개인 · 내 PC' : scope.current.name}</b>
      {scope.current.myRole === 'VIEWER' && <small>읽기 전용</small>}
      <AppIcon name="chevronDown" size={14} />
    </button>
    {open && <div id="workspace-quick-switch" className="fl-space-quick">
      <span className="fl-workbench-label">즐겨찾기 · 최근 공간</span>
      {candidates.map(w => w && <button data-workspace-switch key={workspaceIdentity(w)} aria-label={`${w.name} · ${w.origin === 'local' ? '내 PC' : `서버 · ${w.id}`} 열기`} onClick={() => { visitWorkspace(workspaceStorageKey(scope.remoteKey), w); setOpen(false); scope.select(w.id, w.origin) }}><span title={w.name}>{w.name}</span><small title={w.id}>{w.origin === 'local' ? '내 PC' : `서버 · ${w.id.slice(0, 8)}`}</small></button>)}
      {!candidates.length && <p>공간을 열면 여기에 표시됩니다.</p>}
      <Link to="/workspaces" onClick={() => setOpen(false)}>전체 공간 찾아보기 →</Link>
    </div>}
  </div>
}
