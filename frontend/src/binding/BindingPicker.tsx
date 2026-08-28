import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Binding } from '../api/types'
import { catColor, typeIcon, typeLabel } from '../canvas/nodeMeta'
import { Modal } from '../components/Modal'
import { getRecentBindings, pushRecentBinding } from './recentBindings'
import type { BindableItem, BindableSource } from './upstream'

// 한 소스가 이보다 많은 항목을 가지면 접어서 보여준다(+N개 더) — 칩 수십 개가 화면을 덮는 것 방지.
const TRUNC = 12

interface Entry { it: BindableItem; src: BindableSource }
interface Section {
  id: string
  label: string
  sub?: string
  icon?: string
  iconColor?: string
  entries: Entry[]      // 실제 렌더할 항목(접힘/축약 반영)
  total: number         // 매칭된 전체 항목 수(배지)
  hiddenCount: number   // '+N개 더' 로 감춰진 수
  collapsible: boolean
  isRecent?: boolean
}

// 상위 노드들의 요청/응답 규격을 블록으로 골라 바인딩을 삽입하는 모달 (UI/UX 스펙 §7.3).
export function BindingPicker({
  sources,
  onPick,
  onClose,
}: {
  sources: BindableSource[]
  onPick: (binding: Binding) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  // 기본 접힘 — 노드가 많을 때 칩 벽이 한 번에 쏟아지지 않게. 소스가 2개 이하면 바로 펼쳐준다.
  const [openSecs, setOpenSecs] = useState<Set<string>>(() =>
    sources.length <= 2 ? new Set(sources.map((s) => s.id)) : new Set())
  const [showAll, setShowAll] = useState<Set<string>>(new Set()) // '+N개 더' 로 펼친 섹션
  const listRef = useRef<HTMLDivElement>(null)
  const query = q.trim().toLowerCase()

  // 최근 사용 — 현재 소스에 아직 존재하는 것만(지워진 노드/키는 자연 탈락). 검색 중엔 숨김(중복 노출 방지).
  const recent = useMemo<Entry[]>(() => {
    if (query) return []
    const out: Entry[] = []
    for (const r of getRecentBindings()) {
      const src = sources.find((s) => s.id === r.sourceId)
      if (!src) continue
      const it = src.items.find((x) => x.key === r.key && (x.scope ?? null) === (r.scope ?? null))
      if (it) out.push({ it, src })
    }
    return out
  }, [sources, query])

  const sections = useMemo<Section[]>(() => {
    const list: Section[] = []
    if (recent.length) {
      list.push({ id: '__recent', label: '최근 사용', icon: '🕘', entries: recent, total: recent.length, hiddenCount: 0, collapsible: false, isRecent: true })
    }
    for (const s of sources) {
      let items = s.items
      if (query) {
        items = s.items.filter((it) => it.key.toLowerCase().includes(query))
        // 키가 안 걸려도 노드 이름이 걸리면 그 노드의 전체 항목을 보여준다(빈 섹션 방지)
        if (items.length === 0 && s.name.toLowerCase().includes(query)) items = s.items
        if (items.length === 0) continue
      }
      const total = items.length
      let entries = items.map((it) => ({ it, src: s }))
      let hiddenCount = 0
      if (!query && !openSecs.has(s.id)) {
        entries = []
      } else if (!query && !showAll.has(s.id) && entries.length > TRUNC) {
        hiddenCount = entries.length - TRUNC
        entries = entries.slice(0, TRUNC)
      }
      list.push({
        id: s.id, label: s.name, sub: `${typeLabel(s.type)} · #${s.id}`,
        icon: typeIcon(s.type), iconColor: catColor(s.cat),
        entries, total, hiddenCount, collapsible: !query,
      })
    }
    return list
  }, [sources, recent, query, openSecs, showAll])

  const pick = (e: Entry) => {
    const b: Binding = { nodeName: e.src.name, cat: e.src.cat, key: e.it.key, sourceId: e.src.id, scope: e.it.scope }
    pushRecentBinding(b)
    onPick(b)
    onClose()
  }

  // 키보드 선택 — 검색 후 방향키로 이동, Enter 로 삽입. flat 은 렌더 순서와 동일.
  const flat = useMemo(() => sections.flatMap((sec) => sec.entries), [sections])
  const [active, setActive] = useState(0)
  useEffect(() => { setActive(0) }, [q])
  useEffect(() => { if (active >= flat.length) setActive(Math.max(0, flat.length - 1)) }, [flat.length, active])
  // 활성 칩이 스크롤 밖이면 따라간다
  useEffect(() => {
    listRef.current?.querySelector('[data-bp-active="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, flat])
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const sel = flat[active]; if (sel) pick(sel) }
    else if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } // Esc 1회=검색어 지움, 2회=닫기
  }
  const toggleCollapse = (id: string) => setOpenSecs((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  // 모두 펼치기 ⇄ 모두 접기 — 하나라도 접혀 있으면 전체 펼침
  const anyCollapsed = sources.some((s) => !openSecs.has(s.id))
  const toggleAll = () => setOpenSecs(anyCollapsed ? new Set(sources.map((s) => s.id)) : new Set())

  // 검색어 매칭 부분 하이라이트
  const hi = (key: string) => {
    if (!query) return key
    const i = key.toLowerCase().indexOf(query)
    if (i < 0) return key
    return (
      <>
        {key.slice(0, i)}
        <span style={{ background: 'color-mix(in srgb, var(--fl-primary) 28%, transparent)', borderRadius: 3 }}>{key.slice(i, i + query.length)}</span>
        {key.slice(i + query.length)}
      </>
    )
  }

  let gi = -1
  return (
    <Modal onClose={onClose} ariaLabel="데이터 삽입" width={520} maxWidth="100%" maxHeight="70vh">
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 15 }}>데이터 삽입</strong>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="키·노드 검색… (↑↓ 이동, Enter 삽입)" style={search} />
          {!query && sources.length > 0 && (
            <button onClick={toggleAll} title={anyCollapsed ? '모든 섹션 펼치기' : '모든 섹션 접기'}
              style={{ flexShrink: 0, padding: '5px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', fontSize: 11.5, whiteSpace: 'nowrap' }}>
              {anyCollapsed ? '▾ 모두 펼치기' : '▸ 모두 접기'}
            </button>
          )}
          <button onClick={onClose} aria-label="닫기" style={{ border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>

        <div ref={listRef} style={{ overflowY: 'auto', padding: 8, flex: 1 }}>
          {sections.length === 0 && (
            <p style={{ color: 'var(--fl-text-muted)', fontSize: 13, padding: 16, textAlign: 'center' }}>
              {query ? '검색 결과가 없습니다.' : '연결된 상위 노드가 없습니다. 먼저 이 노드에 이전 노드를 연결하세요.'}
            </p>
          )}
          {sections.map((sec) => {
            const isCollapsed = sec.collapsible && !openSecs.has(sec.id) && !sec.isRecent
            return (
            <section key={sec.id} style={{ marginBottom: 8 }}>
              <div
                role={sec.collapsible && !sec.isRecent ? 'button' : undefined}
                tabIndex={sec.collapsible && !sec.isRecent ? 0 : undefined}
                aria-expanded={sec.collapsible && !sec.isRecent ? !isCollapsed : undefined}
                onClick={sec.collapsible && !sec.isRecent ? () => toggleCollapse(sec.id) : undefined}
                onKeyDown={sec.collapsible && !sec.isRecent ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(sec.id) } } : undefined}
                title={sec.collapsible && !sec.isRecent ? (isCollapsed ? '펼치기' : '접기') : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', fontSize: 12, fontWeight: 700, color: 'var(--fl-text-muted)', cursor: sec.collapsible && !sec.isRecent ? 'pointer' : 'default', userSelect: 'none' }}
              >
                {sec.collapsible && !sec.isRecent && <span aria-hidden style={{ fontSize: 9, width: 10, flexShrink: 0 }}>{isCollapsed ? '▸' : '▾'}</span>}
                <span aria-hidden style={{ color: sec.iconColor }}>{sec.icon}</span>
                {sec.label}
                <span style={countBadge}>{sec.total}</span>
                {sec.sub && <span style={{ fontWeight: 400, fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sec.sub}</span>}
              </div>
              {/* 파라미터는 세로 목록 대신 블럭(칩)으로 나열 — 한눈에 훑고 바로 집는다 */}
              {sec.entries.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 8px 4px 27px' }}>
                {sec.entries.map((e, i) => {
                  gi++
                  const isActive = gi === active
                  const isResp = e.it.group === 'response'
                  return (
                  <button
                    key={`${e.src.id}-${e.it.group}-${e.it.key}-${i}`}
                    data-bp-active={isActive ? '1' : undefined}
                    onClick={() => pick(e)}
                    onMouseEnter={() => setActive(gi)}
                    className="fl-bind-chip"
                    title={`${isResp ? '응답' : '요청'} · ${e.it.key}${e.it.type ? ` (${e.it.type})` : ''}${sec.isRecent ? ` — ${e.src.name}` : ''}`}
                    style={{ ...chipBtn(isResp), ...(isActive ? { outline: '2px solid var(--fl-primary)', outlineOffset: 1 } : {}) }}
                  >
                    {/* 색 단독 금지(1.4.1) — 응답/요청 구분은 텍스트 태그로 */}
                    <span style={{ fontSize: 9.5, fontWeight: 700, flexShrink: 0, color: isResp ? 'var(--fl-ok)' : 'var(--fl-running)' }}>
                      {isResp ? '응답' : '요청'}
                    </span>
                    <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{hi(e.it.key)}</span>
                    {e.it.type && <span style={typeBadge}>{e.it.type}</span>}
                    {sec.isRecent && <span style={{ ...typeBadge, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.src.name}</span>}
                  </button>
                ) })}
                {sec.hiddenCount > 0 && (
                  <button
                    onClick={() => setShowAll((p) => new Set(p).add(sec.id))}
                    style={{ ...chipBtn(false), borderStyle: 'dashed', color: 'var(--fl-text-muted)', fontSize: 11.5 }}
                    title="이 노드의 나머지 항목 펼치기"
                  >+{sec.hiddenCount}개 더</button>
                )}
              </div>
              )}
            </section>
          ) })}
        </div>
      </Modal>
  )
}

const search: CSSProperties = { flex: 1, padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13 }
function chipBtn(isResponse: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    border: `1px solid color-mix(in srgb, ${isResponse ? 'var(--fl-ok)' : 'var(--fl-running)'} 45%, var(--fl-border))`,
    borderRadius: 'var(--fl-radius-pill)',
    background: 'var(--fl-surface)',
    cursor: 'pointer',
    color: 'var(--fl-text)',
    maxWidth: '100%',
  }
}
const typeBadge: CSSProperties = { fontSize: 10, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 5, flexShrink: 0 }
const countBadge: CSSProperties = { flexShrink: 0, fontSize: 10, fontWeight: 600, color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', borderRadius: 8, padding: '1px 6px' }
