import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MockCodecInput, MockCodecSpec, MockCodecStep, TransformInfo } from '../api/types'
import { transformsApi } from '../api/client'
import { TokenInput } from '../binding/TokenInput'
import type { BindableSource } from '../binding/upstream'
import { addStep, detachField, replaceStep, stepsForField, type CodecSide, type StepRef } from '../lib/mockCodecOps'
import { TransformPicker, sortTransforms } from './TransformPicker'

/**
 * "필드에서 시작하는 코덱" — 필드 행 옆 ◈ 버튼. 이 필드에 걸린 코덱 단계를 배지로 보여주고, 팝오버에서 그 자리에서
 * [요청 전 풀기 / 응답 후 감싸기] → 플러그인(검색) → 값(키·IV 는 시크릿 칩) 으로 단계를 만든다(코덱 화면까지 안 가도 됨).
 * 대상 코덱(서버 spec.codec 또는 라우트 route.codec)은 호출자가 넘긴다.
 */
export function FieldCodecButton({ field, codec, onChange, sources = [], defaultSide, sides = ['request', 'response'], readOnly, compact }: {
  field: string
  codec: MockCodecSpec | null | undefined
  onChange: (c: MockCodecSpec | null) => void
  sources?: BindableSource[]
  defaultSide: CodecSide
  sides?: CodecSide[]
  readOnly?: boolean
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<StepRef | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const transforms = useQuery({ queryKey: ['transforms'], queryFn: transformsApi.list, staleTime: 60_000 })
  const list = transforms.data ?? []
  const refs = field ? stepsForField(codec, field) : []
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      // 팝오버는 body 포털에 있어 rootRef 밖이다 — data 표식과 피커 목록(listbox)은 바깥 클릭이 아니다.
      if (rootRef.current?.contains(t) || t.closest?.('[data-fl-codec-pop]') || t.closest?.('[role="listbox"]')) return
      setOpen(false); setEditing(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); setEditing(null) } }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  if (!field) return null
  const label = (r: StepRef) => `${r.side === 'request' ? '⬇' : '⬆'} ${list.find((t) => t.id === r.step.id)?.label ?? r.step.id}`
  return (
    <span ref={rootRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      {refs.map((r) => (
        <button key={`${r.side}-${r.index}`} onClick={() => { setEditing(r); setOpen(true) }}
          title={`${r.side === 'request' ? '요청 전' : '응답 후'} 이 필드에 ${list.find((t) => t.id === r.step.id)?.label ?? r.step.id} 적용 — 클릭해 수정/제거`}
          style={{ ...badge, color: r.side === 'request' ? 'var(--fl-primary)' : 'var(--fl-ok)' }}>◈ {label(r)}</button>
      ))}
      {!readOnly && (
        <button onClick={() => { setEditing(null); setOpen((v) => !v) }} title={`이 필드(${field})에 코덱 걸기 — 요청 전 풀기 / 응답 후 감싸기`} aria-label={`${field} 코덱`}
          style={{ ...iconBtn, ...(compact ? { width: 24, height: 24 } : null), color: refs.length ? 'var(--fl-primary)' : 'var(--fl-text-muted)' }}>◈</button>
      )}
      {open && (
        <StepPopover anchor={rootRef.current} field={field} list={list} sources={sources} sides={sides} defaultSide={editing?.side ?? defaultSide} editing={editing}
          onClose={() => { setOpen(false); setEditing(null) }}
          onSave={(side, step) => {
            if (editing) {
              // side 가 바뀌면 옮기기(제거 후 추가)
              const base = editing.side === side ? replaceStep(codec, side, editing.index, step) : addStep(detachField(codec, editing, field) ?? {}, side, step)
              onChange(base)
            } else onChange(addStep(codec, side, step))
            setOpen(false); setEditing(null)
          }}
          onRemove={editing ? () => { onChange(detachField(codec, editing, field)); setOpen(false); setEditing(null) } : undefined} />
      )}
    </span>
  )
}

