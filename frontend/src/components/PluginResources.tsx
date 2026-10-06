import { Link } from 'react-router-dom'
import type { useTransformCatalog } from '../lib/useTransformCatalog'

export function PluginResourceNotice({ catalog, selected = [] }: { catalog: ReturnType<typeof useTransformCatalog>; selected?: string[] }) {
  const { resources, query, label, location } = catalog
  if (!catalog.allowed) return <p role="status" style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--fl-text-muted)' }}>플러그인은 공용·팀 워크스페이스에서만 사용할 수 있습니다.</p>
  const missing = query.isSuccess ? [...new Set(selected)].filter(id => id && !query.data?.some(p => p.id === id)) : []
  return <div style={{ fontSize: 12, lineHeight: 1.55, overflowWrap: 'anywhere', margin: '6px 0 10px', color: 'var(--fl-text-muted)' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center' }}>
      <span>{label} · 중앙 서버의 승인된 플러그인</span>
      <Link to={location} target="_blank" rel="noreferrer">플러그인 목록</Link>
      <button type="button" disabled={!resources.available || query.isFetching} onClick={() => void query.refetch()} style={{ border: 0, background: 'transparent', color: 'var(--fl-primary)', padding: '2px 0', font: 'inherit', cursor: 'pointer' }}>목록 새로고침</button>
    </div>
    {!resources.available ? <p role="status">{label}에 연결할 수 없습니다.</p>
      : query.isError ? <p role="alert">플러그인 목록을 불러오지 못했습니다. 목록 새로고침으로 다시 확인하세요.</p>
      : query.isPending ? <p role="status">플러그인 확인 중…</p> : null}
    {missing.length > 0 && <p role="alert" style={{ color: 'var(--fl-fail)', margin: '5px 0 0' }}>{label}에 승인된 플러그인이 없습니다: {missing.join(', ')}. 다른 공간의 플러그인은 자동 복사되지 않습니다.</p>}
  </div>
}
