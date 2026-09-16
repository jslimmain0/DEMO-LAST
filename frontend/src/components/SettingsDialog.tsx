import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { settingsApi } from '../api/client'
import { authApi, getAccessToken } from '../auth/auth'
import { useAuth } from '../auth/AuthContext'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * 설정 다이얼로그 — 콜백 수신 주소(relay base) · 실패 알림 웹훅 · MCP 연결 안내.
 * 기본은 접속한 주소(오리진) 자동. 다른 주소로 콜백을 받아야 할 때만 저장(오버라이드)한다.
 * 저장 값은 서버 DB 에 보관 — 재시작해도 유지되고 env 없이 화면에서 관리한다.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { enabled: authEnabled, isGuest } = useAuth()
  // MCP HTTP 서버(옆에 뜬 Node)가 있으면 그 포트 — 접속 주소는 브라우저 호스트 + 그 포트(서버는 자기 외부 주소를 모른다).
  const cfgQ = useQuery({ queryKey: ['auth', 'config'], queryFn: authApi.config, staleTime: 60_000 })
  const mcpPort = cfgQ.data?.mcpPort ?? null
  const mcpUrl = mcpPort && typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:${mcpPort}/mcp` : null
  // 헤더 토큰 = 지금 로그인한 사용자의 앱 JWT(localStorage). github 모드에서 로그인했을 때만 복사할 게 있다.
  const mcpToken = authEnabled && !isGuest ? getAccessToken() : null
  const copy = async (label: string, text: string) => {
    try { await navigator.clipboard.writeText(text); toast(`${label} 복사됨`, 'ok') } catch { toast('클립보드 복사 실패 — 직접 선택해 복사하세요', 'error') }
  }
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
  useEffect(() => setDraft(null), [q.data?.value])
  useEffect(() => setNotifyDraft(null), [notifyQ.data?.value])
  const notifyValue = notifyDraft ?? notifyQ.data?.value ?? ''
  const notifyDirty = notifyDraft != null && notifyDraft !== (notifyQ.data?.value ?? '')

  const value = draft ?? q.data?.value ?? ''
  const dirty = draft != null && draft !== (q.data?.value ?? '')

  return (
    <Modal onClose={onClose} ariaLabel="설정" width={520} card={{ padding: 18, display: 'block' }}>
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

        <label style={{ ...label, marginTop: 18 }}>MCP 연결 (Claude Code · VS Code Copilot 등 에이전트)</label>
        {mcpUrl ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input aria-label="MCP 주소" style={mono} readOnly value={mcpUrl} onFocus={(e) => e.currentTarget.select()} />
              <button style={ghostBtn} onClick={() => copy('MCP 주소', mcpUrl)}>주소 복사</button>
            </div>
            <p style={hint}>
              설치 없이 URL 로 붙습니다 — Claude Code: <code style={code}>{`claude mcp add -s user -t http flowlink ${mcpUrl}`}</code>
              {' '}· VS Code <code style={code}>mcp.json</code>: <code style={code}>{`{ "servers": { "flowlink": { "type": "http", "url": "${mcpUrl}" } } }`}</code>
            </p>
            {authEnabled && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <p style={{ ...hint, margin: 0, flex: 1 }}>
                  {mcpToken
                    ? <>내 이름으로 저장(프로토콜·환경)하려면 토큰을 <code style={code}>Authorization: Bearer …</code> 헤더로 넣습니다(Claude Code: <code style={code}>-H "Authorization: Bearer &lt;토큰&gt;"</code>, VS Code: <code style={code}>"headers"</code>). 토큰은 로그인과 같은 기간 유효합니다.</>
                    : <>로그인하면 여기서 MCP 토큰을 복사할 수 있습니다(게스트는 읽기·워크플로·Mock 만 가능).</>}
                </p>
                {mcpToken && <button style={primaryBtn} onClick={() => copy('MCP 토큰', mcpToken)}>MCP 토큰 복사</button>}
              </div>
            )}
          </>
        ) : (
          <p style={hint}>
            이 서버는 MCP HTTP 를 띄우지 않았습니다(<code style={code}>FLOWLINK_MCP_PORT</code> 미설정).
            로컬 stdio 방식은 <code style={code}>{`npm i -g ${typeof window !== 'undefined' ? window.location.origin : ''}/mcp/flowlink-mcp.tgz`}</code> 로 설치합니다.
          </p>
        )}

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
    </Modal>
  )
}

const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '10px 0 5px' }
const mono: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, fontFamily: 'var(--fl-font-mono)' }
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8, lineHeight: 1.6 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const primaryBtn: CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const ghostBtn: CSSProperties = { padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }
