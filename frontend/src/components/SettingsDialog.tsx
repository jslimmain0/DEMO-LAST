import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { settingsApi } from '../api/client'
import { useEscapeClose } from './useEscapeClose'

/**
 * 설정 다이얼로그 — 콜백 수신 주소(relay base).
 * 기본은 접속한 주소(오리진) 자동. 다른 주소로 콜백을 받아야 할 때만 저장(오버라이드)한다.
 * 저장 값은 서버 DB 에 보관 — 재시작해도 유지되고 env 없이 화면에서 관리한다.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['settings', 'relay'], queryFn: settingsApi.relay })
  const [draft, setDraft] = useState<string | null>(null) // null = 아직 미편집(서버 값 표시)
  const save = useMutation({
    mutationFn: (value: string | null) => settingsApi.saveRelay(value),
    onSuccess: (data) => {
      qc.setQueryData(['settings', 'relay'], data)
      setDraft(null)
    },
  })
  // 실행 실패 알림 웹훅
  const notifyQ = useQuery({ queryKey: ['settings', 'notify'], queryFn: settingsApi.notify })
  const [notifyDraft, setNotifyDraft] = useState<string | null>(null)
  const saveNotify = useMutation({
    mutationFn: (value: string | null) => settingsApi.saveNotify(value),
    onSuccess: (data) => { qc.setQueryData(['settings', 'notify'], data); setNotifyDraft(null) },
  })
  useEscapeClose(onClose)
  useEffect(() => setDraft(null), [q.data?.value])
  useEffect(() => setNotifyDraft(null), [notifyQ.data?.value])
  const notifyValue = notifyDraft ?? notifyQ.data?.value ?? ''
  const notifyDirty = notifyDraft != null && notifyDraft !== (notifyQ.data?.value ?? '')

  const value = draft ?? q.data?.value ?? ''
  const dirty = draft != null && draft !== (q.data?.value ?? '')

  return (
    <div style={overlay} onClick={onClose}>
      <div role="dialog" aria-label="설정" style={card} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span aria-hidden style={{ fontSize: 15 }}>⚙</span>
          <b style={{ flex: 1, fontSize: 15 }}>설정</b>
          <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
        </header>

        <label style={label}>콜백 수신 주소 (wait 노드가 콜백을 받는 서버 주소)</label>
        <input
          aria-label="콜백 수신 주소"
          style={mono}
          value={value}
          placeholder={q.data?.auto ? `${q.data.auto} (자동 — 접속한 주소)` : '비워두면 접속한 주소 자동'}
          onChange={(e) => setDraft(e.target.value)}
        />
        <p style={hint}>
          비워두면 <b>지금 접속한 주소</b>를 자동으로 사용합니다
          {q.data?.auto ? <> (현재: <code style={code}>{q.data.auto}</code>)</> : null}.
          외부 시스템이 다른 주소(터널/도메인)로 콜백해야 할 때만 입력하세요.
        </p>
        <p style={hint}>
          지금 적용되는 값: <code style={code}>{q.data?.effective ?? '…'}</code>
          {' '}→ 수신 URL 은 <code style={code}>{'{이 값}/relay/{실행ID}/cb/{노드ID}'}</code>
        </p>

        <label style={{ ...label, marginTop: 18 }}>실행 실패 알림 웹훅 (Slack/Teams incoming webhook)</label>
        <input
          aria-label="실패 알림 웹훅 URL"
          style={mono}
          value={notifyValue}
          placeholder="https://hooks.slack.com/services/…  (비우면 알림 끔)"
          onChange={(e) => setNotifyDraft(e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <p style={{ ...hint, margin: 0, flex: 1 }}>실행이 <b>실패</b>하면 이 URL 로 <code style={code}>{'{text}'}</code> JSON 을 발송합니다(무인 스케줄/웹훅 실행에 특히 유용).</p>
          <button style={primaryBtn} disabled={!notifyDirty || saveNotify.isPending} onClick={() => saveNotify.mutate(notifyValue.trim() || null)}>알림 저장</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          {(q.data?.value || dirty) && (
            <button
              style={ghostBtn}
              disabled={save.isPending}
              onClick={() => save.mutate(null)}
              title="저장된 값을 지우고 접속한 주소 자동으로 되돌립니다"
            >
              자동으로 되돌리기
            </button>
          )}
          <button
            style={primaryBtn}
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate(value.trim() || null)}
          >
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 520, maxWidth: '100%', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', boxShadow: 'var(--fl-shadow-lg)', padding: 18 }
const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '10px 0 5px' }
const mono: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, fontFamily: 'var(--fl-font-mono)' }
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8, lineHeight: 1.6 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const primaryBtn: CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const ghostBtn: CSSProperties = { padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }
