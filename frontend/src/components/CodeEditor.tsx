import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { html } from '@codemirror/lang-html'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { xml } from '@codemirror/lang-xml'
import { syntaxTree } from '@codemirror/language'
import { linter, lintGutter, setDiagnostics } from '@codemirror/lint'
import type { Diagnostic } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'
import { html as beautifyHtml, js as beautifyJs } from 'js-beautify'
import type { BindableSource } from '../binding/upstream'
import { formatCode, formatWithTokens } from '../lib/codeFormat'

export type CodeLang = 'html' | 'json' | 'xml'
export type EditorLang = CodeLang | 'javascript' | 'text' // text = 하이라이트/체크 없이 편집기 기능(Tab 들여쓰기·undo·찾기·자동완성)만
export interface CodeStatus { line: number; col: number; selected: number; lines: number }
export interface EditorDiagnostic { line: number; col?: number; message: string; severity?: 'error' | 'warning' }
export interface CodeEditorHandle {
  /** 자동 정렬 — ok(바뀜) / noop(이미 정렬) / fail(파싱 불가 — 원문 유지) */
  format: () => 'ok' | 'noop' | 'fail'
  focus: () => void
  /** 커서(선택) 자리에 텍스트 삽입 — 레퍼런스 패널의 예제 삽입 */
  insert: (text: string) => void
}

const BEAUTIFY = { indent_size: 2, indent_char: ' ', wrap_line_length: 0, preserve_newlines: true, max_preserve_newlines: 1, indent_inner_html: true, end_with_newline: false, unformatted: [] as string[], content_unformatted: ['pre', 'textarea'], extra_liners: [] as string[] }
const BUILTIN_TOKENS: Array<[string, string]> = [
  ['uuid', '내장 · 랜덤 UUID'], ['seq', '내장 · 증가 카운터'], ['body', '내장 · 요청 본문 전체'],
  ['now', '내장 · 현재 일시 ISO(UTC)'], ['today', '내장 · 오늘 yyyyMMdd (KST)'], ['time', '내장 · 현재 HHmmss (KST)'],
  ['now:yyyyMMddHHmmss', '내장 · 현재 일시 패턴 (KST)'], ['now:yyyy-MM-dd HH:mm:ss', '내장 · 현재 일시 패턴 (KST)'], ['now:yyyyMMdd@UTC', '내장 · 타임존 지정'],
]

/**
 * 코드 편집기(CodeMirror 6) — BigTextEditor 가 HTML/JSON/XML 본문일 때 textarea 대신 쓴다.
 * 하이라이트(HTML 안의 JS/CSS 포함) + 문법 체크(JSON 은 파서 오류, HTML/XML 은 파스 트리 오류 노드) + **자동 정렬**(js-beautify / JSON 2칸,
 * Shift+Alt+F — `{{ 토큰 }}` 은 보호) + **`{{` 자동완성**(호출처가 넘긴 소스: 예상 요청 키·상태·시크릿·상위 노드 출력 + 내장) +
 * 찾기/바꾸기(Ctrl+F) + 줄바꿈 토글 + 커서/선택 상태 보고. **키 스코프**: Tab 은 들여쓰기(포커스 이탈 아님), Ctrl+Z/Y 는 이 편집기의 히스토리 —
 * 바깥(워크플로 캔버스 undo·노드 검색·빠른 추가)은 contentEditable 가드로 받지 않는다. 무거운 의존성이라 BigTextEditor 에서 lazy import — 평소 번들에는 안 실린다.
 */
