import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type CSSProperties } from 'react'
import { authApi } from '../auth/auth'
import { useAuth } from '../auth/AuthContext'
import { Modal } from './Modal'
import { desktopApi } from '../auth/desktop'
import { apiErrorMessage } from '../lib/apiError'
import { toast } from './toast'
import { DesktopUpdateCard } from './DesktopUpdateCard'

/** 개인 연결과 런타임 공통 설정은 저장 대상과 편집 권한이 다르다. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settingsApi, adminApi } = useApi()
  const scope = useWorkspace()
  const { desktop } = useAuth()
  const qc = useQueryClient()
  const [tab, setTab] = useState<'connection' | 'runtime' | 'update'>(desktop ? 'connection' : 'runtime')
  const runtimeLabel = scope.current.origin === 'local' ? '내 PC 실행 설정' : '서버 공통 설정'
  const connection = useQuery({ queryKey: ['desktop', 'connection'], queryFn: desktopApi.connection, enabled: !!desktop, refetchInterval: desktop ? 3000 : false })
  const permission = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, retry: false })
  const editable = permission.isSuccess && permission.data.admin
  const relay = useQuery({ queryKey: ['settings', 'relay'], queryFn: settingsApi.relay, enabled: tab === 'runtime', retry: false })
  const notify = useQuery({ queryKey: ['settings', 'notify'], queryFn: settingsApi.notify, enabled: tab === 'runtime' && editable, retry: false })
  const cfg = useQuery({ queryKey: ['auth', 'config'], queryFn: authApi.config, enabled: !desktop })
  const [serverDraft, setServerDraft] = useState<string | null>(null)
  const [editingServer, setEditingServer] = useState(false)
  const [editingRelay, setEditingRelay] = useState(false)
  const [relayDraft, setRelayDraft] = useState<string | null>(null)
  const [notifyDraft, setNotifyDraft] = useState<string | null>(null)
  const savedServer = connection.data?.serverUrl ?? desktop?.serverUrl ?? ''
  const server = serverDraft ?? savedServer
  const serverDirty = server.trim() !== savedServer
  const relayValue = relayDraft ?? relay.data?.value ?? ''
  const notifyValue = notifyDraft ?? notify.data?.value ?? ''
  const relayDirty = relayDraft !== null && relayDraft !== (relay.data?.value ?? '')
  const notifyDirty = notifyDraft !== null && notifyDraft !== (notify.data?.value ?? '')
  const saveServer = useMutation({ mutationFn: desktopApi.configure,
    onSuccess: data => { qc.setQueryData(['desktop', 'connection'], data); setServerDraft(null); setEditingServer(false); scope.refresh(); toast('서버 연결 주소를 저장했습니다.', 'ok') } })
  const saveRelay = useMutation({ mutationFn: settingsApi.saveRelay,
    onSuccess: data => { qc.setQueryData(['settings', 'relay'], data); setRelayDraft(null); setEditingRelay(false); toast('콜백 수신 주소를 저장했습니다.', 'ok') } })
  const saveNotify = useMutation({ mutationFn: settingsApi.saveNotify,
    onSuccess: data => { qc.setQueryData(['settings', 'notify'], data); setNotifyDraft(null); toast('알림 설정을 저장했습니다.', 'ok') } })
  const login = useMutation({ mutationFn: desktopApi.login })
  const mcpUrl = connection.data?.mcpUrl || desktop?.mcpUrl || cfg.data?.mcpUrl || ''
  const [confirmClose, setConfirmClose] = useState(false)
  const saving = saveServer.isPending || saveRelay.isPending || saveNotify.isPending
  const close = () => { if (saving) return; if (serverDirty || relayDirty || notifyDirty) setConfirmClose(true); else onClose() }
  const error = (value: unknown) => <p role="alert" style={errorStyle}>{apiErrorMessage(value)}</p>
  const copyMcpUrl = async () => {
    try { await navigator.clipboard.writeText(mcpUrl); toast('MCP 주소를 복사했습니다.', 'ok') }
    catch { toast('복사하지 못했습니다. 주소를 직접 선택해 복사하세요.', 'error') }
  }
  return <Modal onClose={close} ariaLabel="설정" width={620} card={{ padding: 24, overflowY: 'auto' }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 20 }}>설정</h2><button aria-label="설정 닫기" onClick={close} disabled={saving} style={button}>닫기</button>
    </header>
    {<div role="tablist" aria-label="설정 범위" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '20px 0' }}>
      {([...(desktop ? [['connection', '계정 · 연결'] as const] : []), ['runtime', runtimeLabel] as const, ['update', '앱 업데이트'] as const]).map(([id, text]) => <button key={id} role="tab" aria-selected={tab === id} aria-controls={'settings-' + id} onClick={() => setTab(id)} style={{ ...button, borderColor: tab === id ? 'var(--fl-primary)' : 'var(--fl-border)', color: tab === id ? 'var(--fl-primary)' : 'var(--fl-text)' }}>{text}</button>)}
    </div>}
    {tab === 'connection' && desktop && <section id="settings-connection" role="tabpanel" aria-label="계정 · 연결">
      <div style={summary}>
        <div style={row}>
          <div style={{ minWidth: 0, flex: '1 1 180px' }}>
            <p style={{ ...hint, margin: '0 0 6px' }}>Windows 앱 계정</p>
            <h3 role="status" style={{ margin: 0, fontSize: 19, overflowWrap: 'anywhere' }}>{connection.isPending ? '계정 확인 중…' : connection.isError ? '계정 정보를 불러오지 못했습니다' : connection.data?.connected ? connection.data.login || '로그인 정보 저장됨' : '회사 계정으로 로그인'}</h3>
          </div>
          <button style={connection.data?.connected ? button : primary} disabled={serverDirty || !connection.isSuccess || !savedServer || login.isPending} onClick={() => login.mutate()}>{login.isPending ? '로그인 창 여는 중…' : connection.data?.connected ? '계정 관리 열기' : 'Windows 앱에서 로그인'}</button>
        </div>
        <p style={{ ...hint, marginBottom: 0 }}>{connection.data?.connected ? '앱의 로그인을 이 작업 화면에서도 사용합니다.' : '앱에서 한 번 로그인하면 회사 워크스페이스를 사용할 수 있습니다.'} 개인 작업은 로그인 없이도 계속할 수 있습니다.</p>
      </div>
      {connection.isError && <>{error(connection.error)}<button style={button} onClick={() => void connection.refetch()}>연결 정보 다시 불러오기</button></>}
      {login.isError && error(login.error)}
      <section style={section} aria-label="회사 서버">
        <div style={row}><h3 style={{ ...heading, margin: 0 }}>회사 서버</h3>{savedServer && !editingServer && <button style={button} disabled={!connection.isSuccess} onClick={() => setEditingServer(true)}>서버 변경</button>}</div>
        {savedServer && <p style={hint}><code style={code}>{savedServer}</code></p>}
        {!editingServer && savedServer && <p style={hint}>저장된 연결 정보를 사용합니다. 앱 업데이트 후에도 유지됩니다.</p>}
        {(editingServer || (!savedServer && connection.isSuccess)) && <div style={{ marginTop: 12 }}>
          <label style={label} htmlFor="desktop-server">{savedServer ? '변경할 서버 주소' : '회사 서버 주소'}</label>
          <input id="desktop-server" style={input} value={server} placeholder="https://flowlink.company.com" disabled={!connection.isSuccess || saveServer.isPending} onChange={e => setServerDraft(e.target.value)} />
          <p style={hint}>{savedServer ? '다른 서버로 변경하면 현재 회사 계정에서 로그아웃됩니다. 개인 데이터는 PC에 그대로 남습니다.' : '설치 파일에 서버 주소가 포함되지 않았습니다. 관리자가 안내한 주소를 한 번 입력하세요.'}</p>
          <div style={actions}>
            <button style={primary} disabled={!serverDirty || !server.trim() || !connection.isSuccess || saveServer.isPending} onClick={() => saveServer.mutate(server.trim())}>{saveServer.isPending ? '저장 중…' : '서버 주소 저장'}</button>
            {savedServer && <button style={button} disabled={saveServer.isPending} onClick={() => { setServerDraft(null); setEditingServer(false); saveServer.reset() }}>취소</button>}
          </div>
          {saveServer.isError && error(saveServer.error)}
        </div>}
      </section>
      <section style={section} aria-label="IDE 연결 안내"><h3 style={heading}>VS Code · IntelliJ 연결</h3>
        <p style={hint}>회사 서버에서 제공하는 MCP 주소입니다. IDE에 등록한 뒤 도구 사용을 승인하세요.</p>
        {mcpUrl ? <div style={{ ...summary, padding: 12 }}><code style={code}>{mcpUrl}</code><div style={actions}><button style={button} onClick={() => void copyMcpUrl()}>MCP 주소 복사</button></div></div> : <p style={hint}>서버에서 MCP 주소를 아직 받지 못했습니다.</p>}
        <p style={hint}>IDE의 로그인·도구 사용 승인은 별도로 진행합니다. 이 화면에서는 IDE 연결 상태를 확인하지 않습니다.</p>
      </section>
    </section>}
    {tab === 'update' && <section id="settings-update" role="tabpanel" aria-label="앱 업데이트"><DesktopUpdateCard /></section>}
    {tab === 'runtime' && <section id="settings-runtime" role="tabpanel" aria-label={runtimeLabel}>
      <p style={{ ...hint, padding: 12, background: 'var(--fl-surface-2)', borderRadius: 6 }}>
        <b style={{ color: 'var(--fl-text)' }}>{runtimeLabel}</b><br />
        {scope.current.origin === 'local' ? '이 PC에서 실행하는 워크플로에 적용됩니다.' : '현재 서버 계정으로 관리하는 모든 공간에 적용됩니다. 선택한 팀 외의 공간에도 영향을 줍니다.'}
      </p>
      {permission.isPending && <p role="status" style={hint}>설정 권한을 확인하는 중…</p>}
      {permission.isError && <>{error(permission.error)}<button style={button} onClick={() => void permission.refetch()}>설정 권한 다시 확인</button></>}
      {permission.isSuccess && !editable && <p style={hint}>공통 설정은 관리자만 변경할 수 있습니다.</p>}
      <section style={section}>
        <h3 style={heading}>콜백 수신 주소</h3>
        <p style={hint}>WAIT 노드에 콜백을 보내는 상대 시스템이 접근할 주소입니다. 브라우저에서 열리는 주소와 다를 수 있습니다.</p>
        {relay.isError ? <>{error(relay.error)}<button style={button} onClick={() => void relay.refetch()}>콜백 설정 다시 불러오기</button></> : <>
          <div style={{ ...summary, padding: 12 }}><p style={{ ...hint, margin: '0 0 4px' }}>{relay.data?.value ? '직접 지정한 주소 사용 중' : '자동 주소 사용 중'}</p><code style={code}>{relay.isPending ? '불러오는 중…' : relay.data?.effective}</code></div>
          {(editingRelay || !!relay.data?.value || relayDirty) ? <>
            <label style={label} htmlFor="relay-base">수신 주소 직접 지정</label>
            <input id="relay-base" aria-label="콜백 수신 주소" style={input} value={relayValue} placeholder={relay.data?.auto || '자동 주소 사용'} disabled={!editable || !relay.isSuccess || saveRelay.isPending} onChange={e => setRelayDraft(e.target.value)} />
            {editable && <div style={actions}><button style={primary} disabled={!relayDirty || !relay.isSuccess || saveRelay.isPending} onClick={() => saveRelay.mutate(relayValue.trim() || null)}>{saveRelay.isPending ? '저장 중…' : '콜백 주소 저장'}</button>
              {relay.data?.value ? <button style={button} disabled={!relay.isSuccess || saveRelay.isPending} onClick={() => saveRelay.mutate(null)}>{relayDirty ? '입력 변경 버리고 자동 주소 적용' : '자동 주소 사용'}</button> : <button style={button} disabled={saveRelay.isPending} onClick={() => { setRelayDraft(null); setEditingRelay(false); saveRelay.reset() }}>취소</button>}
            </div>}
          </> : editable && <div style={actions}><button style={button} disabled={!relay.isSuccess} onClick={() => setEditingRelay(true)}>다른 수신 주소 지정</button></div>}
          {saveRelay.isError && error(saveRelay.error)}
        </>}
      </section>
      <section style={section}>
        <h3 style={heading}>실행 실패 알림</h3>
        {!editable ? <p style={hint}>알림 주소는 관리자만 조회·변경할 수 있습니다.</p> : notify.isError ? <>{error(notify.error)}<button style={button} onClick={() => void notify.refetch()}>알림 설정 다시 불러오기</button></> : <>
          <label style={label} htmlFor="notify-url">알림 웹훅 주소</label>
          <input id="notify-url" aria-label="실패 알림 웹훅 URL" style={input} value={notifyValue} disabled={!notify.isSuccess || saveNotify.isPending} placeholder="https://…" onChange={e => setNotifyDraft(e.target.value)} />
          <p style={hint}>실행 실패 시 이 주소로 알림을 보냅니다. 비워서 저장하면 알림을 끕니다.</p>
          <button style={primary} disabled={!notifyDirty || !notify.isSuccess || saveNotify.isPending} onClick={() => saveNotify.mutate(notifyValue.trim() || null)}>{saveNotify.isPending ? '저장 중…' : '알림 저장'}</button>
          {saveNotify.isError && error(saveNotify.error)}
        </>}
      </section>
      {!desktop && <section style={section}><h3 style={heading}>IDE 연결</h3><p style={hint}>IDE 등록과 도구 사용 승인은 회사의 MCP 안내를 따르세요. 이 화면은 실제 IDE 연결 상태를 확인하지 않습니다.</p>{mcpUrl && <code style={code}>{mcpUrl}</code>}</section>}
    </section>}
    {confirmClose && <div role="alert" style={{ ...section, padding: 14, background: 'var(--fl-surface-2)' }}><p style={{ margin: '0 0 12px', fontSize: 13 }}>저장하지 않은 설정이 있습니다.</p><div style={actions}><button style={button} onClick={() => setConfirmClose(false)}>계속 편집</button><button style={button} onClick={onClose}>변경 버리고 닫기</button></div></div>}
  </Modal>
}
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text)', font: 'inherit', fontSize: 13 }
const label: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, margin: '12px 0 6px' }
const hint: CSSProperties = { fontSize: 12.5, color: 'var(--fl-text-muted)', lineHeight: 1.65, overflowWrap: 'anywhere' }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 12, overflowWrap: 'anywhere' }
const heading: CSSProperties = { margin: '0 0 8px', fontSize: 14 }
const section: CSSProperties = { marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--fl-border)' }
const summary: CSSProperties = { padding: 18, background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 10, minWidth: 0 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }
const actions: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }
const button: CSSProperties = { padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text)', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }
const primary: CSSProperties = { ...button, background: 'var(--fl-action-primary-bg)', borderColor: 'var(--fl-action-primary-bg)', color: 'var(--fl-action-primary-ink)' }
const errorStyle: CSSProperties = { fontSize: 12.5, lineHeight: 1.6, color: 'var(--fl-fail)' }