function StepPopover({ anchor, field, list, sources, sides, defaultSide, editing, onClose, onSave, onRemove }: {
  anchor: HTMLElement | null
  field: string; list: TransformInfo[]; sources: BindableSource[]; sides: CodecSide[]; defaultSide: CodecSide; editing: StepRef | null
  onClose: () => void; onSave: (side: CodecSide, step: MockCodecStep) => void; onRemove?: () => void
}) {
  const place = useAnchoredPlacement(anchor)
  const [side, setSide] = useState<CodecSide>(defaultSide)
  const [pluginId, setPluginId] = useState<string>(editing?.step.id ?? '')
  const [inputs, setInputs] = useState<MockCodecInput[]>(editing?.step.inputs ?? [])
  const [config, setConfig] = useState<Array<{ key: string; value: string }>>(editing?.step.config ?? [])
  const [outputKey, setOutputKey] = useState<string | undefined>(editing?.step.outputKey)
  const t = list.find((x) => x.id === pluginId)
  const ports = t?.inputs ?? []
  const messagePort = inputs.find((i) => i.mode === 'message')?.key ?? ports[0]?.key ?? ''
  const inputOf = (k: string): MockCodecInput => inputs.find((i) => i.key === k) ?? { key: k, mode: k === messagePort ? 'message' : 'value', value: '' }
  const setPortValue = (k: string, v: string) => setInputs(ports.map((p) => (p.key === k ? { key: k, mode: 'value' as const, value: v } : inputOf(p.key))))
  const setMessagePort = (k: string) => setInputs(ports.map((p) => (p.key === k ? { key: p.key, mode: 'message' as const } : { key: p.key, mode: 'value' as const, value: inputOf(p.key).mode === 'value' ? inputOf(p.key).value ?? '' : '' })))
  const cfgVal = (k: string) => config.find((c) => c.key === k)?.value
  const setCfg = (k: string, v: string) => setConfig([...config.filter((c) => c.key !== k), { key: k, value: v }])
  const save = () => {
    if (!pluginId) return
    const existingFields = editing?.step.fields ?? []
    const fields = existingFields.includes(field) ? existingFields : [...existingFields, field]
    onSave(side, { ...(editing?.step ?? { id: pluginId }), id: pluginId, target: 'fields', fields, inputs: ports.length > 1 ? inputs.length ? inputs : undefined : undefined, config: config.length ? config : undefined, outputKey })
  }
  return createPortal(
    <div role="dialog" data-fl-codec-pop aria-label={`${field} 코덱`} style={{ ...pop, ...place }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 12.5, flex: 1 }}>◈ <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{field}</code> {editing ? '코덱 수정' : '에 코덱 걸기'}</strong>
        <button onClick={onClose} aria-label="닫기" style={{ ...iconBtn, border: 'none' }}>×</button>
      </div>
      <div style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', marginTop: 8 }}>
        {sides.map((s) => (
          <button key={s} onClick={() => { setSide(s); if (!editing) setPluginId('') }}
            style={{ padding: '4px 12px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: side === s ? 'var(--fl-primary)' : 'transparent', color: side === s ? '#fff' : 'var(--fl-text-muted)' }}>
            {s === 'request' ? '⬇ 요청 전 풀기' : '⬆ 응답 후 감싸기'}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 4 }}>
        {side === 'request' ? '들어온 요청의 이 필드 값을 매칭·템플릿 전에 변환합니다(복호화·디코딩).' : '응답의 이 필드 값을 나가기 전에 변환합니다(암호화·인코딩). 필드는 JSON/urlencoded 재직렬화.'}
      </div>
      <div style={{ marginTop: 8 }}>
        <div style={lbl}>플러그인</div>
        <TransformPicker list={list} value={pluginId} onChange={(id) => { setPluginId(id); setInputs([]); setConfig([]); setOutputKey(undefined) }} placeholder="변환 플러그인 선택…" />
        {t?.description && <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 3 }}>{t.description}</div>}
      </div>
      {ports.length > 1 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          <div style={lbl}>입력 포트 — 하나는 필드 값, 나머지는 값(키·IV 는 <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{'{ }'}</code> 시크릿)</div>
          {ports.map((p) => {
            const inp = inputOf(p.key)
            const isMsg = inp.mode === 'message'
            return (
              <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, minWidth: 80, fontFamily: 'var(--fl-font-mono)' }}>{p.label}</span>
                <label style={{ fontSize: 11.5, display: 'inline-flex', gap: 3, alignItems: 'center' }}><input type="radio" name={`fc-${field}-port`} checked={isMsg} onChange={() => setMessagePort(p.key)} />필드 값</label>
                {!isMsg && <div style={{ flex: 1, minWidth: 160 }}><TokenInput ariaLabel={`${field} ${p.key} 값`} value={inp.value ?? ''} sources={sources} placeholder={`{{ ${p.key === 'key' ? 'aesKey' : p.key === 'iv' ? 'aesIv' : p.key}@secret }}`} onChange={(v) => setPortValue(p.key, v)} /></div>}
              </div>
            )
          })}
        </div>
      )}
      {t && t.params.length > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          {t.params.map((p) => {
            const val = cfgVal(p.key) ?? p.defaultValue
            return (
              <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11.5, minWidth: 80 }}>{p.label}</span>
                {p.type === 'select' && (p.options?.length ?? 0) > 0
                  ? <select style={input} value={val} onChange={(e) => setCfg(p.key, e.target.value)}>{p.options!.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  : <div style={{ flex: 1, minWidth: 160 }}><TokenInput ariaLabel={`${field} 파라미터 ${p.key}`} value={val} sources={sources} placeholder={p.placeholder || '값 또는 { } 데이터 삽입'} onChange={(v) => setCfg(p.key, v)} /></div>}
              </div>
            )
          })}
        </div>
      )}
      {t && t.outputs.length > 1 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, minWidth: 80 }}>출력</span>
          <select style={input} value={outputKey ?? t.outputs[0].key} onChange={(e) => setOutputKey(e.target.value)}>{t.outputs.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
        {onRemove && <button onClick={onRemove} style={{ ...miniBtn, color: 'var(--fl-fail)', marginRight: 'auto' }}>이 필드에서 제거</button>}
        <button onClick={onClose} style={miniBtn}>취소</button>
        <button onClick={save} disabled={!pluginId} style={primary}>{editing ? '수정' : '단계 추가'}</button>
      </div>
      {!editing && list.length > 0 && !t && <div style={{ fontSize: 11, color: 'var(--fl-fail)', marginTop: 4 }}>플러그인을 고르세요.</div>}
      <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', marginTop: 6 }}>여러 필드에 같은 단계를 걸면 코덱 화면에서 한 단계로 합쳐 보입니다. 전체/헤더 대상은 코덱 화면에서.</div>
    </div>,
    document.body,
  )
}

