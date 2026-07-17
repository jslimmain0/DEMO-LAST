import { ReactFlowProvider, useReactFlow } from '@xyflow/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ExecutionDetail, PendingClientRequest, PendingInputRequest, ResumeRequest } from '../api/types'
import { flowsApi, runsApi } from '../api/client'
import { catColor, typeIcon, typeLabel } from '../canvas/nodeMeta'
import { FlowCanvas } from '../canvas/FlowCanvas'
import { Palette } from '../canvas/Palette'
import { PropertyPanel } from '../panels/PropertyPanel'
import { RunPanel } from '../panels/RunPanel'
import type { WaitStatus } from '../panels/RunPanel'
import { OpenApiImportDialog } from '../openapi/OpenApiImportDialog'
import { WorkflowIODialog } from '../openapi/WorkflowIODialog'
import { InputPromptDialog } from '../components/InputPromptDialog'
import { ResizeHandle } from '../components/ResizeHandle'
import { ConflictDialog } from '../components/ConflictDialog'
import { PresenceAvatars } from '../components/PresenceAvatars'
import { toast } from '../components/toast'
import { useAuth, usePermissions } from '../auth/AuthContext'
import { getAccessToken } from '../auth/auth'
import { devNickname, presence } from '../lib/presence'
import { startCollab, stopCollab } from '../lib/collab'
import { openFormIframe, openFormPopup } from '../lib/popup'
import { computeRunView } from '../lib/runProgress'
import { useEditorStore } from '../store/editorStore'
import { isAxiosError } from 'axios'

