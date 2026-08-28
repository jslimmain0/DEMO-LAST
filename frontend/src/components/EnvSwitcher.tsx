import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { setActiveEnv, useEnvStore } from '../lib/environments'
import { EnvManagerDialog } from './EnvManagerDialog'

/**
 * 에디터 상단 환경 스위처 — 활성 환경(dev/staging/prod)을 드롭다운으로 바꾸고 ⚙ 로 관리 다이얼로그를 연다.
 * 활성 환경의 변수는 실행 시 `{{ 키@env }}` 로 주입된다([environments.ts], onRun).
 */
export function EnvSwitcher() {
  const store = useEnvStore()
  const [manage, setManage] = useState(false)
  const [open, setOpen] = useState(false)
  const names = Object.keys(store.envs).sort((a, b) => a.localeCompare(b))
  // 드롭다운 열림 중 Esc = 닫기 (바깥 클릭과 같은 어휘)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      {names.length === 0 ? (
        <button onClick={() => setManage(true)} title="실행 환경(dev/staging/prod)과 변수를 설정합니다" style={pill}>
          🌐 환경 설정
        </button>
      ) : (
        <button onClick={() => setOpen((v) => !v)} title="활성 환경 전환 · 관리" style={{ ...pill, ...(store.active ? activePill : null) }}>
          🌐 {store.active ?? '환경 없음'} ▾
        </button>
      )}
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setOpen(false)} />
          <div style={menu}>
            <button
              style={{ ...menuItem, fontWeight: store.active == null ? 700 : 400 }}
              onClick={() => { setActiveEnv(null); setOpen(false) }}
            >
              {store.active == null ? '● ' : '○ '}없음 (주입 안 함)
            </button>
            {names.map((name) => (
              <button
                key={name}
                style={{ ...menuItem, fontWeight: store.active === name ? 700 : 400 }}
                onClick={() => { setActiveEnv(name); setOpen(false) }}
                title={`${Object.keys(store.envs[name]).length}개 변수`}
              >
                {store.active === name ? '● ' : '○ '}{name}
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fl-text-muted)' }}>{Object.keys(store.envs[name]).length}</span>
              </button>
            ))}
            <div style={{ borderTop: '1px solid var(--fl-border)', margin: '4px 0' }} />
            <button style={menuItem} onClick={() => { setManage(true); setOpen(false) }}>⚙ 환경 관리…</button>
          </div>
        </>
      )}
      {manage && <EnvManagerDialog onClose={() => setManage(false)} />}
    </div>
  )
}

const pill: CSSProperties = { padding: '7px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }
const activePill: CSSProperties = { borderColor: 'var(--fl-primary)', color: 'var(--fl-primary)', fontWeight: 600 }
const menu: CSSProperties = { position: 'absolute', top: '110%', right: 0, minWidth: 200, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 91, display: 'flex', flexDirection: 'column', gap: 1 }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', padding: '7px 9px', border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12.5 }
