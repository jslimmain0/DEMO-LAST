import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { assistantApi } from '../api/client'
import type { AssistantMessage, MockServerSpec } from '../api/types'
import { usePermissions } from '../auth/AuthContext'
import { validateMockSpecShape } from '../lib/mockSpecValidate'
import { toast } from './toast'

interface Turn extends AssistantMessage {
  spec?: MockServerSpec | null
  stub?: boolean
  applied?: boolean
}

/**
 * Mock 서버 AI 어시스턴트 — 자연어로 mock spec(경로·응답·조건·콜백·TCP)을 만들고 고친다.
 * 플로우 어시스턴트와 **Copilot 연결·모델 선택을 공유**(같은 react-query 키)한다. 적용은 부모 onApply(spec)로.
 */
export function MockAssistantPanel({ spec, mockId, onApply, onClose }: {
  spec: MockServerSpec
  mockId: string
  onApply: (spec: MockServerSpec) => void
  onClose: () => void
}) {
  const { canEdit } = usePermissions()
  const qc = useQueryClient()
  const oauthQ = useQuery({ queryKey: ['assistant', 'oauth', 'status'], queryFn: assistantApi.oauthStatus, refetchInterval: false })
  const connected = oauthQ.data?.connected === true
  const modelsQ = useQuery({ queryKey: ['assistant', 'oauth', 'models'], queryFn: assistantApi.models, enabled: connected, staleTime: 5 * 60_000 })
  const model = modelsQ.data?.current ?? ''
  const changeModel = async (m: string) => {
    qc.setQueryData(['assistant', 'oauth', 'models'], (prev: typeof modelsQ.data) => (prev ? { ...prev, current: m } : prev))
    try { await assistantApi.setModel(m) } catch { /* ignore */ }
  }
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null)
  const statusPoll = useQuery({ queryKey: ['assistant', 'oauth', 'status', 'poll'], queryFn: assistantApi.oauthStatus, refetchInterval: device ? 3000 : false, enabled: !!device })
  useEffect(() => {
    if (!device) return
    if (statusPoll.data?.connected) { toast('GitHub Copilot 를 연결했습니다.', 'ok'); setDevice(null); qc.invalidateQueries({ queryKey: ['assistant'] }) }
    else if (statusPoll.data && statusPoll.data.pending === false) { toast('연결이 취소/만료됐습니다.', 'error'); setDevice(null) }
  }, [statusPoll.data, device, qc])
  const connect = async () => {
    try {
      const d = await assistantApi.oauthDeviceStart()
      setDevice({ userCode: d.userCode, verificationUri: d.verificationUri })
      try { await navigator.clipboard?.writeText(d.userCode) } catch { /* ignore */ }
      window.open(d.verificationUri, '_blank', 'noopener')
    } catch (e) { toast((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Copilot 연결 시작 실패', 'error') }
  }

  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [turns, pending])

  const send = async (text: string) => {
    const msg = text.trim()
    if (!msg || pending || !canEdit) return
    setInput('')
    const history: Turn[] = [...turns, { role: 'user', content: msg }]
    setTurns(history)
    setPending(true)
    try {
      const res = await assistantApi.mockChat({
        messages: history.map((t) => ({ role: t.role, content: t.content })),
        spec, mockId,
        model: connected && model ? model : undefined,
      })
      setTurns((prev) => [...prev, { role: 'assistant', content: res.reply, spec: res.spec, stub: res.stub }])
    } catch (e) {
      const detail = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
      setTurns((prev) => [...prev, { role: 'assistant', content: `⚠ 오류: ${detail || (e instanceof Error ? e.message : String(e))}` }])
    } finally { setPending(false) }
  }

  const apply = (idx: number, s: MockServerSpec) => {
    if (!canEdit) return
    const err = validateMockSpecShape(s)
    if (err) { toast(`적용할 수 없는 spec 입니다: ${err}`, 'error'); return }
    onApply(s)
    setTurns((prev) => prev.map((t, i) => (i === idx ? { ...t, applied: true } : t)))
    toast('mock spec 을 적용했습니다. 저장 버튼으로 반영하세요.', 'ok')
  }

  return (
    <aside style={{ position: 'fixed', top: 0, right: 0, height: '100vh', width: 340, zIndex: 60, borderLeft: '1px solid var(--fl-border)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--fl-border)' }}>
        <span aria-hidden>✨</span>
        <b style={{ flex: 1, fontSize: 13.5 }}>Mock AI</b>
        {connected ? (
          <span style={{ ...badge(true), border: '1px solid var(--fl-ok)', color: 'var(--fl-ok)' }}>🔗 Copilot</span>
        ) : device ? (
          <span style={badge(false)}>인증 대기…</span>
        ) : canEdit ? (
          <button onClick={connect} style={connectBtn}>Copilot 연결</button>
        ) : null}
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>

      {connected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)' }}>
          <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>모델</span>
          <select value={model} onChange={(e) => void changeModel(e.target.value)} disabled={!canEdit || !modelsQ.data?.models?.length}
            style={{ flex: 1, minWidth: 0, padding: '4px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontFamily: 'var(--fl-font-mono)' }}>
            {!modelsQ.data?.models?.length && <option value={model}>{model || '불러오는 중…'}</option>}
            {(modelsQ.data?.models ?? []).filter((m) => m.recommended !== false || m.id === model).map((m) => (
              <option key={m.id} value={m.id}>{m.id}{m.premium ? ' · 프리미엄' : ''}</option>
            ))}
          </select>
        </div>
      )}

      {device && (
        <div style={{ margin: 12, padding: 12, border: '1px solid var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', fontSize: 12.5, lineHeight: 1.6 }}>
          <b>GitHub Copilot 연결</b> — 열린 페이지에 코드 입력(복사됨):
          <div style={{ margin: '8px 0' }}><code style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface)', padding: '4px 10px', borderRadius: 6 }}>{device.userCode}</code></div>
          <button onClick={() => setDevice(null)} style={{ ...connectBtn, background: 'transparent', color: 'var(--fl-text-muted)', border: '1px solid var(--fl-border)' }}>취소</button>
        </div>
      )}

      <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {turns.length === 0 && (
          <div style={{ color: 'var(--fl-text-muted)', fontSize: 12.5, lineHeight: 1.6 }}>
            <p style={{ margin: 0 }}>만들고 싶은 가짜 API를 한국어로 말해 보세요. 예: "결제창 띄우고 콜백하는 mock", "GET /users/&#123;id&#125; 가 유저 JSON 주게", "0000 전문 받으면 승인 응답하는 TCP".</p>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} style={{ alignSelf: t.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '92%' }}>
            <div style={bubble(t.role)}>{t.content}</div>
            {t.role === 'assistant' && t.spec && <SpecCard spec={t.spec} applied={t.applied} onApply={() => apply(i, t.spec!)} canEdit={canEdit} />}
          </div>
        ))}
        {pending && <div style={{ alignSelf: 'flex-start', ...bubble('assistant'), color: 'var(--fl-text-muted)' }}>생각 중…</div>}
      </div>

      <div style={{ borderTop: '1px solid var(--fl-border)', padding: 10, display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input) } }}
          placeholder={canEdit ? '예: 결제창 mock 만들어줘 (Enter)' : '보기 전용'} disabled={!canEdit || pending} rows={2}
          style={{ flex: 1, resize: 'none', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, minWidth: 0 }} />
        <button onClick={() => void send(input)} disabled={!canEdit || pending || !input.trim()} style={sendBtn}>보내기</button>
      </div>
    </aside>
  )
}

