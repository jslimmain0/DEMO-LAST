import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ExecutionStatus, ExecutionSummary } from '../api/types'
import { runsApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { LogBlock } from '../components/NodeExecutionLog'
import { StatusBadge } from '../components/StatusBadge'
import { toast } from '../components/toast'
import { useEscapeClose } from '../components/useEscapeClose'
import { duration, relTime } from '../lib/format'

const STATUS_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--fl-ok)', FAILED: 'var(--fl-fail)', RUNNING: 'var(--fl-running)',
  WAITING: 'var(--fl-waiting)', PENDING: 'var(--fl-pending)', CANCELLED: 'var(--fl-pending)',
}
const TRIGGER_LABEL: Record<string, string> = { MANUAL: '수동', SCHEDULE: '예약', WEBHOOK: '웹훅', EVENT: '이벤트' }

function statusColor(s: ExecutionStatus): string {
  return STATUS_COLOR[s] ?? 'var(--fl-text-muted)'
}
function elapsed(e: ExecutionSummary): string | null {
  if (!e.startedAt || !e.finishedAt) return null
  const ms = new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime()
  return ms >= 0 ? duration(ms) : null
}

// 기간 필터 — 서버측 from(epoch ms) 로 승격. now 는 렌더 시점 계산(고정 상수 아님).
const RANGES: Array<[string, string, number | null]> = [
  ['all', '전체', null], ['1d', '24시간', 86400_000], ['7d', '7일', 7 * 86400_000], ['30d', '30일', 30 * 86400_000],
]

