import type { EditorDiagnostic } from './CodeEditor'

export function PluginRunPanel(_: { source: string; scriptId: string | null; canRun: boolean; onDiagnostics: (d: EditorDiagnostic[]) => void }) {
  return <aside style={{ padding: 14, fontSize: 12.5, color: 'var(--fl-text-muted)' }}>실행 패널(Task 11)</aside>
}
