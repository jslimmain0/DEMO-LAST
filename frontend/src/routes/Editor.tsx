import { ReactFlowProvider } from '@xyflow/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ExecutionDetail, PendingClientRequest, PendingInputRequest, ResumeRequest } from '../api/types'
import { flowsApi, runsApi } from '../api/client'
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
import { toast } from '../components/toast'
import { usePermissions } from '../auth/AuthContext'
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
  const [execution, setExecution] = useState<ExecutionDetail | null>(null)
  const [running, setRunning] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [saveConflict, setSaveConflict] = useState(false)
  const [showApiImport, setShowApiImport] = useState(false)
  const [workflowIO, setWorkflowIO] = useState<'export' | 'import' | null>(null)
  // wait(콜백 대기) 진행 상태 — RunPanel 카운트다운/수신 URL 표시용
  const [waitStatus, setWaitStatus] = useState<WaitStatus | null>(null)
  const stopRef = useRef<AbortController | null>(null)
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
    onSuccess: () => markSaved(),
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
      while (guard++ < 5000) {
        if (detail.status !== 'RUNNING' && detail.status !== 'WAITING') break // 종료(SUCCEEDED/FAILED/CANCELLED)

        // ⏹ 중단 — pending 지점이면 그 노드를 중단 사유로 재개해 CANCELLED 로 마감.
        // (노드 실행 도중이면 취소 API 가 없어 백엔드는 이어 진행 — 화면만 멈춘다)
        if (stop.signal.aborted) {
          const nodeId = detail.pendingForm?.nodeId ?? detail.pendingWait?.nodeId ?? detail.pendingInput?.nodeId ?? detail.pendingClient?.nodeId
          if (nodeId) {
            await runsApi.resume(detail.id, { nodeId, error: '실행이 중단되었습니다.', aborted: true })
            // 취소 확정(비동기 재개)을 짧게 폴링
            for (let i = 0; i < 20; i++) {
              await sleep(300)
              detail = await runsApi.get(detail.id)
              setExecution(detail)
              if (detail.status !== 'RUNNING' && detail.status !== 'WAITING') break
            }
          }
          break
        }

        if (detail.pendingInput) {
          // 사용자 입력 대기: 모달에 값 입력 → confirm 값이 노드 출력. 취소는 실행 중단.
          const pi = detail.pendingInput
          const values = await askInput(pi)
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
        detail = await runsApi.get(detail.id)
        setExecution(detail)
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={undo} disabled={!canUndo} aria-label="되돌리기" title="되돌리기 (Ctrl+Z)" style={{ ...ghostBtn, padding: '8px 11px', opacity: canUndo ? 1 : 0.4 }}>↺</button>
          <button onClick={redo} disabled={!canRedo} aria-label="다시 실행" title="다시 실행 (Ctrl+Shift+Z)" style={{ ...ghostBtn, padding: '8px 11px', opacity: canRedo ? 1 : 0.4 }}>↻</button>
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
          <Palette width={paletteW} />
          <ResizeHandle axis="x" sign={1} size={paletteW} min={160} max={maxPaletteW} defaultSize={200} onResize={setPaletteW} onResizeEnd={(n) => saveSize('paletteW', n)} ariaLabel="팔레트 너비 조절" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <FlowCanvas />
          </div>
          <ResizeHandle axis="x" sign={-1} size={propertyW} min={300} max={maxPropertyW} defaultSize={330} onResize={setPropertyW} onResizeEnd={(n) => saveSize('propertyW', n)} ariaLabel="속성 패널 너비 조절" />
          <PropertyPanel width={propertyW} />
        </div>
        {showLog && (
          <>
            <ResizeHandle axis="y" sign={-1} size={runH} min={120} max={maxRunH} defaultSize={260} onResize={setRunH} onResizeEnd={(n) => saveSize('runH', n)} ariaLabel="실행 로그 높이 조절" />
            <RunPanel execution={execution} running={running} waitStatus={waitStatus} onStop={onStop} height={runH} onClose={() => setShowLog(false)} />
          </>
        )}
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