export function Executions() {
  const qc = useQueryClient()
  const [limit, setLimit] = useState(50)
  const [filter, setFilter] = useState<'all' | ExecutionStatus>('all')
  const [range, setRange] = useState<string>('all')
  const [q, setQ] = useState('')
  const [openExec, setOpenExec] = useState<string | null>(null)

  const rangeMs = RANGES.find(([k]) => k === range)?.[2] ?? null
  // 서버측 status/기간 필터 + limit. from 은 쿼리 실행 시점 기준(키에는 range 코드만 넣어 매 렌더 재요청 방지).
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['executions', 'list', limit, filter, range],
    queryFn: () => runsApi.list({
      limit,
      status: filter === 'all' ? undefined : filter,
      from: rangeMs != null ? Date.now() - rangeMs : undefined,
    }),
  })
  const all = data ?? []
  const okCount = all.filter((e) => e.status === 'SUCCEEDED').length
  const failCount = all.filter((e) => e.status === 'FAILED').length
  const reRun = useMutation({
    mutationFn: (execId: string) => runsApi.rerun(execId),
    onSuccess: () => { toast('같은 조건으로 재실행을 시작했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['executions', 'list'] }) },
    onError: () => toast('재실행에 실패했습니다.', 'error'),
  })
  const query = q.trim().toLowerCase()
  // status/기간은 서버가 필터 → 여기선 이름 검색만(서버는 flowId 로만 필터하므로 이름은 클라 측)
  const rows = all.filter((e) => !query || (e.flowName ?? '').toLowerCase().includes(query))

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '36px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>실행 이력</h1>
          {rows.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 4 }}>
              <span style={metaMono}>{rows.length}건</span>
              {okCount > 0 && <span style={{ ...metaMono, color: 'var(--fl-ok)' }}>✓ {okCount}</span>}
              {failCount > 0 && <span style={{ ...metaMono, color: 'var(--fl-fail)' }}>✕ {failCount}</span>}
            </div>
          )}
        </div>

        {!isLoading && !isError && (all.length > 0 || filter !== 'all' || range !== 'all' || q) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="워크플로 이름 검색…"
              style={{ padding: '7px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13, minWidth: 220 }} />
            <div style={{ display: 'flex', gap: 3 }}>
              {([['all', '전체'], ['SUCCEEDED', '성공'], ['FAILED', '실패'], ['WAITING', '대기'], ['CANCELLED', '취소']] as const).map(([k, lbl]) => (
                <button key={k} onClick={() => setFilter(k)} style={{ padding: '5px 11px', fontSize: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', cursor: 'pointer', background: filter === k ? 'var(--fl-primary)' : 'transparent', color: filter === k ? '#fff' : 'var(--fl-text-muted)', fontWeight: 500 }}>{lbl}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 3, marginLeft: 4 }} title="기간 필터">
              {RANGES.map(([k, lbl]) => (
                <button key={k} onClick={() => setRange(k)} style={{ padding: '5px 10px', fontSize: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', cursor: 'pointer', background: range === k ? 'var(--fl-surface-2)' : 'transparent', color: range === k ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontWeight: range === k ? 600 : 400 }}>{lbl}</button>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          {isLoading && <div style={{ display: 'grid', gap: 10 }}>{[0, 1, 2, 3].map((i) => <div key={i} style={{ ...rowCard, borderLeft: '3px solid var(--fl-border)', height: 58, opacity: 0.5 }} />)}</div>}
          {isError && (
            <div style={errorBox}>
              <div style={{ fontSize: 22 }}>⚠</div>
              <div>
                <div style={{ fontWeight: 600 }}>백엔드(18080)에 연결하지 못했어요.</div>
                <div style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', marginTop: 4 }}>백엔드를 먼저 실행하세요 — <code style={codeChip}>scripts\dev-all.ps1</code></div>
              </div>
              <button onClick={() => refetch()} style={{ ...ghostBtn, marginLeft: 'auto' }}>다시 시도</button>
            </div>
          )}
          {data && rows.length === 0 && (
            <div style={emptyBox}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>아직 실행 이력이 없습니다</div>
              <div style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, marginTop: 6 }}>워크플로를 열어 <b>▶ 실행</b>하면 여기에 기록됩니다.</div>
            </div>
          )}

          {data && all.length > 0 && rows.length === 0 && (
            <div style={{ padding: 16, color: 'var(--fl-text-muted)', fontSize: 13 }}>이 조건에 해당하는 실행이 없습니다.</div>
          )}
          <div style={{ display: 'grid', gap: 10 }}>
            {rows.map((e) => {
              const el = elapsed(e)
              return (
                <div key={e.id} className="fl-flow-card" onClick={() => setOpenExec(e.id)}
                  style={{ ...rowCard, borderLeft: `3px solid ${statusColor(e.status)}`, cursor: 'pointer' }}
                  title="클릭하면 노드별 결과를 봅니다">
                  <StatusBadge status={e.status} />
                  <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 14.5, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.flowName ?? `삭제된 워크플로 (${e.flowId.slice(0, 8)})`}
                  </span>
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                    <span style={metaMono}>{TRIGGER_LABEL[e.trigger] ?? e.trigger}</span>
                    {el && <span style={metaMono}>{el}</span>}
                    <span style={{ ...metaMono, minWidth: 56, textAlign: 'right' }}>{relTime(e.startedAt)}</span>
                    <button onClick={(ev) => { ev.stopPropagation(); reRun.mutate(e.id) }} disabled={reRun.isPending} title="같은 조건(원본 버전+입력)으로 다시 실행" style={{ ...metaMono, color: 'var(--fl-ok)', background: 'transparent', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', padding: '3px 9px', cursor: 'pointer', fontWeight: 600 }}>↻ 재실행</button>
                    <Link to={`/flows/${e.flowId}`} onClick={(ev) => ev.stopPropagation()} title="에디터 열기" style={{ ...metaMono, color: 'var(--fl-primary)', textDecoration: 'none', fontWeight: 600 }}>편집 →</Link>
                  </div>
                </div>
              )
            })}
          </div>
          {data && all.length >= limit && limit < 200 && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button onClick={() => setLimit((l) => Math.min(l + 50, 200))} style={ghostBtn}>더 보기 ({all.length}건)</button>
            </div>
          )}
        </div>
      </div>
      {openExec && <ExecutionDetailModal execId={openExec} onClose={() => setOpenExec(null)} />}
    </AppShellTier1>
  )
}

// 노드 결과 시그니처(응답+출력) — 이전 실행과 비교용
function nodeSig(nd: { responseText?: string | null; output?: unknown }): string {
  return `${nd.responseText ?? ''}::${nd.output == null ? '' : JSON.stringify(nd.output)}`
}

// 과거 실행 상세 — 노드별 요청/응답/출력 재열람(에디터 안 열고) + 이전 실행과 비교(응답 diff)
function ExecutionDetailModal({ execId, onClose }: { execId: string; onClose: () => void }) {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['execution', execId], queryFn: () => runsApi.get(execId) })
  const [openNode, setOpenNode] = useState<string | null>(null)
  const [compare, setCompare] = useState(false)
  useEscapeClose(onClose)

  // 같은 플로우의 '이 실행 직전' 실행을 찾아 그 상세를 가져온다(비교 켤 때만).
  const flowRuns = useQuery({
    queryKey: ['exec-flow-runs', data?.flowId],
    queryFn: () => runsApi.list({ flowId: data!.flowId, limit: 30 }),
    enabled: compare && !!data?.flowId,
  })
  const prevId = flowRuns.data?.find((r) => r.id !== execId && (!data?.startedAt || (r.startedAt && r.startedAt < data.startedAt)))?.id
  const prev = useQuery({ queryKey: ['execution', prevId], queryFn: () => runsApi.get(prevId as string), enabled: !!prevId })
  const prevByNode = new Map((prev.data?.nodes ?? []).map((n) => [n.nodeId, n]))
  return (
    <div role="dialog" aria-modal="true" aria-label="실행 상세" onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 720, maxWidth: '100%', maxHeight: '85vh', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 15 }}>실행 상세</strong>
          {data && <StatusBadge status={data.status} />}
          {data?.error && <span style={{ fontSize: 12, color: 'var(--fl-fail)' }}>{data.error}</span>}
          <button
            onClick={() => setCompare((v) => !v)}
            title="같은 플로우의 직전 실행과 응답을 비교합니다"
            style={{ marginLeft: 'auto', fontSize: 12, padding: '5px 11px', borderRadius: 'var(--fl-radius-pill)', cursor: 'pointer', border: '1px solid var(--fl-border)', background: compare ? 'var(--fl-primary)' : 'transparent', color: compare ? '#fff' : 'var(--fl-text-muted)', fontWeight: 600 }}
          >⇄ 이전 실행과 비교</button>
          <button onClick={onClose} aria-label="닫기" style={{ border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {isLoading && <div style={{ padding: 20, color: 'var(--fl-text-muted)', fontSize: 13 }}>불러오는 중…</div>}
          {isError && (
            <div style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: 'var(--fl-fail)' }}>실행 상세를 불러오지 못했습니다.</span>
              <button onClick={() => refetch()} style={{ ...ghostBtn, padding: '6px 12px' }}>다시 시도</button>
            </div>
          )}
          {compare && (
            <div style={{ padding: '8px 14px', fontSize: 11.5, color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', borderBottom: '1px solid var(--fl-border)' }}>
              {prev.data ? <>직전 실행({relTime(prev.data.startedAt ?? '')})과 응답 비교 — 노드별 <b style={{ color: 'var(--fl-put)' }}>변경</b>/동일 표시</>
                : flowRuns.isLoading || prev.isLoading ? '이전 실행을 찾는 중…'
                : '비교할 이전 실행이 없습니다.'}
            </div>
          )}
          {data?.nodes.map((nd) => {
            const open = openNode === nd.id
            const p = prevByNode.get(nd.nodeId)
            const changed = compare && !!p && nodeSig(p) !== nodeSig(nd)
            const isNew = compare && prev.data != null && !p
            return (
              <div key={nd.id} style={{ borderBottom: '1px solid var(--fl-border)' }}>
                <button onClick={() => setOpenNode(open ? null : nd.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: nd.status === 'FAILED' ? 'var(--fl-fail)' : nd.status === 'SKIPPED' ? 'var(--fl-text-muted)' : 'var(--fl-ok)' }}>{nd.status === 'FAILED' ? '✕' : nd.status === 'SKIPPED' ? '⊘' : '✓'}</span>
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{nd.nodeName || nd.nodeId}</span>
                  {changed && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--fl-put)', border: '1px solid var(--fl-put)', borderRadius: 8, padding: '0 6px' }}>변경</span>}
                  {compare && !changed && p && <span style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>동일</span>}
                  {isNew && <span style={{ fontSize: 10.5, color: 'var(--fl-ok)' }}>신규</span>}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
                    {nd.httpStatus != null && <span style={metaMono}>{nd.httpStatus}</span>}
                    {nd.durationMs != null && <span style={metaMono}>{duration(nd.durationMs)}</span>}
                  </div>
                </button>
                {open && (
                  <div style={{ padding: '0 14px 12px', display: 'grid', gap: 8 }}>
                    <LogBlock title="요청" text={nd.requestText} />
                    <LogBlock title="응답" text={nd.responseText} />
                    {nd.output != null && <LogBlock title="출력" text={JSON.stringify(nd.output, null, 2)} />}
                    {!nd.requestText && !nd.responseText && nd.output == null && <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>기록된 상세가 없습니다.</span>}
                    {changed && p && (
                      <div>
                        <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', margin: '2px 0 4px' }}>◀ 이전 실행</div>
                        <LogBlock title="이전 응답" text={p.responseText} />
                        {p.output != null && <LogBlock title="이전 출력" text={JSON.stringify(p.output, null, 2)} />}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const rowCard: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', boxShadow: 'var(--fl-shadow)' }
const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const ghostBtn: CSSProperties = { border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '8px 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: 48, textAlign: 'center', color: 'var(--fl-text-muted)' }
const errorBox: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, border: '1px solid var(--fl-fail)', borderRadius: 12, padding: 18, color: 'var(--fl-text)' }
const codeChip: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface-2)', padding: '1px 6px', borderRadius: 5 }
