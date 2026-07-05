import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MockServerSummary } from '../api/types'
import { mockBaseUrl, mocksApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { apiErrorMessage } from '../lib/apiError'
import { relTime } from '../lib/format'

/**
 * Mock 서버 목록 — 워크플로가 호출할 가짜 대상 시스템을 만들고 켜고 끈다.
 * 저장 즉시 /mock/{slug}/** 로 서빙(별도 프로세스 없음).
 */
export function MockServers() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const servers = useQuery({ queryKey: ['mock-servers'], queryFn: mocksApi.list })
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['mock-servers'] })

  const create = useMutation({
    mutationFn: () => mocksApi.create({ name: name.trim() || slug.trim(), slug: slug.trim() }),
    onSuccess: (d) => { setName(''); setSlug(''); setError(null); setCreating(false); void invalidate(); navigate(`/mocks/${d.id}`) },
    onError: (e) => setError(apiErrorMessage(e)),
  })
  const toggle = useMutation({ mutationFn: (s: MockServerSummary) => mocksApi.update(s.id, { enabled: !s.enabled }), onSuccess: invalidate })
  const remove = useMutation({ mutationFn: (id: string) => mocksApi.remove(id), onSuccess: invalidate })

  const list = servers.data ?? []
  const slugOk = /^[a-z0-9-]{3,40}$/.test(slug.trim())

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '36px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>Mock 서버</h1>
              <span style={metaMono}>{list.length}</span>
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'var(--fl-text-muted)', maxWidth: 540 }}>
              미완성 시스템을 흉내 내는 가짜 API. 경로마다 응답·조건 분기·콜백 발사를 정의하면 워크플로 노드가 바로 호출합니다.
            </p>
          </div>
          {!creating && <button onClick={() => setCreating(true)} style={primaryBtn}>+ 새 Mock 서버</button>}
        </div>

        {creating && (
          <div style={createRow}>
            <input style={input} placeholder="이름 (예: 결제 게이트웨이)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <input style={{ ...input, fontFamily: 'var(--fl-font-mono)' }} placeholder="slug (예: pay-mock)" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} onKeyDown={(e) => { if (e.key === 'Enter' && slugOk) create.mutate() }} />
            <button style={{ ...primaryBtn, opacity: slugOk ? 1 : 0.5 }} disabled={!slugOk || create.isPending} onClick={() => create.mutate()}>만들기</button>
            <button style={ghostBtn} onClick={() => { setCreating(false); setError(null) }}>취소</button>
          </div>
        )}
        {error && <p style={{ color: 'var(--fl-fail)', fontSize: 12.5, marginTop: 8 }}>{error}</p>}

        <div style={{ display: 'grid', gap: 10, marginTop: 24 }}>
          {list.map((s) => (
            <MockCard key={s.id} server={s} onToggle={() => toggle.mutate(s)} onRemove={() => { if (window.confirm(`'${s.name}' Mock 서버를 삭제할까요? 되돌릴 수 없습니다.`)) remove.mutate(s.id) }} />
          ))}
          {servers.isSuccess && list.length === 0 && !creating && (
            <div style={emptyBox}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>첫 Mock 서버를 만들어 보세요</div>
              <div style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, marginTop: 6, maxWidth: 420, marginInline: 'auto' }}>
                slug 를 정하면 <code style={codeChip}>/mock/&#123;slug&#125;/**</code> 로 즉시 서빙됩니다. 경로마다 JSON·HTML·XML 응답과 조건 분기·콜백을 정의할 수 있습니다.
              </div>
              <button onClick={() => setCreating(true)} style={{ ...primaryBtn, marginTop: 18 }}>+ 새 Mock 서버</button>
            </div>
          )}
        </div>
      </div>
    </AppShellTier1>
  )
}

function MockCard({ server: s, onToggle, onRemove }: { server: MockServerSummary; onToggle: () => void; onRemove: () => void }) {
  const navigate = useNavigate()
  const detail = useQuery({ queryKey: ['mock-server', s.id], queryFn: () => mocksApi.get(s.id) })
  const routeCount = detail.data?.spec?.routes?.length
  const spine = s.enabled ? 'var(--fl-cat-wait)' : 'var(--fl-border)'
  const open = () => navigate(`/mocks/${s.id}`)
  return (
    <div
      className="fl-flow-card"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      style={{ ...card, borderLeft: `3px solid ${spine}`, cursor: 'pointer' }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15, color: 'var(--fl-text)', textDecoration: 'none' }}>{s.name}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 5, minWidth: 0 }}>
          <button
            title="base URL 복사"
            onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(mockBaseUrl(s.slug)).catch(() => {}) }}
            style={{ ...metaMono, display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}
          >
            {mockBaseUrl(s.slug)} <span aria-hidden style={{ color: 'var(--fl-primary)' }}>⧉</span>
          </button>
          {routeCount != null && <span style={metaMono}>· 라우트 {routeCount}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <span style={metaMono}>{relTime(s.updatedAt ?? '') || ''}</span>
        <button onClick={(e) => { e.stopPropagation(); onToggle() }} title={s.enabled ? '서빙 중 — 클릭하면 끔' : '꺼짐 — 클릭하면 켬'} style={{ ...pill, color: s.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)', borderColor: s.enabled ? 'color-mix(in srgb, var(--fl-ok) 40%, var(--fl-border))' : 'var(--fl-border)' }}>
          {s.enabled ? '● 켜짐' : '○ 꺼짐'}
        </button>
        <button className="fl-card-actions" onClick={(e) => { e.stopPropagation(); onRemove() }} title="삭제" aria-label={`${s.name} 삭제`} style={{ ...pill, color: 'var(--fl-fail)', borderColor: 'var(--fl-border)' }}>삭제</button>
      </div>
    </div>
  )
}

const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const input: CSSProperties = { padding: '0 12px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13.5, minWidth: 200 }
const createRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 20, flexWrap: 'wrap', padding: 14, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const primaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 38, padding: '0 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13.5, cursor: 'pointer' }
const ghostBtn: CSSProperties = { height: 38, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const card: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow)' }
const pill: CSSProperties = { padding: '5px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface)', fontSize: 12, cursor: 'pointer' }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: '48px 40px', textAlign: 'center', color: 'var(--fl-text-muted)' }
const codeChip: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface-2)', padding: '1px 6px', borderRadius: 5 }
