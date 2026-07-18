import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import { secretsApi } from '../api/client'
import { useEnvStore } from '../lib/environments'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * 시크릿 볼트 — Bearer/API 키 등을 이름으로 저장하고 `{{ 이름@secret }}` 로 참조.
 * 값은 서버에서 AES-GCM 암호화 저장(write-only — 목록엔 이름만), 실행 로그/DB 에는 마스킹된다.
 *
 * **환경 스코프**: 각 시크릿은 공통(전역) 또는 특정 환경(dev/staging/prod…) 소속.
 * 실행 시 활성 환경(⚙ 환경 스위처)의 시크릿이 공통 위에 **오버레이**된다(같은 이름이면 환경값이 이김).
 */
export function SecretsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['secrets'], queryFn: secretsApi.list })
  const envStore = useEnvStore()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [env, setEnv] = useState<string>('') // '' = 공통

  // 셀렉트 옵션 = 공통 + 정의된 환경 + 활성 환경(정의 안 됐어도)
  const envNames = useMemo(() => {
    const s = new Set<string>(Object.keys(envStore.envs))
    if (envStore.active) s.add(envStore.active)
    return Array.from(s).sort()
  }, [envStore])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['secrets'] })
  const put = useMutation({
    mutationFn: () => secretsApi.put(name.trim(), value, env || null),
    onSuccess: () => { toast('시크릿을 저장했습니다.', 'ok'); setName(''); setValue(''); invalidate() },
    onError: (e: unknown) => toast(errMsg(e, '저장 실패 — 이름은 영문/숫자/._- 만 허용합니다.'), 'error'),
  })
  const del = useMutation({
    mutationFn: (s: { name: string; environment: string | null }) => secretsApi.remove(s.name, s.environment),
    onSuccess: () => { toast('시크릿을 삭제했습니다.', 'ok'); invalidate() },
  })
  const list = q.data ?? []
  // 공통 먼저, 그다음 환경별 정렬
  const sorted = [...list].sort((a, b) => {
    const ea = a.environment ?? '', eb = b.environment ?? ''
    return ea === eb ? a.name.localeCompare(b.name) : ea.localeCompare(eb)
  })

  return (
    <Modal onClose={onClose} ariaLabel="시크릿" width={560} card={{ padding: 18, display: 'block', overflowY: 'auto' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span aria-hidden>🔑</span>
          <b style={{ flex: 1, fontSize: 15 }}>시크릿 볼트</b>
          <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
        </header>
        <p style={hint}>
          Bearer 토큰·API 키 등을 저장하고 <code style={code}>{'{{ 이름@secret }}'}</code> 로 씁니다.
          값은 암호화 저장되고 실행 로그/DB 에는 <b>마스킹(••••••)</b> 됩니다. 저장된 값은 다시 볼 수 없습니다.
          시크릿은 <b>서버(S→S) 모드</b> HTTP 노드에서 쓰세요 — 클라이언트(C→S) 모드는 값이 브라우저로 전달돼 대기 상태(미마스킹)에 남을 수 있습니다.
          {envStore.active
            ? <> 현재 활성 환경은 <b>{envStore.active}</b> — 실행 시 이 환경의 시크릿이 공통 위에 겹쳐집니다.</>
            : <> 활성 환경이 없어 <b>공통</b> 시크릿만 적용됩니다(환경 스위처에서 전환).</>}
        </p>

        <div style={{ display: 'grid', gap: 6, margin: '12px 0' }}>
          {sorted.length === 0 && !q.isLoading && <p style={{ ...hint, color: 'var(--fl-text-muted)' }}>저장된 시크릿이 없습니다.</p>}
          {sorted.map((s) => (
            <div key={`${s.environment ?? '*'}:${s.name}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }}>
              <span style={envBadge(s.environment)}>{s.environment ?? '공통'}</span>
              <code style={{ flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 12.5 }}>{s.name}</code>
              <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, color: 'var(--fl-text-muted)', letterSpacing: 2 }}>••••••</span>
              <button onClick={() => copy(`{{ ${s.name}@secret }}`)} title="바인딩 토큰 복사" style={miniBtn}>토큰</button>
              <button onClick={() => del.mutate({ name: s.name, environment: s.environment })} aria-label="삭제" style={miniBtn}>×</button>
            </div>
          ))}
        </div>

        <div style={{ borderTop: '1px solid var(--fl-border)', paddingTop: 12 }}>
          <label style={label}>새 시크릿 (환경 + 이름 + 값)</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={env} onChange={(e) => setEnv(e.target.value)} style={{ ...mono, flex: '0 0 96px' }} title="환경 스코프">
              <option value="">공통</option>
              {envNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: API_TOKEN" style={{ ...mono, flex: 1 }} />
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="값(저장 후 숨김)" type="password" style={{ ...mono, flex: 1.3 }} />
            <button onClick={() => put.mutate()} disabled={!name.trim() || !value || put.isPending} style={primary}>저장</button>
          </div>
          <p style={{ ...hint, marginTop: 6 }}>
            같은 이름을 <b>공통</b>과 <b>환경</b>에 둘 다 두면, 실행 시 활성 환경값이 공통값을 덮어씁니다(스테이징 키만 갈아끼우기 등).
          </p>
        </div>
    </Modal>
  )
}

function errMsg(e: unknown, fallback: string): string {
  const m = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
  return m || fallback
}
function copy(s: string) { void navigator.clipboard?.writeText(s).then(() => toast(`${s} 복사`, 'ok')).catch(() => {}) }

const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', lineHeight: 1.6, margin: 0 }
const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '0 0 5px' }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const mono: CSSProperties = { padding: '7px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, fontFamily: 'var(--fl-font-mono)', minWidth: 0 }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const primary: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }
const miniBtn: CSSProperties = { padding: '4px 8px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 11.5, flexShrink: 0 }
function envBadge(env: string | null): CSSProperties {
  return {
    flexShrink: 0, fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
    background: env ? 'var(--fl-primary-weak, rgba(59,130,246,0.16))' : 'var(--fl-surface)',
    color: env ? 'var(--fl-primary)' : 'var(--fl-text-muted)',
    border: '1px solid var(--fl-border)', letterSpacing: 0.2, minWidth: 34, textAlign: 'center',
  }
}
