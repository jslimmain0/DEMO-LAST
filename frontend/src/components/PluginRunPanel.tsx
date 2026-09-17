// 플러그인 실행 패널 — 컴파일 메타로 입력 폼을 자동 생성하고, 샌드박스에서 1회 실행해 출력·콘솔·소요 시간을 보여준다.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { pluginsApi } from '../api/client'
import type { PluginScriptMeta, PluginTryRequest, PluginTryResult, ScriptErrorBody } from '../api/types'
import type { EditorDiagnostic } from './CodeEditor'
import { JsonTree } from './JsonTree'

type Sample = { inputs: Record<string, string>; config: Record<string, string>; value: string; fn: 'encode' | 'decode'; direction: 'send' | 'recv'; message: string; bytesText: string; bytesMode: 'text' | 'hex' }
const EMPTY: Sample = { inputs: {}, config: {}, value: '', fn: 'encode', direction: 'send', message: '{}', bytesText: '', bytesMode: 'text' }

function loadSample(key: string): Sample { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(key) ?? '{}') } } catch { return EMPTY } }
function scriptError(e: unknown): ScriptErrorBody | null {
  const d = (e as { response?: { data?: Partial<ScriptErrorBody> } })?.response?.data
  return d && typeof d.message === 'string' && 'line' in d ? { message: d.message, line: d.line ?? null, col: d.col ?? null } : null
}
const b64 = { enc: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)), dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) }
const hex = { enc: (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '), dec: (s: string) => Uint8Array.from((s.replace(/[^0-9a-f]/gi, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))) }

export function PluginRunPanel({ source, scriptId, canRun, onDiagnostics }: { source: string; scriptId: string | null; canRun: boolean; onDiagnostics: (d: EditorDiagnostic[]) => void }) {
  const key = `fl:plugrun:${scriptId ?? 'new'}`
  const [meta, setMeta] = useState<PluginScriptMeta | null>(null)
  const [compileErr, setCompileErr] = useState<string | null>(null)
  const [sample, setSample] = useState<Sample>(() => loadSample(key))
  const [result, setResult] = useState<PluginTryResult | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sourceRef = useRef(source); sourceRef.current = source
  const compileSeq = useRef(0)
  useEffect(() => { setSample(loadSample(key)); setResult(null); setRunErr(null); setMeta(null); setCompileErr(null); compileSeq.current++ }, [key])
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(sample)) } catch { /* */ } }, [key, sample])

  // 타이핑 멈춤 600ms → 컴파일만(입력 없이) → 메타로 폼
  useEffect(() => {
    if (!canRun) return
    const t = setTimeout(() => {
      const seq = ++compileSeq.current
      pluginsApi.tryRun({ source: sourceRef.current }).then((r) => { if (seq !== compileSeq.current) return; setMeta(r.meta); setCompileErr(null); onDiagnostics([]) })
        .catch((e) => { if (seq !== compileSeq.current) return; const se = scriptError(e); setCompileErr(se?.message ?? '컴파일 실패'); if (se?.line) onDiagnostics([{ line: se.line, col: se.col ?? undefined, message: se.message }]) })
    }, 600)
    return () => clearTimeout(t)
  }, [source, canRun, onDiagnostics])

  const request = useMemo((): PluginTryRequest | null => {
    if (!meta) return null
    if (meta.kind === 'transform') return { source, inputs: sample.inputs, config: sample.config }
    let message: Record<string, string> = {}
    try { message = JSON.parse(sample.message || '{}') } catch { /* 잘못된 JSON 은 빈 맵 */ }
    if (meta.kind === 'fieldCodec') return { source, value: sample.value, fn: sample.fn, direction: sample.direction, config: sample.config, message }
    const bytes = sample.bytesMode === 'hex' ? hex.dec(sample.bytesText) : new TextEncoder().encode(sample.bytesText)
    return { source, fn: sample.fn, direction: sample.direction, config: sample.config, bytesB64: b64.enc(bytes) }
  }, [meta, sample, source])

  const run = async () => {
    if (!canRun || !request || busy || compileErr) return
    setBusy(true); setRunErr(null)
    try {
      const r = await pluginsApi.tryRun(request)
      setResult(r); onDiagnostics([])
      if (scriptId) void pluginsApi.saveSample(scriptId, JSON.stringify({ request: { ...request, source: undefined, config: undefined }, result: r })).catch(() => {})
    } catch (e) {
      const se = scriptError(e)
      setRunErr(se ? `${se.line ? `${se.line}행: ` : ''}${se.message}` : (e as Error).message)
      if (se?.line) onDiagnostics([{ line: se.line, col: se.col ?? undefined, message: se.message }])
    } finally { setBusy(false) }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run() } }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, busy])

  const setIn = (k: string, v: string) => setSample((s) => ({ ...s, inputs: { ...s.inputs, [k]: v } }))
  const setCfg = (k: string, v: string) => setSample((s) => ({ ...s, config: { ...s.config, [k]: v } }))
  const out = result?.bytesB64 ? b64.dec(result.bytesB64) : null

  return (
    <aside style={panel} aria-label="실행 패널">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>▶ 실행해 보기</strong>
        {meta && <span style={mono}>{meta.id} · {meta.kind}</span>}
        <button onClick={() => void run()} disabled={!canRun || !request || busy || !!compileErr} style={{ ...runBtn, marginLeft: 'auto' }} title="Ctrl+Enter">{busy ? '실행 중…' : '▶ 실행'}</button>
      </div>
      {!canRun && <div style={hint}>실행은 가입 승인 후 가능합니다.</div>}
      {compileErr && <div style={{ ...hint, color: 'var(--fl-fail)' }}>⚠ {compileErr}</div>}
      {meta && (
        <div style={{ display: 'grid', gap: 6 }}>
          {meta.kind === 'transform' && meta.inputs.map((io) => (
            <label key={io.key} style={row}><span style={lbl} title={io.key}>{io.label}</span><input style={input} value={sample.inputs[io.key] ?? ''} placeholder={io.example || io.key} onChange={(e) => setIn(io.key, e.target.value)} /></label>
          ))}
          {meta.kind !== 'transform' && (
            <>
              <label style={row}><span style={lbl}>방향</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <select style={input} value={sample.fn} onChange={(e) => setSample((s) => ({ ...s, fn: e.target.value as 'encode' | 'decode' }))}><option value="encode">encode(보낼 때)</option><option value="decode">decode(받을 때)</option></select>
                  <select style={input} value={sample.direction} onChange={(e) => setSample((s) => ({ ...s, direction: e.target.value as 'send' | 'recv' }))}><option value="send">send</option><option value="recv">recv</option></select>
                </span>
              </label>
              {meta.kind === 'fieldCodec' && <label style={row}><span style={lbl}>값</span><input style={input} value={sample.value} onChange={(e) => setSample((s) => ({ ...s, value: e.target.value }))} /></label>}
              {meta.kind === 'fieldCodec' && <label style={row}><span style={lbl}>다른 필드(JSON)</span><input style={{ ...input, fontFamily: 'var(--fl-font-mono)' }} value={sample.message} onChange={(e) => setSample((s) => ({ ...s, message: e.target.value }))} placeholder='{"거래코드":"0210"}' /></label>}
              {meta.kind === 'messageCodec' && (
                <label style={row}><span style={lbl}>본문</span>
                  <span style={{ display: 'grid', gap: 4 }}>
                    <select style={input} value={sample.bytesMode} onChange={(e) => setSample((s) => ({ ...s, bytesMode: e.target.value as 'text' | 'hex' }))}><option value="text">텍스트(UTF-8)</option><option value="hex">hex</option></select>
                    <textarea style={{ ...input, minHeight: 60, fontFamily: 'var(--fl-font-mono)' }} value={sample.bytesText} onChange={(e) => setSample((s) => ({ ...s, bytesText: e.target.value }))} placeholder={sample.bytesMode === 'hex' ? '30 30 31 32 …' : '전문 본문'} />
                  </span>
                </label>
              )}
            </>
          )}
          {meta.params.map((p) => (
            <label key={p.key} style={row}><span style={lbl} title={p.key}>{p.label}</span>
              {p.type === 'select' && p.options?.length
                ? <select style={input} value={sample.config[p.key] ?? p.defaultValue} onChange={(e) => setCfg(p.key, e.target.value)}>{p.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                : <input style={input} value={sample.config[p.key] ?? p.defaultValue} placeholder={p.placeholder || p.key} onChange={(e) => setCfg(p.key, e.target.value)} />}
            </label>
          ))}
          <div style={hint}>시크릿 토큰(<code>{'{{ x@secret }}'}</code>)은 여기선 풀리지 않습니다 — 실제 값을 넣어 시험하세요. 입력과 결과는 승인 화면에 샘플로 보이며, 파라미터(키·IV 등) 값은 저장하지 않습니다.</div>
        </div>
      )}
      {runErr && <div style={{ ...hint, color: 'var(--fl-fail)' }}>✕ {runErr}</div>}
      {result && (
        <div style={{ display: 'grid', gap: 6, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}><span style={{ color: 'var(--fl-ok)', fontWeight: 700 }}>✓ 성공</span><span style={mono}>{result.durationMs}ms</span></div>
          {result.outputs && <div style={box}><JsonTree value={result.outputs} defaultOpenDepth={2} /></div>}
          {result.result != null && <pre style={box}>{result.result}</pre>}
          {out && <div style={{ display: 'grid', gap: 4 }}><pre style={box}>{hex.enc(out)}</pre><pre style={box}>{new TextDecoder('utf-8', { fatal: false }).decode(out)}</pre></div>}
          {result.logs.length > 0 && <pre style={{ ...box, color: 'var(--fl-text-muted)' }}>{result.logs.map((l) => `› ${l}`).join('\n')}</pre>}
        </div>
      )}
    </aside>
  )
}

const panel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: 14, overflowY: 'auto', background: 'var(--fl-surface)', minHeight: 0 }
const row: CSSProperties = { display: 'grid', gridTemplateColumns: '96px 1fr', gap: 8, alignItems: 'center', fontSize: 12.5 }
const lbl: CSSProperties = { color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const input: CSSProperties = { padding: '6px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, width: '100%', boxSizing: 'border-box' }
const runBtn: CSSProperties = { padding: '6px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-ok)', color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', lineHeight: 1.5 }
const mono: CSSProperties = { fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const box: CSSProperties = { margin: 0, padding: '8px 10px', fontSize: 12, fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto' }
