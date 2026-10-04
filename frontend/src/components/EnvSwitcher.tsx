import { Link, useLocation } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEnvStore, useEnvironment } from '../lib/environments'
import { EnvManagerDialog } from './EnvManagerDialog'
import { useAnchoredPopover } from './useAnchoredPopover'
import { AppIcon } from './AppIcon'

/**
 * 에디터 상단 환경 스위처 — 활성 환경을 바꾸고 관리 다이얼로그를 연다.
 * 활성 환경의 변수는 실행 시 `{{ 키@env }}` 로 주입된다([environments.ts], onRun).
 */
export function EnvSwitcher() {
  const location = useLocation()
  const resourceParams = new URLSearchParams(location.search)
  resourceParams.set('tab', 'environments')
  const { setActiveEnv } = useEnvironment()

  const store = useEnvStore()
  const [manage, setManage] = useState(false)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const anchored = useAnchoredPopover(trigger, open)
  useEffect(() => { if (open && anchored.ready) searchRef.current?.focus({ preventScroll: true }) }, [open, anchored.ready])
  const names = Object.keys(store.envs).sort((a, b) => a.localeCompare(b))
  const shown = names.filter(name => name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
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
      {names.length === 0 ? (
        <button onClick={() => setManage(true)} title="실행 환경(dev/staging/prod)과 변수를 설정합니다" className="fl-action-button fl-env-trigger">
          <AppIcon name="globe" size={16} /><span>환경 설정</span>
        </button>
      ) : (
        <button ref={trigger} aria-expanded={open} onClick={() => { setOpen((v) => !v); setFilter('') }} title={`활성 환경 전환 · ${store.active ?? '환경 없음'}`} className={`fl-action-button fl-env-trigger${store.active ? ' fl-env-trigger--active' : ''}`}>
          <AppIcon name="globe" size={16} /><span>{store.active ?? '환경 없음'}</span><AppIcon name="chevronDown" size={14} />
        </button>
      )}
      {open && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setOpen(false)} />
          <div ref={anchored.popupRef} className="fl-env-menu" style={anchored.style} onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-env-option]'))
            const index = options.indexOf(document.activeElement as HTMLButtonElement)
            event.preventDefault()
            options[Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
          }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
            <input ref={searchRef} type="search" aria-label="활성 환경 검색" value={filter} onChange={event => setFilter(event.target.value)} placeholder="환경 이름 검색" className="fl-control" />
            <span role="status" className="fl-env-menu__status">환경 {shown.length} / {names.length}개 · ↑↓ 이동</span>
            <div className="fl-env-menu__options">
            <button
              data-env-option
              aria-pressed={store.active == null}
              className="fl-env-menu__item"
              onClick={() => { setActiveEnv(null); close() }}
            >
              <span className="fl-env-menu__name">없음 (주입 안 함)</span>{store.active == null && <AppIcon name="check" size={16} />}
            </button>
            {shown.length === 0 && <p className="fl-env-menu__status">일치하는 환경이 없습니다.</p>}
            {shown.map((name) => (
              <button
                key={name}
                data-env-option aria-pressed={store.active === name}
                className="fl-env-menu__item"
                onClick={() => { setActiveEnv(name); close() }}
                title={`${name} · ${Object.keys(store.envs[name]).length}개 변수`}
              >
                <span className="fl-env-menu__name">{name}</span>
                <span className="fl-env-menu__count">{Object.keys(store.envs[name]).length}</span>
                {store.active === name && <AppIcon name="check" size={16} />}
              </button>
            ))}
            </div>
            <div className="fl-env-menu__footer"><button className="fl-env-menu__item" onClick={() => { setManage(true); setOpen(false) }}><AppIcon name="settings" size={16} />환경 관리</button></div>
          </div>
        </>, document.body
      )}
      <Link to={`/resources?${resourceParams}`} title="환경·시크릿 전체 관리" className="fl-action-button" style={{ textDecoration: 'none' }}>관리<AppIcon name="arrowRight" size={14} /></Link>
      {manage && <EnvManagerDialog onClose={() => setManage(false)} />}
    </div>
  )
}
