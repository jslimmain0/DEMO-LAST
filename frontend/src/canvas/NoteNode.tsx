import type { NodeProps } from '@xyflow/react'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from './graphAdapter'
import { annoColor } from './nodeMeta'

/**
 * 메모(스티키 노트) — 캔버스 주석. 핸들(연결)이 없고 실행에서 제외된다.
 * 본문은 노드 안 textarea 로 바로 입력(nodrag — 타이핑/드래그 선택이 노드 이동으로 새지 않게).
 */
export function NoteNode({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const update = useEditorStore((s) => s.updateNodeData)
  const c = annoColor(n.noteColor)

  return (
    <div
      style={{
        width: 220,
        background: c.bg,
        border: `1px solid ${selected ? 'var(--fl-primary)' : c.border}`,
        borderRadius: 8,
        boxShadow: selected ? 'var(--fl-shadow-lg)' : 'var(--fl-shadow)',
        padding: '7px 9px 9px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        fontFamily: 'var(--fl-font-ui)',
      }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 700, color: c.border, letterSpacing: '.02em', display: 'flex', alignItems: 'center', gap: 5 }}>
        <span aria-hidden>✎</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name || '메모'}</span>
      </div>
      <textarea
        className="nodrag fl-note-text"
        aria-label="메모 내용"
        value={n.noteText ?? ''}
        onChange={(e) => update(n.id, { noteText: e.target.value })}
        placeholder="메모를 입력하세요…"
        rows={3}
        style={{
          width: '100%',
          minHeight: 56,
          border: 'none',
          outline: 'none',
          resize: 'none',
          background: 'transparent',
          color: 'var(--fl-text)',
          fontSize: 12.5,
          lineHeight: 1.5,
          fontFamily: 'var(--fl-font-ui)',
        }}
      />
    </div>
  )
}
