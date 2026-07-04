import { ReactFlowProvider } from '@xyflow/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ExecutionDetail, PendingClientRequest, PendingInputRequest, PendingWaitRequest, ResumeRequest, RunRequest } from '../api/types'
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
import { openFormPopup } from '../lib/popup'
import { RelaySession } from '../lib/relay'
import type { RelayEvent } from '../lib/relay'
import { useEditorStore } from '../store/editorStore'

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

  const [execution, setExecution] = useState<ExecutionDetail | null>(null)
  const [running, setRunning] = useState(false)
  const [showLog, setShowLog] = useState(false)
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
  })

  const onRun = async () => {
    setShowLog(true)
    setRunning(true)
    setExecution(null)
    setWaitStatus(null)
    const stop = new AbortController()
    stopRef.current = stop
    let relay: RelaySession | null = null
    const setWaitingNode = useEditorStore.getState().setWaitingNode
    try {
      if (useEditorStore.getState().dirty) await save.mutateAsync()

      // wait 노드가 하나라도 있으면 실행 시작 시점에 relay 에 응답 설정을 등록하고 SSE 를 연결한다.
      // 실패는 즉시 실패가 아니라 기억 — wait 노드에 도달했을 때 그 에러로 실패시킨다.
      const graph = getGraph()
      const waitNodes = graph.nodes.filter((n) => n.type === 'wait')
      let runBody: RunRequest = {}
      if (waitNodes.length > 0) {
        relay = new RelaySession()
        await relay.start(waitNodes)
        if (!relay.error) runBody = { relayRunId: relay.runId, relayBase: relay.base }
      }

      let detail = await runsApi.run(flowId, runBody)
      setExecution(detail)
      // 서버가 중단(WAITING)하며 넘기는 지점을 처리하고 resume 으로 이어가길 반복:
      //  - pendingForm: 팝업 열고 form 자동 submit → 즉시 재개(기다리지 않음)
      //  - pendingWait: relay 콜백(버퍼/SSE) 소비 또는 타임아웃/중단 → 재개
      //  - pendingClient: 브라우저가 직접 API 호출 → 결과 전송
      let guard = 0
      while ((detail.pendingClient || detail.pendingForm || detail.pendingWait || detail.pendingInput) && guard++ < 100) {
        // ⏹ 중단은 wait 대기뿐 아니라 어느 중단 지점에서도 존중 — 대기 중인 노드를 중단 사유로 재개해 CANCELLED 로 마감
        if (stop.signal.aborted) {
          const nodeId = detail.pendingForm?.nodeId ?? detail.pendingWait?.nodeId ?? detail.pendingInput?.nodeId ?? detail.pendingClient?.nodeId
          detail = await runsApi.resume(detail.id, { nodeId, error: '실행이 중단되었습니다.', aborted: true })
          setExecution(detail)
          break
        }
        if (detail.pendingInput) {
          // 사용자 입력 대기: 모달에 값 입력 → confirm 값이 노드 출력. 취소는 실행 중단.
          const pi = detail.pendingInput
          const values = await askInput(pi)
          detail = await runsApi.resume(detail.id, values === null
            ? { nodeId: pi.nodeId, error: '사용자가 입력을 취소했습니다.', aborted: true }
            : { nodeId: pi.nodeId, formValues: values })
        } else if (detail.pendingForm) {
          const pf = detail.pendingForm
          const err = openFormPopup(pf)
          detail = await runsApi.resume(detail.id, err
            ? { nodeId: pf.nodeId, error: err }
            : { nodeId: pf.nodeId, popupOpened: true })
        } else if (detail.pendingWait) {
          const pw = detail.pendingWait
          if (!relay || relay.error) {
            const err = relay?.error ?? 'relay 미연결 — 콜백 대기 노드를 실행할 수 없습니다.'
            detail = await runsApi.resume(detail.id, { nodeId: pw.nodeId, error: err })
          } else {
            setWaitingNode(pw.nodeId)
            const deadline = Date.now() + pw.timeoutSec * 1000
            setWaitStatus({ nodeId: pw.nodeId, nodeName: pw.nodeName, receiveUrl: pw.receiveUrl ?? relay.urlFor(pw.nodeId), deadline })
            const result = await waitForCallback(relay, pw, deadline, stop.signal)
            setWaitStatus(null)
            setWaitingNode(null)
            detail = await runsApi.resume(detail.id, resumeForWait(pw, result))
          }
        } else if (detail.pendingClient) {
          const resumeBody = await callClientRequest(detail.pendingClient)
          detail = await runsApi.resume(detail.id, resumeBody)
        }
        setExecution(detail)
      }
    } catch {
      setExecution(null)
    } finally {
      relay?.close()
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
        <Link to="/flows" aria-label="워크플로 목록" style={{ textDecoration: 'none', color: 'var(--fl-text-muted)', fontSize: 18 }}>←</Link>
        <input
          aria-label="워크플로 이름"
          className="fl-name-input"
          value={flowName}
          onChange={(e) => setName(e.target.value)}
          title="워크플로 이름 — 눌러서 편집"
          style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15, border: '1px solid transparent', borderRadius: 8, padding: '6px 8px', background: 'transparent', color: 'var(--fl-text)', minWidth: 220 }}
        />
        <span style={{ fontSize: 12, color: dirty ? 'var(--fl-put)' : 'var(--fl-text-muted)' }}>{dirty ? '● 미저장' : '저장됨'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setShowApiImport(true)} style={ghostBtn} title="OpenAPI/Swagger 스펙에서 노드 가져오기 (팔레트에 추가)">API 가져오기</button>
          <button onClick={() => setWorkflowIO('import')} style={ghostBtn}>가져오기</button>
          <button onClick={() => setWorkflowIO('export')} style={ghostBtn}>내보내기</button>
          {running && <button onClick={onStop} style={stopBtn} title="실행 중단 — 대기 중이면 즉시 해제됩니다">⏹ 중단</button>}
          <button onClick={() => onRun()} disabled={running} style={runBtn}>{running ? '실행 중…' : '▶ 실행'}</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !dirty} style={saveBtn}>💾 저장</button>
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

// --- wait(콜백 대기) 처리 ---

type WaitOutcome = { kind: 'callback'; ev: RelayEvent } | { kind: 'timeout' } | { kind: 'aborted' }

/** relay 콜백(버퍼/SSE) · 타임아웃 · 사용자 중단(⏹) 중 먼저 오는 것 하나로 낙착. */
function waitForCallback(relay: RelaySession, pw: PendingWaitRequest, deadline: number, signal: AbortSignal): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    let done = false
    const finish = (r: WaitOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (r.kind !== 'callback') relay.cancelWait(pw.nodeId) // 늦은 콜백은 버퍼로
      resolve(r)
    }
    const timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, deadline - Date.now()))
    const onAbort = () => finish({ kind: 'aborted' })
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    void relay.take(pw.nodeId).then((ev) => finish({ kind: 'callback', ev }))
  })
}

function resumeForWait(pw: PendingWaitRequest, result: WaitOutcome): ResumeRequest {
  if (result.kind === 'callback') {
    const ev = result.ev
    return {
      nodeId: pw.nodeId,
      callback: { method: ev.method, url: ev.url, headers: ev.headers, body: ev.body },
    }
  }
  if (result.kind === 'timeout') {
    return { nodeId: pw.nodeId, error: `타임아웃 — ${pw.timeoutSec}초 동안 콜백이 오지 않았습니다.` }
  }
  return { nodeId: pw.nodeId, error: '실행이 중단되었습니다.', aborted: true }
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
