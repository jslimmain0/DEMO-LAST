import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { FlowSummary } from '../api/types'
import { flowsApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { initial, relTime } from '../lib/format'

export function Dashboard() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data, isLoading, isError } = useQuery({ queryKey: ['flows'], queryFn: flowsApi.list })

  const create = useMutation({
    mutationFn: () => flowsApi.create({ name: '새 워크플로' }),
    onSuccess: (flow) => navigate(`/flows/${flow.id}`),
  })
  const remove = useMutation({
    mutationFn: (id: string) => flowsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flows'] }),
  })
  const duplicate = useMutation({
    mutationFn: async (f: FlowSummary) => {
      const detail = await flowsApi.get(f.id)
      return flowsApi.importFlow({ name: `${f.name} 복사`, nodes: detail.graph.nodes, edges: detail.graph.edges })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flows'] }),
  })

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: '40px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 26 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 30, letterSpacing: '-.02em', margin: '0 0 6px' }}>워크플로</h1>
            <p style={{ margin: 0, color: 'var(--fl-text-muted)', fontSize: 15 }}>REST API를 순서대로 엮어 자동으로 실행하세요.</p>
          </div>
          <button onClick={() => create.mutate()} disabled={create.isPending} style={primaryBtn}>+ 새 워크플로</button>
        </div>

        {isLoading && <Grid>{[0, 1, 2, 3].map((i) => <div key={i} style={{ ...card, height: 132, opacity: 0.5 }} />)}</Grid>}

        {isError && (
          <div style={errorBox}>⚠ 백엔드(18080)에 연결하지 못했습니다. <code style={{ fontFamily: 'var(--fl-font-mono)' }}>start.ps1 -H2</code> 로 백엔드를 먼저 띄우세요.</div>
        )}

        {data && data.length === 0 && (
          <div style={emptyBox}>저장된 워크플로가 없습니다. "새 워크플로"로 시작하세요.</div>
        )}

        {data && data.length > 0 && (
          <Grid>
            {data.map((f) => (
              <article key={f.id} style={card}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <span aria-hidden style={{ width: 38, height: 38, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--fl-primary) 14%, transparent)', color: 'var(--fl-primary)', fontFamily: 'var(--fl-font-head)', fontWeight: 700 }}>{initial(f.name)}</span>
                    <div>
                      <Link to={`/flows/${f.id}`} style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 16, color: 'var(--fl-text)', textDecoration: 'none' }}>{f.name}</Link>
                      <div style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', marginTop: 2 }}>v{f.currentVersion} · {relTime(f.updatedAt) || '방금'}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => duplicate.mutate(f)} title="복제" aria-label={`${f.name} 복제`} style={iconBtn}>⧉</button>
                    <button onClick={() => { if (confirm(`'${f.name}' 을(를) 삭제할까요?`)) remove.mutate(f.id) }} title="삭제" aria-label={`${f.name} 삭제`} style={iconBtn}>🗑</button>
                  </div>
                </div>
                {f.description && <p style={{ margin: '14px 0 0', fontSize: 13.5, color: 'var(--fl-text-muted)', lineHeight: 1.5 }}>{f.description}</p>}
              </article>
            ))}
          </Grid>
        )}
      </div>
    </AppShellTier1>
  )
}

function Grid({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 18 }}>{children}</div>
}

const primaryBtn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--fl-text)', color: 'var(--fl-bg)', border: 'none', padding: '11px 18px', borderRadius: 11, fontWeight: 600, fontSize: 14, cursor: 'pointer' }
const card: CSSProperties = { background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', padding: '22px 22px 18px', boxShadow: 'var(--fl-shadow)' }
const iconBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', cursor: 'pointer', color: 'var(--fl-text-muted)' }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: 48, textAlign: 'center', color: 'var(--fl-text-muted)', fontSize: 14 }
const errorBox: CSSProperties = { border: '1px solid var(--fl-fail)', borderRadius: 12, padding: 20, color: 'var(--fl-fail)', fontSize: 14, background: 'color-mix(in srgb, var(--fl-fail) 8%, transparent)' }
