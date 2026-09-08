import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MockServerDetail, MockServerSpec } from '../api/types'
import { mocksApi } from '../api/client'
import { apiErrorMessage } from '../lib/apiError'
import { isValidSlug, nextSlugCandidate, parseMockBundle, prepareImportedSpec, serializeMockBundle, toMockBundle } from '../lib/mockTransfer'
import type { MockBundle } from '../lib/mockTransfer'
import { Modal } from './Modal'
import { toast } from './toast'

/** Mock 한 개 내보내기 — JSON 텍스트 복사/파일 다운로드. */
export function MockExportDialog({ mock, spec, onClose }: { mock: MockServerDetail; spec?: MockServerSpec; onClose: () => void }) {
  const text = serializeMockBundle(toMockBundle({ name: mock.name, slug: mock.slug, kind: mock.kind, spec: spec ?? mock.spec }))
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); toast('클립보드에 복사했습니다.', 'ok') }).catch(() => toast('복사 실패 — 텍스트를 직접 선택하세요.', 'error'))
  }
  const download = () => {
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `mock-${mock.slug}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <Modal onClose={onClose} ariaLabel="Mock 내보내기" width={640}>
      <div style={{ padding: 20, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h3 style={h3}>Mock 내보내기</h3>
          <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>{mock.name} · {mock.slug}</span>
          <button style={{ ...miniBtn, marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
        <textarea readOnly value={text} onFocus={(e) => e.currentTarget.select()} style={area} aria-label="내보내기 JSON" />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button style={primaryBtn} onClick={copy}>{copied ? '✓ 복사됨' : '⧉ 전체 복사'}</button>
          <button style={miniBtn} onClick={download}>⬇ 파일 다운로드</button>
          <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>{text.length.toLocaleString()}자 — 다른 워크스페이스/서버의 Mock 목록 [가져오기]에 붙여넣으세요</span>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Mock 가져오기(새로 만들기) — 붙여넣기 → 이름/slug 확인(실시간 slug 검사, 충돌 시 -2 제안) → create + updateSpec.
 * TCP 는 꺼서 가져온다(포트 전역 자원).
 */
export function MockImportDialog({ workspaceId, onClose, onImported }: { workspaceId: string | null; onClose: () => void; onImported?: (id: string) => void }) {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [bundle, setBundle] = useState<MockBundle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTaken, setSlugTaken] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const parse = () => {
    const p = parseMockBundle(text)
    if (!p.ok) { setError(p.error); setBundle(null); return }
    setError(null); setBundle(p.bundle); setName(p.bundle.name || p.bundle.slug); setSlug(p.bundle.slug)
  }
  const slugFormatOk = isValidSlug(slug)
  useEffect(() => {
    if (!bundle) return
    setSlugTaken(null)
    if (!slugFormatOk) return
    const t = setTimeout(() => {
      mocksApi.slugCheck(slug).then((r) => setSlugTaken(!r.available)).catch(() => setSlugTaken(null))
    }, 300)
    return () => clearTimeout(t)
  }, [slug, slugFormatOk, bundle])
  // 충돌이면 -2, -3 … 자동 제안(한 번만 — 사용자가 고친 값은 존중)
  useEffect(() => {
    if (slugTaken !== true || !bundle) return
    const m = /-(\d+)$/.exec(slug)
    const n = m ? Number(m[1]) + 1 : 2
    if (n <= 9) setSlug(nextSlugCandidate(slug, n))
  }, [slugTaken]) // eslint-disable-line react-hooks/exhaustive-deps

  const doImport = async () => {
    if (!bundle || !slugFormatOk || slugTaken !== false) return
    setBusy(true)
    try {
      const created = await mocksApi.create({ name: name.trim() || slug, slug, type: bundle.type, workspaceId })
      const prepared = prepareImportedSpec(bundle.spec, { disableTcp: true })
      try {
        await mocksApi.updateSpec(created.id, prepared.spec)
      } catch (e) {
        // spec 저장 실패(포트 충돌 등)면 빈 mock 이 남지 않게 정리
        await mocksApi.remove(created.id).catch(() => {})
        throw e
      }
      toast(`Mock '${name.trim() || slug}' 을 가져왔습니다.${prepared.warnings.length ? ' ' + prepared.warnings.join(' ') : ''}`, prepared.warnings.length ? 'info' : 'ok')
      onImported?.(created.id)
      onClose()
      navigate(`/mocks/${created.id}`)
    } catch (e) {
      setError(apiErrorMessage(e, '가져오기에 실패했습니다'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel="Mock 가져오기" width={640} closeOnBackdrop={false}>
      <div style={{ padding: 20, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h3 style={h3}>Mock 가져오기</h3>
          <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>내보내기로 복사한 JSON 을 붙여넣으면 새 Mock 서버로 만듭니다</span>
          <button style={{ ...miniBtn, marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
        {!bundle ? (
          <>
            <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder='{"kind":"flowlink-mock", "version":1, …}' style={area} aria-label="가져오기 JSON" />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button style={primaryBtn} disabled={!text.trim()} onClick={parse}>다음 →</button>
              {error && <span style={{ fontSize: 12.5, color: 'var(--fl-fail)' }}>{error}</span>}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--fl-text-muted)' }}>
              {bundle.type} · 라우트 {bundle.spec.routes?.length ?? 0}{bundle.spec.tcp ? ` · TCP :${bundle.spec.tcp.port ?? '?'}(꺼진 상태로 가져옴)` : ''}{bundle.spec.codec ? ' · 코덱 포함' : ''}
            </div>
            <label style={lbl}>이름<input style={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label style={lbl}>slug
              <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flex: 1 }}>
                <input style={{ ...input, width: '100%', fontFamily: 'var(--fl-font-mono)', paddingRight: 84, borderColor: slugTaken === true ? 'var(--fl-fail)' : undefined }} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') void doImport() }} />
                {slugFormatOk && slugTaken !== null && (
                  <span style={{ position: 'absolute', right: 10, fontSize: 11, fontWeight: 700, pointerEvents: 'none', color: slugTaken ? 'var(--fl-fail)' : 'var(--fl-ok)' }}>{slugTaken ? '✕ 사용 중' : '✓ 사용 가능'}</span>
                )}
              </span>
            </label>
            {!slugFormatOk && <span style={{ fontSize: 11.5, color: 'var(--fl-fail)' }}>slug 는 소문자·숫자·하이픈 3~40자</span>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button style={{ ...primaryBtn, opacity: slugFormatOk && slugTaken === false ? 1 : 0.5 }} disabled={busy || !slugFormatOk || slugTaken !== false} onClick={() => { void doImport() }}>{busy ? '가져오는 중…' : '가져오기'}</button>
              <button style={miniBtn} onClick={() => { setBundle(null); setError(null) }}>← 다시 붙여넣기</button>
              {error && <span style={{ fontSize: 12.5, color: 'var(--fl-fail)' }}>{error}</span>}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/** 편집기 안 — 붙여넣은 번들의 spec 으로 현재 Mock 의 spec 을 덮어쓴다(미저장 편집 상태로 반영, 저장은 사용자가). */
export function MockReplaceSpecDialog({ onClose, onReplace }: { onClose: () => void; onReplace: (spec: MockServerSpec, warnings: string[]) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<MockBundle | null>(null)
  const parse = () => {
    const p = parseMockBundle(text)
    if (!p.ok) { setError(p.error); return }
    setError(null); setPending(p.bundle)
  }
  return (
    <Modal onClose={onClose} ariaLabel="Mock 가져오기(덮어쓰기)" width={640} closeOnBackdrop={false}>
      <div style={{ padding: 20, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h3 style={h3}>가져오기 (현재 Mock 덮어쓰기)</h3>
          <button style={{ ...miniBtn, marginLeft: 'auto' }} onClick={onClose}>닫기</button>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fl-text-muted)' }}>붙여넣은 번들의 라우트·TCP·코덱으로 이 Mock 의 정의를 <b>교체</b>합니다(이름/slug 는 유지). 저장 전까지는 미저장 편집 상태라 되돌릴 수 있습니다.</p>
        <textarea autoFocus value={text} onChange={(e) => { setText(e.target.value); setPending(null) }} placeholder='{"kind":"flowlink-mock", …}' style={area} aria-label="가져오기 JSON" />
        {error && <span style={{ fontSize: 12.5, color: 'var(--fl-fail)' }}>{error}</span>}
        {pending ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 10, border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius-sm)' }}>
            <span style={{ fontSize: 12.5 }}>라우트 {pending.spec.routes?.length ?? 0}{pending.spec.tcp ? ` · TCP :${pending.spec.tcp.port ?? '?'}` : ''}{pending.spec.codec ? ' · 코덱' : ''} — 현재 정의를 교체할까요?</span>
            <button style={{ ...primaryBtn, marginLeft: 'auto', background: 'var(--fl-fail)' }} onClick={() => {
              const prepared = prepareImportedSpec(pending.spec, { disableTcp: true })
              onReplace(prepared.spec, prepared.warnings); onClose()
            }}>교체</button>
            <button style={miniBtn} onClick={() => setPending(null)}>취소</button>
          </div>
        ) : (
          <div><button style={primaryBtn} disabled={!text.trim()} onClick={parse}>검사 →</button></div>
        )}
      </div>
    </Modal>
  )
}

const h3: CSSProperties = { margin: 0, fontFamily: 'var(--fl-font-head)', fontSize: 16 }
const area: CSSProperties = { width: '100%', minHeight: 220, boxSizing: 'border-box', padding: 10, fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', resize: 'vertical' }
const lbl: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }
const input: CSSProperties = { flex: 1, padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13 }
const primaryBtn: CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
