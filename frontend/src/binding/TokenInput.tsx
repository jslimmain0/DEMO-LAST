import type { CSSProperties, ClipboardEvent, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { DataInsertIcon } from '../components/icons'
import { asGraphNode } from '../canvas/graphAdapter'
import { catColor, typeIcon } from '../canvas/nodeMeta'
import { parseToken, segmentValue, tokenRegex, bindingToToken } from '../lib/tokenGrammar'
import { useEditorStore } from '../store/editorStore'
import type { Binding } from '../api/types'
import { BindingPicker } from './BindingPicker'
import type { BindableSource } from './upstream'

/**
 * 데이터 삽입 토큰({{ key@노드 }})을 <b>인라인 블럭(칩)</b>으로 보여주는 한 줄 입력.
 * 텍스트와 칩을 자유롭게 섞어 쓸 수 있다 — "https://" + [수신 URL 칩] + "/return" 같은 조합.
 *
 * 저장 포맷은 순수 문자열(토큰 포함) 그대로라 백엔드 resolveTokens 와 1:1 — 칩은 렌더링일 뿐이다.
 * contentEditable 은 비제어(uncontrolled)로 두고, 부모 value 가 밖에서 바뀔 때만 DOM 을 다시 그린다
 * (IME 조합 중 재렌더로 한글 입력이 깨지는 것 방지).
 *
 * 기본(inline)은 <b>한 줄 고정</b> — 값이 길어도 줄로 늘어나지 않고 가로 스크롤되며,
 * 넘치면 ⤢(자세히 보기) 버튼이 나타나 크게 편집하는 다이얼로그를 연다(variant="large").
 */
export function TokenInput({
  value,
  onChange,
  sources,
  placeholder,
  ariaLabel,
  autoFocus = false,
  variant = 'inline',
}: {
  value: string
  onChange: (v: string) => void
  sources: BindableSource[]
  placeholder?: string
  ariaLabel?: string
  autoFocus?: boolean
  variant?: 'inline' | 'large' // large = 자세히 보기 다이얼로그 안의 큰 편집(줄바꿈 표시 허용)
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastValueRef = useRef<string | null>(null) // 마지막으로 emit/rebuild 한 값 — echo 재렌더 방지
  const savedRangeRef = useRef<Range | null>(null) // 피커 열기 직전 캐럿 위치(칩 삽입 지점)
  const [picking, setPicking] = useState(false)
  const [empty, setEmpty] = useState(value === '')
  const [overflow, setOverflow] = useState(false) // inline: 내용이 한 줄을 넘는가 → ⤢ 자세히 보기 노출
  const [expanded, setExpanded] = useState(false)
  const isLarge = variant === 'large'

  // 칩 × 삭제 콜백은 DOM 에 남아 오래 살므로, 항상 최신 onChange 를 보도록 ref 로 우회(stale closure 방지)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const updateOverflow = () => {
    const root = rootRef.current
    if (!root || isLarge) return
    setOverflow(root.scrollWidth > root.clientWidth + 1)
  }

  const emit = () => {
    const root = rootRef.current
    if (!root) return
    const s = serializeDom(root)
    lastValueRef.current = s
    setEmpty(s === '')
    onChangeRef.current(s)
    updateOverflow()
  }

  // 밖에서 value 가 바뀐 경우에만 DOM 재구성(자기 echo 는 건너뜀 — 캐럿/IME 보존)
  useEffect(() => {
    if (value === lastValueRef.current) {
      updateOverflow()
      return
    }
    lastValueRef.current = value
    setEmpty(value === '')
    const root = rootRef.current
    if (root) rebuildDom(root, value, emit)
    updateOverflow()
    // emit 은 칩 × 삭제 콜백용 — rebuild 자체는 onChange 를 부르지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // 패널 리사이즈 등 컨테이너 폭 변화에도 넘침 여부 재계산
  useEffect(() => {
    const root = rootRef.current
    if (!root || isLarge) return
    const ro = new ResizeObserver(() => updateOverflow())
    ro.observe(root)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLarge])

  useEffect(() => {
    const root = rootRef.current
    if (!autoFocus || !root) return
    root.focus()
    // 캐럿을 내용 끝으로 — 자세히 보기로 열었을 때 바로 이어서 편집
    const sel = window.getSelection()
    if (sel) {
      const r = document.createRange()
      r.selectNodeContents(root)
      r.collapse(false)
      sel.removeAllRanges()
      sel.addRange(r)
    }
  }, [autoFocus])

  const saveRange = () => {
    const root = rootRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0) return
    const r = sel.getRangeAt(0)
    if (root.contains(r.startContainer)) savedRangeRef.current = r.cloneRange()
  }

  // 칩이 맨 앞/맨 끝인데 패드(제로폭 공백)가 지워졌으면 복구 — 캐럿 착지 자리를 항상 보장
  const ensurePads = () => {
    const root = rootRef.current
    if (!root) return
    const first = root.firstChild
    if (first instanceof HTMLElement && first.dataset.token) root.insertBefore(document.createTextNode(ZWSP), first)
    const last = root.lastChild
    if (last instanceof HTMLElement && last.dataset.token) root.appendChild(document.createTextNode(ZWSP))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') e.preventDefault() // 한 줄 입력 — 줄바꿈 금지
  }

  // 붙여넣기는 항상 평문으로 — 토큰이 섞여 있으면 즉시 칩으로 렌더
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain').replace(/\r?\n/g, ' ')
    insertAtCaret(text)
  }

  // 복사/잘라내기 — 칩은 라벨 텍스트가 아니라 토큰 원문({{ key@노드 }})으로 클립보드에 실린다
  const onCopyOrCut = (e: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const root = rootRef.current
    const sel = window.getSelection()
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return
    e.preventDefault()
    const holder = document.createElement('div')
    holder.appendChild(range.cloneContents())
    e.clipboardData.setData('text/plain', serializeDom(holder))
    if (cut) {
      range.deleteContents()
      emit()
    }
  }

  const insertAtCaret = (text: string) => {
    const root = rootRef.current
    if (!root) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !root.contains(sel.getRangeAt(0).startContainer)) {
      // 캐럿이 에디터 밖이면 끝에 덧붙임
      root.append(...buildNodes(text, emit))
      emit()
      return
    }
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const nodes = buildNodes(text, emit)
    let lastNode: Node | null = null
    for (const n of nodes) {
      range.insertNode(n)
      range.setStartAfter(n)
      lastNode = n
    }
    if (lastNode) {
      range.setStartAfter(lastNode)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    emit()
  }

  // 데이터 삽입 피커에서 고른 바인딩을 저장해 둔 캐럿 위치(없으면 끝)에 칩으로 삽입
  const insertBinding = (b: Binding) => {
    const root = rootRef.current
    if (!root) return
    root.focus() // 피커(모달)에서 돌아온 포커스를 입력으로 복귀 — 바로 이어서 타이핑 가능
    const token = bindingToToken(b)
    const chip = makeChip(token, emit)
    // 칩 뒤에 제로폭 공백을 둬서 칩이 맨 끝이어도 그 뒤에 캐럿을 놓고 이어서 타이핑할 수 있게 한다
    // (Chromium 은 trailing non-editable 요소 뒤에 캐럿을 못 둔다). 직렬화 시 제거된다.
    const pad = document.createTextNode(ZWSP)
    const saved = savedRangeRef.current
    if (saved && root.contains(saved.startContainer)) {
      saved.deleteContents()
      saved.insertNode(pad)
      saved.insertNode(chip)
      saved.setStartAfter(pad)
      saved.collapse(true)
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(saved)
      }
    } else {
      root.appendChild(chip)
      root.appendChild(pad)
    }
    emit()
  }

  // 손으로 {{ … }} 를 타이핑한 경우 — 포커스를 벗어날 때 칩으로 정돈
  const onBlur = () => {
    saveRange()
    const root = rootRef.current
    if (!root) return
    if (hasRawTokenText(root)) {
      const s = serializeDom(root)
      rebuildDom(root, s, emit)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0 }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        {empty && placeholder && (
          <span aria-hidden style={placeholderStyle}>{placeholder}</span>
        )}
        <div
          ref={rootRef}
          className="fl-token-input"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label={ariaLabel}
          spellCheck={false}
          style={isLarge ? editorLargeStyle : editorStyle}
          onInput={emit}
          onKeyDown={onKeyDown}
          onKeyUp={() => { ensurePads(); saveRange() }}
          onMouseUp={saveRange}
          onClick={ensurePads}
          onPaste={onPaste}
          onCopy={(e) => onCopyOrCut(e, false)}
          onCut={(e) => onCopyOrCut(e, true)}
          onDrop={(e) => e.preventDefault()} // 드롭 삽입 차단 — 표시 DOM/저장값 불일치·리스너 없는 칩 복제 방지
          onBlur={onBlur}
        />
        {!isLarge && overflow && <span aria-hidden style={fadeStyle} />}
        {!isLarge && overflow && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            title="자세히 보기 — 크게 편집"
            aria-label="자세히 보기"
            style={expandBtn}
          >⤢</button>
        )}
      </div>
      <button
        type="button"
        onClick={() => setPicking(true)}
        title="데이터 삽입"
        aria-label="데이터 삽입"
        style={braceBtn}
      ><DataInsertIcon /></button>
      {picking && (
        <BindingPicker
          sources={sources}
          onClose={() => setPicking(false)}
          onPick={(b) => insertBinding(b)}
        />
      )}
      {expanded && (
        <ExpandDialog label={ariaLabel ?? '값'} onClose={() => setExpanded(false)}>
          <TokenInput
            variant="large"
            value={value}
            onChange={onChange}
            sources={sources}
            placeholder={placeholder}
            ariaLabel={`${ariaLabel ?? '값'} 자세히 보기`}
            autoFocus
          />
        </ExpandDialog>
      )}
    </div>
  )
}

/** 자세히 보기 다이얼로그 — 긴 값을 줄바꿈 표시로 크게 편집(저장 값은 그대로 한 줄). */
function ExpandDialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  // Esc: 위에 데이터 삽입 피커가 떠 있으면 그쪽이 닫히도록 양보(이중 닫힘 방지)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[aria-label="데이터 삽입"][role="dialog"]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label={`${label} 자세히 보기`} style={dlgOverlay} onClick={onClose}>
      <div style={dlgCard} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 14.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label} — 자세히 보기</strong>
          <button onClick={onClose} aria-label="닫기" style={{ border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>
        <div style={{ padding: 16, display: 'flex' }}>{children}</div>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 16px 14px' }}>
          <button onClick={onClose} style={dlgDoneBtn}>완료</button>
        </footer>
      </div>
    </div>
  )
}

// --- DOM 직렬화/구성 (칩 = data-token 스팬, 그 외는 평문) ---

// 칩 앞뒤 캐럿 착지용 제로폭 공백 — 화면에 안 보이고 직렬화에서 제거된다.
const ZWSP = '\u200B'

function serializeDom(root: HTMLElement): string {
  let out = ''
  const walk = (n: ChildNode) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.nodeValue ?? ''
      return
    }
    if (!(n instanceof HTMLElement)) return
    if (n.dataset.token) {
      out += n.dataset.token
      return
    }
    if (n.tagName === 'BR') return // 한 줄 입력 — 브라우저가 넣는 표시용 <br> 무시
    n.childNodes.forEach(walk)
  }
  root.childNodes.forEach(walk)
  return out.replace(/[\n\u200B]/g, '')
}

