import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { assistantApi } from '../api/client'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * AI 어시스턴트 대화 세션 목록 — 이어하기/새 대화/삭제. 사용자별로 저장된 세션을 최근순으로 보여준다.
 */
export function SessionsDialog({ currentId, onClose, onLoad, onNew }: {
  currentId: string | null
  onClose: () => void
  onLoad: (id: string) => void
  onNew: () => void
}) {
  const qc = useQueryClient()
  const listQ = useQuery({ queryKey: ['assistant', 'sessions'], queryFn: assistantApi.sessions })
  const del = useMutation({
    mutationFn: assistantApi.deleteSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assistant', 'sessions'] }),
    onError: () => toast('세션 삭제 실패', 'error'),
  })
  const sessions = listQ.data ?? []

  return (
    <Modal onClose={onClose} ariaLabel="대화 세션" width={440} card={{ padding: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
        <b style={{ flex: 1, fontSize: 14 }}>🕘 대화 기록</b>
        <button onClick={() => { onNew(); onClose() }} style={newBtn}>＋ 새 대화</button>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </div>
      <div style={{ maxHeight: '60vh', overflow: 'auto', padding: 8 }}>
        {listQ.isLoading && <div style={empty}>불러오는 중…</div>}
        {!listQ.isLoading && sessions.length === 0 && <div style={empty}>저장된 대화가 없습니다. 대화를 시작하면 자동 저장됩니다.</div>}
        {sessions.map((s) => (
          <div key={s.id} style={{ ...row, ...(s.id === currentId ? rowSel : {}) }}>
            <button onClick={() => { onLoad(s.id); onClose() }} style={rowMain} title={s.title}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.id === currentId ? '● ' : ''}{s.title || '(제목 없음)'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 2 }}>
                {rel(s.updatedAt)} · 메시지 {s.messageCount}개
              </div>
            </button>
            <button onClick={() => del.mutate(s.id)} disabled={del.isPending} aria-label="삭제" title="삭제" style={delBtn}>×</button>
          </div>
        ))}
      </div>
    </Modal>
  )
}

function rel(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  if (s < 604800) return `${Math.floor(s / 86400)}일 전`
  return new Date(iso).toLocaleDateString('ko-KR')
}

const empty: CSSProperties = { padding: 24, textAlign: 'center', color: 'var(--fl-text-muted)', fontSize: 12.5, lineHeight: 1.6 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, borderRadius: 'var(--fl-radius-sm)' }
const rowSel: CSSProperties = { background: 'rgba(97,85,245,.08)' }
const rowMain: CSSProperties = { flex: 1, minWidth: 0, textAlign: 'left', padding: '9px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 13 }
const delBtn: CSSProperties = { flexShrink: 0, width: 28, height: 28, marginRight: 4, borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }
const newBtn: CSSProperties = { padding: '5px 10px', borderRadius: 999, border: '1px solid var(--fl-primary)', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 7, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }
