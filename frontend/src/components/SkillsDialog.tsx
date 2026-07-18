import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { assistantApi } from '../api/client'
import type { OAuthProviderUpdate, Skill } from '../api/types'
import { usePermissions } from '../auth/AuthContext'
import { newId } from '../lib/ids'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * 어시스턴트 프롬프트 라이브러리(awesome-copilot 스타일) — 자주 쓰는 프롬프트를 저장해 두고 클릭 한 번으로 적용.
 * + 팀 지침(admin, 항상 주입) + GitHub 연결(OAuth) 설정(admin).
 */
export function SkillsDialog({ onClose, onApplyPrompt }: { onClose: () => void; onApplyPrompt?: (prompt: string) => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['assistant', 'skills'], queryFn: assistantApi.skills })
  const { canAdmin } = usePermissions()
  const [user, setUser] = useState<Skill[]>([])
  const [instrEdit, setInstrEdit] = useState<string | null>(null)
  const loaded = useRef(false)

  useEffect(() => {
    if (q.data && !loaded.current) { loaded.current = true; setUser(q.data.user ?? []) }
  }, [q.data])

  const invalidate = () => qc.invalidateQueries({ queryKey: ['assistant', 'skills'] })
  const savePrompts = useMutation({
    mutationFn: (u: Skill[]) => assistantApi.updateSkills({ user: u.filter((s) => s.name.trim()) }),
    onSuccess: () => { toast('프롬프트를 저장했습니다.', 'ok'); invalidate() },
    onError: (e: unknown) => toast(errMsg(e, '저장 실패'), 'error'),
  })
  const saveInstr = useMutation({
    mutationFn: (instructions: string) => assistantApi.updateInstructions({ instructions }),
    onSuccess: () => { toast('팀 지침을 저장했습니다.', 'ok'); setInstrEdit(null); invalidate() },
    onError: (e: unknown) => toast(errMsg(e, '지침 저장 실패(admin 권한 필요)'), 'error'),
  })

  const add = () => setUser((u) => [...u, { id: newId(), name: '', description: '', prompt: '' }])
  const upd = (i: number, patch: Partial<Skill>) => setUser((u) => u.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const del = (i: number) => setUser((u) => u.filter((_, j) => j !== i))
  const apply = (s: Skill) => { if (s.prompt.trim() && onApplyPrompt) { onApplyPrompt(s.prompt); onClose() } }

  const serverInstr = q.data?.instructions ?? ''
  const instrValue = instrEdit ?? serverInstr

  return (
    <Modal onClose={onClose} ariaLabel="프롬프트 라이브러리" width={660} card={{ padding: 18, display: 'block', overflowY: 'auto', maxHeight: '86vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span aria-hidden>💬</span>
        <b style={{ flex: 1, fontSize: 15 }}>프롬프트 라이브러리</b>
        <button onClick={() => savePrompts.mutate(user)} disabled={savePrompts.isPending} style={primary}>저장</button>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>
      <p style={hint}>자주 쓰는 프롬프트(예: "결제 플로우 만들어줘", "에러 처리 추가")를 저장해 두고 <b>적용</b>으로 어시스턴트에 바로 보냅니다. <a href="https://awesome-copilot.github.com/" target="_blank" rel="noreferrer" style={{ color: 'var(--fl-primary)' }}>awesome-copilot</a> 처럼요.</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 6px' }}>
        <label style={{ ...secLabel, margin: 0, flex: 1 }}>내 프롬프트</label>
        <button onClick={add} style={ghostMini}>+ 프롬프트 추가</button>
      </div>
      {user.length === 0 && <p style={{ ...hint, color: 'var(--fl-text-muted)' }}>저장한 프롬프트가 없습니다. 추가해 보세요.</p>}
      <div style={{ display: 'grid', gap: 8 }}>
        {user.map((s, i) => (
          <div key={s.id} style={card}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <input value={s.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="이름 (예: 결제 플로우 생성)" style={{ ...mono, flex: 1, fontWeight: 600 }} />
              {onApplyPrompt && <button onClick={() => apply(s)} disabled={!s.prompt.trim()} style={applyBtn} title="이 프롬프트를 어시스턴트에 보냅니다">▶ 적용</button>}
              <button onClick={() => del(i)} aria-label="삭제" style={xBtnSm}>×</button>
            </div>
            <input value={s.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} placeholder="한 줄 설명(선택)" style={{ ...mono, width: '100%', marginBottom: 6, fontSize: 12 }} />
            <textarea value={s.prompt} onChange={(e) => upd(i, { prompt: e.target.value })} placeholder="프롬프트 본문 — 어시스턴트에 보낼 내용" style={{ ...mono, minHeight: 64, resize: 'vertical', width: '100%', fontSize: 12 }} />
          </div>
        ))}
      </div>

      {/* 팀 지침 (admin) */}
      <div style={{ marginTop: 18, borderTop: '1px solid var(--fl-border)', paddingTop: 14 }}>
        <label style={secLabel}>팀 지침 (AI 가 항상 준수 · admin){!canAdmin && <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)' }}> — 읽기전용</span>}</label>
        <textarea value={instrValue} onChange={(e) => setInstrEdit(e.target.value)} disabled={!canAdmin}
          placeholder="예: 기본 API 는 https://api.acme.com. 인증 헤더는 Authorization: Bearer {{ TOKEN@secret }}. HTTP 는 서버 모드."
          style={{ ...mono, minHeight: 72, resize: 'vertical', width: '100%', opacity: canAdmin ? 1 : 0.6 }} />
        {canAdmin && (
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={() => saveInstr.mutate(instrValue)} disabled={saveInstr.isPending || instrEdit === null} style={primary}>지침 저장</button>
            {instrEdit !== null && <button onClick={() => setInstrEdit(null)} style={ghostMini}>되돌리기</button>}
          </div>
        )}
      </div>

      {canAdmin && <GitHubOAuthSection />}
    </Modal>
  )
}

/** GitHub 연결(OAuth) 설정 — admin. client_id/secret 만(엔드포인트는 GitHub 고정). */
function GitHubOAuthSection() {
  const qc = useQueryClient()
  const cfg = useQuery({ queryKey: ['assistant', 'oauth', 'config'], queryFn: assistantApi.oauthConfig })
  const [form, setForm] = useState<OAuthProviderUpdate>({})
  const loaded = useRef(false)
  useEffect(() => {
    if (cfg.data && !loaded.current) { loaded.current = true; setForm({ clientId: cfg.data.clientId, scope: cfg.data.scope, clientSecret: '', gatewayBaseUrl: cfg.data.gatewayBaseUrl, gatewayModel: cfg.data.gatewayModel }) }
  }, [cfg.data])
  const save = useMutation({
    mutationFn: () => assistantApi.updateOAuthConfig({ ...form, clientSecret: form.clientSecret || undefined }),
    onSuccess: () => { toast('GitHub 연결 설정을 저장했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['assistant'] }) },
    onError: (e: unknown) => toast(errMsg(e, '저장 실패(admin 권한 필요)'), 'error'),
  })
  const upd = (patch: OAuthProviderUpdate) => setForm((f) => ({ ...f, ...patch }))
  const redirect = `${window.location.origin}/api/v1/assistant/oauth/callback`
  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--fl-border)', paddingTop: 14 }}>
      <label style={secLabel}>GitHub 연결 (OAuth) · admin</label>
      <p style={{ ...hint, marginBottom: 8 }}>GitHub OAuth App 을 만들고 <b>client_id / client_secret</b> 을 넣으면, 어시스턴트에 <b>GitHub 연결</b> 버튼이 뜹니다. 로그인하면 그 GitHub 토큰으로 아래 <b>AI 게이트웨이</b>(기본 <a href="https://github.com/marketplace/models" target="_blank" rel="noreferrer" style={{ color: 'var(--fl-primary)' }}>GitHub Models</a>)를 호출합니다. GitHub App 의 <b>Authorization callback URL</b> 에 아래 값을 등록하세요.</p>
      <div style={{ display: 'grid', gap: 6 }}>
        <input value={form.clientId ?? ''} onChange={(e) => upd({ clientId: e.target.value })} placeholder="client_id (GitHub OAuth App)" style={mono} />
        <input value={form.clientSecret ?? ''} onChange={(e) => upd({ clientSecret: e.target.value })} type="password" placeholder={cfg.data?.hasSecret ? 'client_secret (저장됨 — 바꿀 때만 입력)' : 'client_secret'} style={mono} />
        <input value={form.scope ?? ''} onChange={(e) => upd({ scope: e.target.value })} placeholder="scope (예: models · read:user)" style={mono} />
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', marginTop: 4 }}>AI 게이트웨이 (OpenAI 호환)</div>
        <input value={form.gatewayBaseUrl ?? ''} onChange={(e) => upd({ gatewayBaseUrl: e.target.value })} placeholder="게이트웨이 URL (기본 https://models.github.ai/inference)" style={mono} />
        <input value={form.gatewayModel ?? ''} onChange={(e) => upd({ gatewayModel: e.target.value })} placeholder="모델 (기본 openai/gpt-4o)" style={mono} />
        <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', wordBreak: 'break-all' }}>callback URL: {redirect}</div>
        <div><button onClick={() => save.mutate()} disabled={save.isPending} style={primary}>GitHub 설정 저장</button></div>
      </div>
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
const card: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', padding: 10 }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const xBtnSm: CSSProperties = { width: 24, height: 24, flexShrink: 0, borderRadius: 6, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer' }
const primary: CSSProperties = { padding: '7px 12px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }
const applyBtn: CSSProperties = { flexShrink: 0, padding: '5px 11px', border: '1px solid var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }
const ghostMini: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12 }