export function Editor() {
  const { id } = useParams()
  const flowId = id ?? ''
  const loadGraph = useEditorStore((s) => s.loadGraph)
  const flowName = useEditorStore((s) => s.flowName)
  const setName = useEditorStore((s) => s.setName)
  const dirty = useEditorStore((s) => s.dirty)
  const getGraph = useEditorStore((s) => s.getGraph)
  const markSaved = useEditorStore((s) => s.markSaved)
  const addPaletteGroup = useEditorStore((s) => s.addPaletteGroup)
  const importGraph = useEditorStore((s) => s.importGraph)

  const { canEdit, isViewer } = usePermissions()
  const { me, enabled: authEnabled } = useAuth()

  // presence — 같은 플로우를 연 사람들끼리 커서/편집중/저장 알림(별도 presenceStore, 그래프 불변)
  useEffect(() => {
    if (!id) return
    // 이름: OIDC 면 로그인 사용자명, dev 면 브라우저별 닉네임(dev 모드 /me 는 전원 "dev" 라 devNickname 사용)
    const displayName = authEnabled ? (me?.username ?? devNickname()) : devNickname()
    presence.connect(id, displayName, authEnabled ? getAccessToken : undefined)
    startCollab() // 실시간 공동 편집(그래프 변경 중계·적용)
    // 선택 노드 변경 → 편집중 신호(속성 패널이 그 노드를 편집 중)
    const unsub = useEditorStore.subscribe((s, prev) => {
      if (s.selectedId !== prev.selectedId) presence.sendEditing(s.selectedId)
    })
    return () => { unsub(); stopCollab(); presence.close() }
  }, [id, me?.username, authEnabled])

  const [execution, setExecution] = useState<ExecutionDetail | null>(null)
  const [running, setRunning] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [saveConflict, setSaveConflict] = useState(false)
  const [showApiImport, setShowApiImport] = useState(false)
  const [workflowIO, setWorkflowIO] = useState<'export' | 'import' | null>(null)
  // wait(콜백 대기) 진행 상태 — RunPanel 카운트다운/수신 URL 표시용
  const [waitStatus, setWaitStatus] = useState<WaitStatus | null>(null)
  const stopRef = useRef<AbortController | null>(null)
  // 최신 flowId 를 비동기 실행 루프가 참조 — 플로우 전환 후 낡은 실행이 새 화면을 덧칠하지 않게 가드
  const flowIdRef = useRef(flowId)
  flowIdRef.current = flowId
  // input(사용자 입력) 노드 모달 — 실행 루프가 confirm 값(취소=null)을 기다리도록 resolver 보관
  const [pendingInput, setPendingInput] = useState<PendingInputRequest | null>(null)
  const inputResolverRef = useRef<((values: Record<string, unknown> | null) => void) | null>(null)
  const askInput = (pi: PendingInputRequest): Promise<Record<string, unknown> | null> => {
    setPendingInput(pi)
    return new Promise((resolve) => { inputResolverRef.current = resolve })
  }
  const resolveInput = (values: Record<string, unknown> | null) => {
    inputResolverRef.current?.(values)
    inputResolverRef.current = null
    setPendingInput(null)
  }

  // 패널 크기(좌 팔레트 / 우 속성 / 하 로그) — 드래그로 조절하고 localStorage 에 유지
  const [paletteW, setPaletteW] = useState(() => loadSize('paletteW', 200, 160, 420))
  const [propertyW, setPropertyW] = useState(() => loadSize('propertyW', 330, 300, 560))
  const [runH, setRunH] = useState(() => loadSize('runH', 260, 120, 600))
  // 사이드바 접기 + 속성 패널 넓게 편집(모달) (localStorage 지속)
  const [paletteCollapsed, setPaletteCollapsed] = useState(() => localStorage.getItem('fl:editor:palColl') === '1')
  const [propCollapsed, setPropCollapsed] = useState(() => localStorage.getItem('fl:editor:propColl') === '1')
  const [propModal, setPropModal] = useState(false) // 좁은 사이드 대신 넓은 모달로 편집
  const persistUI = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 프라이빗 모드 무시 */ } }
  // QoL: 도구 메뉴 + 모달들 + 자동저장
  const [toolsOpen, setToolsOpen] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [autosave, setAutosave] = useState(() => localStorage.getItem('fl:editor:autosave') === '1')
  const autoLayout = useEditorStore((s) => s.autoLayout)
  const nodeCount = useEditorStore((s) => s.nodes.length)
  const zen = paletteCollapsed && propCollapsed
  const toggleZen = () => {
    const next = !zen
    setPaletteCollapsed(next); persistUI('fl:editor:palColl', next ? '1' : '0')
    setPropCollapsed(next); persistUI('fl:editor:propColl', next ? '1' : '0')
  }
  const resetPanels = () => {
    setPaletteW(200); saveSize('paletteW', 200)
    setPropertyW(330); saveSize('propertyW', 330)
    setRunH(260); saveSize('runH', 260)
    setPaletteCollapsed(false); persistUI('fl:editor:palColl', '0')
    setPropCollapsed(false); persistUI('fl:editor:propColl', '0')
  }
  // 속성 모달: Esc 닫기 + 노드 선택이 풀리면 자동으로 닫는다
  useEffect(() => {
    if (!propModal) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPropModal(false) }
    window.addEventListener('keydown', onKey)
    const unsub = useEditorStore.subscribe((s, prev) => { if (s.selectedId !== prev.selectedId && !s.selectedId) setPropModal(false) })
    return () => { window.removeEventListener('keydown', onKey); unsub() }
  }, [propModal])

  // 뷰포트에 맞춘 동적 상한 — 패널이 화면을 넘어 캔버스를 0으로 만들지 않도록 창 크기 변화에 재클램프
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const maxPaletteW = Math.max(160, Math.min(420, Math.round(vp.w * 0.35)))
  const maxPropertyW = Math.max(300, Math.min(560, Math.round(vp.w * 0.45)))
  const maxRunH = Math.max(120, Math.min(600, vp.h - 160))
  useEffect(() => { setPaletteW((w) => Math.min(w, maxPaletteW)) }, [maxPaletteW])
  useEffect(() => { setPropertyW((w) => Math.min(w, maxPropertyW)) }, [maxPropertyW])
  useEffect(() => { setRunH((h) => Math.min(h, maxRunH)) }, [maxRunH])

  const flowQuery = useQuery({ queryKey: ['flow', flowId], queryFn: () => flowsApi.get(flowId), enabled: !!flowId })

  // 실행 경과 → 캔버스 표시(노드 배지·엣지 애니메이션). 실행 결과는 다음 실행/그래프 로드까지 유지된다.
  useEffect(() => {
    const st = useEditorStore.getState()
    st.setRunView(computeRunView(execution, running, st.nodes, st.edges))
  }, [execution, running])

  // 플로우 전환(뒤로가기/다른 플로우 열기) — 이전 플로우의 실행 상태가 새 캔버스에 비치지 않게 정리.
  // 진행 중이던 실행 루프/폴러는 중단 신호로 마감한다(백엔드 실행은 wait 타임아웃/자체 완료로 정리됨).
  useEffect(() => {
    return () => {
      stopRef.current?.abort()
      setExecution(null)
      setWaitStatus(null)
    }
  }, [flowId])

  // 노드 복사/붙여넣기(Ctrl/Cmd+C·V) — localStorage 클립보드라 다른 워크플로에 가서 붙여넣어도 된다.
  const [copyNote, setCopyNote] = useState<string | null>(null)
  useEffect(() => {
    if (!copyNote) return
    const t = setTimeout(() => setCopyNote(null), 2600)
    return () => clearTimeout(t)
  }, [copyNote])
  // Ctrl+S 저장 — 핸들러([] deps)가 최신 save 뮤테이션을 부를 수 있게 ref 로 연결(아래 save 정의 후 갱신)
  const saveShortcutRef = useRef<() => void>(() => {})
  useEffect(() => {
    // 단축키는 물리 키(e.code) 기준 — 한/영(IME) 한글 모드에서 e.key 가 'ㅊ'/'ㅍ'/'ㅋ' 로 바뀌어
    // Ctrl+C/V/Z 가 죽던 버그 수정(e.key 는 비QWERTY 배열 폴백으로 유지)
    const is = (e: KeyboardEvent, code: string, key: string) =>
      e.code === code || e.key === key || e.key === key.toUpperCase()
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      // Ctrl+S 저장 — 입력 필드 안에서도 동작. 브라우저 "페이지 저장" 다이얼로그는 항상 차단
      if (is(e, 'KeyS', 's')) {
        e.preventDefault()
        saveShortcutRef.current()
        return
      }
      const t = e.target as HTMLElement | null
      // 입력 중(텍스트 필드/토큰 입력)의 복사·붙여넣기·undo 는 브라우저 기본 동작에 양보
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (is(e, 'KeyC', 'c')) {
        if (window.getSelection()?.toString()) return // 텍스트 선택 복사 우선
        const n = useEditorStore.getState().copySelection()
        if (n > 0) setCopyNote(`노드 ${n}개 복사됨 — 다른 워크플로에서도 Ctrl+V`)
      } else if (is(e, 'KeyV', 'v')) {
        const n = useEditorStore.getState().pasteClipboard()
        if (n > 0) {
          e.preventDefault()
          setCopyNote(`노드 ${n}개 붙여넣음`)
        }
      } else if (is(e, 'KeyZ', 'z')) {
        e.preventDefault()
        if (e.shiftKey) useEditorStore.getState().redo()
        else useEditorStore.getState().undo()
      } else if (is(e, 'KeyY', 'y')) {
        e.preventDefault()
        useEditorStore.getState().redo()
      } else if (is(e, 'KeyD', 'd')) { // 선택 노드 복제
        e.preventDefault()
        const n = useEditorStore.getState().duplicateSelection()
        if (n > 0) setCopyNote(`노드 ${n}개 복제됨`)
      } else if (is(e, 'KeyF', 'f')) { // 노드 검색
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const canUndo = useEditorStore((s) => s.past.length > 0)
  const canRedo = useEditorStore((s) => s.future.length > 0)
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)

  useEffect(() => {
    if (flowQuery.data) loadGraph(flowQuery.data.id, flowQuery.data.name, flowQuery.data.graph)
  }, [flowQuery.data, loadGraph])

  // 이탈 경고 — 미저장 편집 또는 실행 중(탭을 닫으면 실행이 끊긴다)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty || running) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, running])

  const save = useMutation({
    mutationFn: () => flowsApi.saveVersion(flowId, { graph: getGraph() }),
    onSuccess: () => { markSaved(); presence.sendSaved() },
    onError: (e) => {
      if (isAxiosError(e) && e.response?.status === 409) setSaveConflict(true)
      else toast(`저장 실패: ${e instanceof Error ? e.message : e}`, 'error')
    },
  })
  // Ctrl+S 가 최신 상태(dirty/isPending)를 보고 저장하게 매 렌더 갱신 — 저장 버튼과 동일 조건
  useEffect(() => {
    saveShortcutRef.current = () => {
      if (canEdit && !save.isPending && useEditorStore.getState().dirty) save.mutate()
    }
  })
  // 자동 저장 — 켜져 있으면 dirty 후 1.5초 뒤 저장(연속 편집은 debounce). 편집 권한/저장중 아닐 때만.
  useEffect(() => {
    if (!autosave || !canEdit || !dirty || save.isPending) return
    const t = setTimeout(() => { if (useEditorStore.getState().dirty) save.mutate() }, 1500)
    return () => clearTimeout(t)
  }, [autosave, canEdit, dirty, save])

  const onRun = async () => {
    if (!canEdit) return
    setShowLog(true)
    setRunning(true)
    setExecution(null)
    setWaitStatus(null)
    const stop = new AbortController()
    stopRef.current = stop
    const setWaitingNode = useEditorStore.getState().setWaitingNode
    try {
      if (useEditorStore.getState().dirty) await save.mutateAsync()

      // 비동기 실행: POST 는 즉시 RUNNING 을 반환하고, 이 루프가 폴링 드라이버가 된다 —
      // 폴링 스냅샷이 실행 경과 애니메이션(runView)도 함께 구동한다(별도 baseline 폴러 불필요).
      // pending(브라우저 협업 지점)을 만나면 처리 후 resume(즉시 반환) → 다시 폴링으로 다음 상태를 감지.
      let detail = await runsApi.run(flowId)
      setExecution(detail)
      let guard = 0
      let waitBannerNode: string | null = null
      let pollFailures = 0 // 연속 폴링 실패(백엔드 재시작 등 일시 장애) — 임계까지는 추적 유지(P2 내구성)
      // ⏹/플로우 전환 abort 를 Promise 로도 대기 — input 모달처럼 사용자 상호작용에 갇힌 지점도 즉시 깨우기
      const aborted = new Promise<'__abort__'>((resolve) => {
        if (stop.signal.aborted) resolve('__abort__')
        else stop.signal.addEventListener('abort', () => resolve('__abort__'), { once: true })
      })
      while (guard++ < 5000) {
        if (detail.status !== 'RUNNING' && detail.status !== 'WAITING') break // 종료(SUCCEEDED/FAILED/CANCELLED)

        // ⏹ 중단 — pending 지점이면 그 노드를 중단 사유로 재개해 CANCELLED 로 마감.
        // (노드 실행 도중이면 취소 API 가 없어 백엔드는 이어 진행 — 화면만 멈춘다)
        if (stop.signal.aborted) {
          // 플로우 전환으로 인한 abort 면 UI 갱신은 새 플로우 몫 — 취소 resume 만 보내고 화면은 안 건드린다
          const switched = flowIdRef.current !== flowId
          // 최신 스냅샷으로 pending 노드를 다시 확인 — 마지막 폴링 이후 다음 대기 지점으로 넘어갔을 수 있어
          // 낡은 nodeId 로 resume 하면 claim 이 어긋나 취소가 무산된다(실패는 무시하고 기존 값 폴백)
          try { detail = await runsApi.get(detail.id) } catch { /* 스냅샷 갱신 실패 — 기존 detail 사용 */ }
          const nodeId = detail.pendingForm?.nodeId ?? detail.pendingWait?.nodeId ?? detail.pendingInput?.nodeId ?? detail.pendingClient?.nodeId
          if (nodeId) {
            await runsApi.resume(detail.id, { nodeId, error: '실행이 중단되었습니다.', aborted: true })
            // 취소 확정(비동기 재개)을 짧게 폴링 — 같은 플로우를 계속 보고 있을 때만 화면 반영
            if (!switched) {
              for (let i = 0; i < 20; i++) {
                await sleep(300)
                detail = await runsApi.get(detail.id)
                setExecution(detail)
                if (detail.status !== 'RUNNING' && detail.status !== 'WAITING') break
              }
            }
          }
          break
        }

        if (detail.pendingInput) {
          // 사용자 입력 대기: 모달에 값 입력 → confirm 값이 노드 출력. 취소는 실행 중단.
          // ⏹/플로우 전환 abort 도 함께 대기 — 모달에 갇혀 중단 버튼이 먹통되지 않게(먼저 오는 것 채택)
          const pi = detail.pendingInput
          const values = await Promise.race([askInput(pi), aborted])
          if (values === '__abort__') { resolveInput(null); continue } // 루프 상단 중단 처리로
          await runsApi.resume(detail.id, values === null
            ? { nodeId: pi.nodeId, error: '사용자가 입력을 취소했습니다.', aborted: true }
            : { nodeId: pi.nodeId, formValues: values })
        } else if (detail.pendingForm) {
          const pf = detail.pendingForm
          // 노드의 표시 모드에 따라 팝업 창 또는 페이지 내 iframe 모달로 결제창을 연다.
          const fnode = useEditorStore.getState().nodes.find((n) => n.id === pf.nodeId)
          const display = (fnode?.data as { formDisplay?: string } | undefined)?.formDisplay
          const err = display === 'iframe' ? openFormIframe(pf) : openFormPopup(pf)
          await runsApi.resume(detail.id, err
            ? { nodeId: pf.nodeId, error: err }
            : { nodeId: pf.nodeId, popupOpened: true })
        } else if (detail.pendingClient) {
          const resumeBody = await callClientRequest(detail.pendingClient)
          await runsApi.resume(detail.id, resumeBody)
        }

        // wait 배너/펄스 — pendingWait 가 보이는 동안 유지(콜백/타임아웃은 백엔드가 자가 재개)
        const pw = detail.pendingWait
        if (pw?.nodeId && pw.nodeId !== waitBannerNode) {
          waitBannerNode = pw.nodeId
          setWaitingNode(pw.nodeId)
          setWaitStatus({
            nodeId: pw.nodeId,
            nodeName: pw.nodeName,
            receiveUrl: pw.receiveUrl ?? null,
            deadline: Date.now() + pw.timeoutSec * 1000,
          })
        } else if (!pw && waitBannerNode) {
          waitBannerNode = null
          setWaitStatus(null)
          setWaitingNode(null)
        }

        await sleep(detail.pendingWait ? 1000 : 400, stop.signal)
        if (stop.signal.aborted) continue // 루프 상단의 중단 처리로
        // 폴링 GET 은 일시 장애(백엔드 재시작 등)를 견딘다 — 실행은 DB 에 내구(P2)하므로 몇 번 실패해도
        // 마지막 스냅샷을 유지하고 계속 폴링, 연속 임계 초과 시에만 포기(재시작 중 추적 유실 방지).
        try {
          const next = await runsApi.get(detail.id)
          pollFailures = 0
          detail = next
          setExecution(detail)
        } catch (e) {
          if (++pollFailures >= 10) throw e
        }
      }
    } catch (e) {
      // 저장 409 는 save.onError 가 충돌 다이얼로그로 안내 — 여기선 중복 토스트만 피한다
      if (!(isAxiosError(e) && e.response?.status === 409)) {
        toast(`실행 실패: ${isAxiosError(e) ? (e.response?.data as { message?: string })?.message ?? e.message : e instanceof Error ? e.message : e}`, 'error')
      }
      setExecution(null)
    } finally {
      stopRef.current = null
      setWaitingNode(null)
      setWaitStatus(null)
      inputResolverRef.current = null
      setPendingInput(null)
      setRunning(false)
    }
  }

  // ⏹ 실행 중단 — wait 대기를 즉시 해제하고 실행을 CANCELLED 로 마감한다.
  const onStop = () => stopRef.current?.abort()

  if (flowQuery.isLoading) return <div style={{ padding: 40, color: 'var(--fl-text-muted)' }}>불러오는 중…</div>
  if (flowQuery.isError) return <div style={{ padding: 40, color: 'var(--fl-fail)' }}>워크플로를 불러오지 못했습니다. 백엔드(18080)를 확인하세요.</div>

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--fl-bg)', overflow: 'hidden' }}>
      {/* top-bar */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)' }}>
        {/* ← 는 홈이 아니라 이 워크플로가 담긴 폴더로 — 탐색기에서 온 흐름 유지 */}
        <Link
          to={flowQuery.data?.folderId ? `/flows?folder=${flowQuery.data.folderId}` : '/flows'}
          aria-label="워크플로 목록"
          style={{ textDecoration: 'none', color: 'var(--fl-text-muted)', fontSize: 18 }}
        >←</Link>
        <input
          aria-label="워크플로 이름"
          className="fl-name-input"
          value={flowName}
          onChange={(e) => setName(e.target.value)}
          title="워크플로 이름 — 눌러서 편집"
          style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15, border: '1px solid transparent', borderRadius: 8, padding: '6px 8px', background: 'transparent', color: 'var(--fl-text)', minWidth: 220 }}
        />
        <span style={{ fontSize: 12, color: dirty ? 'var(--fl-put)' : 'var(--fl-text-muted)' }}>{dirty ? '● 미저장' : '저장됨'}</span>
        {isViewer && (
          <span title="viewer 역할은 조회만 가능합니다 — 저장/실행이 비활성화됩니다"
            style={{ fontSize: 12, fontWeight: 600, color: 'var(--fl-waiting)', border: '1px solid var(--fl-waiting)', borderRadius: 'var(--fl-radius-pill)', padding: '2px 8px' }}>
            읽기 전용
          </span>
        )}
        {copyNote && <span role="status" style={{ fontSize: 12, color: 'var(--fl-primary)', fontWeight: 600 }}>{copyNote}</span>}
        <span title="노드 수" style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>노드 {nodeCount}</span>
        <PresenceAvatars />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, position: 'relative' }}>
          <button onClick={undo} disabled={!canUndo} aria-label="되돌리기" title="되돌리기 (Ctrl+Z)" style={{ ...ghostBtn, padding: '8px 11px', opacity: canUndo ? 1 : 0.4 }}>↺</button>
          <button onClick={redo} disabled={!canRedo} aria-label="다시 실행" title="다시 실행 (Ctrl+Shift+Z)" style={{ ...ghostBtn, padding: '8px 11px', opacity: canRedo ? 1 : 0.4 }}>↻</button>
          <button onClick={() => setToolsOpen((v) => !v)} title="도구" aria-label="도구 메뉴" style={{ ...ghostBtn, padding: '8px 11px' }}>⋯ 도구</button>
          {toolsOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setToolsOpen(false)} />
              <div style={toolsMenu}>
                <button style={toolItem} onClick={() => { autoLayout(); setToolsOpen(false) }}>⇥ 자동 정렬</button>
                <button style={{ ...toolItem, opacity: canEdit && !running ? 1 : 0.4 }} disabled={!canEdit || running} onClick={() => { onRun(); setToolsOpen(false) }}>▶ 재실행</button>
                <button style={toolItem} onClick={() => { toggleZen(); setToolsOpen(false) }}>{zen ? '◱ 집중 모드 끄기' : '⛶ 집중 모드'}</button>
                <button style={toolItem} onClick={() => { setSearchOpen(true); setToolsOpen(false) }}>🔍 노드 검색 (Ctrl+F)</button>
                <button style={toolItem} onClick={() => { setJsonOpen(true); setToolsOpen(false) }}>{'{ } 그래프 JSON 보기'}</button>
                <button style={toolItem} onClick={() => { setAutosave((v) => { persistUI('fl:editor:autosave', v ? '0' : '1'); return !v }); setToolsOpen(false) }}>{autosave ? '☑ 자동 저장 켜짐' : '☐ 자동 저장'}</button>
                <button style={toolItem} onClick={() => { resetPanels(); setToolsOpen(false) }}>↺ 패널 크기 리셋</button>
                <button style={toolItem} onClick={() => { setShortcutsOpen(true); setToolsOpen(false) }}>⌨ 단축키 도움말</button>
              </div>
            </>
          )}
          <button onClick={() => setShowApiImport(true)} disabled={!canEdit} style={{ ...ghostBtn, opacity: canEdit ? 1 : 0.4 }} title="OpenAPI/Swagger 스펙에서 노드 가져오기 (팔레트에 추가)">API 가져오기</button>
          <button onClick={() => setWorkflowIO('import')} disabled={!canEdit} style={{ ...ghostBtn, opacity: canEdit ? 1 : 0.4 }}>가져오기</button>
          <button onClick={() => setWorkflowIO('export')} style={ghostBtn}>내보내기</button>
          {running && <button onClick={onStop} style={stopBtn} title="실행 중단 — 대기 중이면 즉시 해제됩니다">⏹ 중단</button>}
          <button onClick={() => onRun()} disabled={running || !canEdit} title={canEdit ? undefined : 'viewer 역할은 실행할 수 없습니다'} style={runBtn}>{running ? '실행 중…' : '▶ 실행'}</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !dirty || !canEdit} title={canEdit ? undefined : 'viewer 역할은 저장할 수 없습니다'} style={saveBtn}>💾 저장</button>
        </div>
      </header>

      <ReactFlowProvider>
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
          {!paletteCollapsed ? (
            <>
              <Palette width={paletteW} onCollapse={() => { setPaletteCollapsed(true); persistUI('fl:editor:palColl', '1') }} />
              <ResizeHandle axis="x" sign={1} size={paletteW} min={160} max={maxPaletteW} defaultSize={200} onResize={setPaletteW} onResizeEnd={(n) => saveSize('paletteW', n)} ariaLabel="팔레트 너비 조절" />
            </>
          ) : (
            <button onClick={() => { setPaletteCollapsed(false); persistUI('fl:editor:palColl', '0') }} title="노드 팔레트 펼치기" aria-label="노드 팔레트 펼치기" style={expandStrip}>»</button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <FlowCanvas />
          </div>
          {propCollapsed ? (
            <button onClick={() => { setPropCollapsed(false); persistUI('fl:editor:propColl', '0') }} title="속성 패널 펼치기" aria-label="속성 패널 펼치기" style={expandStrip}>«</button>
          ) : (
            <>
              <ResizeHandle axis="x" sign={-1} size={propertyW} min={300} max={maxPropertyW} defaultSize={330} onResize={setPropertyW} onResizeEnd={(n) => saveSize('propertyW', n)} ariaLabel="속성 패널 너비 조절" />
              <PropertyPanel width={propertyW}
                onExpand={() => setPropModal(true)}
                onCollapse={() => { setPropCollapsed(true); persistUI('fl:editor:propColl', '1') }} />
            </>
          )}
        </div>
        {showLog && (
          <>
            <ResizeHandle axis="y" sign={-1} size={runH} min={120} max={maxRunH} defaultSize={260} onResize={setRunH} onResizeEnd={(n) => saveSize('runH', n)} ariaLabel="실행 로그 높이 조절" />
            <RunPanel execution={execution} running={running} waitStatus={waitStatus} onStop={onStop} height={runH} onClose={() => setShowLog(false)} />
          </>
        )}
        {/* 넓은 모달 편집 — 좁은 사이드가 불편할 때. 배경/Esc 로 닫으면 도킹으로 복귀 */}
        {propModal && (
          <div style={modalBackdrop} onClick={() => setPropModal(false)} role="presentation">
            <div style={modalCard} onClick={(e) => e.stopPropagation()}>
              <PropertyPanel width={760} modal onCloseModal={() => setPropModal(false)} />
            </div>
          </div>
        )}
        {jsonOpen && <JsonViewModal graph={getGraph()} onClose={() => setJsonOpen(false)} />}
        {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
        {searchOpen && <NodeSearch onClose={() => setSearchOpen(false)} />}
      </ReactFlowProvider>

      {pendingInput && (
        <InputPromptDialog
          input={pendingInput}
          onConfirm={(values) => resolveInput(values)}
          onCancel={() => resolveInput(null)}
        />
      )}
      {saveConflict && (
        <ConflictDialog
          onRetry={() => save.mutate()}
          onReload={() => { void flowQuery.refetch() }}
          onClose={() => setSaveConflict(false)}
        />
      )}
      {showApiImport && <OpenApiImportDialog onClose={() => setShowApiImport(false)} onImport={(group) => addPaletteGroup(group)} />}
      {workflowIO && (
        <WorkflowIODialog
          getGraph={getGraph}
          flowName={flowName}
          initialTab={workflowIO}
          onImport={(g) => importGraph(g)}
          onClose={() => setWorkflowIO(null)}
        />
      )}
    </div>
  )
}

// 폴링 간격용 sleep — 중단 시그널이 오면 즉시 깨어난다(⏹ 반응성).
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

// 패널 크기 지속(localStorage). 잘못된 값/예외는 기본값, 범위 밖이면 min/max 로 클램프.
function loadSize(key: string, dflt: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem('fl:editor:' + key))
    if (!Number.isFinite(v) || v <= 0) return dflt
    return Math.min(max, Math.max(min, v))
  } catch {
    return dflt
  }
}
function saveSize(key: string, v: number) {
  try {
    localStorage.setItem('fl:editor:' + key, String(Math.round(v)))
  } catch {
    /* 저장 불가(프라이빗 모드 등) 무시 */
  }
}

