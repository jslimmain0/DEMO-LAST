import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { html } from '@codemirror/lang-html'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { syntaxTree } from '@codemirror/language'
import { linter, lintGutter } from '@codemirror/lint'
import type { Diagnostic } from '@codemirror/lint'
import { oneDark } from '@codemirror/theme-one-dark'

export type CodeLang = 'html' | 'json' | 'xml'

/**
 * 코드 편집기(CodeMirror 6) — BigTextEditor 가 HTML/JSON/XML 본문일 때 textarea 대신 쓴다.
 * 하이라이트(HTML 안의 JS/CSS 포함) + 문법 체크(JSON 은 파서 오류, HTML/XML 은 파스 트리 오류 노드).
 * 무거운 의존성이라 BigTextEditor 에서 lazy import — 평소 번들에는 안 실린다.
 */
export default function CodeEditor({
  value,
  onChange,
  language,
}: {
  value: string
  onChange: (v: string) => void
  language: CodeLang
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

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
      : [html(), treeLinter] // html — 내장 css/js 하이라이트 포함
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        lintGutter(),
        ...langExts,
        ...(dark ? [oneDark] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--fl-surface)' },
          '.cm-scroller': { fontFamily: 'var(--fl-font-mono)', lineHeight: '1.65' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    })
    viewRef.current = view
    view.focus()
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

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }} />
}
