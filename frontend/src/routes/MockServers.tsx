import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ['mock-servers'] })

  const create = useMutation({
    mutationFn: () => mocksApi.create({ name: name.trim() || slug.trim(), slug: slug.trim() }),
    onSuccess: (d) => {
      setName(''); setSlug(''); setError(null)
      void invalidate()
      navigate(`/mocks/${d.id}`)
    },
    onError: (e) => setError(apiErrorMessage(e)),
  })
  const toggle = useMutation({
    mutationFn: (s: MockServerSummary) => mocksApi.update(s.id, { enabled: !s.enabled }),
    onSuccess: invalidate,
  })
  const remove = useMutation({ mutationFn: (id: string) => mocksApi.remove(id), onSuccess: invalidate })

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', margin: 0 }}>Mock 서버</h1>
          <span style={{ fontSize: 13, color: 'var(--fl-text-muted)' }}>
            미완성 시스템을 흉내 내는 가짜 API — 워크플로 HTTP/폼 노드가 바로 호출할 수 있습니다.
          </span>
        </div>

        {/* 생성 폼 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 20, flexWrap: 'wrap' }}>
          <input style={input} placeholder="이름 (예: 결제 게이트웨이)" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            style={{ ...input, fontFamily: 'var(--fl-font-mono)' }}
            placeholder="slug (소문자·숫자·하이픈, 예: pay-mock)"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
          />
          <button
            style={primaryBtn}
            disabled={!/^[a-z0-9-]{3,40}$/.test(slug.trim()) || create.isPending}
            onClick={() => create.mutate()}
          >
            + 만들기
          </button>
        </div>
        {error && <p style={{ color: 'var(--fl-fail)', fontSize: 12.5, marginTop: 8 }}>{error}</p>}

        {/* 목록 */}
        <div style={{ display: 'grid', gap: 10, marginTop: 22 }}>
          {(servers.data ?? []).map((s) => (
            <div key={s.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{ ...kindBadge, background: 'var(--fl-cat-generic)' }}>Mock</span>
                <div style={{ minWidth: 0 }}>
                  <Link to={`/mocks/${s.id}`} style={{ fontWeight: 600, fontSize: 15, color: 'var(--fl-text)', textDecoration: 'none' }}>{s.name}</Link>
                  <div style={{ fontSize: 12, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {mockBaseUrl(s.slug)}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>{relTime(s.updatedAt ?? '') || ''}</span>
                <button
                  style={miniBtn}
                  title="base URL 복사"
                  onClick={() => { void navigator.clipboard?.writeText(mockBaseUrl(s.slug)).catch(() => {}) }}
                >⧉ URL</button>
                <button
                  style={{ ...miniBtn, color: s.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)', borderColor: s.enabled ? 'var(--fl-ok)' : 'var(--fl-border)' }}
                  onClick={() => toggle.mutate(s)}
                  title={s.enabled ? '서빙 중 — 클릭하면 끔' : '꺼짐 — 클릭하면 켬'}
                >
                  {s.enabled ? '● 켜짐' : '○ 꺼짐'}
                </button>
                <button
                  style={{ ...miniBtn, color: 'var(--fl-fail)' }}
                  onClick={() => { if (window.confirm(`'${s.name}' mock 서버를 삭제할까요?`)) remove.mutate(s.id) }}
                >삭제</button>
              </div>
            </div>
          ))}
          {servers.isSuccess && (servers.data?.length ?? 0) === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--fl-text-muted)', fontSize: 13.5 }}>
              아직 mock 서버가 없습니다. 위에서 slug 를 정하고 만들어 보세요 —
              경로마다 응답(JSON·HTML·XML 등)·조건 분기·콜백 발사를 정의해 미완성 API 를 흉내 낼 수 있습니다.
            </div>
          )}
        </div>
      </div>
    </AppShellTier1>
  )
}

const input: CSSProperties = {
  padding: '9px 12px',
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-text)',
  fontSize: 13.5,
  minWidth: 200,
}

const primaryBtn: CSSProperties = {
  padding: '9px 16px',
  border: 'none',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-primary)',
  color: '#fff',
  fontWeight: 700,
  fontSize: 13.5,
  cursor: 'pointer',
}

const card: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 16px',
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius)',
  background: 'var(--fl-surface)',
}

const kindBadge: CSSProperties = {
  padding: '3px 9px',
  borderRadius: 'var(--fl-radius-pill)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 700,
  flexShrink: 0,
}

const miniBtn: CSSProperties = {
  padding: '5px 10px',
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-text)',
  fontSize: 12,
  cursor: 'pointer',
}
