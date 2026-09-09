import type { CSSProperties } from 'react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { BindableSource } from '../binding/upstream'
import { previewDocument, renderTemplatePreview, templateTokens } from '../lib/templatePreview'
import type { CodeEditorHandle, CodeLang, CodeStatus, EditorLang } from './CodeEditor'
import { JsonTree } from './JsonTree'
import { Modal } from './Modal'
import { toast } from './toast'

// CodeMirror(하이라이트·문법 체크·정렬·자동완성)는 무거워서 편집기를 열 때만 로드
const CodeEditorLazy = lazy(() => import('./CodeEditor'))

export type BigTextLang = CodeLang | 'text' | 'auto'

/** 내용으로 언어 추정 — 명시 language 가 없을 때(auto)만 */
function detectLang(v: string): CodeLang | 'text' {
  const t = v.trimStart()
  if (t.startsWith('<')) return 'html'
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  return 'text'
}

/**
 * 거의 전체화면 텍스트 편집 모달 — HTML 응답 템플릿·콜백 본문·raw 바디처럼 작은 textarea 로 쓰기 힘든 긴 본문을 크게 편집한다.
 * value/onChange 를 그대로 물려받아 원본 입력과 실시간 동기화(닫으면 그 상태가 남는다 — 별도 저장 없음).
 * HTML(내장 JS/CSS)·JSON·XML 은 코드 편집기: 하이라이트 + 문법 체크 + **⇥ 정렬**(Shift+Alt+F, `{{ 토큰 }}` 보호) + **`{{` 자동완성**(sources) +
 * 찾기/바꾸기(Ctrl+F) + 줄바꿈 토글 + 상태바. **👁 미리보기**(HTML=샌드박스 iframe 실시간 렌더 / JSON=트리)는 템플릿 토큰을
 * **샘플 값**(호출처가 넘긴 예상 요청 예시값 + 미리보기 pane 에서 직접 입력)으로 치환해 보여준다. 텍스트 모드도 같은 편집기(하이라이트/체크만 없음)라
 * Tab 들여쓰기·Ctrl+Z 편집기 내부 undo·찾기·자동완성이 동일하다.
 */
