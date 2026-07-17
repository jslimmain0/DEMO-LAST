import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { triggersApi } from '../api/client'
import type { TriggerView } from '../api/types'
import { toast } from './toast'
import { useEscapeClose } from './useEscapeClose'

/**
 * 자동 실행 트리거 — 스케줄(cron) / 인바운드 웹훅. 야간 회귀·외부 이벤트 실행용.
 * 실행은 P2 비동기 워커 풀이 구동하므로 브라우저 없이 완결된다.
 */
const CRON_PRESETS: Array<[string, string]> = [
  ['0 0 * * * *', '매시 정각'],
  ['0 0 3 * * *', '매일 03:00'],
  ['0 */10 * * * *', '10분마다'],
  ['0 0 9 * * MON-FRI', '평일 09:00'],
  ['0 0 0 * * *', '매일 자정'],
]

export function TriggersDialog({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const qc = useQueryClient()
  useEscapeClose(onClose)
  const q = useQuery({ queryKey: ['triggers', flowId], queryFn: () => triggersApi.list(flowId) })
  const [cron, setCron] = useState('0 0 3 * * *')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['triggers', flowId] })
  const addSchedule = useMutation({
    mutationFn: () => triggersApi.create(flowId, { type: 'SCHEDULE', cron }),
    onSuccess: () => { toast('스케줄 트리거를 만들었습니다.', 'ok'); invalidate() },
    onError: (e: unknown) => toast(errMsg(e, '스케줄 생성 실패 — cron 식을 확인하세요.'), 'error'),
  })
  const addWebhook = useMutation({
    mutationFn: () => triggersApi.create(flowId, { type: 'WEBHOOK' }),
    onSuccess: () => { toast('웹훅 트리거를 만들었습니다.', 'ok'); invalidate() },
    onError: () => toast('웹훅 생성 실패', 'error'),
  })
  const toggle = useMutation({
    mutationFn: (t: TriggerView) => triggersApi.update(flowId, t.id, { enabled: !t.enabled }),
    onSuccess: invalidate,
  })
  const del = useMutation({
    mutationFn: (id: string) => triggersApi.remove(flowId, id),
    onSuccess: () => { toast('트리거를 삭제했습니다.', 'ok'); invalidate() },
  })

  const list = q.data ?? []
  const origin = window.location.origin

  return (
    <div role="dialog" aria-modal="true" aria-label="트리거" style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
          <span aria-hidden>⏰</span>
          <strong style={{ flex: 1, fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>자동 실행 트리거</strong>
          <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
        </header>

        <div style={{ padding: 18, overflowY: 'auto' }}>
          <p style={hint}>스케줄(cron) 또는 웹훅으로 워크플로를 자동 실행합니다. 실행은 서버가 구동하므로 브라우저를 켜 둘 필요가 없습니다.</p>

          {/* 기존 트리거 */}
          {q.isLoading && <p style={hint}>불러오는 중…</p>}
          {list.length === 0 && !q.isLoading && <p style={{ ...hint, color: 'var(--fl-text-muted)' }}>아직 트리거가 없습니다.</p>}
          <div style={{ display: 'grid', gap: 8, margin: '10px 0' }}>
            {list.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: t.type === 'SCHEDULE' ? 'var(--fl-primary)' : 'var(--fl-put)' }}>{t.type === 'SCHEDULE' ? '⏱ 스케줄' : '🪝 웹훅'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {t.type === 'SCHEDULE' ? (
                    <>
                      <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12 }}>{t.cron}</code>
                      <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', marginTop: 2 }}>다음 실행: {t.nextRunAt ? fmt(t.nextRunAt) : '—'}{t.lastRunAt ? ` · 최근 ${fmt(t.lastRunAt)}` : ''}</div>
                    </>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{origin}/hooks/{t.webhookToken}</code>
                      <button onClick={() => copy(`${origin}/hooks/${t.webhookToken}`)} title="웹훅 URL 복사" style={miniBtn}>복사</button>
                    </div>
                  )}
                </div>
                <button onClick={() => toggle.mutate(t)} title={t.enabled ? '비활성화' : '활성화'} style={{ ...miniBtn, color: t.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)', borderColor: t.enabled ? 'var(--fl-ok)' : 'var(--fl-border)' }}>{t.enabled ? '켜짐' : '꺼짐'}</button>
                <button onClick={() => del.mutate(t.id)} aria-label="삭제" style={miniBtn}>×</button>
              </div>
            ))}
          </div>

          {/* 추가 */}
          <div style={{ borderTop: '1px solid var(--fl-border)', paddingTop: 14, marginTop: 6 }}>
            <label style={label}>스케줄 추가 (cron: 초 분 시 일 월 요일)</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={cron} onChange={(e) => setCron(e.target.value)} style={mono} placeholder="0 0 3 * * *" />
              <button onClick={() => addSchedule.mutate()} disabled={addSchedule.isPending} style={primary}>+ 스케줄</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
              {CRON_PRESETS.map(([c, lbl]) => (
                <button key={c} onClick={() => setCron(c)} title={c} style={chip}>{lbl}</button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={() => addWebhook.mutate()} disabled={addWebhook.isPending} style={ghost}>🪝 웹훅 URL 발급</button>
            </div>
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
function copy(s: string) { void navigator.clipboard?.writeText(s).then(() => toast('복사했습니다.', 'ok')).catch(() => {}) }
function fmt(iso: string): string {
  try { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` } catch { return iso }
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 620, maxWidth: '96vw', maxHeight: '88vh', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', lineHeight: 1.6, margin: 0 }
const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '0 0 5px' }
const mono: CSSProperties = { flex: 1, padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, fontFamily: 'var(--fl-font-mono)' }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const primary: CSSProperties = { padding: '8px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }
const ghost: CSSProperties = { padding: '8px 14px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 13 }
const chip: CSSProperties = { padding: '4px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 11.5 }
const miniBtn: CSSProperties = { padding: '4px 8px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 11.5, flexShrink: 0 }
