import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { secretsApi } from '../api/client'
import { toast } from './toast'
import { useEscapeClose } from './useEscapeClose'

/**
 * 시크릿 볼트 — Bearer/API 키 등을 이름으로 저장하고 `{{ 이름@secret }}` 로 참조.
 * 값은 서버에서 AES-GCM 암호화 저장(write-only — 목록엔 이름만), 실행 로그/DB 에는 마스킹된다.
 */
export function SecretsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  useEscapeClose(onClose)
  const q = useQuery({ queryKey: ['secrets'], queryFn: secretsApi.list })
  const [name, setName] = useState('')
  const [value, setValue] = useState('')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['secrets'] })
  const put = useMutation({
    mutationFn: () => secretsApi.put(name.trim(), value),
    onSuccess: () => { toast('시크릿을 저장했습니다.', 'ok'); setName(''); setValue(''); invalidate() },
    onError: (e: unknown) => toast(errMsg(e, '저장 실패 — 이름은 영문/숫자/._- 만 허용합니다.'), 'error'),
  })
  const del = useMutation({
    mutationFn: (n: string) => secretsApi.remove(n),
    onSuccess: () => { toast('시크릿을 삭제했습니다.', 'ok'); invalidate() },
  })
  const list = q.data ?? []

  return (
    <div role="dialog" aria-modal="true" aria-label="시크릿" style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span aria-hidden>🔑</span>
          <b style={{ flex: 1, fontSize: 15 }}>시크릿 볼트</b>
          <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
        </header>
        <p style={hint}>
          Bearer 토큰·API 키 등을 저장하고 <code style={code}>{'{{ 이름@secret }}'}</code> 로 씁니다.
          값은 암호화 저장되고 실행 로그/DB 에는 <b>마스킹(••••••)</b> 됩니다. 저장된 값은 다시 볼 수 없습니다.
        </p>

        <div style={{ display: 'grid', gap: 6, margin: '12px 0' }}>
          {list.length === 0 && !q.isLoading && <p style={{ ...hint, color: 'var(--fl-text-muted)' }}>저장된 시크릿이 없습니다.</p>}
          {list.map((s) => (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }}>
              <code style={{ flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 12.5 }}>{s.name}</code>
              <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, color: 'var(--fl-text-muted)', letterSpacing: 2 }}>••••••</span>
              <button onClick={() => copy(`{{ ${s.name}@secret }}`)} title="바인딩 토큰 복사" style={miniBtn}>토큰</button>
              <button onClick={() => del.mutate(s.name)} aria-label="삭제" style={miniBtn}>×</button>
            </div>
          ))}
        </div>

        <div style={{ borderTop: '1px solid var(--fl-border)', paddingTop: 12 }}>
          <label style={label}>새 시크릿 (이름 + 값)</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: API_TOKEN" style={{ ...mono, flex: 1 }} />
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="값(저장 후 숨김)" type="password" style={{ ...mono, flex: 1.4 }} />
            <button onClick={() => put.mutate()} disabled={!name.trim() || !value || put.isPending} style={primary}>저장</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function errMsg(e: unknown, fallback: string): string {
  const m = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
  return m || fallback
}
function copy(s: string) { void navigator.clipboard?.writeText(s).then(() => toast(`${s} 복사`, 'ok')).catch(() => {}) }

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 540, maxWidth: '96vw', maxHeight: '86vh', overflowY: 'auto', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', boxShadow: 'var(--fl-shadow-lg)', padding: 18 }
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', lineHeight: 1.6, margin: 0 }
const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '0 0 5px' }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const mono: CSSProperties = { padding: '7px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, fontFamily: 'var(--fl-font-mono)', minWidth: 0 }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const primary: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }
const miniBtn: CSSProperties = { padding: '4px 8px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 11.5, flexShrink: 0 }
