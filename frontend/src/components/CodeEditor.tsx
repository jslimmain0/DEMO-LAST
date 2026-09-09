import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { html } from '@codemirror/lang-html'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { syntaxTree } from '@codemirror/language'
import { linter, lintGutter } from '@codemirror/lint'
import type { Diagnostic } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'
import { html as beautifyHtml } from 'js-beautify'
import type { BindableSource } from '../binding/upstream'
import { formatCode } from '../lib/codeFormat'

export type CodeLang = 'html' | 'json' | 'xml'
export interface CodeStatus { line: number; col: number; selected: number; lines: number }
export interface CodeEditorHandle {
  /** 자동 정렬 — ok(바뀜) / noop(이미 정렬) / fail(파싱 불가 — 원문 유지) */
  format: () => 'ok' | 'noop' | 'fail'
  focus: () => void
}

const BEAUTIFY = { indent_size: 2, indent_char: ' ', wrap_line_length: 0, preserve_newlines: true, max_preserve_newlines: 1, indent_inner_html: true, end_with_newline: false, unformatted: [] as string[], content_unformatted: ['pre', 'textarea'], extra_liners: [] as string[] }
const BUILTIN_TOKENS = ['uuid', 'seq', 'now', 'body']

/**
 * 코드 편집기(CodeMirror 6) — BigTextEditor 가 HTML/JSON/XML 본문일 때 textarea 대신 쓴다.
 * 하이라이트(HTML 안의 JS/CSS 포함) + 문법 체크(JSON 은 파서 오류, HTML/XML 은 파스 트리 오류 노드) + **자동 정렬**(js-beautify / JSON 2칸,
 * Shift+Alt+F — `{{ 토큰 }}` 은 보호) + **`{{` 자동완성**(호출처가 넘긴 소스: 예상 요청 키·상태·시크릿·상위 노드 출력 + 내장) +
 * 찾기/바꾸기(Ctrl+F) + 줄바꿈 토글 + 커서/선택 상태 보고. 무거운 의존성이라 BigTextEditor 에서 lazy import — 평소 번들에는 안 실린다.
 */
const CodeEditor = forwardRef<CodeEditorHandle, {
  value: string
  onChange: (v: string) => void
  language: CodeLang
  sources?: BindableSource[]
  wrap?: boolean
  onStatus?: (s: CodeStatus) => void
}>(function CodeEditor({ value, onChange, language, sources = [], wrap = true, onStatus }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange
  const onStatusRef = useRef(onStatus); onStatusRef.current = onStatus
  const sourcesRef = useRef(sources); sourcesRef.current = sources
  const wrapComp = useRef(new Compartment()).current

  const doFormat = (view: EditorView): 'ok' | 'noop' | 'fail' => {
    const cur = view.state.doc.toString()
    const out = formatCode(cur, language, (s) => beautifyHtml(s, BEAUTIFY))
    if (out == null) return 'fail'
    if (out === cur) return 'noop'
    const head = view.state.selection.main.head
    view.dispatch({ changes: { from: 0, to: cur.length, insert: out }, selection: { anchor: Math.min(head, out.length) }, scrollIntoView: true })
    return 'ok'
  }
  useImperativeHandle(ref, () => ({
    format: () => (viewRef.current ? doFormat(viewRef.current) : 'fail'),
    focus: () => viewRef.current?.focus(),
  }))

  useEffect(() => {
    if (!hostRef.current) return
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    // HTML/XML: lezer 파스 트리의 오류 노드를 경고로 표시(템플릿 토큰 {{…}} 이 섞여도 죽지 않는 관대한 체크)
    const treeLinter = linter((view) => {
      const diags: Diagnostic[] = []
      syntaxTree(view.state).cursor().iterate((n) => {
        if (n.type.isError) {
          diags.push({ from: n.from, to: Math.max(n.to, n.from + 1), severity: 'warning', message: '문법 오류로 보입니다 — 태그/괄호 짝을 확인하세요' })
        }
      })
      return diags.slice(0, 50) // 오류 폭주 방지
    })
    const langExts =
      language === 'json' ? [json(), linter(jsonParseLinter())]
      : language === 'xml' ? [xml(), treeLinter]
      : [html(), treeLinter] // html — 내장 css/js 하이라이트 + 태그 자동 닫기
    // `{{` 자동완성 — 언어(HTML 안의 JS/CSS 포함)와 무관하게 전역 languageData 로 제공
    const tokenCompletion = (ctx: CompletionContext): CompletionResult | null => {
      const m = ctx.matchBefore(/\{\{\s*[^{}]*$/)
      if (!m) return null
      const options: Completion[] = []
      for (const s of sourcesRef.current) for (const it of s.items) options.push({ label: `{{ ${it.key}@${s.id} }}`, detail: s.name, type: 'variable', boost: 1 })
      for (const b of BUILTIN_TOKENS) options.push({ label: `{{ ${b} }}`, detail: '내장', type: 'keyword' })
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
        lintGutter(),
        ...langExts,
        EditorState.languageData.of(() => [{ autocomplete: tokenCompletion }]),
        keymap.of([{ key: 'Shift-Alt-f', run: (v) => { doFormat(v); return true } }]),
        ...(dark ? [oneDark] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          if (u.docChanged || u.selectionSet) report(u.state)
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
    view.focus()
    report(view.state)
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // value 는 초기 문서로만 사용 — 이후 동기화는 아래 effect 가 담당(재생성 방지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language])

  // 밖에서 value 가 바뀐 경우(프리셋 버튼 등) 문서를 교체 — 자기 onChange 에는 이미 같아서 no-op
  useEffect(() => {
    const v = viewRef.current
    if (v && value !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
    }
  }, [value])
  // 줄바꿈 토글
  useEffect(() => { viewRef.current?.dispatch({ effects: wrapComp.reconfigure(wrap ? EditorView.lineWrapping : []) }) }, [wrap, wrapComp])

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
})

export default CodeEditor
