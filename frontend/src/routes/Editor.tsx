import { ReactFlowProvider } from '@xyflow/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { ExecutionDetail, PendingClientRequest, PendingFormRequest, PendingInputRequest, ResumeRequest } from '../api/types'
import { flowsApi, runsApi } from '../api/client'
import { FlowCanvas } from '../canvas/FlowCanvas'
import { Palette } from '../canvas/Palette'
import { PropertyPanel } from '../panels/PropertyPanel'
import { RunPanel } from '../panels/RunPanel'
import { OpenApiImportDialog } from '../openapi/OpenApiImportDialog'
import { WorkflowIODialog } from '../openapi/WorkflowIODialog'
import { FormPopupDialog } from '../components/FormPopupDialog'
import { InputPromptDialog } from '../components/InputPromptDialog'
import { ResizeHandle } from '../components/ResizeHandle'
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
  const setWaitingNode = useEditorStore((s) => s.setWaitingNode)

  const [execution, setExecution] = useState<ExecutionDetail | null>(null)
  const [running, setRunning] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [showApiImport, setShowApiImport] = useState(false)
  const [workflowIO, setWorkflowIO] = useState<'export' | 'import' | null>(null)
  // 폼 전송(fire-and-forget) 팝업 — submit 완료(null)/실패(에러 문자열) 또는 취소(null 리절브가 아닌 cancel)를 기다림
  const [pendingForm, setPendingForm] = useState<PendingFormRequest | null>(null)
  const formResolverRef = useRef<((r: { error: string | null } | null) => void) | null>(null)
  // 입력 대기 창 — 입력 값 또는 취소(null)
  const [pendingInput, setPendingInput] = useState<PendingInputRequest | null>(null)
  const inputResolverRef = useRef<((values: Record<string, unknown> | null) => void) | null>(null)
  // ⏹ 중단 — 폴링/루프를 다음 틱에 빠져나오게 하는 플래그
  const stopRef = useRef(false)

  // 패널 크기(좌 팔레트 / 우 속성 / 하 로그) — 드래그로 조절하고 localStorage 에 유지
  const [paletteW, setPaletteW] = useState(() => loadSize('paletteW', 200, 160, 420))
  const [propertyW, setPropertyW] = useState(() => loadSize('propertyW', 360, 300, 560))
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

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const save = useMutation({
    mutationFn: () => flowsApi.saveVersion(flowId, { graph: getGraph() }),
    onSuccess: () => markSaved(),
  })

  // 폼 팝업 submit 결과({error:null}=성공, {error:…}=실패) 또는 취소(null)를 기다린다.
  const askForm = (form: PendingFormRequest): Promise<{ error: string | null } | null> => {
    setPendingForm(form)
    return new Promise((resolve) => { formResolverRef.current = resolve })
  }
  const resolveForm = (r: { error: string | null } | null) => {
    formResolverRef.current?.(r)
    formResolverRef.current = null
    setPendingForm(null)
  }
  // 입력 대기 창의 값(또는 취소 null)을 기다린다.
  const askInput = (input: PendingInputRequest): Promise<Record<string, unknown> | null> => {
    setPendingInput(input)
    return new Promise((resolve) => { inputResolverRef.current = resolve })
  }
  const resolveInput = (values: Record<string, unknown> | null) => {
    inputResolverRef.current?.(values)
    inputResolverRef.current = null
    setPendingInput(null)
  }

  const onRun = async () => {
    setShowLog(true)
    setRunning(true)
    setExecution(null)
    stopRef.current = false
    try {
      if (useEditorStore.getState().dirty) await save.mutateAsync()
      let detail = await runsApi.run(flowId)
      setExecution(detail)
      // 서버가 중단(WAITING)하며 넘기는 지점을 처리하며 진행:
      //  - pendingForm: 팝업 열고 폼 submit(fire-and-forget) → 즉시 재개, 기다림은 다음 wait 노드 몫
      //  - pendingInput: 입력 창을 띄워 사용자 값 → 재개
      //  - pendingClient: 브라우저가 직접 API 호출 → 결과 전송
      //  - pendingWait(콜백 대기): 서버가 콜백 수신으로 스스로 재개 → 폴링으로 관전(카운트다운/타임아웃)
      let guard = 0
      while (guard++ < 500) {
        if (stopRef.current) break
        setWaitingNode(detail.pendingWait?.nodeId ?? detail.pendingInput?.nodeId ?? detail.pendingForm?.nodeId ?? null)
        if (detail.pendingForm) {
          const r = await askForm(detail.pendingForm)
          if (r === null) break // 취소 → 실행은 WAITING 상태로 남김
          detail = await runsApi.resume(detail.id, { nodeId: detail.pendingForm.nodeId, error: r.error })
        } else if (detail.pendingInput) {
          const values = await askInput(detail.pendingInput)
          if (values === null) break // 취소 → WAITING 유지(재실행으로 다시 진입)
          detail = await runsApi.resume(detail.id, { nodeId: detail.pendingInput.nodeId, formValues: values })
        } else if (detail.pendingClient) {
          const resumeBody = await callClientRequest(detail.pendingClient)
          detail = await runsApi.resume(detail.id, resumeBody)
        } else if (detail.status === 'WAITING') {
          await sleep(800)
          detail = await runsApi.get(detail.id)
        } else {
          break // SUCCEEDED / FAILED / CANCELLED
        }
        setExecution(detail)
      }
    } catch {
      setExecution(null)
    } finally {
      setRunning(false)
      setWaitingNode(null)
    }
  }

  // ⏹ 실행 중단 — 대기(콜백/입력/폼)를 즉시 해제하고 CANCELLED 로.
  const onStop = async () => {
    stopRef.current = true
    if (!execution) return
    try {
      setExecution(await runsApi.cancel(execution.id))
    } catch {
      /* 이미 종료된 실행 등 — 무시 */
    }
  }

  if (flowQuery.isLoading) return <div style={{ padding: 40, color: 'var(--fl-text-muted)' }}>불러오는 중…</div>
  if (flowQuery.isError) return <div style={{ padding: 40, color: 'var(--fl-fail)' }}>워크플로를 불러오지 못했습니다. 백엔드(18080)를 확인하세요.</div>

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--fl-bg)', overflow: 'hidden' }}>
      {/* top-bar */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)' }}>
        <Link to="/flows" aria-label="워크플로 목록" style={{ textDecoration: 'none', color: 'var(--fl-text-muted)', fontSize: 18 }}>←</Link>
        <input
          aria-label="워크플로 이름"
          value={flowName}
          onChange={(e) => setName(e.target.value)}
          style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15, border: '1px solid transparent', borderRadius: 8, padding: '6px 8px', background: 'transparent', color: 'var(--fl-text)', minWidth: 220 }}
        />
        <span style={{ fontSize: 12, color: dirty ? 'var(--fl-put)' : 'var(--fl-text-muted)' }}>{dirty ? '● 미저장' : '저장됨'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setShowApiImport(true)} style={ghostBtn} title="OpenAPI/Swagger 가져오기 (팔레트에 추가)">API</button>
          <button onClick={() => setWorkflowIO('import')} style={ghostBtn}>가져오기</button>
          <button onClick={() => setWorkflowIO('export')} style={ghostBtn}>내보내기</button>
          <button onClick={() => onRun()} disabled={running} style={runBtn}>{running ? '실행 중…' : '▶ 실행'}</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !dirty} style={saveBtn}>💾 저장</button>
        </div>
      </header>

      <ReactFlowProvider>
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
          <Palette width={paletteW} />
          <ResizeHandle axis="x" sign={1} size={paletteW} min={160} max={maxPaletteW} onResize={setPaletteW} onResizeEnd={(n) => saveSize('paletteW', n)} ariaLabel="팔레트 너비 조절" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <FlowCanvas />
          </div>
          <ResizeHandle axis="x" sign={-1} size={propertyW} min={300} max={maxPropertyW} onResize={setPropertyW} onResizeEnd={(n) => saveSize('propertyW', n)} ariaLabel="속성 패널 너비 조절" />
          <PropertyPanel width={propertyW} />
        </div>
        {showLog && (
          <>
            <ResizeHandle axis="y" sign={-1} size={runH} min={120} max={maxRunH} onResize={setRunH} onResizeEnd={(n) => saveSize('runH', n)} ariaLabel="실행 로그 높이 조절" />
            <RunPanel execution={execution} running={running} height={runH} onClose={() => setShowLog(false)} onStop={onStop} />
          </>
        )}
      </ReactFlowProvider>

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
      {pendingForm && (
        <FormPopupDialog
          form={pendingForm}
          onDone={(error) => resolveForm({ error })}
          onCancel={() => resolveForm(null)}
        />
      )}
      {pendingInput && (
        <InputPromptDialog
          input={pendingInput}
          onSubmit={(values) => resolveInput(values)}
          onCancel={() => resolveInput(null)}
        />
      )}
    </div>
  )
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
const saveBtn: CSSProperties = { ...ghostBtn, border: 'none', background: 'var(--fl-primary)', color: '#fff' }
