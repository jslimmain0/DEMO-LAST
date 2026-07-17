import type { CSSProperties } from 'react'
import { useState } from 'react'
import { getRunInputVars, setRunInputVars } from '../lib/runInput'
import { Modal } from './Modal'

/**
 * 실행 입력(런타임 파라미터) 다이얼로그 — `{{ 키@input }}` 로 참조되는 값을 넣고 실행.
 * 같은 플로우를 다른 입력으로 반복 실행(파라미터화)하는 용도. 값은 플로우별 localStorage 에 저장돼 다음에 재사용된다.
 */
export function RunInputDialog({ onClose, onRun }: { onClose: () => void; onRun: () => void }) {
  const [rows, setRows] = useState<Array<{ k: string; v: string }>>(
    () => { const e = Object.entries(getRunInputVars()); return e.length ? e.map(([k, v]) => ({ k, v })) : [{ k: '', v: '' }] },
  )
  const commit = (next: Array<{ k: string; v: string }>) => {
    setRows(next)
    const out: Record<string, string> = {}
    for (const { k, v } of next) if (k.trim()) out[k.trim()] = v
    setRunInputVars(out)
  }
  const setRow = (i: number, patch: Partial<{ k: string; v: string }>) => commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const runNow = () => { onRun(); onClose() }

  return (
    <Modal onClose={onClose} ariaLabel="입력값과 실행" width={520} card={{ padding: 18, display: 'block' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span aria-hidden>▶</span>
          <b style={{ flex: 1, fontSize: 15 }}>입력값과 실행</b>
          <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
        </header>
        <p style={hint}>
          여기 넣은 값은 실행 시 <code style={code}>{'{{ 키@input }}'}</code> 로 주입됩니다. 같은 플로우를 다른 입력으로 반복 실행할 때 쓰세요.
          (플로우별로 저장돼 다음에 다시 채워집니다.)
        </p>
        <div style={{ maxHeight: 300, overflowY: 'auto', marginTop: 8 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input style={{ ...mono, flex: 1 }} value={r.k} placeholder="키 (예: amount)" onChange={(e) => setRow(i, { k: e.target.value })} />
              <input style={{ ...mono, flex: 1.4 }} value={r.v} placeholder="값" onChange={(e) => setRow(i, { v: e.target.value })} />
              <button onClick={() => commit(rows.filter((_, j) => j !== i))} aria-label="삭제" style={delBtn}>×</button>
            </div>
          ))}
          <button onClick={() => commit([...rows, { k: '', v: '' }])} style={addBtn}>+ 입력값</button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={ghostBtn}>닫기</button>
          <button onClick={runNow} style={primaryBtn}>▶ 이 입력으로 실행</button>
        </div>
    </Modal>
  )
}

const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', lineHeight: 1.6, margin: 0 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const mono: CSSProperties = { padding: '7px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, fontFamily: 'var(--fl-font-mono)', minWidth: 0 }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const delBtn: CSSProperties = { width: 30, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer' }
const addBtn: CSSProperties = { marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
const primaryBtn: CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const ghostBtn: CSSProperties = { padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }
