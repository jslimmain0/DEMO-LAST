import type { CSSProperties } from 'react'
import { useState } from 'react'
import { transformsApi } from '../api/client'
import type { TransformInfo } from '../api/types'

/**
 * 변환 인라인 미리보기 — 샘플 입력/현재 config 로 결과를 즉시 확인(순수 계산, 상위 바인딩 불필요).
 * config 를 돌려보며 조정하는 루프를 속성 패널 안에서 닫는다.
 */
export function TransformPreview({ transform, config }: { transform: TransformInfo; config: Record<string, string> }) {
  const [open, setOpen] = useState(false)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ ok: boolean; outputs: Record<string, unknown>; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    try { setResult(await transformsApi.preview(transform.id, { inputs, config })) }
    catch (e) { setResult({ ok: false, outputs: {}, error: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false) }
  }

  if (!open) {
    return <button style={toggleBtn} onClick={() => setOpen(true)}>🔍 변환 미리보기</button>
  }
  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <b style={{ fontSize: 11.5 }}>미리보기</b>
        <button style={{ ...toggleBtn, marginLeft: 'auto', padding: '2px 8px' }} onClick={() => setOpen(false)}>닫기</button>
      </div>
      {transform.inputs.map((io) => (
        <div key={io.key} style={{ marginBottom: 6 }}>
          <label style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>{io.label}{io.example ? ` (예: ${io.example})` : ''}</label>
          <input style={miniInput} value={inputs[io.key] ?? ''} placeholder="샘플 값"
            onChange={(e) => setInputs((s) => ({ ...s, [io.key]: e.target.value }))} />
        </div>
      ))}
      <button style={runBtn} disabled={busy} onClick={run}>{busy ? '실행 중…' : '▶ 변환 실행'}</button>
      {result && (
        <div style={{ marginTop: 8, fontSize: 11.5 }}>
          {result.ok ? (
            <div>
              {Object.entries(result.outputs).map(([k, v]) => (
                <div key={k} style={{ fontFamily: 'var(--fl-font-mono)', wordBreak: 'break-all' }}>
                  <span style={{ color: 'var(--fl-primary)' }}>{k}</span> = {typeof v === 'string' ? v : JSON.stringify(v)}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--fl-fail)' }}>오류: {result.error}</div>
          )}
        </div>
      )}
    </div>
  )
}

const toggleBtn: CSSProperties = { marginTop: 10, padding: '5px 10px', fontSize: 11.5, border: '1px dashed var(--fl-border)', borderRadius: 999, background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer' }
const box: CSSProperties = { marginTop: 10, padding: 10, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }
const miniInput: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 12, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text)' }
const runBtn: CSSProperties = { padding: '5px 12px', fontSize: 12, border: 'none', borderRadius: 6, background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontWeight: 600 }
