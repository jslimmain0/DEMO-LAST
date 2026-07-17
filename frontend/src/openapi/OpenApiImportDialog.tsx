import type { ChangeEvent, CSSProperties } from 'react'
import { useState } from 'react'
import type { PaletteGroup } from '../api/types'
import { MethodTag } from '../components/MethodTag'
import { useEscapeClose } from '../components/useEscapeClose'
import { newId } from '../lib/ids'
import { parseOpenApi } from './parseOpenApi'
import type { ParsedOperation } from './parseOpenApi'

export function OpenApiImportDialog({
  onImport,
  onClose,
}: {
  onImport: (group: PaletteGroup) => void
  onClose: () => void
}) {
  useEscapeClose(onClose)
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [ops, setOps] = useState<ParsedOperation[] | null>(null)
  const [title, setTitle] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const parse = () => {
    setError('')
    try {
      const doc = parseOpenApi(text)
      if (doc.operations.length === 0) {
        setError('오퍼레이션을 찾지 못했습니다. paths 가 있는 OpenAPI/Swagger 문서인지 확인하세요.')
        return
      }
      setOps(doc.operations)
      setTitle(doc.title)
      setSelected(new Set(doc.operations.map((o) => o.key)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setOps(null)
    }
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result))
    reader.readAsText(file)
  }

  const fetchUrl = async () => {
    if (!url.trim()) return
    setFetching(true); setError('')
    try {
      const res = await fetch(url.trim(), { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setText(await res.text())
    } catch (e) {
      setError(`URL 가져오기 실패: ${e instanceof Error ? e.message : String(e)} — CORS 로 막혔을 수 있습니다(파일/붙여넣기로 시도하세요).`)
    } finally { setFetching(false) }
  }

  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelected(next)
  }

  const doImport = () => {
    if (!ops) return
    const picked = ops.filter((o) => selected.has(o.key))
    const group: PaletteGroup = {
      id: newId(),
      title: title || 'API',
      items: picked.map((o) => ({
        id: newId(),
        label: o.summary || o.key,
        method: o.method,
        path: o.path,
        node: o.build(0, 0), // 위치는 캔버스에 떨어뜨릴 때 결정 — 여기선 템플릿만
      })),
    }
    onImport(group)
    onClose()
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="OpenAPI 가져오기" style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>OpenAPI / Swagger 가져오기</strong>
          <button onClick={onClose} aria-label="닫기" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>

        {!ops ? (
          <div style={{ padding: 18 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="스펙 URL (예: https://host/v3/api-docs)"
                onKeyDown={(e) => { if (e.key === 'Enter') fetchUrl() }}
                style={{ flex: 1, padding: '8px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13 }} />
              <button onClick={fetchUrl} disabled={fetching || !url.trim()} style={{ padding: '8px 14px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>{fetching ? '…' : 'URL 가져오기'}</button>
            </div>
            <input type="file" accept=".json,application/json" onChange={onFile} style={{ marginBottom: 12 }} />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='{ "openapi": "3.0.0", "paths": { ... } }  (JSON 붙여넣기)'
              style={{ width: '100%', height: 220, resize: 'vertical', fontFamily: 'var(--fl-font-mono)', fontSize: 12, padding: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)' }}
            />
            {error && <div style={{ color: 'var(--fl-fail)', fontSize: 13, marginTop: 8 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={parse} disabled={!text.trim()} style={primary}>분석</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--fl-border)' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>{ops.length}개 오퍼레이션</span>
              <button onClick={() => setSelected(new Set(selected.size === ops.length ? [] : ops.map((o) => o.key)))} style={{ marginLeft: 'auto', ...ghost }}>
                {selected.size === ops.length ? '전체 해제' : '전체 선택'}
              </button>
            </div>
            <div style={{ overflowY: 'auto', padding: 8, flex: 1 }}>
              {ops.map((o) => (
                <label key={o.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--fl-radius-sm)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selected.has(o.key)} onChange={() => toggle(o.key)} />
                  <MethodTag method={o.method} />
                  <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12.5 }}>{o.path}</code>
                  <span style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.summary}</span>
                </label>
              ))}
            </div>
            <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', borderTop: '1px solid var(--fl-border)' }}>
              <button onClick={() => setOps(null)} style={ghost}>← 다시</button>
              <button onClick={doImport} disabled={selected.size === 0} style={primary}>{selected.size}개 팔레트에 추가</button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 560, maxWidth: '100%', maxHeight: '80vh', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const primary: CSSProperties = { padding: '9px 18px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const ghost: CSSProperties = { padding: '7px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