// client(클라이언트→서버) 모드: 브라우저에서 직접 API를 호출하고 결과를 resume 페이로드로 만든다.
// (서버는 호출하지 않으므로 브라우저의 동일출처/CORS 정책이 그대로 적용된다.)
async function callClientRequest(p: PendingClientRequest): Promise<ResumeRequest> {
  const t0 = performance.now()
  const hasBody = p.body != null && p.method !== 'GET' && p.method !== 'HEAD'
  try {
    const res = await fetch(p.url, {
      method: p.method,
      headers: p.headers,
      body: hasBody ? p.body ?? undefined : undefined,
    })
    const text = await res.text()
    return { nodeId: p.nodeId, status: res.status, body: text, durationMs: Math.round(performance.now() - t0) }
  } catch (e) {
    return {
      nodeId: p.nodeId,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
      durationMs: Math.round(performance.now() - t0),
    }
  }
}

const ghostBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', padding: '8px 14px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, fontWeight: 600, textDecoration: 'none', cursor: 'pointer' }
const runBtn: CSSProperties = { ...ghostBtn, border: 'none', background: 'var(--fl-ok)', color: '#fff' }
const stopBtn: CSSProperties = { ...ghostBtn, border: 'none', background: 'var(--fl-fail)', color: '#fff' }
const saveBtn: CSSProperties = { ...ghostBtn, border: 'none', background: 'var(--fl-primary)', color: '#fff' }
// 접힌 사이드바를 펼치는 얇은 세로 바
const expandStrip: CSSProperties = { width: 22, flexShrink: 0, border: 'none', borderLeft: '1px solid var(--fl-border)', borderRight: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }
// 넓은 속성 편집 모달(배경 딤 + 중앙 카드)
const modalBackdrop: CSSProperties = { position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--fl-bg) 55%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 250, padding: 24 }
const modalCard: CSSProperties = { width: 'min(760px, 94vw)', height: 'min(85vh, 900px)', display: 'flex', flexDirection: 'column', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', boxShadow: 'var(--fl-shadow-lg)', overflow: 'hidden' }
// 도구 드롭다운 메뉴
const toolsMenu: CSSProperties = { position: 'absolute', top: '110%', right: 0, zIndex: 91, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', minWidth: 200, padding: 4 }
const toolItem: CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12.5, borderRadius: 6 }
const mHeader: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--fl-border)' }
const mTitle: CSSProperties = { flex: 1, fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 14 }

