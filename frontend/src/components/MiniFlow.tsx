import { CAT_COLOR, catColor, typeIcon } from '../canvas/nodeMeta'
import { useReadableInk } from '../lib/contrast'

// 워크플로의 노드 구성을 캔버스와 같은 노드/흐름 언어로 시각화한다.
// hero 는 아이콘 칩 시퀀스(FlowStrip), 카드는 색 도트 미니어처(FlowMini).

export interface MiniNode {
  type: string
  cat?: string
}

/** 카테고리색 배경 위 아이콘 칩 — 글자색을 배경 대비로 골라(테마·색 무관 가독성) 렌더. */
function CatIcon({ type, cat, size, radius, fontSize }: { type: string; cat?: string; size: number; radius: number; fontSize: number }) {
  const bg = catColor(cat ?? type)
  const ink = useReadableInk(bg)
  return (
    <span title={type} style={{
      width: size, height: size, borderRadius: radius, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: bg, color: ink, fontSize, flexShrink: 0,
    }}>
      {typeIcon(type)}
    </span>
  )
}

/** hero 밴드용 — 노드를 typeIcon + catColor 칩으로 실제 실행 순서대로 이어붙인다. */
export function FlowStrip({ nodes, max = 8 }: { nodes: MiniNode[]; max?: number }) {
  const shown = nodes.slice(0, max)
  const extra = nodes.length - shown.length
  return (
    <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', paddingBottom: 2 }} aria-hidden>
      {shown.map((n, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {i > 0 && <span style={{ width: 16, height: 2, background: 'var(--fl-border)', flexShrink: 0 }} />}
          <CatIcon type={n.type} cat={n.cat} size={30} radius={9} fontSize={14} />
        </div>
      ))}
      {extra > 0 && (
        <span style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', flexShrink: 0 }}>
          +{extra}
        </span>
      )}
    </div>
  )
}

/** 카드 리드용 — 노드 카테고리를 색 도트 미니어처로(캔버스 흐름의 축소판). */
export function FlowMini({ cats, max = 6 }: { cats: string[]; max?: number }) {
  const shown = cats.slice(0, max)
  const extra = cats.length - shown.length
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }} aria-hidden>
      {shown.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {i > 0 && <span style={{ width: 7, height: 2, background: 'var(--fl-border)' }} />}
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: catColor(c) }} />
        </div>
      ))}
      {extra > 0 && <span style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', marginLeft: 4, fontFamily: 'var(--fl-font-mono)' }}>+{extra}</span>}
    </div>
  )
}

/** 빈 상태 온보딩용 — 흐릿한 고스트 흐름(▶ … ■). */
export function FlowGhost() {
  const ghost = ['start', 'generic', 'if', 'http', 'end']
  return (
    <div style={{ display: 'flex', alignItems: 'center', opacity: 0.45 }} aria-hidden>
      {ghost.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
          {i > 0 && <span style={{ width: 14, height: 2, background: 'var(--fl-border)' }} />}
          <CatIcon type={c} size={26} radius={8} fontSize={12} />
        </div>
      ))}
    </div>
  )
}

// 그래프가 아직 로드되기 전, id 를 해시해 온브랜드 카테고리 색을 결정적으로 고르는 폴백.
const CAT_KEYS = Object.keys(CAT_COLOR).filter((k) => !['generic', 'start', 'end'].includes(k))
export function fallbackCats(id: string, n = 4): string[] {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return Array.from({ length: n }, (_, i) => CAT_KEYS[(h + i * 7) % CAT_KEYS.length])
}

/** 워크플로의 지배 카테고리(좌측 스파인 색) — 노드가 있으면 최빈 cat, 없으면 id 해시 폴백. */
export function dominantCat(cats: string[] | undefined, id: string): string {
  if (cats && cats.length > 0) {
    const count = new Map<string, number>()
    for (const c of cats) if (c !== 'start' && c !== 'end') count.set(c, (count.get(c) ?? 0) + 1)
    let best = cats[0]
    let max = 0
    for (const [c, n] of count) if (n > max) { max = n; best = c }
    return best
  }
  return fallbackCats(id, 1)[0]
}