/**
 * 팝오버를 **뷰포트 기준(fixed)** 으로 앉힌다 — 앵커(◈ 버튼) 왼쪽에 맞춰 펴되 화면 밖으로 나가면 당기고,
 * 아래 공간이 모자라면 위로 뒤집는다. 남은 공간을 maxHeight 로 줘서 어떤 높이여도 잘리지 않는다.
 * (absolute 로 두면 Mock 편집기 상세 패널의 overflow:auto 가 팝오버를 잘라낸다 — 왼쪽·아래가 잘리던 버그)
 */
function useAnchoredPlacement(anchor: HTMLElement | null): CSSProperties {
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!anchor) return
    const put = () => {
      const a = anchor.getBoundingClientRect()
      const vw = window.innerWidth, vh = window.innerHeight
      const w = Math.min(POP_W, vw - 16)
      // 앵커 왼쪽에 맞춰 오른쪽으로 편다(칩에 붙어 보이게). 오른쪽이 모자라면 그만큼만 당긴다.
      const left = Math.min(Math.max(8, a.left), Math.max(8, vw - w - 8))
      const below = vh - a.bottom - 14, above = a.top - 14
      setPlace(below >= 260 || below >= above
        ? { top: a.bottom + 6, left, width: w, maxHeight: below }
        : { bottom: vh - a.top + 6, left, width: w, maxHeight: above })
    }
    put()
    // 패널 스크롤(capture)·창 리사이즈에 따라 다시 앉힌다.
    window.addEventListener('scroll', put, true)
    window.addEventListener('resize', put)
    return () => { window.removeEventListener('scroll', put, true); window.removeEventListener('resize', put) }
  }, [anchor])
  return place
}