export function BigTextEditor({
  title,
  value,
  onChange,
  onClose,
  placeholder,
  hint,
  language = 'auto',
  sources = [],
  samples,
}: {
  title: string
  value: string
  onChange: (v: string) => void
  onClose: () => void
  placeholder?: string
  hint?: string
  language?: BigTextLang
  sources?: BindableSource[]         // `{{` 자동완성 소스(예상 요청·상태·시크릿·상위 노드 출력)
  samples?: Record<string, string>   // 미리보기 샘플 값 초기 세트(`key@source` → 값)
}) {
  const [lang, setLang] = useState<EditorLang>(() => (language === 'auto' ? detectLang(value) : language))
  const [wrap, setWrap] = useState(() => { try { return localStorage.getItem('fl:bigedit:wrap') !== '0' } catch { return true } })
  const [preview, setPreview] = useState(() => { try { return localStorage.getItem('fl:bigedit:preview') === '1' } catch { return false } })
  const [status, setStatus] = useState<CodeStatus | null>(null)
  const editorRef = useRef<CodeEditorHandle>(null)
  const canPreview = lang === 'html' || lang === 'json'
  const canFormat = lang !== 'text'
  const toggleWrap = () => setWrap((v) => { try { localStorage.setItem('fl:bigedit:wrap', v ? '0' : '1') } catch { /* */ } return !v })
  const togglePreview = () => setPreview((v) => { try { localStorage.setItem('fl:bigedit:preview', v ? '0' : '1') } catch { /* */ } return !v })
  const format = () => {
    const r = editorRef.current?.format()
    if (r === 'fail') toast(`정렬 실패 — ${lang === 'json' ? 'JSON 문법을 확인하세요' : '문법을 확인하세요'}(원문 유지)`, 'error')
    else if (r === 'noop') toast('이미 정렬돼 있습니다.', 'info')
    else if (r === 'ok') toast('정렬했습니다.', 'ok')
    editorRef.current?.focus()
  }
  return (
    <Modal onClose={onClose} ariaLabel={title} width="min(1500px, 96vw)" maxWidth="96vw" height="92vh" maxHeight="94vh" zIndex={320} card={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--fl-border)', flexShrink: 0, flexWrap: 'wrap' }}>
        <strong style={{ flex: 1, minWidth: 160, fontFamily: 'var(--fl-font-head)', fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</strong>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value as EditorLang)}
          aria-label="문법(하이라이트·체크)"
          title="문법 하이라이트·체크 언어 — HTML 은 안의 JS/CSS 까지"
          style={langSel}
        >
          <option value="html">HTML (+JS/CSS)</option>
          <option value="json">JSON</option>
          <option value="xml">XML</option>
          <option value="text">텍스트</option>
        </select>
        <button onClick={format} disabled={!canFormat} title={canFormat ? '자동 정렬 (Shift+Alt+F) — {{ 토큰 }} 은 그대로 보호' : '텍스트 모드에는 정렬이 없습니다'} style={{ ...toolBtn, opacity: canFormat ? 1 : 0.45 }}>⇥ 정렬</button>
        <button onClick={toggleWrap} aria-pressed={wrap} title="긴 줄 줄바꿈" style={{ ...toolBtn, ...(wrap ? toolOn : null) }}>↩ 줄바꿈</button>
        <button onClick={togglePreview} disabled={!canPreview} aria-pressed={preview && canPreview} title={canPreview ? (lang === 'html' ? '샘플 값으로 렌더한 페이지를 옆에 보여줍니다(실시간)' : 'JSON 트리로 보기') : 'HTML/JSON 만 미리보기'} style={{ ...toolBtn, ...(preview && canPreview ? toolOn : null), opacity: canPreview ? 1 : 0.45 }}>👁 미리보기</button>
        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', flexShrink: 0 }}>{value.length.toLocaleString()}자</span>
        <button onClick={onClose} aria-label="닫기" title="닫기 (Esc)" style={xBtn}>×</button>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Suspense fallback={<textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} style={plainArea} />}>
            <CodeEditorLazy ref={editorRef} value={value} onChange={onChange} language={lang} sources={sources} wrap={wrap} placeholder={placeholder} onStatus={setStatus} />
          </Suspense>
        </div>
        {preview && canPreview && <PreviewPane lang={lang} value={value} initialSamples={samples ?? {}} />}
      </div>
      <footer style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 16px', borderTop: '1px solid var(--fl-border)', fontSize: 11.5, color: 'var(--fl-text-muted)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 200 }}>{hint}</span>
        <span style={{ display: 'inline-flex', gap: 10, fontFamily: 'var(--fl-font-mono)', flexShrink: 0 }} aria-label="편집기 상태">
          {status && <span>줄 {status.line}:{status.col}</span>}
          {status && status.selected > 0 && <span>선택 {status.selected.toLocaleString()}자</span>}
          {status && <span>{status.lines.toLocaleString()}줄</span>}
          <span title="Tab 들여쓰기 · Shift+Tab 내어쓰기 (포커스는 편집기 안에 머뭅니다)">Tab 들여쓰기</span>
          <span title="이 편집기 안의 되돌리기/다시 실행 — 바깥(캔버스)엔 영향 없음">Ctrl+Z/Y undo</span>
          {lang !== 'text' && <span title="자동 정렬">Shift+Alt+F 정렬</span>}
          <span title="찾기/바꾸기 패널">Ctrl+F 찾기·바꾸기</span>
          <span title="예상 요청·상태·시크릿 토큰 자동완성">{'{{ 자동완성'}</span>
        </span>
      </footer>
    </Modal>
  )
}

