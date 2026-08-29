import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { assistantApi } from '../api/client'
import type { AssistantMessage, FlowGraph } from '../api/types'
import { usePermissions } from '../auth/AuthContext'
import { hasStartNode, validateGraphShape } from '../lib/graphValidate'
import { useEditorStore } from '../store/editorStore'
import { CopilotStatusDialog } from './CopilotStatusDialog'
import { SessionsDialog } from './SessionsDialog'
import { SkillsDialog } from './SkillsDialog'
import { toast } from './toast'

/** 대화에 붙은 제안 그래프(적용 가능) — assistant 메시지에만. */
interface Turn extends AssistantMessage {
  graph?: FlowGraph | null
  stub?: boolean
  applied?: boolean
}

/**
 * AI 어시스턴트 채팅 패널 — 자연어로 플로우를 만들고 고친다.
 * 현재 캔버스 그래프를 맥락으로 보내고, 제안 그래프는 '적용'으로 importGraph(교체, Ctrl+Z 되돌리기).
 */
export function AssistantPanel({ width, onClose }: { width: number; onClose: () => void }) {
  const getGraph = useEditorStore((s) => s.getGraph)
  const importGraph = useEditorStore((s) => s.importGraph)
  const { canEdit: canEditGlobal } = usePermissions()
  const wsReadOnly = useEditorStore((s) => s.readOnly) // 워크스페이스 VIEWER — 캔버스 적용 차단
  const canEdit = canEditGlobal && !wsReadOnly
  const qc = useQueryClient()
  const cfg = useQuery({ queryKey: ['assistant', 'config'], queryFn: assistantApi.config })
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null)
  // 디바이스 인증 중이면 상태를 주기적으로 폴링(사용자가 코드 입력 완료를 감지)
  const oauthQ = useQuery({ queryKey: ['assistant', 'oauth', 'status'], queryFn: assistantApi.oauthStatus, refetchInterval: device ? 3000 : false })
  const connected = oauthQ.data?.connected === true
  const [statusOpen, setStatusOpen] = useState(false)
  // GitHub Copilot 연결 — 디바이스 플로우(확장과 동일). 코드 발급 → 사용자가 github.com/login/device 에서 입력 → 폴링.
  const connect = async () => {
    try {
      const d = await assistantApi.oauthDeviceStart()
      setDevice({ userCode: d.userCode, verificationUri: d.verificationUri })
      try { await navigator.clipboard?.writeText(d.userCode) } catch { /* ignore */ }
      window.open(d.verificationUri, '_blank', 'noopener')
    } catch (e) {
      toast((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'Copilot 연결 시작 실패', 'error')
    }
  }
  // 인증 완료(connected) 또는 대기 종료(에러) 감지
  useEffect(() => {
    if (!device) return
    if (connected) { toast('GitHub Copilot 를 연결했습니다.', 'ok'); setDevice(null); qc.invalidateQueries({ queryKey: ['assistant'] }) }
    else if (oauthQ.data && oauthQ.data.pending === false) { toast(oauthQ.data.error ? `연결 실패: ${oauthQ.data.error}` : '연결이 취소/만료됐습니다.', 'error'); setDevice(null) }
  }, [connected, oauthQ.data, device, qc])
  const canConnect = !connected
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null) // 현재 저장 중인 세션(없으면 첫 대화에서 생성)
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId
  const listRef = useRef<HTMLDivElement>(null)

  // 연결 시 모델 목록 조회 + 선택. current(서버 저장, 기본 gpt-4.1)를 단일 진실원으로 — 헤더 드롭다운과 상태 다이얼로그가 공유.
  const modelsQ = useQuery({ queryKey: ['assistant', 'oauth', 'models'], queryFn: assistantApi.models, enabled: connected, staleTime: 5 * 60_000 })
  const model = modelsQ.data?.current ?? ''
  const changeModel = async (m: string) => {
    qc.setQueryData(['assistant', 'oauth', 'models'], (prev: typeof modelsQ.data) => (prev ? { ...prev, current: m } : prev)) // 낙관적
    try { await assistantApi.setModel(m); qc.invalidateQueries({ queryKey: ['assistant', 'config'] }) } catch { /* ignore */ }
  }

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [turns, pending])

  // 대화 자동 저장(사용자별) — 첫 저장은 생성, 이후 갱신. 저장 실패는 조용히(대화는 유지).
  const persist = async (allTurns: Turn[]) => {
    if (allTurns.length === 0) return
    const messages = allTurns.map((t) => ({ role: t.role, content: t.content, graph: t.graph ?? null, stub: t.stub }))
    try {
      if (sessionIdRef.current) {
        await assistantApi.updateSession(sessionIdRef.current, { messages })
      } else {
        const s = await assistantApi.createSession({ messages })
        setSessionId(s.id)
      }
      qc.invalidateQueries({ queryKey: ['assistant', 'sessions'] })
    } catch { /* 저장 실패는 무시 — 대화 흐름 우선 */ }
  }

  const newChat = () => { setTurns([]); setSessionId(null); setInput('') }
  const loadSession = async (id: string) => {
    try {
      const s = await assistantApi.getSession(id)
      setTurns((s.messages ?? []).map((m) => ({ role: m.role, content: m.content, graph: m.graph ?? undefined, stub: m.stub })))
      setSessionId(id)
    } catch { toast('세션을 불러오지 못했습니다.', 'error') }
  }

  const send = async (text: string) => {
    const msg = text.trim()
    if (!msg || pending || !canEdit) return
    setInput('')
    const history: Turn[] = [...turns, { role: 'user', content: msg }]
    setTurns(history)
    setPending(true)
    try {
      const res = await assistantApi.chat({
        messages: history.map((t) => ({ role: t.role, content: t.content })),
        graph: getGraph(),
        model: connected && model ? model : undefined,
      })
      const final: Turn[] = [...history, { role: 'assistant', content: res.reply, graph: res.graph, stub: res.stub }]
      setTurns(final)
      void persist(final)
    } catch (e) {
      const detail = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
      setTurns((prev) => [...prev, { role: 'assistant', content: `⚠ 오류: ${detail || (e instanceof Error ? e.message : String(e))}` }])
    } finally {
      setPending(false)
    }
  }

  const apply = (idx: number, graph: FlowGraph) => {
    if (!canEdit) return
    // 크래시 안전 검증(수동 가져오기와 동일) — 잘못된 LLM 그래프가 React Flow 를 깨뜨리지 않게
    const err = validateGraphShape(graph)
    if (err) { toast(`적용할 수 없는 그래프입니다: ${err}`, 'error'); return }
    importGraph(graph)
    setTurns((prev) => prev.map((t, i) => (i === idx ? { ...t, applied: true } : t)))
    toast(hasStartNode(graph)
      ? '플로우를 캔버스에 적용했습니다 (Ctrl+Z 로 되돌리기).'
      : '적용했습니다. ⚠ START 노드가 없어 실행하려면 시작 노드를 추가하세요.', 'ok')
  }

  return (
    <aside style={{ width, flexShrink: 0, borderLeft: '1px solid var(--fl-border)', background: 'var(--fl-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--fl-border)' }}>
        <span aria-hidden>✨</span>
        <b style={{ flex: 1, fontSize: 13.5 }}>AI 어시스턴트</b>
        {connected ? (
          <button onClick={() => setStatusOpen(true)} title="GitHub Copilot 연결됨 — 클릭해 사용량·모델·연결 상태 보기" style={{ ...badge(true), cursor: 'pointer', border: '1px solid var(--fl-ok)', color: 'var(--fl-ok)' }}>🔗 Copilot</button>
        ) : device ? (
          <span style={badge(false)} title="인증 대기 중">인증 대기…</span>
        ) : canConnect && canEdit ? (
          <button onClick={connect} title="GitHub 로그인으로 Copilot 연결(디바이스 코드)" style={connectBtn}>Copilot 연결</button>
        ) : (
          <span style={badge(cfg.data?.usingRealLlm)} title={cfg.data?.usingRealLlm ? `모델: ${cfg.data?.model}` : 'Copilot/API 키 미설정 — 샘플(stub) 모드'}>
            {cfg.data?.usingRealLlm ? cfg.data?.model : 'stub'}
          </span>
        )}
        {canEdit && turns.length > 0 && <button onClick={newChat} aria-label="새 대화" title="새 대화 시작(현재 대화는 기록에 저장됨)" style={xBtn}>＋</button>}
        {canEdit && <button onClick={() => setSessionsOpen(true)} aria-label="대화 기록" title="저장된 대화 목록 · 이어하기" style={xBtn}>🕘</button>}
        {canEdit && <button onClick={() => setSkillsOpen(true)} aria-label="프롬프트·지침" title="프롬프트 라이브러리 · 팀 지침" style={xBtn}>💬</button>}
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>

      {/* 모델 선택 — 연결 시 표시. 포함(base)/프리미엄 구분. 프리미엄은 계정에 프리미엄 요청 쿼터가 있어야 동작(없으면 429). */}
      {connected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)' }}>
          <span aria-hidden style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>모델</span>
          <select
            value={model}
            onChange={(e) => void changeModel(e.target.value)}
            disabled={!canEdit || !modelsQ.data?.models?.length}
            title="AI 모델 선택 — 포함 모델은 무료, 프리미엄은 Copilot 프리미엄 요청 쿼터 필요"
            style={{ flex: 1, minWidth: 0, padding: '4px 8px', fontSize: 12, borderRadius: 6, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontFamily: 'var(--fl-font-mono)' }}
          >
            {!modelsQ.data?.models?.length && <option value={model}>{model || '불러오는 중…'}</option>}
            {(() => {
              // 헤더 드롭다운은 권장 모델만(+현재 선택) — 레거시/스냅샷은 🔗 Copilot 상태창 '더보기'에서.
              const ms = (modelsQ.data?.models ?? []).filter((m) => m.recommended !== false || m.id === model)
              const base = ms.filter((m) => !m.premium)
              const prem = ms.filter((m) => m.premium)
              return (
                <>
                  {base.length > 0 && (
                    <optgroup label="포함(무료)">
                      {base.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                    </optgroup>
                  )}
                  {prem.length > 0 && (
                    <optgroup label="프리미엄(쿼터 필요)">
                      {prem.map((m) => <option key={m.id} value={m.id}>{m.id} · 프리미엄</option>)}
                    </optgroup>
                  )}
                </>
              )
            })()}
          </select>
          {modelsQ.data?.models?.find((m) => m.id === model)?.premium && (
            <span title="이 모델은 Copilot 프리미엄 요청 쿼터가 필요합니다. 없으면 429가 납니다." style={{ fontSize: 10, color: 'var(--fl-warn, #b8860b)', whiteSpace: 'nowrap' }}>⚠ 프리미엄</span>
          )}
        </div>
      )}

      {skillsOpen && <SkillsDialog onClose={() => setSkillsOpen(false)} onApplyPrompt={(p) => void send(p)} />}
      {statusOpen && <CopilotStatusDialog onClose={() => setStatusOpen(false)} canEdit={canEdit} />}
      {sessionsOpen && <SessionsDialog currentId={sessionId} onClose={() => setSessionsOpen(false)} onLoad={(id) => void loadSession(id)} onNew={newChat} />}

      {/* 디바이스 인증 안내 카드 */}
      {device && (
        <div style={{ margin: 12, padding: 12, border: '1px solid var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', fontSize: 12.5, lineHeight: 1.6 }}>
          <b>GitHub Copilot 연결</b> — 열린 GitHub 페이지에 아래 코드를 입력하세요(복사됨):
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
            <code style={{ fontSize: 18, fontWeight: 700, letterSpacing: 2, fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface)', padding: '4px 10px', borderRadius: 6 }}>{device.userCode}</code>
            <a href={device.verificationUri} target="_blank" rel="noreferrer" style={{ color: 'var(--fl-primary)', fontSize: 12 }}>페이지 다시 열기 ↗</a>
          </div>
          <div style={{ color: 'var(--fl-text-muted)' }}>인증하면 자동으로 연결됩니다… <button onClick={() => setDevice(null)} style={{ ...connectBtn, background: 'transparent', color: 'var(--fl-text-muted)', border: '1px solid var(--fl-border)' }}>취소</button></div>
        </div>
      )}

      <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {turns.length === 0 && (
          <div style={{ color: 'var(--fl-text-muted)', fontSize: 12.5, lineHeight: 1.6 }}>
            <p style={{ margin: 0 }}>만들고 싶은 플로우를 한국어로 말해 보세요. 현재 캔버스를 이어서 고칠 수도 있습니다. 자주 쓰는 프롬프트는 💬 에서 저장·적용하세요.</p>
            {!canEdit && <p style={{ marginTop: 10, color: 'var(--fl-put)' }}>보기 전용 권한이라 플로우를 만들 수 없습니다(editor 이상 필요).</p>}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} style={{ alignSelf: t.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '92%' }}>
            <div style={bubble(t.role)}>{t.content}</div>
            {t.role === 'assistant' && t.graph && <GraphCard graph={t.graph} applied={t.applied} onApply={() => apply(i, t.graph!)} canEdit={canEdit} />}
          </div>
        ))}
        {pending && <div style={{ alignSelf: 'flex-start', ...bubble('assistant'), color: 'var(--fl-text-muted)' }}>생각 중…</div>}
      </div>

      <div style={{ borderTop: '1px solid var(--fl-border)', padding: 10, display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(input) } }}
          placeholder={canEdit ? '예: 로그인하고 주문 생성하는 플로우 만들어줘 (Enter 전송)' : '보기 전용'}
          disabled={!canEdit || pending}
          rows={2}
          style={{ flex: 1, resize: 'none', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, fontFamily: 'var(--fl-font-ui)', minWidth: 0 }}
        />
        <button onClick={() => void send(input)} disabled={!canEdit || pending || !input.trim()} style={sendBtn}>보내기</button>
      </div>
    </aside>
  )
}

/** 제안 그래프 요약 카드 + 적용 버튼. */
function GraphCard({ graph, applied, onApply, canEdit }: { graph: FlowGraph; applied?: boolean; onApply: () => void; canEdit: boolean }) {
  const nodes = graph.nodes ?? []
  const exec = nodes.filter((n) => n.type !== 'note' && n.type !== 'group')
  const types = Array.from(new Set(exec.map((n) => n.type))).join(', ')
  return (
    <div style={{ marginTop: 6, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', padding: 10 }}>
      <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginBottom: 8 }}>
        <b style={{ color: 'var(--fl-text)' }}>제안 플로우</b>{graph.name ? ` — ${graph.name}` : ''}
        <br />노드 {exec.length}개 · {(graph.edges ?? []).length}개 연결
        <br /><span style={{ fontFamily: 'var(--fl-font-mono)' }}>{types}</span>
      </div>
      <button onClick={onApply} disabled={!canEdit || applied} style={{ ...applyBtn, ...(applied ? { opacity: 0.6, cursor: 'default' } : {}) }}>
        {applied ? '✓ 적용됨' : '캔버스에 적용'}
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