/** 코덱 화면 위저드 — 언제 → 무엇을(전체/필드 체크/헤더) → 플러그인 → 값. 필드 후보는 호출자가 수집해 넘긴다. */
export function CodecStepWizard({ list, sources, fieldHints, defaultSide, onCancel, onAdd }: {
  list: TransformInfo[]; sources: BindableSource[]; fieldHints: { request: string[]; response: string[] }
  defaultSide: CodecSide; onCancel: () => void; onAdd: (side: CodecSide, step: MockCodecStep) => void
}) {
  const [side, setSide] = useState<CodecSide>(defaultSide)
  const [target, setTarget] = useState<'body' | 'fields' | 'header'>('body')
  const [fields, setFields] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [header, setHeader] = useState('')
  const [pluginId, setPluginId] = useState(sortTransforms(list)[0]?.id ?? '')
  const [inputs, setInputs] = useState<MockCodecInput[]>([])
  const [config, setConfig] = useState<Array<{ key: string; value: string }>>([])
  const t = list.find((x) => x.id === pluginId)
  const ports = t?.inputs ?? []
  const hints = side === 'request' ? fieldHints.request : fieldHints.response
  const messagePort = inputs.find((i) => i.mode === 'message')?.key ?? ports[0]?.key ?? ''
  const inputOf = (k: string): MockCodecInput => inputs.find((i) => i.key === k) ?? { key: k, mode: k === messagePort ? 'message' : 'value', value: '' }
  const setPortValue = (k: string, v: string) => setInputs(ports.map((p) => (p.key === k ? { key: k, mode: 'value' as const, value: v } : inputOf(p.key))))
  const setMessagePort = (k: string) => setInputs(ports.map((p) => (p.key === k ? { key: p.key, mode: 'message' as const } : { key: p.key, mode: 'value' as const, value: inputOf(p.key).mode === 'value' ? inputOf(p.key).value ?? '' : '' })))
  const cfgVal = (k: string) => config.find((c) => c.key === k)?.value
  const setCfg = (k: string, v: string) => setConfig([...config.filter((c) => c.key !== k), { key: k, value: v }])
  const allFields = [...fields, ...custom.split(',').map((x) => x.trim()).filter((x) => x && !fields.includes(x))]
  const valid = !!pluginId && (target === 'body' || (target === 'fields' && allFields.length > 0) || (target === 'header' && header.trim()))
  return (
    <div style={{ border: '1px solid var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)', padding: 12, background: 'var(--fl-surface)', display: 'grid', gap: 10 }} role="dialog" aria-label="코덱 단계 추가">
      <div style={{ fontSize: 12.5, fontWeight: 700 }}>새 코덱 단계</div>
      <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: '8px 10px', alignItems: 'start' }}>
        <span style={stepNo}>① 언제</span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', width: 'fit-content' }}>
          {(['request', 'response'] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)} style={{ padding: '5px 12px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: side === s ? 'var(--fl-primary)' : 'transparent', color: side === s ? '#fff' : 'var(--fl-text-muted)' }}>{s === 'request' ? '⬇ 요청 전 (요청이 들어올 때)' : '⬆ 응답 후 (나가기 전)'}</button>
          ))}
        </div>
        <span style={stepNo}>② 무엇을</span>
        <div>
          <div style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }}>
            {(['body', 'fields', 'header'] as Array<'body' | 'fields' | 'header'>).map((tg) => (
              <button key={tg} onClick={() => setTarget(tg)} style={{ padding: '5px 12px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: target === tg ? 'var(--fl-primary)' : 'transparent', color: target === tg ? '#fff' : 'var(--fl-text-muted)' }}>
                {tg === 'body' ? '본문 전체' : tg === 'fields' ? '특정 필드만' : '헤더'}
              </button>
            ))}
          </div>
          {target === 'fields' && (
            <div style={{ marginTop: 6 }}>
              {hints.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {hints.map((h) => (
                    <label key={h} style={{ ...chipLabel, ...(fields.includes(h) ? chipOn : null) }}><input type="checkbox" checked={fields.includes(h)} onChange={(e) => setFields(e.target.checked ? [...fields, h] : fields.filter((x) => x !== h))} style={{ display: 'none' }} />{h}</label>
                  ))}
                </div>
              ) : <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>{side === 'request' ? '예상 요청 필드가 없습니다 — 라우트의 예상 요청에 적거나 요청 기록 → [예상 필드로]. ' : '규칙 본문(JSON)에서 키를 못 찾았습니다. '}아래에 직접 적을 수도 있습니다.</div>}
              <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="직접 입력 — 쉼표 구분(JSON 점 경로: card.no)" style={{ ...input, width: '100%', boxSizing: 'border-box', marginTop: 6, fontFamily: 'var(--fl-font-mono)' }} />
            </div>
          )}
          {target === 'header' && (
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input value={header} onChange={(e) => setHeader(e.target.value)} placeholder="헤더명 — 예: X-Signature" style={{ ...input, width: 220, fontFamily: 'var(--fl-font-mono)' }} />
              <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>{side === 'request' ? '이 헤더 값을 변환' : '본문을 입력으로 결과를 이 헤더에 기록(서명)'}</span>
            </div>
          )}
        </div>
        <span style={stepNo}>③ 플러그인</span>
        <div>
          <TransformPicker list={list} value={pluginId} onChange={(id) => { setPluginId(id); setInputs([]); setConfig([]) }} style={{ maxWidth: 420 }} />
          {t?.description && <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 3 }}>{t.description}</div>}
        </div>
        {(ports.length > 1 || (t?.params.length ?? 0) > 0) && <>
          <span style={stepNo}>④ 값</span>
          <div style={{ display: 'grid', gap: 4 }}>
            {ports.length > 1 && ports.map((p) => {
              const inp = inputOf(p.key); const isMsg = inp.mode === 'message'
              return (
                <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, minWidth: 90, fontFamily: 'var(--fl-font-mono)' }}>{p.label}</span>
                  <label style={{ fontSize: 11.5, display: 'inline-flex', gap: 3, alignItems: 'center' }}><input type="radio" name="wiz-port" checked={isMsg} onChange={() => setMessagePort(p.key)} />{target === 'fields' ? '필드 값' : target === 'header' && side === 'request' ? '헤더 값' : '본문'}</label>
                  {!isMsg && <div style={{ flex: 1, minWidth: 180 }}><TokenInput ariaLabel={`입력 ${p.key}`} value={inp.value ?? ''} sources={sources} placeholder={`{{ ${p.key === 'key' ? 'aesKey' : p.key === 'iv' ? 'aesIv' : p.key}@secret }}`} onChange={(v) => setPortValue(p.key, v)} /></div>}
                </div>
              )
            })}
            {t?.params.map((p) => {
              const val = cfgVal(p.key) ?? p.defaultValue
              return (
                <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, minWidth: 90 }}>{p.label}</span>
                  {p.type === 'select' && (p.options?.length ?? 0) > 0
                    ? <select style={input} value={val} onChange={(e) => setCfg(p.key, e.target.value)}>{p.options!.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                    : <div style={{ flex: 1, minWidth: 180 }}><TokenInput ariaLabel={`파라미터 ${p.key}`} value={val} sources={sources} placeholder={p.placeholder || '값 또는 { } 데이터 삽입'} onChange={(v) => setCfg(p.key, v)} /></div>}
                </div>
              )
            })}
          </div>
        </>}
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={miniBtn}>취소</button>
        <button disabled={!valid} onClick={() => onAdd(side, { id: pluginId, target, fields: target === 'fields' ? allFields : undefined, header: target === 'header' ? header.trim() : undefined, inputs: ports.length > 1 && inputs.length ? inputs : undefined, config: config.length ? config : undefined })} style={{ ...primary, opacity: valid ? 1 : 0.5 }}>단계 추가</button>
      </div>
    </div>
  )
}

