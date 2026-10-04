type Rect = { x: number; y: number; width: number; height: number }
/** 화면 경계 밖의 선택만 이동한다. 큰 노드는 읽기 시작점인 좌상단을 우선한다. */
export function revealNodeTranslation(node: Rect, canvas: { width: number; height: number }, margin = 24) {
  const axis = (start: number, size: number, available: number) => {
    const inset = Math.min(margin, available / 4)
    if (size > available - inset * 2) return inset - start
    if (start < inset) return inset - start
    if (start + size > available - inset) return available - inset - start - size
    return 0
  }
  return { x: axis(node.x, node.width, canvas.width), y: axis(node.y, node.height, canvas.height) }
}
