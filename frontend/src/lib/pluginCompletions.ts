import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { FlApiEntry } from '../api/types'

/** `fl.` 뒤 — 매니페스트의 네임스페이스/함수를 단계별로 제안(툴팁 = 시그니처·설명·예시). */
export function flCompletionSource(manifest: FlApiEntry[]): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/fl(\.[A-Za-z0-9_]*)*\.?[A-Za-z0-9_]*$/)
    if (!m) return null
    const typed = m.text // 예: "fl.ae" · "fl.aes." · "fl.aes.enc"
    const parts = typed.split('.')
    const prefix = parts.slice(0, -1).join('.') // 확정된 앞부분 "fl" | "fl.aes"
    const seen = new Map<string, Completion>()
    for (const e of manifest) {
      if (!e.path.startsWith(prefix + '.')) continue
      const rest = e.path.slice(prefix.length + 1)
      const head = rest.split('.')[0]
      const leaf = !rest.includes('.')
      if (seen.has(head)) continue
      seen.set(head, leaf
        ? { label: head, type: 'function', detail: e.signature.replace(e.path, ''), info: `${e.doc}\n예: ${e.example}`, apply: head + '(' }
        : { label: head, type: 'namespace', detail: '…' })
    }
    if (seen.size === 0) return null
    const from = m.from + prefix.length + 1
    return { from, options: [...seen.values()], validFor: /^[A-Za-z0-9_]*$/ }
  }
}

/** `inputs.` / `config.` / `ctx.` 뒤 — 문서에 선언된 key 를 제안(정규식 스캔, 파싱 없음). */
export function declaredKeysSource(getDoc: () => string): CompletionSource {
  const keysIn = (doc: string, section: 'inputs' | 'params'): string[] => {
    const block = new RegExp(`${section}\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(doc)?.[1] ?? ''
    return [...block.matchAll(/key\s*:\s*['"]([^'"]+)['"]/g)].map((x) => x[1])
  }
  return (ctx) => {
    const m = ctx.matchBefore(/\b(inputs|config|ctx)\.[A-Za-z0-9_]*$/)
    if (!m) return null
    const root = m.text.split('.')[0]
    const doc = getDoc()
    const opts: Completion[] = root === 'inputs' ? keysIn(doc, 'inputs').map((k) => ({ label: k, type: 'property' }))
      : root === 'config' ? keysIn(doc, 'params').map((k) => ({ label: k, type: 'property' }))
      : [{ label: 'config', type: 'property' }, { label: 'direction', type: 'property' }, { label: 'field', type: 'property' }, { label: 'message', type: 'property' }]
    if (opts.length === 0) return null
    return { from: m.from + root.length + 1, options: opts, validFor: /^[A-Za-z0-9_]*$/ }
  }
}
