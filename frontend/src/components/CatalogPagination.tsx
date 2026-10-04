import { catalogPage } from '../lib/catalog'
import { AppIcon } from './AppIcon'

export function CatalogPagination({ total, page, size, onPage, onSize, label }: {
  total: number; page: number; size: number; onPage: (page: number) => void; onSize?: (size: number) => void; label: string
}) {
  const range = catalogPage(total, page, size)
  return <nav aria-label={`${label} 페이지`} className="fl-catalog-pagination">
    <span role="status" className="fl-catalog-pagination__range">{total ? `${range.start + 1}–${range.end}` : '0'} / {total.toLocaleString()}개</span>
    {onSize && <select aria-label={`${label} 페이지당 개수`} value={size} onChange={e => onSize(Number(e.target.value))} className="fl-control">{[25, 50, 100].map(n => <option key={n} value={n}>{n}개씩</option>)}</select>}
    <button className="fl-action-button" disabled={range.page === 1} onClick={() => onPage(range.page - 1)}><AppIcon name="chevronLeft" size={14} />이전</button>
    <span className="fl-catalog-pagination__page">{range.page} / {range.pages}</span>
    <button className="fl-action-button" disabled={range.page === range.pages} onClick={() => onPage(range.page + 1)}>다음<AppIcon name="chevronRight" size={14} /></button>
  </nav>
}