const CodeEditor = forwardRef<CodeEditorHandle, {
  value: string
  onChange: (v: string) => void
  language: EditorLang
  sources?: BindableSource[]
  wrap?: boolean
  placeholder?: string
  onStatus?: (s: CodeStatus) => void
  completions?: CompletionSource[]
  diagnostics?: EditorDiagnostic[]
  ariaLabel?: string
  readOnly?: boolean
}>(function CodeEditor({ value, onChange, language, sources = [], wrap = true, placeholder, onStatus, completions, diagnostics, ariaLabel, readOnly = false }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const docValueRef = useRef(value)
  const syncingRef = useRef(false)
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange
  const onStatusRef = useRef(onStatus); onStatusRef.current = onStatus
  const sourcesRef = useRef(sources); sourcesRef.current = sources
  const completionsRef = useRef(completions ?? []); completionsRef.current = completions ?? []
  const wrapComp = useRef(new Compartment()).current
  const themeComp = useRef(new Compartment()).current
  const accessComp = useRef(new Compartment()).current
  const label = ariaLabel ?? `${language === 'javascript' ? 'JavaScript' : language === 'text' ? '텍스트' : language.toUpperCase()} 코드 편집기`

  const doFormat = (view: EditorView): 'ok' | 'noop' | 'fail' => {
    if (language === 'text' || view.state.readOnly) return 'fail'
    const cur = view.state.doc.toString()
    const out = language === 'javascript' ? formatWithTokens(cur, (s) => beautifyJs(s, { indent_size: 2, preserve_newlines: true, max_preserve_newlines: 1 })) : formatCode(cur, language, (s) => beautifyHtml(s, BEAUTIFY))
    if (out == null) return 'fail'
    if (out === cur) return 'noop'
    const head = view.state.selection.main.head
    view.dispatch({ changes: { from: 0, to: cur.length, insert: out }, selection: { anchor: Math.min(head, out.length) }, scrollIntoView: true })
    return 'ok'
  }
  useImperativeHandle(ref, () => ({
    format: () => (viewRef.current ? doFormat(viewRef.current) : 'fail'),
    focus: () => viewRef.current?.focus(),
    insert: (text) => { const v = viewRef.current; if (!v || v.state.readOnly) return; v.dispatch(v.state.replaceSelection(text)); v.focus() },
  }))

  useEffect(() => {
    if (!hostRef.current) return
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    docValueRef.current = value
    let statusFrame = 0
    // HTML/XML: lezer 파스 트리의 오류 노드를 경고로 표시(템플릿 토큰 {{…}} 이 섞여도 죽지 않는 관대한 체크)
    const treeLinter = linter((view) => {
      const diags: Diagnostic[] = []
      const n = syntaxTree(view.state).cursor()
      do {
        if (n.type.isError) {
          diags.push({ from: n.from, to: Math.min(view.state.doc.length, Math.max(n.to, n.from + 1)), severity: 'warning', message: '문법 오류로 보입니다 — 태그/괄호 짝을 확인하세요' })
        }
      } while (diags.length < 50 && n.next())
      return diags
    })
    const langExts =
      language === 'json' ? [json(), linter(jsonParseLinter())]
      : language === 'xml' ? [xml(), treeLinter]
      : language === 'javascript' ? [javascript(), treeLinter]
      : language === 'text' ? []
      : [html(), treeLinter] // html — 내장 css/js 하이라이트 + 태그 자동 닫기
    // `{{` 자동완성 — 언어(HTML 안의 JS/CSS 포함)와 무관하게 전역 languageData 로 제공
    const tokenCompletion = (ctx: CompletionContext): CompletionResult | null => {
      const m = ctx.matchBefore(/\{\{\s*[^{}]*$/)
      if (!m) return null
      const options: Completion[] = []
      for (const s of sourcesRef.current) for (const it of s.items) options.push({ label: `{{ ${it.key}@${s.id} }}`, detail: s.name, type: 'variable', boost: 1 })
      for (const [b, d] of BUILTIN_TOKENS) options.push({ label: `{{ ${b} }}`, detail: d, type: 'keyword' })
      return { from: m.from, options, validFor: /^\{\{\s*[^{}]*$/ }
    }
    const report = (state: EditorState) => {
      const cb = onStatusRef.current
      if (!cb) return
      const sel = state.selection.main
      const line = state.doc.lineAt(sel.head)
      cb({ line: line.number, col: sel.head - line.from + 1, selected: Math.abs(sel.to - sel.from), lines: state.doc.lines })
    }
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        basicSetup,
        wrapComp.of(wrap ? EditorView.lineWrapping : []),
        themeComp.of(dark ? oneDark : []),
        accessComp.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({ 'aria-label': label })]),
        lintGutter(),
        ...langExts,
        EditorState.languageData.of(() => [{ autocomplete: tokenCompletion }, ...completionsRef.current.map((c) => ({ autocomplete: c }))]),
        // Tab = 들여쓰기(Shift+Tab 내어쓰기) — 편집기 밖으로 포커스가 나가지 않는다(나가려면 Esc 후 Tab)
        keymap.of([indentWithTab, { key: 'Shift-Alt-f', run: (v) => { doFormat(v); return true } }]),
        ...(placeholder ? [cmPlaceholder(placeholder)] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            docValueRef.current = u.state.doc.toString()
            if (!syncingRef.current) onChangeRef.current(docValueRef.current)
          }
          // 커서 상태만 바뀌어도 큰 편집 모달 전체가 키마다 다시 그려지지 않게 모은다.
          if ((u.docChanged || u.selectionSet) && onStatusRef.current && !statusFrame) {
            statusFrame = requestAnimationFrame(() => { statusFrame = 0; report(view.state) })
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--fl-surface)' },
          '.cm-scroller': { fontFamily: 'var(--fl-font-mono)', lineHeight: '1.65' },
          '&.cm-focused': { outline: 'none' },
          '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--fl-font-mono)', fontSize: '12px' },
        }),
      ],
    })
    viewRef.current = view
    const themeObserver = new MutationObserver(() => view.dispatch({ effects: themeComp.reconfigure(document.documentElement.getAttribute('data-theme') === 'dark' ? oneDark : []) }))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    view.focus()
    report(view.state)
    return () => {
      viewRef.current = null
      themeObserver.disconnect()
      cancelAnimationFrame(statusFrame)
      view.destroy()
    }
    // value 는 초기 문서로만 사용 — 이후 동기화는 아래 effect 가 담당(재생성 방지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language])

  // 밖에서 value 가 바뀐 경우(프리셋 버튼 등) 문서를 교체 — 자기 onChange 에는 이미 같아서 no-op
  useEffect(() => {
    const v = viewRef.current
    if (v && value !== docValueRef.current) {
      // 상위에서 불러온 본문을 다시 사용자 편집으로 보고하면 새 초안이 즉시 dirty가 된다.
      syncingRef.current = true
      try { v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } }) }
      finally { syncingRef.current = false }
    }
  }, [value])
  // 줄바꿈 토글
  useEffect(() => { viewRef.current?.dispatch({ effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) }) }, [wrap, wrapComp])
  useEffect(() => { viewRef.current?.dispatch({ effects: accessComp.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({ 'aria-label': label })]) }) }, [readOnly, label, accessComp])

  // 서버 컴파일/실행 오류(줄 번호) → 거터. 문서를 고치면 클라이언트 linter 가 다시 돌며 자연히 지워진다.
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    const diags: Diagnostic[] = (diagnostics ?? []).flatMap((d) => {
      if (d.line < 1 || d.line > v.state.doc.lines) return []
      const ln = v.state.doc.line(d.line)
      const from = Math.min(ln.from + Math.max((d.col ?? 1) - 1, 0), ln.to)
      return [{ from, to: Math.min(v.state.doc.length, Math.max(from + 1, ln.to)), severity: d.severity ?? 'error', message: d.message }]
    })
    v.dispatch(setDiagnostics(v.state, diags))
  }, [diagnostics])

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
})

export default CodeEditor
