import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type CSSProperties } from 'react'
import type { SecretView } from '../api/client'
import { useEnvStore } from '../lib/environments'
import { Modal } from './Modal'
import { AskDialog, type AskSpec } from './AskDialog'
import { toast } from './toast'
import { ResourceScopeNote } from './ResourceScopeNote'
import { useUnsavedNavigation } from './UnsavedNavigation'

export function SecretsDialog({ onClose }: { onClose: () => void }) {
  const [dirty, setDirty] = useState(false)
  useUnsavedNavigation({ dirty, label: '입력한 시크릿 값' })
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const close = () => dirty ? setAsk({ title: '저장하지 않은 시크릿', message: '입력한 새 값을 버리고 닫을까요?', confirmLabel: '버리고 닫기', onConfirm: onClose }) : onClose()
  return <><Modal onClose={close} ariaLabel="시크릿 관리" width={1060} height="min(780px, 90vh)" card={{ padding: 18 }}><SecretsPanel onClose={close} onDraftChange={setDirty} /></Modal>{ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}</>
}

export function SecretsPanel({ onClose, onDraftChange, compact = false }: { onClose?: () => void; onDraftChange?: (dirty: boolean) => void; compact?: boolean }) {
  const { secretsApi } = useApi()
  const { current } = useWorkspace()
  const readOnly = current.myRole === 'VIEWER'
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['secrets'], queryFn: secretsApi.list })
  const environments = useEnvStore()
  const [selected, setSelected] = useState<SecretView | null>(null)
  const [name, setName] = useState('')
  const [environment, setEnvironment] = useState('')
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [filter, setFilter] = useState('')
  const [scope, setScope] = useState('*')
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const list = query.data ?? []
  const names = [...new Set([...Object.keys(environments.envs), ...list.flatMap(item => item.environment ? [item.environment] : [])])].sort()
  const active = environments.active
  const appliedNames = new Set(list.filter(item => active && item.environment === active).map(item => item.name))
  const effect = (item: SecretView) => item.environment && item.environment !== active ? '다른 환경' : !item.environment && appliedNames.has(item.name) ? '환경값으로 대체' : '실행에 적용'
  const shown = list.filter(item => (scope === '*' || (item.environment ?? '') === scope) && `${item.name} ${item.environment ?? '공통'}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).sort((a, b) => a.name.localeCompare(b.name) || (a.environment ?? '').localeCompare(b.environment ?? ''))
  const reset = () => { setSelected(null); setName(''); setValue(''); setReveal(false) }
  const choose = (item: SecretView | null) => {
    const change = () => { setSelected(item); setName(item?.name ?? ''); setEnvironment(item?.environment ?? (scope !== '*' ? scope : '')); setValue(''); setReveal(false) }
    if (value) setAsk({ title: '입력한 값을 버릴까요?', message: '아직 저장하지 않은 시크릿 값이 있습니다.', confirmLabel: '버리고 선택', onConfirm: change })
    else change()
  }
  const save = useMutation({
    mutationFn: () => secretsApi.put(name.trim(), value, environment || null),
    onSuccess: () => { toast(selected ? '시크릿 값을 교체했습니다.' : '시크릿을 추가했습니다.', 'ok'); reset(); void qc.invalidateQueries({ queryKey: ['secrets'] }) },
    onError: () => toast('시크릿 저장 실패. 입력값을 확인하고 다시 저장하세요.', 'error'),
  })
  const remove = useMutation({ mutationFn: (item: SecretView) => secretsApi.remove(item.name, item.environment), onSuccess: () => { reset(); toast('시크릿을 삭제했습니다.', 'ok'); void qc.invalidateQueries({ queryKey: ['secrets'] }) } })
  useUnsavedNavigation({ dirty: false, saving: save.isPending || remove.isPending, label: '시크릿 저장' })
  const existing = list.some(item => item.name === name.trim() && (item.environment ?? '') === environment)
  const validName = /^[A-Za-z0-9._-]+$/.test(name.trim())
  useEffect(() => { onDraftChange?.(!!value); return () => onDraftChange?.(false) }, [value, onDraftChange])
  useEffect(() => { if (!value) return; const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave) }, [value])
  return <div className="fl-resource-panel" style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
    {!compact && <header style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}><b style={{ fontSize: 16 }}>시크릿 관리</b><span style={hint}>{list.length}개</span>{onClose && <button onClick={onClose} style={{ ...button, marginLeft: 'auto' }}>닫기</button>}</header>}
    {!compact && <ResourceScopeNote />}
    {readOnly && <p role="status" style={hint}>읽기 전용 공간입니다. 이름과 적용 범위 확인, 바인딩 토큰 복사가 가능합니다.</p>}
    {!compact && <p style={hint}>{current.origin === 'local' ? '내 PC 데이터베이스에 암호화해 저장합니다.' : '서버 데이터베이스에 암호문을 저장합니다. 서버 정책에 따라 Vault Transit 또는 서버 키로 암호화합니다.'} 저장된 값은 다시 조회할 수 없습니다. 로그에는 마스킹합니다.</p>}
    <div className="fl-secret-workbench" style={{ marginTop: compact ? 0 : 18, flex: 1, minHeight: 0 }}>
      <section className="fl-secret-collection" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }} aria-label="시크릿 목록">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <input type="search" aria-label="시크릿 이름 검색" placeholder="이름 검색" value={filter} onChange={event => setFilter(event.target.value)} style={{ ...input, flex: '1 1 180px' }} />
          <select aria-label="시크릿 환경 필터" value={scope} onChange={event => setScope(event.target.value)} style={input}><option value="*">전체 환경</option><option value="">공통</option>{names.map(item => <option key={item}>{item}</option>)}</select>
          <button disabled={readOnly} style={button} onClick={() => choose(null)}>+ 새 시크릿</button>
        </div>
        <div role="status" style={{ ...hint, marginBottom: 8 }}>{shown.length}개 표시 · 활성 환경 {active ?? '없음'}</div>
        {query.isError && <p role="alert" style={{ color: 'var(--fl-fail)' }}>목록을 불러오지 못했습니다. <button style={button} onClick={() => void query.refetch()}>다시 불러오기</button></p>}
        <div className="fl-secret-list" style={{ overflowY: 'auto', minHeight: 0 }}>
          {query.isLoading && <p role="status" style={hint}>이름을 불러오는 중…</p>}
          {!query.isLoading && !shown.length && <p style={hint}>{list.length ? '검색 조건에 맞는 시크릿이 없습니다.' : '새 시크릿을 추가하세요. 값은 저장 후 숨겨집니다.'}</p>}
          {shown.map(item => <button className="fl-secret-entry" key={`${item.environment}:${item.name}`} onClick={() => choose(item)} aria-pressed={selected?.name === item.name && selected?.environment === item.environment}>
            <code style={{ display: 'block', overflowWrap: 'anywhere', fontSize: 13 }}>{item.name}</code><span style={{ ...hint, display: 'block', marginTop: 5 }}>{item.environment ?? '공통'} · {effect(item)}</span>
          </button>)}
        </div>
      </section>
      <section className="fl-secret-editor" aria-label="시크릿 값 편집">
        <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>{selected ? '선택한 시크릿 값 교체' : '새 시크릿 추가'}</h3>
        <p style={hint}>{selected ? '이름과 환경은 유지하고 새 값으로 교체합니다.' : '환경별 값이 공통값보다 먼저 적용됩니다.'}</p>
        <label style={label}>환경<select disabled={readOnly || !!selected || save.isPending} value={environment} onChange={event => setEnvironment(event.target.value)} aria-label="시크릿 환경" style={{ ...input, width: '100%' }}><option value="">공통</option>{names.map(item => <option key={item}>{item}</option>)}</select></label>
        <label style={label}>이름<input disabled={!!selected || save.isPending} aria-label="시크릿 이름" value={name} onChange={event => setName(event.target.value)} autoComplete="off" placeholder="API_TOKEN" style={{ ...input, width: '100%' }} /></label>
        <label style={label}>{selected ? '교체할 새 값' : '저장할 값'}<textarea disabled={readOnly || save.isPending} aria-label="새 시크릿 값" value={value} onChange={event => setValue(event.target.value)} autoComplete="off" spellCheck={false} rows={4} style={{ ...input, width: '100%', resize: 'vertical', fontFamily: 'var(--fl-font-mono)', ...(!reveal ? { WebkitTextSecurity: 'disc' } as CSSProperties : {}) }} /></label>
        <p style={{ ...hint, marginTop: 8 }}>일반 값은 암호화해 저장합니다. <code>vault:</code>로 시작하는 Vault 암호문은 입력한 그대로 저장하며, 실행 시 해당 Vault 키로 복호화합니다.</p>
        {value.startsWith('vault:') && <p role="status" style={{ ...hint, marginTop: 6 }}>Vault 암호문으로 감지했습니다. 다시 암호화하지 않고 저장합니다.</p>}
        <button disabled={readOnly} style={button} aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? '입력값 숨기기' : '입력값 확인'}</button>
        {name && !validName && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)', marginTop: 10 }}>이름은 영문·숫자·점·밑줄·하이픈만 사용할 수 있습니다.</p>}
        {!selected && existing && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)', marginTop: 10 }}>이 환경에 같은 이름이 있습니다. 목록에서 선택해 값을 교체하세요.</p>}
        {(save.isError || remove.isError) && <p role="alert" style={{ color: 'var(--fl-fail)', fontSize: 12 }}>저장하지 못했습니다. 입력은 유지됩니다. 다시 시도하세요.</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}><button style={{ ...button, background: 'var(--fl-action-primary-bg)', color: 'var(--fl-action-primary-ink)', borderColor: 'var(--fl-action-primary-bg)' }} disabled={readOnly || !validName || !value || save.isPending || query.isLoading || query.isError || (!selected && existing)} onClick={() => save.mutate()}>{save.isPending ? '저장 중…' : selected ? '새 값으로 교체' : '시크릿 저장'}</button>{selected && <button disabled={readOnly || remove.isPending || save.isPending} style={button} onClick={() => setAsk({ title: '시크릿 삭제', message: `${selected.environment ?? '공통'} / ${selected.name}을 삭제하면 이 값을 사용하는 실행이 실패할 수 있습니다.`, danger: true, confirmLabel: '삭제', onConfirm: () => remove.mutate(selected) })}>삭제</button>}</div>
        {selected && <div style={{ marginTop: 20 }}><code style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{`{{ ${selected.name}@secret }}`}</code><button style={{ ...button, marginTop: 8 }} onClick={() => void navigator.clipboard.writeText(`{{ ${selected.name}@secret }}`).then(() => toast('바인딩 토큰을 복사했습니다.', 'ok')).catch(() => toast('복사하지 못했습니다.', 'error'))}>바인딩 토큰 복사</button></div>}
        {compact && <p style={{ ...hint, marginTop: 16 }}>{current.origin === 'local' ? '내 PC 데이터베이스에 암호화해 저장합니다.' : '서버 DB에 암호문을 저장하며, 서버 정책에 따라 Vault Transit 또는 서버 키로 암호화합니다.'} 저장된 값은 다시 조회할 수 없습니다.</p>}
        <p style={{ ...hint, marginTop: 20 }}>브라우저에서 보내는 요청에 시크릿을 사용하면 값이 브라우저로 전달됩니다.</p>
      </section>
    </div>
    {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
  </div>
}

const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', lineHeight: 1.65, margin: 0 }
const input: CSSProperties = { minWidth: 0, padding: '9px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, boxSizing: 'border-box' }
const button: CSSProperties = { padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }
const label: CSSProperties = { display: 'grid', gap: 6, fontSize: 12, color: 'var(--fl-text-muted)', margin: '15px 0' }