const badge: CSSProperties = { fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 999, border: '1px solid currentColor', background: 'var(--fl-surface)', cursor: 'pointer', whiteSpace: 'nowrap' }
const iconBtn: CSSProperties = { width: 26, height: 26, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer', fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }
const POP_W = 440
const pop: CSSProperties = { position: 'fixed', zIndex: 120, overflowY: 'auto', width: POP_W, padding: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow-lg, 0 8px 24px rgba(0,0,0,.18))', textAlign: 'left', fontWeight: 400, cursor: 'default' }
const lbl: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', marginBottom: 4 }
const input: CSSProperties = { padding: '5px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5 }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const primary: CSSProperties = { padding: '5px 12px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }
const stepNo: CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--fl-text-muted)', paddingTop: 5 }
const chipLabel: CSSProperties = { fontSize: 12, fontFamily: 'var(--fl-font-mono)', padding: '3px 9px', border: '1px solid var(--fl-border)', borderRadius: 999, cursor: 'pointer', background: 'var(--fl-surface-2)', color: 'var(--fl-text)' }
const chipOn: CSSProperties = { borderColor: 'var(--fl-primary)', background: 'color-mix(in srgb, var(--fl-primary) 12%, var(--fl-surface))', color: 'var(--fl-primary)', fontWeight: 700 }