// 그래프 JSON 보기/복사
function JsonViewModal({ graph, onClose }: { graph: object; onClose: () => void }) {
  const json = useMemo(() => JSON.stringify(graph, null, 2), [graph])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div style={modalBackdrop} onClick={onClose} role="presentation">
      <div style={{ ...modalCard, height: 'min(80vh, 800px)' }} onClick={(e) => e.stopPropagation()}>
        <header style={mHeader}>
          <span style={mTitle}>그래프 JSON</span>
          <button style={ghostBtn} onClick={() => { void navigator.clipboard?.writeText(json).catch(() => {}); toast('JSON 복사됨', 'ok') }}>복사</button>
          <button style={{ ...ghostBtn, padding: '8px 11px' }} onClick={onClose} aria-label="닫기">×</button>
        </header>
        <pre style={{ margin: 0, flex: 1, overflow: 'auto', padding: 16, fontSize: 12, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text)', whiteSpace: 'pre' }}>{json}</pre>
      </div>
    </div>
  )
}

// 키보드 단축키 도움말
function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['Ctrl/⌘ + S', '저장'], ['Ctrl/⌘ + Z', '되돌리기'], ['Ctrl/⌘ + Shift + Z', '다시 실행'],
    ['Ctrl/⌘ + C / V', '노드 복사 / 붙여넣기(워크플로 간)'], ['Ctrl/⌘ + D', '선택 노드 복제'],
    ['Ctrl/⌘ + F', '노드 검색'], ['Delete / Backspace', '노드·연결 삭제'],
    ['우클릭', '노드 컨텍스트 메뉴(실행/복제/삭제)'], ['Esc', '모달·피커 닫기'],
  ]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div style={modalBackdrop} onClick={onClose} role="presentation">
      <div style={{ ...modalCard, height: 'auto', maxHeight: '80vh', width: 'min(440px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
        <header style={mHeader}><span style={mTitle}>키보드 단축키</span><button style={{ ...ghostBtn, padding: '8px 11px' }} onClick={onClose} aria-label="닫기">×</button></header>
        <div style={{ padding: 16, overflow: 'auto' }}>
          {rows.map(([k, d]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--fl-border)' }}>
              <kbd style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, color: 'var(--fl-primary)' }}>{k}</kbd>
              <span style={{ fontSize: 12.5, color: 'var(--fl-text-muted)' }}>{d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// 노드 검색 — 이름/타입/id 로 찾아 선택하고 캔버스를 그 노드로 이동
function NodeSearch({ onClose }: { onClose: () => void }) {
  const nodes = useEditorStore((s) => s.nodes)
  const selectNode = useEditorStore((s) => s.selectNode)
  const { setCenter } = useReactFlow()
  const [q, setQ] = useState('')
  const results = useMemo(() => {
    const query = q.trim().toLowerCase()
    return nodes.filter((n) => {
      const d = n.data as { name?: string; type?: string }
      if (d.type === 'note' || d.type === 'group') return false
      if (!query) return true
      return (d.name ?? '').toLowerCase().includes(query) || (d.type ?? '').includes(query) || n.id.toLowerCase().includes(query)
    }).slice(0, 8)
  }, [nodes, q])
  const pick = (n: { id: string; position: { x: number; y: number } }) => {
    selectNode(n.id)
    setCenter(n.position.x + 115, n.position.y + 44, { zoom: 1, duration: 300 })
    onClose()
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 250, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh' }} onClick={onClose} role="presentation">
      <div style={{ width: 'min(460px, 92vw)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', boxShadow: 'var(--fl-shadow-lg)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && results[0]) pick(results[0]) }}
          placeholder="노드 이름·타입으로 검색 (Enter=첫 결과)"
          style={{ width: '100%', padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--fl-border)', background: 'transparent', color: 'var(--fl-text)', fontSize: 14, outline: 'none' }} />
        <div style={{ maxHeight: 300, overflow: 'auto' }}>
          {results.length === 0 && <div style={{ padding: 14, fontSize: 12.5, color: 'var(--fl-text-muted)' }}>일치하는 노드 없음</div>}
          {results.map((n) => {
            const d = n.data as { name?: string; type?: string; cat?: string }
            return (
              <button key={n.id} onClick={() => pick(n)} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '9px 14px', border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 13 }}>
                <span aria-hidden style={{ color: catColor(d.cat), width: 16, textAlign: 'center' }}>{typeIcon(d.type ?? '')}</span>
                <span style={{ fontWeight: 600 }}>{d.name || d.type}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{typeLabel(d.type ?? '')}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
