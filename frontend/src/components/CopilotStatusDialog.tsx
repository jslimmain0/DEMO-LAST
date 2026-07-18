import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import { assistantApi } from '../api/client'
import type { CopilotModel, CopilotQuota } from '../api/types'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * GitHub Copilot 상태 다이얼로그 — VS Code 확장 수준의 종합 화면.
 * 연결 계정·요금제·쿼터 사용량(프리미엄 요청 등) + 모델 선택(벤더/컨텍스트/비전) + 연결 해제를 한 곳에서 본다.
 */
export function CopilotStatusDialog({ onClose, canEdit }: { onClose: () => void; canEdit: boolean }) {
  const qc = useQueryClient()
  const infoQ = useQuery({ queryKey: ['assistant', 'oauth', 'info'], queryFn: assistantApi.info, refetchOnWindowFocus: true })
  const modelsQ = useQuery({ queryKey: ['assistant', 'oauth', 'models'], queryFn: assistantApi.models, staleTime: 5 * 60_000 })
  const [q, setQ] = useState('')

  const setModel = useMutation({
    mutationFn: (m: string) => assistantApi.setModel(m),
    onSuccess: (_d, m) => {
      qc.setQueryData(['assistant', 'oauth', 'models'], (prev: typeof modelsQ.data) => (prev ? { ...prev, current: m } : prev))
      qc.invalidateQueries({ queryKey: ['assistant', 'config'] })
      qc.invalidateQueries({ queryKey: ['assistant', 'oauth', 'info'] })
    },
    onError: (e: unknown) => toast((e as { response?: { data?: { message?: string } } })?.response?.data?.message || '모델 변경 실패', 'error'),
  })
  const disconnect = useMutation({
    mutationFn: assistantApi.oauthDisconnect,
    onSuccess: () => { toast('Copilot 연결을 해제했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['assistant'] }); onClose() },
    onError: (e: unknown) => toast((e as { response?: { data?: { message?: string } } })?.response?.data?.message || '연결 해제 실패', 'error'),
  })

  const info = infoQ.data
  const current = modelsQ.data?.current ?? info?.currentModel ?? ''
  const [showAll, setShowAll] = useState(false)
  const searching = q.trim().length > 0
  // 권장 모델만 기본 노출. 검색 중이거나 '더보기'를 켜면 레거시/스냅샷도. 현재 선택 모델은 항상 보이게.
  const shown = (m: CopilotModel) => searching || showAll || m.recommended !== false || m.id === current
  const filtered = useMemo(() => {
    const ms = modelsQ.data?.models ?? []
    const k = q.trim().toLowerCase()
    const f = k ? ms.filter((m) => m.id.toLowerCase().includes(k) || (m.vendor || '').toLowerCase().includes(k) || m.name.toLowerCase().includes(k)) : ms
    return { base: f.filter((m) => !m.premium), prem: f.filter((m) => m.premium), all: f }
  }, [modelsQ.data, q])
  const hiddenCount = filtered.all.filter((m) => m.recommended === false && m.id !== current).length
  // 프리미엄 요청 쿼터 소진 여부 — 프리미엄 모델 선택 시 경고에 사용
  const premQuota = info?.quotas?.find((x) => x.id === 'premium_interactions')
  const premiumExhausted = !!premQuota && !premQuota.unlimited && premQuota.remaining <= 0

  return (
    <Modal onClose={onClose} ariaLabel="GitHub Copilot 상태" width={560} card={{ padding: 0 }}>
      {/* 헤더 — 계정 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--fl-border)' }}>
        {info?.avatarUrl
          ? <img src={info.avatarUrl} alt="" width={40} height={40} style={{ borderRadius: '50%', border: '1px solid var(--fl-border)' }} />
          : <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--fl-surface-2)', display: 'grid', placeItems: 'center', fontSize: 18 }}>🐙</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ fontSize: 15 }}>{info?.login ?? (infoQ.isLoading ? '불러오는 중…' : 'GitHub Copilot')}</b>
            {info?.plan && <span style={planBadge}>{planLabel(info.plan)}</span>}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 2 }}>
            GitHub Copilot 연결됨{info?.agentEnabled ? ' · 에이전트' : ''}{info?.chatEnabled ? ' · 채팅' : ''}
          </div>
        </div>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </div>

      <div style={{ overflow: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* 사용량 */}
        <section>
          <h4 style={h4}>사용량{info?.quotaResetDate ? <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)', fontSize: 11 }}> · {info.quotaResetDate} 초기화</span> : null}</h4>
          {infoQ.isLoading && <div style={{ color: 'var(--fl-text-muted)', fontSize: 12 }}>불러오는 중…</div>}
          {info?.error && <div style={{ color: 'var(--fl-fail)', fontSize: 12 }}>{info.error}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(info?.quotas ?? []).map((qt) => <QuotaBar key={qt.id} q={qt} />)}
          </div>
          {(info?.quotas?.length ?? 0) > 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              ※ ‘무제한’은 <b>포함(무료) 모델</b>(gpt-4.1·gpt-4o) 기준입니다. <b>프리미엄 모델</b>(Claude·GPT-5 등)은 채팅·자동완성과 무관하게 매 요청이 위 <b>프리미엄 요청</b> 쿼터에서 차감됩니다.
            </div>
          )}
          {premiumExhausted && (
            <div style={noteBox}>
              ⚠ <b>프리미엄 요청 쿼터를 다 썼습니다.</b> Claude Sonnet·GPT-5 등 프리미엄 모델은 다음 초기화({info?.quotaResetDate}) 전까지 429가 납니다.
              아래 <b>포함(무료)</b> 모델(gpt-4.1 등)을 쓰세요.
            </div>
          )}
        </section>

        {/* 모델 선택 */}
        <section>
          <h4 style={h4}>모델 <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)', fontSize: 11 }}>· 현재 <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{current}</code></span></h4>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="모델 검색(이름·벤더)…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', marginBottom: 8, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }}
          />
          {modelsQ.isLoading && <div style={{ color: 'var(--fl-text-muted)', fontSize: 12 }}>모델 목록 불러오는 중…</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflow: 'auto' }}>
            {filtered.base.some(shown) && <div style={groupLbl}>포함(무료) — 프리미엄 쿼터 불필요</div>}
            {filtered.base.filter(shown).map((m) => <ModelRow key={m.id} m={m} current={current} disabled={!canEdit || setModel.isPending} onPick={() => setModel.mutate(m.id)} />)}
            {filtered.prem.some(shown) && <div style={groupLbl}>프리미엄 — 프리미엄 요청 쿼터 필요{premiumExhausted ? ' (현재 소진)' : ''}</div>}
            {filtered.prem.filter(shown).map((m) => <ModelRow key={m.id} m={m} current={current} disabled={!canEdit || setModel.isPending} exhausted={premiumExhausted} onPick={() => setModel.mutate(m.id)} />)}
            {!searching && hiddenCount > 0 && (
              <button onClick={() => setShowAll((v) => !v)} style={moreBtn}>
                {showAll ? '간단히 보기' : `더보기 · 이전/스냅샷 모델 ${hiddenCount}개`}
              </button>
            )}
          </div>
        </section>
      </div>

      {/* 푸터 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--fl-border)' }}>
        <span style={{ flex: 1, fontSize: 11, color: 'var(--fl-text-muted)' }}>{info?.sku ? `SKU: ${info.sku}` : ''}</span>
        <button onClick={() => disconnect.mutate()} disabled={!canEdit || disconnect.isPending} style={disconnectBtn}>연결 해제</button>
      </div>
    </Modal>
  )
}

function QuotaBar({ q }: { q: CopilotQuota }) {
  if (q.unlimited) {
    return (
      <div>
        <div style={quotaHead}><span>{q.label}</span><span style={{ color: 'var(--fl-ok)', fontWeight: 700 }}>무제한</span></div>
        <div style={{ ...track, background: 'var(--fl-surface-2)' }}><div style={{ ...fill, width: '100%', background: 'var(--fl-ok)', opacity: 0.35 }} /></div>
      </div>
    )
  }
  const usedFrac = q.entitlement > 0 ? Math.min(1, q.used / q.entitlement) : (q.remaining <= 0 ? 1 : 0)
  const over = q.remaining < 0
  const color = usedFrac >= 1 ? 'var(--fl-fail)' : usedFrac >= 0.8 ? '#d08700' : 'var(--fl-primary)'
  return (
    <div>
      <div style={quotaHead}>
        <span>{q.label}</span>
        <span style={{ fontFamily: 'var(--fl-font-mono)', color: over ? 'var(--fl-fail)' : 'var(--fl-text)' }}>
          {fmt(q.used)} / {fmt(q.entitlement)}{over ? ` (초과 ${fmt(-q.remaining)})` : ''}
        </span>
      </div>
      <div style={track}><div style={{ ...fill, width: `${usedFrac * 100}%`, background: color }} /></div>
      <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', marginTop: 2 }}>{Math.max(0, Math.round(q.percentRemaining))}% 남음</div>
    </div>
  )
}

function ModelRow({ m, current, disabled, exhausted, onPick }: { m: CopilotModel; current: string; disabled: boolean; exhausted?: boolean; onPick: () => void }) {
  const sel = m.id === current
  return (
    <button
      onClick={onPick}
      disabled={disabled || sel}
      title={m.premium && exhausted ? '프리미엄 요청 쿼터 소진 — 선택 시 429가 납니다' : `${m.vendor || ''}${m.contextTokens ? ` · 컨텍스트 ${Math.round(m.contextTokens / 1000)}K` : ''}`}
      style={{ ...modelRow, ...(sel ? modelRowSel : {}), cursor: disabled && !sel ? 'default' : sel ? 'default' : 'pointer' }}
    >
      <span style={{ width: 14, flexShrink: 0, color: 'var(--fl-primary)', fontWeight: 700 }}>{sel ? '✓' : ''}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 600 }}>{m.name}</span>
        <span style={{ color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>  {m.id}</span>
      </span>
      {m.vision && <span title="이미지 입력 지원" style={tag}>👁</span>}
      {m.contextTokens ? <span style={tag}>{Math.round(m.contextTokens / 1000)}K</span> : null}
      {m.premium
        ? <span style={{ ...tag, color: exhausted ? 'var(--fl-fail)' : '#d08700', borderColor: exhausted ? 'var(--fl-fail)' : '#d08700' }}>⭐ 프리미엄</span>
        : <span style={{ ...tag, color: 'var(--fl-ok)', borderColor: 'var(--fl-ok)' }}>포함</span>}
    </button>
  )
}

function fmt(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(0) }
function planLabel(plan: string): string {
  const p = plan.toLowerCase()
  if (p === 'individual') return 'Copilot Pro'
  if (p === 'business') return 'Copilot Business'
  if (p === 'enterprise') return 'Copilot Enterprise'
  return plan
}

const h4: CSSProperties = { margin: '0 0 8px', fontSize: 12.5, fontWeight: 700 }
const quotaHead: CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }
const track: CSSProperties = { height: 7, borderRadius: 999, background: 'var(--fl-surface-2)', overflow: 'hidden' }
const fill: CSSProperties = { height: '100%', borderRadius: 999, transition: 'width .3s' }
const groupLbl: CSSProperties = { fontSize: 10.5, fontWeight: 700, color: 'var(--fl-text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '8px 0 2px' }
const modelRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '7px 9px', border: '1px solid transparent', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', fontSize: 12.5 }
const modelRowSel: CSSProperties = { background: 'rgba(97,85,245,.10)', border: '1px solid var(--fl-primary)' }
const moreBtn: CSSProperties = { alignSelf: 'flex-start', marginTop: 4, padding: '5px 10px', border: '1px dashed var(--fl-border)', borderRadius: 999, background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 11.5 }
const tag: CSSProperties = { flexShrink: 0, fontSize: 9.5, fontWeight: 700, padding: '1px 5px', borderRadius: 999, border: '1px solid var(--fl-border)', color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const planBadge: CSSProperties = { fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(97,85,245,.12)', color: 'var(--fl-primary)', border: '1px solid var(--fl-primary)' }
const noteBox: CSSProperties = { marginTop: 10, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.5, borderRadius: 'var(--fl-radius-sm)', background: 'rgba(217,48,37,.08)', border: '1px solid rgba(217,48,37,.3)', color: 'var(--fl-text)' }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 7, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16, flexShrink: 0 }
const disconnectBtn: CSSProperties = { padding: '6px 12px', border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }
