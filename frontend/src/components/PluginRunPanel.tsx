import { useCentralApi, useWorkspace } from '../app/WorkspaceContext'
// 플러그인 실행 패널 — 컴파일 메타로 입력 폼을 자동 생성하고, 샌드박스에서 1회 실행해 출력·콘솔·소요 시간을 보여준다.
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type { PluginScriptMeta, PluginTryRequest, PluginTryResult, ScriptErrorBody } from '../api/types'
import type { EditorDiagnostic } from './CodeEditor'
import { JsonTree } from './JsonTree'
import { TokenInput } from '../binding/TokenInput'
import { useEnvStore, useEnvironment, useEnvironmentLoadStatus } from '../lib/environments'
import { useVaultSources } from '../lib/vaultSources'
import { ui } from '../design/ui'
import { apiErrorMessage } from '../lib/apiError'

type Sample = { inputs: Record<string, string>; config: Record<string, string>; value: string; fn: 'encode' | 'decode'; direction: 'send' | 'recv'; message: string; bytesText: string; bytesMode: 'text' | 'hex' }
const EMPTY: Sample = { inputs: {}, config: {}, value: '', fn: 'encode', direction: 'send', message: '{}', bytesText: '', bytesMode: 'text' }

function loadSample(key: string): Sample { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(key) ?? '{}') } } catch { return EMPTY } }
function scriptError(e: unknown): ScriptErrorBody | null {
  const d = (e as { response?: { data?: Partial<ScriptErrorBody> } })?.response?.data
  return d && typeof d.message === 'string' && 'line' in d ? { message: d.message, line: d.line ?? null, col: d.col ?? null } : null
}
const b64 = { enc: (bytes: Uint8Array) => { let text = ''; for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768)); return btoa(text) }, dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) }
const hex = { enc: (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '), dec: (s: string) => { const value = s.replace(/\s/g, ''); if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('hex 본문은 두 자리씩 입력하세요. 예: 30 31 ff'); return Uint8Array.from((value.match(/.{2}/g) ?? []).map(h => parseInt(h, 16))) } }

function pluginTryRequest(meta: PluginScriptMeta, sample: Sample, source: string, environment?: string): PluginTryRequest {
  if (meta.kind === 'transform') return { source, inputs: sample.inputs, config: sample.config, environment }
  if (meta.kind === 'fieldCodec') {
    let message: Record<string, string>
    try { message = JSON.parse(sample.message || '{}'); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error() } catch { throw new Error('다른 필드는 JSON 객체로 입력하세요. 예: {"거래코드":"0210"}') }
    return { source, value: sample.value, fn: sample.fn, direction: sample.direction, config: sample.config, message, environment }
  }
  const bytes = sample.bytesMode === 'hex' ? hex.dec(sample.bytesText) : new TextEncoder().encode(sample.bytesText)
  return { source, fn: sample.fn, direction: sample.direction, config: sample.config, bytesB64: b64.enc(bytes), environment }
}

export const PluginRunPanel = memo(function PluginRunPanel({ source, scriptId, canRun, onDiagnostics, getSource, active = true, onRunStart }: { source: string; scriptId: string | null; canRun: boolean; onDiagnostics: (d: EditorDiagnostic[]) => void; getSource?: () => string; active?: boolean; onRunStart?: () => void }) {
  const { pluginsApi } = useCentralApi()
  const { remoteKey, connected } = useWorkspace()

  const key = `fl:plugrun:${remoteKey.replace(/:(?:true|false)$/, '')}:${scriptId ?? 'new'}`
  // {{ 이름@secret }}·{{ 키@env }} 칩 — 활성 환경 기준(서버가 시험 실행 때 그 환경으로 푼다)
  const envStore = useEnvStore('server')
  const environmentStore = useEnvironment('server')
  const environmentStatus = useEnvironmentLoadStatus('server')
  const envName = envStore.active && envStore.envs[envStore.active] ? envStore.active : null
  const envRef = useRef(envName); envRef.current = envName
  const sources = useVaultSources(envName, true)
  const [meta, setMeta] = useState<PluginScriptMeta | null>(null)
  const [compileErr, setCompileErr] = useState<string | null>(null)
  const [sample, setSample] = useState<Sample>(() => loadSample(key))
  const [result, setResult] = useState<PluginTryResult | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [compiling, setCompiling] = useState(false)
  const sourceRef = useRef(source); sourceRef.current = source
  const sampleRef = useRef(sample); sampleRef.current = sample
  const metaRef = useRef(meta); metaRef.current = meta
  const compiledSource = useRef(source)
  const resultSource = useRef<string | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const keyRef = useRef(key); keyRef.current = key
  const busyRef = useRef(false)
  const runSeq = useRef(0)
  const compileSeq = useRef(0)
  const readSource = useCallback(() => getSource?.() ?? sourceRef.current, [getSource])
  useEffect(() => { if (result && active) resultRef.current?.scrollIntoView({ block: 'nearest' }) }, [result, active])
  useEffect(() => { const next = loadSample(key); sampleRef.current = next; setSample(next); setResult(null); setRunErr(null); setMeta(null); metaRef.current = null; setCompileErr(null); busyRef.current = false; setBusy(false); compileSeq.current++; runSeq.current++ }, [key])
  useEffect(() => { const timer = setTimeout(() => { try { localStorage.setItem(key, JSON.stringify(sampleRef.current)) } catch { /* private mode */ } }, 600); return () => clearTimeout(timer) }, [key, sample])
  useEffect(() => { const sequence = runSeq; const flush = () => { try { localStorage.setItem(key, JSON.stringify(sampleRef.current)) } catch { /* private mode */ } }; window.addEventListener('beforeunload', flush); return () => { flush(); window.removeEventListener('beforeunload', flush); sequence.current++ } }, [key])

  // 타이핑 멈춤 600ms → 컴파일만(입력 없이) → 메타로 폼
  useEffect(() => {
    if (!canRun || !active || !connected) { setCompiling(false); return }
    const sequence = compileSeq
    const seq = ++compileSeq.current
    setCompiling(true)
    const t = setTimeout(() => {
      const snapshot = readSource()
      pluginsApi.tryRun({ source: snapshot }).then((r) => { if (seq !== compileSeq.current || snapshot !== readSource()) return; metaRef.current = r.meta; compiledSource.current = snapshot; setMeta(r.meta); setCompileErr(null); onDiagnostics([]) })
        .catch((e) => { if (seq !== compileSeq.current || snapshot !== readSource()) return; const se = scriptError(e); setCompileErr(se?.message ?? apiErrorMessage(e, '코드를 확인하지 못했습니다. 서버 연결 후 다시 테스트하세요.')); if (se?.line) onDiagnostics([{ line: se.line, col: se.col ?? undefined, message: se.message }]) })
        .finally(() => { if (seq === compileSeq.current) setCompiling(false) })
    }, 600)
    return () => { clearTimeout(t); sequence.current++ }
    // key: 저장으로 scriptId 가 생기면(초안→상세) 위 효과가 meta 를 비우므로 여기서 다시 컴파일해야 폼이 돌아온다
  }, [source, canRun, active, connected, onDiagnostics, key, pluginsApi, readSource])

  const run = async () => {
    if (!canRun || !connected || environmentStatus !== 'ready' || busyRef.current) return
    const snapshot = readSource(), owner = key, seq = ++runSeq.current
    const sampleSnapshot = structuredClone(sampleRef.current)
    busyRef.current = true; onRunStart?.()
    setBusy(true); setRunErr(null); setResult(null)
    try {
      await environmentStore.prepareForRun()
      let currentMeta = metaRef.current
      if (!currentMeta || compiledSource.current !== snapshot || compileErr) {
        const compiled = await pluginsApi.tryRun({ source: snapshot })
        if (owner !== keyRef.current || seq !== runSeq.current) return
        if (snapshot !== readSource()) throw new Error('코드가 바뀌었습니다. 현재 코드로 다시 테스트하세요.')
        currentMeta = compiled.meta; metaRef.current = currentMeta; compiledSource.current = snapshot; setMeta(currentMeta); setCompileErr(null)
      }
      const request = pluginTryRequest(currentMeta, sampleSnapshot, snapshot, envName ?? undefined)
      const r = await pluginsApi.tryRun(request)
      if (owner !== keyRef.current || seq !== runSeq.current) return
      if (snapshot !== readSource() || envRef.current !== envName || JSON.stringify(sampleRef.current) !== JSON.stringify(sampleSnapshot)) { setRunErr('실행 중 코드나 입력이 바뀌었습니다. 현재 내용으로 다시 테스트하세요.'); return }
      resultSource.current = snapshot
      setResult(r); onDiagnostics([])
      if (scriptId) void pluginsApi.saveSample(scriptId, JSON.stringify({ request: { ...request, source: undefined, config: undefined }, result: r })).catch(() => {})
    } catch (e) {
      if (owner !== keyRef.current || seq !== runSeq.current) return
      if (snapshot !== readSource() || envRef.current !== envName || JSON.stringify(sampleRef.current) !== JSON.stringify(sampleSnapshot)) { setRunErr('실행 중 코드나 입력이 바뀌었습니다. 현재 내용으로 다시 테스트하세요.'); return }
      const se = scriptError(e)
      setRunErr(se ? `${se.line ? `${se.line}행: ` : ''}${se.message}` : apiErrorMessage(e, '테스트에 실패했습니다. 서버 연결 상태를 확인하세요.'))
      if (se?.line) onDiagnostics([{ line: se.line, col: se.col ?? undefined, message: se.message }])
    } finally { if (owner === keyRef.current && seq === runSeq.current) { busyRef.current = false; setBusy(false) } }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.isComposing || e.keyCode === 229) return; const target = e.target as HTMLElement | null; if (!target?.closest?.('.fl-plugin-workbench') || target.closest('[role="dialog"],[role="alertdialog"]')) return; if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!canRun || !connected || environmentStatus !== 'ready') onRunStart?.(); else void run() } }
    window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, canRun, connected, envName, environmentStatus, environmentStore, compileErr, pluginsApi, scriptId, onDiagnostics, getSource, onRunStart])

  const updateSample = (update: (current: Sample) => Sample) => { const next = update(sampleRef.current); sampleRef.current = next; setSample(next); setResult(null); setRunErr(null) }
  const setIn = (k: string, v: string) => updateSample((s) => ({ ...s, inputs: { ...s.inputs, [k]: v } }))
  const setCfg = (k: string, v: string) => updateSample((s) => ({ ...s, config: { ...s.config, [k]: v } }))
  const out = result?.bytesB64 ? b64.dec(result.bytesB64) : null

  return (
    <aside className="fl-plugin-run-panel" style={panel} aria-label="실행 패널">
      <div className="fl-plugin-run-heading">
        <div className="fl-plugin-run-heading-info">
        <strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>▶ 실행해 보기</strong>
        {meta && <span style={mono} title={`${meta.id} · ${meta.kind}`}>{meta.id} · {meta.kind}</span>}
        </div>
        <button onClick={() => void run()} disabled={!canRun || !connected || environmentStatus !== 'ready' || busy} style={runBtn} title="Ctrl+Enter">{busy ? '실행 중…' : '▶ 테스트'}</button>
      </div>
      <label style={{ display: 'grid', gap: 5 }}><span style={{ ...hint, fontWeight: 600 }}>테스트 환경 · 서버</span><select aria-label="테스트 환경 · 서버" style={input} value={envName ?? ''} disabled={!canRun || !connected || environmentStatus !== 'ready' || busy} onChange={event => { environmentStore.setActiveEnv(event.target.value || null); setResult(null); setRunErr(null) }}><option value="">공통 시크릿만</option>{Object.keys(envStore.envs).sort((a, b) => a.localeCompare(b, 'ko')).map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      {!connected ? <p style={hint} role="status">서버 연결 필요</p> : environmentStatus === 'loading' ? <p style={hint} role="status">서버 환경을 불러오는 중…</p> : environmentStatus === 'error' ? <p style={{ ...hint, color: 'var(--fl-fail)' }} role="alert">서버 환경을 불러오지 못했습니다. <button style={input} onClick={() => void environmentStore.ensureEnvLoaded().catch(() => {})}>다시 불러오기</button></p> : null}
      {!canRun && connected && <div style={hint}>이 플러그인을 테스트할 권한이 없습니다.</div>}
      {compileErr && <div style={{ ...hint, color: 'var(--fl-fail)' }}>⚠ {compileErr}</div>}
      {active && compiling && <div style={hint} role="status">코드를 확인해 테스트 입력을 준비하는 중…</div>}
      {meta && (
        <div style={{ display: 'grid', gap: 6 }}>
          {meta.kind === 'transform' && meta.inputs.map((io) => (
            <label key={io.key} className="fl-plugin-run-field" style={row}><span style={lbl} title={io.key}>{io.label}</span><TokenInput value={sample.inputs[io.key] ?? ''} onChange={(v) => setIn(io.key, v)} sources={sources} placeholder={io.example || io.key} ariaLabel={`입력 ${io.key}`} /></label>
          ))}
          {meta.kind !== 'transform' && (
            <>
              <label className="fl-plugin-run-field" style={row}><span style={lbl}>방향</span>
                <span className="fl-plugin-run-direction">
                  <select style={input} value={sample.fn} onChange={(e) => updateSample((s) => ({ ...s, fn: e.target.value as 'encode' | 'decode' }))}><option value="encode">encode(보낼 때)</option><option value="decode">decode(받을 때)</option></select>
                  <select style={input} value={sample.direction} onChange={(e) => updateSample((s) => ({ ...s, direction: e.target.value as 'send' | 'recv' }))}><option value="send">send</option><option value="recv">recv</option></select>
                </span>
              </label>
              {meta.kind === 'fieldCodec' && <label className="fl-plugin-run-field" style={row}><span style={lbl}>값</span><TokenInput value={sample.value} onChange={(v) => updateSample((s) => ({ ...s, value: v }))} sources={sources} ariaLabel="값" /></label>}
              {meta.kind === 'fieldCodec' && <label className="fl-plugin-run-field" style={row}><span style={lbl}>다른 필드(JSON)</span><input style={{ ...input, fontFamily: 'var(--fl-font-mono)' }} value={sample.message} onChange={(e) => updateSample((s) => ({ ...s, message: e.target.value }))} placeholder='{"거래코드":"0210"}' /></label>}
              {meta.kind === 'messageCodec' && (
                <label className="fl-plugin-run-field" style={row}><span style={lbl}>본문</span>
                  <span style={{ display: 'grid', gap: 4 }}>
                    <select style={input} value={sample.bytesMode} onChange={(e) => updateSample((s) => ({ ...s, bytesMode: e.target.value as 'text' | 'hex' }))}><option value="text">텍스트(UTF-8)</option><option value="hex">hex</option></select>
                    <textarea style={{ ...input, minHeight: 60, fontFamily: 'var(--fl-font-mono)' }} value={sample.bytesText} onChange={(e) => updateSample((s) => ({ ...s, bytesText: e.target.value }))} placeholder={sample.bytesMode === 'hex' ? '30 30 31 32 …' : '전문 본문'} />
                  </span>
                </label>
              )}
            </>
          )}
          {meta.params.map((p) => (
            <label key={p.key} className="fl-plugin-run-field" style={row}><span style={lbl} title={p.key}>{p.label}</span>
              {p.type === 'select' && p.options?.length
                ? <select style={input} value={sample.config[p.key] ?? p.defaultValue} onChange={(e) => setCfg(p.key, e.target.value)}>{p.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                : <TokenInput value={sample.config[p.key] ?? p.defaultValue ?? ''} onChange={(v) => setCfg(p.key, v)} sources={sources} placeholder={p.placeholder || p.key} ariaLabel={`파라미터 ${p.key}`} />}
            </label>
          ))}
          <div style={hint}><code>{'{{'}</code> 로 시크릿·환경 변수 토큰을 넣을 수 있습니다. {envName ? `서버 · ${envName}` : '서버 · 공통 시크릿'} 기준으로 값을 사용합니다. 입력과 결과는 승인 화면에 샘플로 보이며, 파라미터(키·IV 등) 값은 저장하지 않습니다.</div>
        </div>
      )}
      {runErr && <div style={{ ...hint, color: 'var(--fl-fail)' }}>✕ {runErr}</div>}
      {result && (
        <div ref={resultRef} className="fl-plugin-run-result" style={{ display: 'grid', gap: 6, minHeight: 0, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}><span style={{ color: 'var(--fl-ok)', fontWeight: 700 }}>✓ 테스트 성공</span><span style={mono}>{result.durationMs}ms</span>{resultSource.current !== readSource() && <span style={hint}>코드가 바뀌었습니다. 다시 테스트하세요.</span>}</div>
          {result.outputs && <div style={box}><JsonTree value={result.outputs} defaultOpenDepth={2} /></div>}
          {result.result != null && <pre style={box}>{result.result}</pre>}
          {out && <div style={{ display: 'grid', gap: 4 }}><pre style={box}>{hex.enc(out)}</pre><pre style={box}>{new TextDecoder('utf-8', { fatal: false }).decode(out)}</pre></div>}
          {result.logs.length > 0 && <pre style={{ ...box, color: 'var(--fl-text-muted)' }}>{result.logs.map((l) => `› ${l}`).join('\n')}</pre>}
        </div>
      )}
    </aside>
  )
})

const panel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: 14, overflowY: 'auto', background: 'var(--fl-surface)', minHeight: 0, minWidth: 0, boxSizing: 'border-box' }
const row: CSSProperties = { display: 'grid', gap: 8, alignItems: 'center', fontSize: 13, minWidth: 0 }
const lbl: CSSProperties = { color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const input: CSSProperties = { padding: '6px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, width: '100%', boxSizing: 'border-box' }
const runBtn: CSSProperties = { ...ui.primary, flexShrink: 0 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', lineHeight: 1.5 }
const mono: CSSProperties = { fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', minWidth: 0, overflowWrap: 'anywhere' }
const box: CSSProperties = { margin: 0, padding: '8px 10px', fontSize: 12, fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto' }