/** 미리보기 pane — HTML 은 샌드박스 iframe(앱 세션·쿠키 접근 불가), JSON 은 트리. 토큰은 샘플 값으로 치환(300ms 디바운스). */
function PreviewPane({ lang, value, initialSamples }: { lang: 'html' | 'json'; value: string; initialSamples: Record<string, string> }) {
  const [samples, setSamples] = useState<Record<string, string>>(() => ({ ...initialSamples }))
  const [samplesOpen, setSamplesOpen] = useState(true)
  const [rendered, setRendered] = useState(() => renderTemplatePreview(value, initialSamples))
  const [tick, setTick] = useState(0)
  const tokens = useMemo(() => templateTokens(value), [value])
  useEffect(() => {
    const t = setTimeout(() => setRendered(renderTemplatePreview(value, samples)), 300)
    return () => clearTimeout(t)
  }, [value, samples, tick])
  const valueOf = (id: string, key: string) => samples[id] ?? samples[key] ?? ''
  let jsonView: { ok: true; data: unknown } | { ok: false; error: string } | null = null
  if (lang === 'json') {
    try { jsonView = { ok: true, data: JSON.parse(rendered) } } catch (e) { jsonView = { ok: false, error: (e as Error).message } }
  }
  return (
    <div style={paneWrap} aria-label="미리보기">
      <div style={paneBar}>
        <strong style={{ fontSize: 12 }}>👁 미리보기</strong>
        <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>{lang === 'html' ? '샌드박스 — 스크립트는 돌지만 앱 세션엔 접근 못 함' : 'JSON 트리(샘플 값 치환 후)'}</span>
        <span style={{ marginLeft: 'auto' }} />
        <button onClick={() => setSamplesOpen((v) => !v)} aria-expanded={samplesOpen} style={{ ...toolBtn, padding: '2px 8px', fontSize: 11.5 }} title="템플릿 토큰에 넣을 샘플 값">{samplesOpen ? '▾' : '▸'} 샘플 값 {tokens.length}</button>
        <button onClick={() => setTick((t) => t + 1)} style={{ ...toolBtn, padding: '2px 8px', fontSize: 11.5 }} title="다시 렌더">↻</button>
      </div>
      {samplesOpen && (
        <div style={sampleBox}>
          {tokens.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>템플릿 토큰이 없습니다 — 본문이 그대로 렌더됩니다.</span>}
          {tokens.map((t) => (
            <label key={t.id} style={sampleRow}>
              <code style={sampleKey} title={t.raw}>{t.id}</code>
              {t.builtin
                ? <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>내장 값(자동)</span>
                : <input value={valueOf(t.id, t.key)} placeholder={`«${t.key}»`} aria-label={`샘플 ${t.id}`} onChange={(e) => setSamples((s) => ({ ...s, [t.id]: e.target.value }))} style={sampleInput} />}
            </label>
          ))}
        </div>
      )}
      {lang === 'html' ? (
        <iframe title="HTML 미리보기" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={previewDocument(rendered)} style={{ flex: 1, border: 0, background: '#fff', minHeight: 0 }} />
      ) : jsonView?.ok ? (
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px', minHeight: 0 }}><JsonTree value={jsonView.data} defaultOpenDepth={4} /></div>
      ) : (
        <div style={{ padding: 12, fontSize: 12, color: 'var(--fl-fail)' }}>JSON 으로 해석할 수 없습니다 — {jsonView?.error}<div style={{ color: 'var(--fl-text-muted)', marginTop: 4 }}>따옴표 없는 토큰(<code>{'"n": {{ amount@body }}'}</code>)은 샘플 값이 숫자여야 합니다.</div></div>
      )}
    </div>
  )
}

/** 작은 textarea 우상단에 붙이는 ⤢(크게 편집) 버튼 — 부모는 position:relative 컨테이너로 감싼다. */
export function ExpandCorner({ onClick, label = '크게 편집' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={`${label} — 거의 전체화면 (문법 체크·정렬·미리보기)`}
      style={corner}
    >⤢</button>
  )
}

const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15, flexShrink: 0 }
const langSel: CSSProperties = { flexShrink: 0, padding: '5px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12 }
const toolBtn: CSSProperties = { flexShrink: 0, padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
const toolOn: CSSProperties = { borderColor: 'var(--fl-primary)', color: 'var(--fl-primary)', background: 'color-mix(in srgb, var(--fl-primary) 10%, var(--fl-surface))' }
const plainArea: CSSProperties = {
  flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', resize: 'none',
  padding: '14px 16px', border: 'none', outline: 'none',
  background: 'var(--fl-surface)', color: 'var(--fl-text)',
  fontFamily: 'var(--fl-font-mono)', fontSize: 13, lineHeight: 1.65, tabSize: 2,
}
const paneWrap: CSSProperties = { width: '46%', minWidth: 320, borderLeft: '1px solid var(--fl-border)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--fl-surface-2)' }
const paneBar: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--fl-border)', flexShrink: 0, flexWrap: 'wrap' }
const sampleBox: CSSProperties = { display: 'grid', gap: 4, padding: '6px 10px', borderBottom: '1px solid var(--fl-border)', maxHeight: 180, overflowY: 'auto', flexShrink: 0 }
const sampleRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const sampleKey: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, minWidth: 140, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fl-primary)' }
const sampleInput: CSSProperties = { flex: 1, minWidth: 0, padding: '3px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, fontFamily: 'var(--fl-font-mono)' }
const corner: CSSProperties = {
  position: 'absolute', top: 5, right: 7, width: 24, height: 24,
  border: '1px solid var(--fl-border)', borderRadius: 6,
  background: 'var(--fl-surface)', color: 'var(--fl-text-muted)',
  cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  opacity: 0.85,
}