function SpecCard({ spec, applied, onApply, canEdit }: { spec: MockServerSpec; applied?: boolean; onApply: () => void; canEdit: boolean }) {
  const routes = spec.routes?.length ?? 0
  const hasTcp = spec.tcp != null && (spec.tcp.port != null || (spec.tcp.rules?.length ?? 0) > 0)
  return (
    <div style={{ marginTop: 6, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', padding: 10 }}>
      <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginBottom: 8 }}>
        <b style={{ color: 'var(--fl-text)' }}>제안 mock</b><br />
        {routes > 0 && `HTTP 라우트 ${routes}개`}{routes > 0 && hasTcp ? ' · ' : ''}{hasTcp && `TCP :${spec.tcp?.port ?? '?'}`}
      </div>
      <button onClick={onApply} disabled={!canEdit || applied} style={{ ...applyBtn, ...(applied ? { opacity: 0.6, cursor: 'default' } : {}) }}>
        {applied ? '✓ 적용됨' : '편집기에 적용'}
      </button>
    </div>
  )
}

function badge(real?: boolean): CSSProperties {
  return { fontSize: 10, fontWeight: 700, fontFamily: 'var(--fl-font-mono)', padding: '2px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', color: real ? 'var(--fl-primary)' : 'var(--fl-text-muted)', background: real ? 'rgba(97,85,245,.12)' : 'var(--fl-surface-2)' }
}
function bubble(role: string): CSSProperties {
  return { padding: '8px 11px', borderRadius: 12, fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: role === 'user' ? 'var(--fl-primary)' : 'var(--fl-surface-2)', color: role === 'user' ? '#fff' : 'var(--fl-text)', border: role === 'user' ? 'none' : '1px solid var(--fl-border)' }
}
const xBtn: CSSProperties = { width: 26, height: 26, borderRadius: 7, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const connectBtn: CSSProperties = { padding: '4px 10px', borderRadius: 999, border: 'none', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700 }
const sendBtn: CSSProperties = { flexShrink: 0, padding: '8px 12px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }
const applyBtn: CSSProperties = { padding: '6px 12px', border: '1px solid var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }
