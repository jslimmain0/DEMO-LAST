import { PageHeader } from '../components/PageHeader'
import { AppIcon } from '../components/AppIcon'
import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ExecutionStatus, ExecutionSummary } from '../api/types'


import { AppShellTier1 } from '../app/AppShell'
import { LogBlock } from '../components/NodeExecutionLog'
import { StatusBadge } from '../components/StatusBadge'
import { toast } from '../components/toast'
import { Modal } from '../components/Modal'
import { AgentBadge } from '../components/AgentSettings'
import { duration, relTime } from '../lib/format'
import { apiErrorMessage } from '../lib/apiError'

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
  const { runsApi } = useApi()

  const scope = useWorkspace()
  const runtime = { kind: scope.current.origin }
  const wsId = scope.current.id
  const workspaces = { data: scope.workspaces }
  const setWsId = scope.select
  const qc = useQueryClient()
  const [limit, setLimit] = useState(50)
  const [filter, setFilter] = useState<'all' | ExecutionStatus>('all')
  const [range, setRange] = useState<string>('all')
  const [q, setQ] = useState('')
  const [openExec, setOpenExec] = useState<string | null>(null)

  const rangeMs = RANGES.find(([k]) => k === range)?.[2] ?? null
  // 서버측 status/기간/워크스페이스 필터 + limit. from 은 쿼리 실행 시점 기준(키에는 range 코드만 넣어 매 렌더 재요청 방지).
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['executions', 'list', limit, filter, range, wsId],
    queryFn: () => runsApi.list({
      limit,
      status: filter === 'all' ? undefined : filter,
      from: rangeMs != null ? Date.now() - rangeMs : undefined,
      workspaceId: wsId,
    }),
  })
  const all = data ?? []
  const reRun = useMutation({
    mutationFn: (execId: string) => runsApi.rerun(execId),
    onSuccess: () => { toast('같은 조건으로 재실행을 시작했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['executions', 'list'] }) },
    onError: () => toast('재실행에 실패했습니다.', 'error'),
  })
  const query = q.trim().toLowerCase()
  // status/기간은 서버가 필터 → 여기선 이름 검색만(서버는 flowId 로만 필터하므로 이름은 클라 측)
  const rows = all.filter((e) => !query || (e.flowName ?? '').toLowerCase().includes(query))
  const okCount = rows.filter((e) => e.status === 'SUCCEEDED').length
  const failCount = rows.filter((e) => e.status === 'FAILED').length
  const hasFilters = filter !== 'all' || range !== 'all' || !!query
  const initialEmpty = !hasFilters && all.length === 0

  return (
    <AppShellTier1>
      <div className="fl-page fl-execution-catalog">
        <div className="fl-execution-heading" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <PageHeader title="실행 이력" />
          {rows.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 4 }}>
              <span style={metaText}>{rows.length}건</span>
              {okCount > 0 && <span style={{ ...metaText, color: 'var(--fl-ok)' }} aria-label={`성공 ${okCount}건`}><AppIcon name="check" size={13} /> {okCount}</span>}
              {failCount > 0 && <span style={{ ...metaText, color: 'var(--fl-fail)' }} aria-label={`실패 ${failCount}건`}><AppIcon name="close" size={13} /> {failCount}</span>}
            </div>
          )}
          {/* 워크스페이스 스코프 — 이력이 워크스페이스별로 분리. 대시보드 선택과 동기화 */}
          <select
            aria-label="워크스페이스"
            value={wsId}
            onChange={(e) => setWsId(e.target.value)}
            style={{ marginLeft: 'auto', maxWidth: '100%', padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }}
          >
            {(workspaces.data ?? [{ id: wsId, name: runtime?.kind === 'local' ? '개인 · 내 PC' : '공용', kind: runtime?.kind === 'local' ? 'PERSONAL' : 'PUBLIC' } as const]).map((w) => (
              <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '개인' : w.kind === 'TEAM' ? '팀' : '공용'} · {w.name}</option>
            ))}
          </select>
        </div>

        {!isLoading && !isError && (all.length > 0 || filter !== 'all' || range !== 'all' || q) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <input aria-label="워크플로 이름 검색" value={q} onChange={(e) => setQ(e.target.value)} placeholder="워크플로 이름 검색…"
              onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }}
              style={{ padding: '7px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13, width: 220, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' }} />
            <div role="group" aria-label="실행 상태" style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {([['all', '전체'], ['SUCCEEDED', '성공'], ['FAILED', '실패'], ['WAITING', '대기'], ['CANCELLED', '취소']] as const).map(([k, lbl]) => (
                <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)} style={{ padding: '5px 11px', fontSize: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', cursor: 'pointer', background: filter === k ? 'var(--fl-action-primary-bg)' : 'transparent', color: filter === k ? 'var(--fl-action-primary-ink)' : 'var(--fl-text-muted)', fontWeight: filter === k ? 600 : 500 }}>{lbl}</button>
              ))}
            </div>
            <div role="group" aria-label="실행 기간" style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginLeft: 4 }} title="기간 필터">
              {RANGES.map(([k, lbl]) => (
                <button key={k} aria-pressed={range === k} onClick={() => setRange(k)} style={{ padding: '5px 10px', fontSize: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', cursor: 'pointer', background: range === k ? 'var(--fl-surface-2)' : 'transparent', color: range === k ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontWeight: range === k ? 600 : 400 }}>{lbl}</button>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          {isLoading && <div style={{ display: 'grid', gap: 10 }}>{[0, 1, 2, 3].map((i) => <div key={i} style={{ ...rowCard, borderLeft: '3px solid var(--fl-border)', height: 58, opacity: 0.5 }} />)}</div>}
          {isError && (
            <div style={errorBox}>
              <AppIcon name="alert" size={22} style={{ color: 'var(--fl-fail)' }} />
              <div>
                <div style={{ fontWeight: 600 }}>{scope.current.origin === 'local' ? '개인 PC의' : '서버 공간의'} 실행 이력을 불러오지 못했습니다.</div>
                <div style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', marginTop: 4 }}>{apiErrorMessage(error, '연결 상태와 공간 접근 권한을 확인한 뒤 다시 시도하세요.')}</div>
              </div>
              <button onClick={() => refetch()} style={{ ...ghostBtn, marginLeft: 'auto' }}>다시 시도</button>
            </div>
          )}
          {data && !isLoading && !isError && initialEmpty && (
            <div style={emptyBox}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 16, letterSpacing: '-.02em' }}>아직 실행 이력이 없습니다</div>
              <div style={{ color: 'var(--fl-text-muted)', fontSize: 13, lineHeight: 1.6, marginTop: 6 }}>워크플로를 열어 <b><AppIcon name="play" size={12} /> 실행</b>하면 여기에 기록됩니다.</div>
            </div>
          )}

          {data && !isLoading && !isError && !initialEmpty && rows.length === 0 && (
            <div style={{ ...emptyBox, fontSize: 13 }}>
              <p style={{ margin: '0 0 12px', color: 'var(--fl-text-muted)' }}>이 조건에 해당하는 실행이 없습니다.</p>
              <button style={ghostBtn} onClick={() => { setFilter('all'); setRange('all'); setQ('') }}>필터 해제</button>
            </div>
          )}
          <div style={{ display: 'grid', gap: 10 }}>
            {rows.map((e) => {
              const el = elapsed(e)
              return (
                <div key={e.id} className="fl-flow-card fl-execution-row" onClick={() => setOpenExec(e.id)}
                  style={{ ...rowCard, borderLeft: `3px solid ${statusColor(e.status)}`, cursor: 'pointer' }}
                  title="클릭하면 노드별 결과를 봅니다">
                  <StatusBadge status={e.status} />
                  <button type="button" className="fl-execution-name" aria-label={`${e.flowName ?? '삭제된 워크플로'} 실행 결과 상세 보기`} title={e.flowName ?? '실행 결과 상세 보기'}
                    onClick={(event) => { event.stopPropagation(); setOpenExec(e.id) }}
                    style={{ fontFamily: 'var(--fl-font-ui)', fontWeight: 650, fontSize: 14, letterSpacing: '-.015em', color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer' }}>
                    {e.flowName ?? `삭제된 워크플로 (${e.flowId.slice(0, 8)})`}
                  </button>
                  <div className="fl-execution-meta" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={metaText}>{TRIGGER_LABEL[e.trigger] ?? e.trigger}</span>
                    {el && <span style={metaText}>{el}</span>}
                    <span title={e.startedAt ? new Date(e.startedAt).toLocaleString('ko-KR') : undefined} style={{ ...metaText, minWidth: 56, textAlign: 'right' }}>{relTime(e.startedAt)}</span>
                    <button onClick={(ev) => { ev.stopPropagation(); reRun.mutate(e.id) }} disabled={reRun.isPending} aria-label={`${e.flowName ?? '워크플로'} 같은 조건으로 재실행`} title="같은 조건(원본 버전+입력)으로 다시 실행" style={{ ...metaText, display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--fl-ok)', background: 'transparent', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: '3px 9px', cursor: 'pointer', fontWeight: 600 }}><AppIcon name="refresh" size={13} />재실행</button>
                    <Link to={`/flows/${e.flowId}`} onClick={(ev) => ev.stopPropagation()} title="에디터 열기" style={{ ...metaText, display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--fl-primary)', textDecoration: 'none', fontWeight: 600 }}>편집<AppIcon name="arrowRight" size={13} /></Link>
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
  const { runsApi } = useApi()
  const scope = useWorkspace()

  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['execution', execId], queryFn: () => runsApi.get(execId), refetchInterval: q => ['RUNNING', 'WAITING'].includes(q.state.data?.status ?? '') ? 1000 : false })
  const cancel = useMutation({ mutationFn: () => runsApi.resume(execId, { nodeId: data?.pendingAgent?.nodeId, aborted: true, error: '사용자가 실행을 중단했습니다.' }), onSuccess: () => { void refetch() }, onError: () => toast('중단 요청에 실패했습니다. 연결 상태를 확인하세요.', 'error') })
  const [openNode, setOpenNode] = useState<string | null>(null)
  const [compare, setCompare] = useState(false)

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
    <Modal onClose={onClose} ariaLabel="실행 상세" zIndex={300} width={720} maxWidth="100%" maxHeight="85vh">
        <header style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 15 }}>실행 상세</strong>
          {data && <StatusBadge status={data.status} />}
          {data?.error && <span style={{ fontSize: 12, color: 'var(--fl-fail)', overflowWrap: 'anywhere' }}>{data.error}</span>}
          <button
            onClick={() => setCompare((v) => !v)}
            title="같은 플로우의 직전 실행과 응답을 비교합니다"
            aria-pressed={compare}
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '5px 11px', borderRadius: 'var(--fl-radius-sm)', cursor: 'pointer', border: '1px solid var(--fl-border)', background: compare ? 'var(--fl-action-primary-bg)' : 'transparent', color: compare ? 'var(--fl-action-primary-ink)' : 'var(--fl-text-muted)', fontWeight: 600 }}
          ><AppIcon name="arrows" size={14} />이전 실행과 비교</button>
          <button onClick={onClose} aria-label="닫기" style={{ display: 'inline-flex', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', padding: 4 }}><AppIcon name="close" size={18} /></button>
        </header>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {data?.pendingAgent && <div role="status" style={{ padding: 16, borderBottom: '1px solid var(--fl-border)', fontSize: 12, lineHeight: 1.6, color: data.pendingAgent.status === 'UNKNOWN' ? 'var(--fl-waiting)' : 'var(--fl-text-muted)' }}>
            <AgentBadge agent={data.pendingAgent.agent} /> {data.pendingAgent.nodeName || data.pendingAgent.nodeId} · {data.pendingAgent.status === 'UNKNOWN' ? '결과 확인 필요 — 요청이 처리됐을 수 있어 자동 재실행하지 않습니다.' : '에이전트 작업 대기·처리 중'}
            {data.pendingAgent.error && <p>{data.pendingAgent.error}</p>}
            {scope.current.myRole !== 'VIEWER' && <button onClick={() => cancel.mutate()} disabled={cancel.isPending} style={{ ...ghostBtn, marginLeft: 8 }}>실행 중단</button>}
          </div>}
          {data && ['RUNNING', 'WAITING'].includes(data.status) && <p style={{ padding: '0 16px', fontSize: 12 }}><Link to={`/flows/${data.flowId}?execution=${encodeURIComponent(data.id)}`}>에디터에서 이 실행 이어보기 →</Link></p>}
          {isLoading && <div style={{ padding: 20, color: 'var(--fl-text-muted)', fontSize: 13 }}>불러오는 중…</div>}
          {isError && (
            <div style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: 'var(--fl-fail)' }}>실행 상세를 불러오지 못했습니다.</span>
              <button onClick={() => refetch()} style={{ ...ghostBtn, padding: '6px 12px' }}>다시 시도</button>
            </div>
          )}
          {compare && (
            <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', borderBottom: '1px solid var(--fl-border)' }}>
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
                <button onClick={() => setOpenNode(open ? null : nd.id)} aria-expanded={open} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', textAlign: 'left' }}>
                  <AppIcon name={nd.status === 'FAILED' ? 'close' : nd.status === 'SKIPPED' ? 'arrowRight' : 'check'} size={14} style={{ color: nd.status === 'FAILED' ? 'var(--fl-fail)' : nd.status === 'SKIPPED' ? 'var(--fl-text-muted)' : 'var(--fl-ok)' }} />
                  <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-.015em', minWidth: 0, overflowWrap: 'anywhere', flex: 1 }}>{nd.nodeName || nd.nodeId}</span>
                  {nd.executionAgent && !['set', 'if', 'assert', 'switch'].includes(nd.nodeType ?? '') && <AgentBadge agent={nd.executionAgent} />}
                  {changed && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fl-put)', border: '1px solid var(--fl-put)', borderRadius: 5, padding: '0 6px' }}>변경</span>}
                  {compare && !changed && p && <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>동일</span>}
                  {isNew && <span style={{ fontSize: 12, color: 'var(--fl-ok)' }}>신규</span>}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
                    {nd.httpStatus != null && <span style={metaText}>{nd.httpStatus}</span>}
                    {nd.durationMs != null && <span style={metaText}>{duration(nd.durationMs)}</span>}
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--fl-text-muted)', margin: '2px 0 4px' }}><AppIcon name="arrowLeft" size={12} />이전 실행</div>
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
    </Modal>
  )
}

const rowCard: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', boxShadow: 'var(--fl-shadow)' }
const metaText: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-ui)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const ghostBtn: CSSProperties = { border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '8px 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const emptyBox: CSSProperties = { border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius)', padding: 48, textAlign: 'center', color: 'var(--fl-text-muted)' }
const errorBox: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius)', padding: 18, color: 'var(--fl-text)' }
