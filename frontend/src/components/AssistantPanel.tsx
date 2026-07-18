import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { assistantApi } from '../api/client'
import type { AssistantMessage, FlowGraph } from '../api/types'
import { usePermissions } from '../auth/AuthContext'
import { hasStartNode, validateGraphShape } from '../lib/graphValidate'
import { useEditorStore } from '../store/editorStore'
import { SkillsDialog } from './SkillsDialog'
import { toast } from './toast'

/** 대화에 붙은 제안 그래프(적용 가능) — assistant 메시지에만. */
interface Turn extends AssistantMessage {
  graph?: FlowGraph | null
  stub?: boolean
  applied?: boolean
}

const SUGGESTIONS = [
  'REST API 호출하고 상태 검증하는 플로우 만들어줘',
  '결제창 열고 콜백 기다렸다가 승인 분기하는 플로우',
  'OTP 입력받아 검증하는 플로우',
  'TCP 전문 보내고 응답 자르는 플로우',
]

/**
 * AI 어시스턴트 채팅 패널 — 자연어로 플로우를 만들고 고친다.
 * 현재 캔버스 그래프를 맥락으로 보내고, 제안 그래프는 '적용'으로 importGraph(교체, Ctrl+Z 되돌리기).
 */
export function AssistantPanel({ width, onClose }: { width: number; onClose: () => void }) {
  const getGraph = useEditorStore((s) => s.getGraph)
  const importGraph = useEditorStore((s) => s.importGraph)
  const { canEdit } = usePermissions()
  const qc = useQueryClient()
  const cfg = useQuery({ queryKey: ['assistant', 'config'], queryFn: assistantApi.config })
  const oauthQ = useQuery({ queryKey: ['assistant', 'oauth', 'status'], queryFn: assistantApi.oauthStatus })
  const disconnect = useMutation({
    mutationFn: assistantApi.oauthDisconnect,
    onSuccess: () => { toast('AI 연결을 해제했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['assistant'] }) },
    onError: (e: unknown) => toast((e as { response?: { data?: { message?: string } } })?.response?.data?.message || '연결 해제 실패', 'error'),
  })
  // GitHub 로그인 — 팝업을 열어 로그인·토큰 취득. 팝업이 콜백에서 postMessage 로 결과를 알려주면 상태 갱신.
  const connect = async () => {
    try {
      const { url } = await assistantApi.oauthAuthorize()
      window.open(url, 'flowlink-github-oauth', 'width=620,height=760,menubar=no,toolbar=no')
    } catch (e) {
      toast((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'GitHub 연결 시작 실패', 'error')
    }
  }
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return
      const d = ev.data as { flowlink?: string; result?: string }
      if (d?.flowlink !== 'ai-oauth') return
      if (d.result === 'connected') toast('GitHub 를 연결했습니다.', 'ok')
      else toast('GitHub 연결에 실패했습니다.', 'error')
      qc.invalidateQueries({ queryKey: ['assistant'] })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [qc])
  const connected = oauthQ.data?.connected === true
  const canConnect = oauthQ.data?.providerConfigured === true && !connected
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
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
      const res = await assistantApi.chat({
        messages: history.map((t) => ({ role: t.role, content: t.content })),
        graph: getGraph(),
      })
      setTurns((prev) => [...prev, { role: 'assistant', content: res.reply, graph: res.graph, stub: res.stub }])
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
          <button onClick={() => disconnect.mutate()} title="GitHub 연결됨 — 클릭해 연결 해제" style={{ ...badge(true), cursor: 'pointer', border: '1px solid var(--fl-ok)', color: 'var(--fl-ok)' }}>🔗 연결됨</button>
        ) : canConnect && canEdit ? (
          <button onClick={connect} title="GitHub 로그인으로 연결(팝업)" style={connectBtn}>GitHub 연결</button>
        ) : (
          <span style={badge(cfg.data?.usingRealLlm)} title={cfg.data?.usingRealLlm ? `모델: ${cfg.data?.model}` : 'API 키/OAuth 미설정 — 샘플(stub) 모드'}>
            {cfg.data?.usingRealLlm ? cfg.data?.model : 'stub'}
          </span>
        )}
        {canEdit && <button onClick={() => setSkillsOpen(true)} aria-label="프롬프트·지침" title="프롬프트 라이브러리 · 팀 지침 · GitHub 연결" style={xBtn}>💬</button>}
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>
      {skillsOpen && <SkillsDialog onClose={() => setSkillsOpen(false)} onApplyPrompt={(p) => void send(p)} />}

      <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {turns.length === 0 && (
          <div style={{ color: 'var(--fl-text-muted)', fontSize: 12.5, lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 10px' }}>만들고 싶은 플로우를 한국어로 말해 보세요. 현재 캔버스를 이어서 고칠 수도 있습니다.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} disabled={!canEdit} style={suggestBtn}>{s}</button>
              ))}
            </div>
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
const suggestBtn: CSSProperties = { textAlign: 'left', padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12, lineHeight: 1.4 }