function rebuildDom(root: HTMLElement, value: string, onMutate: () => void) {
  root.textContent = ''
  root.append(...buildNodes(value, onMutate))
}

function buildNodes(value: string, onMutate: () => void): Node[] {
  const segs = segmentValue(value)
  const out: Node[] = []
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (seg.type === 'text') {
      out.push(document.createTextNode(seg.text))
      continue
    }
    // 칩이 맨 앞이거나 칩끼리 붙으면 사이에 제로폭 공백 — 캐럿을 놓을 자리를 보장
    if (i === 0 || segs[i - 1].type === 'token') out.push(document.createTextNode(ZWSP))
    out.push(makeChip(seg.raw, onMutate))
    if (i === segs.length - 1) out.push(document.createTextNode(ZWSP)) // 칩이 맨 끝
  }
  return out
}

/** 칩 밖(텍스트 노드)에 완성된 토큰 문자열이 남아 있는지 — blur 시 칩으로 정돈할지 판단. */
function hasRawTokenText(root: HTMLElement): boolean {
  let text = ''
  const walk = (n: ChildNode) => {
    if (n.nodeType === Node.TEXT_NODE) {
      text += n.nodeValue ?? ''
      return
    }
    if (n instanceof HTMLElement && n.dataset.token) return
    n.childNodes.forEach(walk)
  }
  root.childNodes.forEach(walk)
  return tokenRegex().test(text)
}

