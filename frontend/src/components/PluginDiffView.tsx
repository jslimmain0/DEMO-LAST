export function PluginDiffView({ before, after }: { before: string; after: string }) {
  return <pre style={{ margin: 0, padding: 14, overflow: 'auto', flex: 1 }}>{before === after ? '승인본과 동일' : after}</pre>
}
