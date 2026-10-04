export interface PlacementRect { x: number; y: number; width: number; height: number }

/** Click additions use nearby free space; existing nodes and explicit drag positions stay unchanged. */
export function findNodePlacement(view: PlacementRect, size: { width: number; height: number }, occupied: PlacementRect[]) {
  const gap = 24
  const preferred = { x: view.x + (view.width - size.width) / 2, y: view.y + (view.height - size.height) / 2 }
  const free = (point: { x: number; y: number }) => !occupied.some(rect =>
    point.x < rect.x + rect.width + gap && point.x + size.width + gap > rect.x &&
    point.y < rect.y + rect.height + gap && point.y + size.height + gap > rect.y)
  const inside = (point: { x: number; y: number }) => point.x >= view.x && point.y >= view.y &&
    point.x + size.width <= view.x + view.width && point.y + size.height <= view.y + view.height
  const candidates = [preferred]
  for (const rect of occupied) {
    for (const y of [preferred.y, rect.y]) {
      candidates.push({ x: rect.x + rect.width + gap, y }, { x: rect.x - size.width - gap, y })
    }
    for (const x of [preferred.x, rect.x]) {
      candidates.push({ x, y: rect.y + rect.height + gap }, { x, y: rect.y - size.height - gap })
    }
  }
  // Include the viewport corners so a large centered card cannot hide available edge space.
  for (const x of [view.x, view.x + view.width - size.width]) {
    for (const y of [view.y, view.y + view.height - size.height]) candidates.push({ x, y })
  }
  candidates.sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y))
  const visible = candidates.find(point => inside(point) && free(point))
  if (visible) return { ...visible, visible: true }
  // A fully occupied/small viewport has a guaranteed free position just beyond the current graph.
  const x = Math.max(preferred.x, ...occupied.map(rect => rect.x + rect.width + gap))
  return { x, y: preferred.y, visible: false }
}