/** 토큰 → 인라인 칩 DOM. 노드 이름/아이콘은 현재 캔버스에서 해석(없으면 sourceId 그대로). */
function makeChip(tokenRaw: string, onMutate: () => void): HTMLSpanElement {
  const parsed = parseToken(tokenRaw)
  const chip = document.createElement('span')
  chip.className = 'fl-token-chip'
  chip.contentEditable = 'false'
  chip.dataset.token = tokenRaw
  chip.title = tokenRaw

  let name: string | null = null
  let icon = '↯'
  let color = 'var(--fl-primary)'
  if (parsed?.sourceId) {
    const rf = useEditorStore.getState().nodes.find((n) => n.id === parsed.sourceId)
    if (rf) {
      const gn = asGraphNode(rf.data)
      name = gn.name ?? parsed.sourceId
      icon = typeIcon(gn.type)
      color = catColor(gn.cat)
    } else {
      name = parsed.sourceId
    }
  }
  chip.style.borderColor = color

  const iconEl = document.createElement('span')
  iconEl.setAttribute('aria-hidden', 'true')
  iconEl.style.color = color
  iconEl.textContent = icon
  chip.appendChild(iconEl)

  const label = document.createElement('span')
  label.className = 'fl-token-chip-label'
  if (name) {
    const nameEl = document.createElement('span')
    nameEl.className = 'fl-token-chip-name'
    nameEl.textContent = name + (parsed?.scope === 'req' ? ' (요청)' : '') + ' · '
    label.appendChild(nameEl)
  }
  const keyEl = document.createElement('strong')
  keyEl.textContent = parsed?.key ?? tokenRaw
  label.appendChild(keyEl)
  chip.appendChild(label)

  const x = document.createElement('span')
  x.className = 'fl-token-chip-x'
  x.setAttribute('role', 'button')
  x.setAttribute('aria-label', '토큰 제거')
  x.textContent = '×'
  x.addEventListener('mousedown', (e) => e.preventDefault()) // 캐럿 이동/포커스 이탈 방지
  x.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    chip.remove()
    onMutate()
  })
  chip.appendChild(x)

  // Alt/⌘+클릭 → 이 토큰이 가리키는 소스 노드로 바로가기(선택 + 캔버스 센터링)
  if (parsed?.sourceId) {
    const jumpId = parsed.sourceId
    if (name && name !== jumpId) chip.title = `${tokenRaw}\n(Alt+클릭: ${name} 노드로 이동)`
  }
  chip.addEventListener('click', (e) => {
    if (e.target === x) return
    if ((e.altKey || e.metaKey) && parsed?.sourceId && useEditorStore.getState().nodes.some((n) => n.id === parsed.sourceId)) {
      e.preventDefault()
      e.stopPropagation()
      useEditorStore.getState().focusNode(parsed.sourceId)
      return
    }
    const editor = chip.closest('.fl-token-input') as HTMLElement | null
    const sel = window.getSelection()
    if (!editor || !sel) return
    editor.focus()
    const r = document.createRange()
    let next = chip.nextSibling
    if (!(next && next.nodeType === Node.TEXT_NODE)) {
      next = document.createTextNode(ZWSP) // 패드가 없으면 만들어서 캐럿 착지 자리를 보장
      chip.after(next)
    }
    r.setStart(next, (next.nodeValue ?? '').startsWith(ZWSP) ? 1 : 0) // 제로폭 공백 다음 — 바로 이어서 타이핑
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  })

  return chip
}

const editorBase: CSSProperties = {
  padding: '6px 9px',
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-text)',
  fontFamily: 'var(--fl-font-mono)',
  fontSize: 12,
  lineHeight: '20px',
  cursor: 'text',
  outlineOffset: 0,
}

// inline: 한 줄 고정 — 값이 길어도 줄로 늘어나지 않고 가로 스크롤(넘치면 ⤢ 자세히 보기)
const editorStyle: CSSProperties = {
  ...editorBase,
  minHeight: 34,
  whiteSpace: 'pre',
  overflowX: 'auto',
  overflowY: 'hidden',
}

// large(자세히 보기): 줄바꿈 "표시"를 허용해 전체 값을 한눈에 — 저장 값은 여전히 한 줄
const editorLargeStyle: CSSProperties = {
  ...editorBase,
  flex: 1,
  minWidth: 0,
  minHeight: 140,
  maxHeight: '50vh',
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontSize: 13,
  lineHeight: '24px',
}

const fadeStyle: CSSProperties = {
  position: 'absolute',
  top: 1,
  bottom: 1,
  right: 1,
  width: 46,
  borderRadius: '0 var(--fl-radius-sm) var(--fl-radius-sm) 0',
  background: 'linear-gradient(to right, transparent, var(--fl-surface) 65%)',
  pointerEvents: 'none',
}

const expandBtn: CSSProperties = {
  position: 'absolute',
  top: '50%',
  right: 5,
  transform: 'translateY(-50%)',
  width: 24,
  height: 24,
  border: '1px solid var(--fl-border)',
  borderRadius: 6,
  background: 'var(--fl-surface)',
  color: 'var(--fl-text-muted)',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
}

const dlgOverlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(26,29,39,.34)',
  zIndex: 180, // 데이터 삽입 피커(200)보다 아래 — 큰 편집 위에서 피커가 뜬다
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
}

const dlgCard: CSSProperties = {
  width: 640,
  maxWidth: '100%',
  background: 'var(--fl-surface)',
  borderRadius: 'var(--fl-radius-lg)',
  boxShadow: 'var(--fl-shadow-lg)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const dlgDoneBtn: CSSProperties = {
  border: 'none',
  background: 'var(--fl-primary)',
  color: '#fff',
  padding: '8px 18px',
  borderRadius: 'var(--fl-radius-sm)',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
}

const placeholderStyle: CSSProperties = {
  position: 'absolute',
  left: 10,
  top: 7,
  right: 8,
  color: 'var(--fl-text-muted)',
  fontFamily: 'var(--fl-font-mono)',
  fontSize: 12,
  lineHeight: '20px',
  pointerEvents: 'none',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  opacity: 0.8,
}

const braceBtn: CSSProperties = {
  width: 32,
  height: 34,
  flexShrink: 0,
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-primary)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
