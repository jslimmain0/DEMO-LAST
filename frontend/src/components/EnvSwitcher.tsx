import { Link, useLocation } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEnvStore, useEnvironment, useEnvironmentSource, useEnvironmentLoadStatus } from '../lib/environments'
import { EnvManagerDialog } from './EnvManagerDialog'
import { useAnchoredPopover } from './useAnchoredPopover'
import { AppIcon } from './AppIcon'
import { useWorkspace } from '../app/WorkspaceContext'
import { useAuth } from '../auth/AuthContext'

/**
 * 에디터 상단 환경 스위처 — 활성 환경을 바꾸고 관리 다이얼로그를 연다.
 * 활성 환경의 변수는 실행 시 `{{ 키@env }}` 로 주입된다([environments.ts], onRun).
 */
export function EnvSwitcher({ disabled = false }: { disabled?: boolean } = {}) {
  const location = useLocation()
  const resourceParams = new URLSearchParams(location.search)
  resourceParams.set('tab', 'environments')
  const scope = useWorkspace()
  const { desktop } = useAuth()
  const source = useEnvironmentSource()
  const localEnvironment = useEnvironment('local')
  const serverEnvironment = useEnvironment('server')
  const localStore = useEnvStore('local')
  const serverStore = useEnvStore('server')
  const localStatus = useEnvironmentLoadStatus('local')
  const serverStatus = useEnvironmentLoadStatus('server')
  const { setActiveEnv } = useEnvironment()
  const store = useEnvStore()
  const [manage, setManage] = useState(false)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const anchored = useAnchoredPopover(trigger, open && !disabled)
  useEffect(() => { if (open && anchored.ready) searchRef.current?.focus({ preventScroll: true }) }, [open, anchored.ready])
  useEffect(() => { if (disabled) { setOpen(false); setManage(false) } }, [disabled])
  const groups = [
    ...(desktop ? [{ origin: 'local' as const, label: '내 PC', store: localStore, environment: localEnvironment, available: true, status: localStatus }] : []),
    { origin: 'server' as const, label: '서버', store: serverStore, environment: serverEnvironment, available: scope.connected, status: serverStatus },
  ]
  const names = groups.flatMap(group => Object.keys(group.store.envs))
  const shownCount = names.filter(name => name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())).length
  const close = () => { setOpen(false); trigger.current?.focus() }
  // 드롭다운 열림 중 Esc = 닫기 (바깥 클릭과 같은 어휘)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="fl-env-switcher">
        <button ref={trigger} disabled={disabled} aria-expanded={open && !disabled} aria-controls="execution-environment-menu" onClick={() => { if (disabled) return; setOpen((v) => !v); setFilter('') }} title={disabled ? '실행 준비·실행 중에는 환경을 바꿀 수 없습니다.' : `실행 환경 · ${source.origin === 'local' ? '내 PC' : '서버'} · ${store.active ?? '선택 안 함'}`} className={`fl-action-button fl-env-trigger${store.active ? ' fl-env-trigger--active' : ''}`}>
          <AppIcon name={source.origin === 'local' ? 'monitor' : 'server'} size={16} /><span>{store.active ? `${source.origin === 'local' ? '내 PC' : '서버'} · ${store.active}` : '환경 선택'}</span><AppIcon name="chevronDown" size={14} />
        </button>
      {open && !disabled && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setOpen(false)} />
          <div id="execution-environment-menu" ref={anchored.popupRef} className="fl-env-menu" style={anchored.style} onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-env-option]:not(:disabled)'))
            const index = options.indexOf(document.activeElement as HTMLButtonElement)
            event.preventDefault()
            options[Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
          }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
            <input ref={searchRef} type="search" aria-label="활성 환경 검색" value={filter} onChange={event => setFilter(event.target.value)} placeholder="환경 이름 검색" className="fl-control" />
            <span role="status" className="fl-env-menu__status">환경 {shownCount} / {names.length}개 · ↑↓ 이동</span>
            <div className="fl-env-menu__options">
            <button
              data-env-option
              aria-pressed={store.active == null}
              className="fl-env-menu__item"
              onClick={() => { setActiveEnv(null); close() }}
            >
              <span className="fl-env-menu__name">없음 (주입 안 함)</span>{store.active == null && <AppIcon name="check" size={16} />}
            </button>
            {groups.map(group => <div key={group.origin} className="fl-env-menu__group"><strong className="fl-env-menu__status"><AppIcon name={group.origin === 'local' ? 'monitor' : 'server'} size={13} />{group.label}</strong>
            {!group.available ? <p role="status" className="fl-env-menu__status">서버 연결 필요</p> : group.status === 'loading' ? <p role="status" className="fl-env-menu__status">환경을 불러오는 중…</p> : group.status === 'error' ? <p role="alert" className="fl-env-menu__status">환경을 불러오지 못했습니다. <button className="fl-env-menu__item" onClick={() => void group.environment.ensureEnvLoaded().catch(() => {})}>다시 불러오기</button></p> : null}
            {Object.keys(group.store.envs).filter(name => name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())).sort((a,b) => a.localeCompare(b, 'ko')).map((name) => (
              <button
                key={name}
                data-env-option aria-pressed={source.origin === group.origin && store.active === name}
                disabled={!group.available || group.status !== 'ready'}
                className="fl-env-menu__item"
                onClick={() => { group.environment.setActiveEnv(name); source.setOrigin(group.origin); close() }}
                title={`${group.label} · ${name} · ${Object.keys(group.store.envs[name]).length}개 변수`}
              >
                <span className="fl-env-menu__name">{name}</span>
                <span className="fl-env-menu__count">{Object.keys(group.store.envs[name]).length}</span>
                {source.origin === group.origin && store.active === name && <AppIcon name="check" size={16} />}
              </button>
            ))}
            {group.available && group.status === 'ready' && !Object.keys(group.store.envs).length && <p className="fl-env-menu__status">환경이 없습니다.</p>}
            {group.available && group.status === 'ready' && Object.keys(group.store.envs).length > 0 && !Object.keys(group.store.envs).some(name => name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) && <p className="fl-env-menu__status">일치하는 환경이 없습니다.</p>}
            </div>)}
            <p className="fl-env-menu__status">내 PC 또는 서버의 환경을 선택해 실행에 사용합니다.</p>
            </div>
            <div className="fl-env-menu__footer"><button className="fl-env-menu__item" onClick={() => { setManage(true); setOpen(false) }}><AppIcon name="settings" size={16} />환경 관리</button></div>
          </div>
        </>, document.body
      )}
      {disabled ? <button type="button" disabled title="실행을 마친 후 환경을 관리하세요." className="fl-action-button">관리<AppIcon name="arrowRight" size={14} /></button> : <Link to={`/resources?${resourceParams}`} title="환경·시크릿 전체 관리" className="fl-action-button" style={{ textDecoration: 'none' }}>관리<AppIcon name="arrowRight" size={14} /></Link>}
      {manage && !disabled && <EnvManagerDialog onClose={() => setManage(false)} />}
    </div>
  )
}
