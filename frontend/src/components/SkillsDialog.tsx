import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { assistantApi } from '../api/client'
import type { Skill } from '../api/types'
import { usePermissions } from '../auth/AuthContext'
import { newId } from '../lib/ids'
import { useEditorStore } from '../store/editorStore'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * 스킬 라이브러리 — 재사용 **플로우 조각**(nodes+edges)을 캔버스에 삽입하거나, 현재 선택을 스킬로 저장.
 * 내장 스킬은 읽기전용. AI 어시스턴트도 이 조각들을 알고 조합한다. + 팀 지침(admin).
 */
export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['assistant', 'skills'], queryFn: assistantApi.skills })
  const { canAdmin } = usePermissions()
  const insertFragment = useEditorStore((s) => s.insertFragment)
  const selectionFragment = useEditorStore((s) => s.selectionFragment)
  const [saveName, setSaveName] = useState('')
  const [instrEdit, setInstrEdit] = useState<string | null>(null) // null=미편집(서버값 표시)

  const invalidate = () => qc.invalidateQueries({ queryKey: ['assistant', 'skills'] })
  const saveUser = useMutation({
    mutationFn: (user: Skill[]) => assistantApi.updateSkills({ user }),
    onSuccess: () => { toast('스킬을 저장했습니다.', 'ok'); invalidate() },
    onError: (e: unknown) => toast(errMsg(e, '스킬 저장 실패'), 'error'),
  })
  const saveInstr = useMutation({
    mutationFn: (instructions: string) => assistantApi.updateInstructions({ instructions }),
    onSuccess: () => { toast('팀 지침을 저장했습니다.', 'ok'); setInstrEdit(null); invalidate() },
    onError: (e: unknown) => toast(errMsg(e, '지침 저장 실패(admin 권한 필요)'), 'error'),
  })

  const user = q.data?.user ?? []
  const builtin = q.data?.builtin ?? []

  const insert = (s: Skill) => {
    if (!s.graph) { toast('조각이 비어 있습니다.', 'error'); return }
    const n = insertFragment(s.graph)
    if (n > 0) { toast(`"${s.name}" ${n}개 노드를 캔버스에 삽입했습니다.`, 'ok'); onClose() }
  }

  const saveSelection = () => {
    const name = saveName.trim()
    if (!name) { toast('스킬 이름을 입력하세요.', 'error'); return }
    const frag = selectionFragment()
    if (!frag || frag.nodes.length === 0) { toast('캔버스에서 노드를 선택하세요(없으면 전체).', 'error'); return }
    const nodeTypes = Array.from(new Set(frag.nodes.map((n) => n.type as string).filter(Boolean)))
    const skill: Skill = { id: newId(), name, description: '', nodeTypes, graph: frag }
    saveUser.mutate([...user, skill])
    setSaveName('')
  }

  const del = (id?: string) => saveUser.mutate(user.filter((s) => s.id !== id))

  const serverInstr = q.data?.instructions ?? ''
  const instrValue = instrEdit ?? serverInstr

  return (
    <Modal onClose={onClose} ariaLabel="스킬 라이브러리" width={660} card={{ padding: 18, display: 'block', overflowY: 'auto', maxHeight: '86vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span aria-hidden>🧩</span>
        <b style={{ flex: 1, fontSize: 15 }}>스킬 — 재사용 플로우 조각</b>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>
      <p style={hint}>자주 쓰는 <b>플로우 조각</b>(노드+연결)을 저장해 두고 <b>＋ 삽입</b>으로 어느 플로우에나 붙여 조립합니다. AI 어시스턴트도 이 조각들을 조합해 플로우를 만듭니다.</p>

      {/* 현재 선택을 스킬로 저장 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '12px 0' }}>
        <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="현재 캔버스 선택을 스킬로 저장 — 이름 입력" style={{ ...mono, flex: 1 }} />
        <button onClick={saveSelection} disabled={saveUser.isPending} style={primary}>＋ 선택을 스킬로</button>
      </div>

      {/* 사용자 스킬 */}
      <label style={secLabel}>내 스킬</label>
      {user.length === 0 && <p style={{ ...hint, color: 'var(--fl-text-muted)' }}>저장한 스킬이 없습니다. 캔버스에서 노드를 선택하고 위에 이름을 넣어 저장하세요.</p>}
      <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
        {user.map((s) => (
          <SkillRow key={s.id} skill={s} onInsert={() => insert(s)} onDelete={() => del(s.id)} />
        ))}
      </div>

      {/* 내장 스킬 */}
      <label style={secLabel}>내장 스킬 (항상 사용 가능)</label>
      <div style={{ display: 'grid', gap: 6 }}>
        {builtin.map((s) => (
          <SkillRow key={s.id ?? s.name} skill={s} onInsert={() => insert(s)} />
        ))}
      </div>

      {/* 팀 지침 (admin) */}
      <div style={{ marginTop: 18, borderTop: '1px solid var(--fl-border)', paddingTop: 14 }}>
        <label style={secLabel}>팀 지침 (AI 가 항상 준수 · admin){!canAdmin && <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)' }}> — 읽기전용</span>}</label>
        <textarea
          value={instrValue}
          onChange={(e) => setInstrEdit(e.target.value)}
          disabled={!canAdmin}
          placeholder="예: 기본 API 는 https://api.acme.com. 인증 헤더는 Authorization: Bearer {{ TOKEN@secret }}. HTTP 는 서버 모드."
          style={{ ...mono, minHeight: 72, resize: 'vertical', width: '100%', opacity: canAdmin ? 1 : 0.6 }}
        />
        {canAdmin && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={() => saveInstr.mutate(instrValue)} disabled={saveInstr.isPending || instrEdit === null} style={primary}>지침 저장</button>
            {instrEdit !== null && <button onClick={() => setInstrEdit(null)} style={ghostMini}>되돌리기</button>}
          </div>
        )}
      </div>
    </Modal>
  )
}

function SkillRow({ skill, onInsert, onDelete }: { skill: Skill; onInsert: () => void; onDelete?: () => void }) {
  const nodeCount = (skill.graph?.nodes ?? []).length
  return (
    <div style={row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
          {skill.name}
          {(skill.nodeTypes ?? []).length > 0 && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--fl-primary)', fontFamily: 'var(--fl-font-mono)' }}>[{(skill.nodeTypes ?? []).join(',')}]</span>}
          <span style={{ marginLeft: 6, fontWeight: 400, fontSize: 11, color: 'var(--fl-text-muted)' }}>· 노드 {nodeCount}</span>
        </div>
        {skill.description && <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 2 }}>{skill.description}</div>}
      </div>
      <button onClick={onInsert} style={insertBtn} title="이 조각을 캔버스에 삽입">＋ 삽입</button>
      {onDelete && <button onClick={onDelete} aria-label="삭제" style={xBtnSm}>×</button>}
    </div>
  )
}

function errMsg(e: unknown, fallback: string): string {
  const m = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
  return m || fallback
}

const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', lineHeight: 1.6, margin: 0 }
const secLabel: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--fl-text)', margin: '0 0 6px' }
const mono: CSSProperties = { padding: '7px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, fontFamily: 'var(--fl-font-mono)', boxSizing: 'border-box' }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const xBtnSm: CSSProperties = { width: 24, height: 24, flexShrink: 0, borderRadius: 6, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer' }
const primary: CSSProperties = { padding: '7px 12px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }
const insertBtn: CSSProperties = { flexShrink: 0, padding: '5px 11px', border: '1px solid var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }
const ghostMini: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12 }
