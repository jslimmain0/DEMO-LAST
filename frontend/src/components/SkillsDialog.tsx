import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { assistantApi } from '../api/client'
import type { Skill } from '../api/types'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * 어시스턴트 지침 + 스킬 관리 — 커스텀 인스트럭션(팀 지침)과 사용자 스킬을 편집.
 * 내장 스킬은 읽기전용으로 표시. 저장 값은 시스템 프롬프트에 주입돼 조직 맞춤 플로우를 생성하게 한다.
 */
export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['assistant', 'skills'], queryFn: assistantApi.skills })
  const [instr, setInstr] = useState('')
  const [user, setUser] = useState<Skill[]>([])

  // 서버 값 로드 시 로컬 편집 상태 초기화(최초/재오픈)
  useEffect(() => {
    if (q.data) { setInstr(q.data.instructions ?? ''); setUser(q.data.user ?? []) }
  }, [q.data])

  const save = useMutation({
    mutationFn: () => assistantApi.updateSkills({ instructions: instr, user: user.filter((s) => s.name.trim()) }),
    onSuccess: () => { toast('지침·스킬을 저장했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['assistant', 'skills'] }) },
    onError: (e: unknown) => toast(errMsg(e, '저장 실패'), 'error'),
  })

  const addSkill = () => setUser((u) => [...u, { name: '', description: '', instruction: '', nodeTypes: [], enabled: true }])
  const updSkill = (i: number, patch: Partial<Skill>) => setUser((u) => u.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const delSkill = (i: number) => setUser((u) => u.filter((_, j) => j !== i))

  return (
    <Modal onClose={onClose} ariaLabel="어시스턴트 스킬" width={640} card={{ padding: 18, display: 'block', overflowY: 'auto', maxHeight: '86vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span aria-hidden>🧠</span>
        <b style={{ flex: 1, fontSize: 15 }}>어시스턴트 지침 · 스킬</b>
        <button onClick={() => save.mutate()} disabled={save.isPending} style={primary}>저장</button>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>
      <p style={hint}>여기 저장한 내용은 AI 어시스턴트가 플로우를 만들 때 <b>항상 참고</b>합니다(실제 LLM 사용 시). 팀 규칙·기본 URL·자주 쓰는 패턴을 적어 두세요.</p>

      <label style={secLabel}>팀 지침 (항상 우선 준수)</label>
      <textarea
        value={instr}
        onChange={(e) => setInstr(e.target.value)}
        placeholder={'예: 기본 API 는 https://api.acme.com. 인증은 항상 OAuth2 client credentials, client_secret 은 {{ ACME_SECRET@secret }}. HTTP 는 서버 모드. 응답은 항상 httpStatus 로 검증.'}
        style={{ ...mono, minHeight: 90, resize: 'vertical', width: '100%' }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 6px' }}>
        <label style={{ ...secLabel, margin: 0, flex: 1 }}>사용자 스킬 (재사용 지식)</label>
        <button onClick={addSkill} style={ghostMini}>+ 스킬 추가</button>
      </div>
      {user.length === 0 && <p style={{ ...hint, color: 'var(--fl-text-muted)' }}>추가한 스킬이 없습니다. 아래 내장 스킬을 참고하세요.</p>}
      <div style={{ display: 'grid', gap: 8 }}>
        {user.map((s, i) => (
          <div key={i} style={skillCard}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <input value={s.name} onChange={(e) => updSkill(i, { name: e.target.value })} placeholder="스킬 이름" style={{ ...mono, flex: 1, fontWeight: 600 }} />
              <label style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={s.enabled !== false} onChange={(e) => updSkill(i, { enabled: e.target.checked })} /> 사용
              </label>
              <button onClick={() => delSkill(i)} aria-label="삭제" style={xBtnSm}>×</button>
            </div>
            <input value={s.description ?? ''} onChange={(e) => updSkill(i, { description: e.target.value })} placeholder="한 줄 설명(선택)" style={{ ...mono, width: '100%', marginBottom: 6, fontSize: 12 }} />
            <input value={(s.nodeTypes ?? []).join(', ')} onChange={(e) => updSkill(i, { nodeTypes: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} placeholder="관련 노드 타입(쉼표): http, tcp, if …" style={{ ...mono, width: '100%', marginBottom: 6, fontSize: 12 }} />
            <textarea value={s.instruction} onChange={(e) => updSkill(i, { instruction: e.target.value })} placeholder="어시스턴트에게 줄 지시/지식(예: 우리 결제 API 는 …)" style={{ ...mono, minHeight: 60, resize: 'vertical', width: '100%', fontSize: 12 }} />
          </div>
        ))}
      </div>

      <label style={{ ...secLabel, marginTop: 16 }}>내장 스킬 (항상 사용 · 읽기전용)</label>
      <div style={{ display: 'grid', gap: 6 }}>
        {(q.data?.builtin ?? []).map((s) => (
          <details key={s.name} style={builtinCard}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
              {s.name}
              {(s.nodeTypes ?? []).length > 0 && <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--fl-primary)', fontFamily: 'var(--fl-font-mono)' }}>[{(s.nodeTypes ?? []).join(',')}]</span>}
              <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--fl-text-muted)', fontSize: 11.5 }}>{s.description}</span>
            </summary>
            <pre style={{ margin: '6px 0 0', fontSize: 11, fontFamily: 'var(--fl-font-mono)', whiteSpace: 'pre-wrap', color: 'var(--fl-text-muted)' }}>{s.instruction}</pre>
          </details>
        ))}
      </div>
    </Modal>
  )
}

function errMsg(e: unknown, fallback: string): string {
  const m = (e as { response?: { data?: { message?: string } } })?.response?.data?.message
  return m || fallback
}

const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', lineHeight: 1.6, margin: '0 0 12px' }
const secLabel: CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--fl-text)', margin: '0 0 6px' }
const mono: CSSProperties = { padding: '7px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, fontFamily: 'var(--fl-font-mono)', boxSizing: 'border-box' }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const xBtnSm: CSSProperties = { width: 24, height: 24, flexShrink: 0, borderRadius: 6, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer' }
const primary: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const ghostMini: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12 }
const skillCard: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', padding: 10 }
const builtinCard: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', padding: '8px 10px' }
