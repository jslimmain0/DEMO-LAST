import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import type { MockCodecSpec, MockCodecStep, TransformInfo } from '../api/types'
import { transformsApi } from '../api/client'
import { TransformPicker, sortTransforms } from './TransformPicker'

/**
 * Mock 전문 코덱 편집 — 요청 전문이 매칭·템플릿에 들어가기 **전**(request) / 응답 전문을 다 만든 뒤 나가기 **전**(response)
 * 적용할 변환 플러그인 단계 목록. 워크플로 TRANSFORM 노드와 같은 플러그인(내장+JAR)을 그대로 쓴다.
 * 서버 전체(spec.codec)와 라우트(route.codec) 양쪽에서 같은 컴포넌트를 쓴다.
 */
export function MockCodecEditor({ codec, onChange, readOnly, compact }: {
  codec: MockCodecSpec | null | undefined
  onChange: (c: MockCodecSpec | null) => void
  readOnly?: boolean
  compact?: boolean // 라우트 카드 안(제목 축약)
}) {
  const transforms = useQuery({ queryKey: ['transforms'], queryFn: transformsApi.list, staleTime: 60_000 })
  const list = transforms.data ?? []
  const c = codec ?? {}
  const setSide = (side: 'request' | 'response', steps: MockCodecStep[]) => {
    const next: MockCodecSpec = { ...c, [side]: steps.length ? steps : undefined }
    onChange(next.request?.length || next.response?.length ? next : null)
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <CodecSide title={compact ? '요청 전' : '요청 전 (request) — 전문이 들어오면 매칭 전에 적용'} side="request"
        steps={c.request ?? []} list={list} readOnly={readOnly} onChange={(s) => setSide('request', s)}
        empty="요청 본문을 그대로 사용" />
      <CodecSide title={compact ? '응답 후' : '응답 후 (response) — 전문을 다 만든 뒤 나가기 전에 적용'} side="response"
        steps={c.response ?? []} list={list} readOnly={readOnly} onChange={(s) => setSide('response', s)}
        empty="렌더된 본문을 그대로 전송" />
    </div>
  )
}

function CodecSide({ title, side, steps, list, readOnly, onChange, empty }: {
  title: string
  side: 'request' | 'response'
  steps: MockCodecStep[]
  list: TransformInfo[]
  readOnly?: boolean
  onChange: (s: MockCodecStep[]) => void
  empty: string
}) {
  const setStep = (i: number, patch: Partial<MockCodecStep>) => onChange(steps.map((s, si) => (si === i ? { ...s, ...patch } : s)))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]; const t = next[i]; next[i] = next[j]; next[j] = t
    onChange(next)
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: side === 'request' ? 'var(--fl-primary)' : 'var(--fl-ok)' }}>{side === 'request' ? '⬇' : '⬆'} {title}</span>
        {steps.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>— {empty}</span>}
        {!readOnly && (
          <button style={{ ...miniBtn, marginLeft: 'auto' }} onClick={() => onChange([...steps, { id: sortTransforms(list)[0]?.id ?? '' }])} title="플러그인 단계 추가(순서대로 체인)">+ 단계</button>
        )}
      </div>
      {steps.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          {steps.map((s, i) => {
            const t = list.find((x) => x.id === s.id)
            const cfg = s.config ?? []
            const cfgVal = (k: string) => cfg.find((kv) => kv.key === k)?.value
            const setCfg = (k: string, v: string) => setStep(i, { config: [...cfg.filter((kv) => kv.key !== k), { key: k, value: v }] })
            return (
              <div key={i} style={{ border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: '8px 10px', background: 'var(--fl-surface-2)' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{i + 1}</span>
                  <TransformPicker style={{ flex: 1, minWidth: 220 }} list={list} value={s.id} disabled={readOnly}
                    onChange={(id) => { if (id !== s.id) setStep(i, { id, config: undefined, inputKey: undefined, outputKey: undefined }) }} />
                  {t && t.inputs.length > 1 && (
                    <label style={lbl}>입력
                      <select style={{ ...input, minWidth: 90 }} value={s.inputKey ?? t.inputs[0].key} disabled={readOnly} onChange={(e) => setStep(i, { inputKey: e.target.value })}>
                        {t.inputs.map((io) => <option key={io.key} value={io.key}>{io.label}</option>)}
                      </select>
                    </label>
                  )}
                  {t && t.outputs.length > 1 && (
                    <label style={lbl}>출력
                      <select style={{ ...input, minWidth: 90 }} value={s.outputKey ?? t.outputs[0].key} disabled={readOnly} onChange={(e) => setStep(i, { outputKey: e.target.value })}>
                        {t.outputs.map((io) => <option key={io.key} value={io.key}>{io.label}</option>)}
                      </select>
                    </label>
                  )}
                  {!readOnly && <>
                    <button style={{ ...miniBtn, marginLeft: 'auto' }} onClick={() => move(i, -1)} title="위로">↑</button>
                    <button style={miniBtn} onClick={() => move(i, 1)} title="아래로">↓</button>
                    <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => onChange(steps.filter((_, si) => si !== i))} title="단계 삭제">×</button>
                  </>}
                </div>
                {t?.description && <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 4 }}>{t.description}</div>}
                {t && t.params.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                    {t.params.map((p) => {
                      const val = cfgVal(p.key) ?? p.defaultValue
                      return (
                        <label key={p.key} style={lbl}>{p.label}
                          {p.type === 'select' && (p.options?.length ?? 0) > 0 ? (
                            <select style={{ ...input, minWidth: 100 }} value={val} disabled={readOnly} onChange={(e) => setCfg(p.key, e.target.value)}>
                              {p.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : p.type === 'textarea' ? (
                            <textarea style={{ ...input, minWidth: 220, minHeight: 40, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }} value={val} placeholder={p.placeholder} disabled={readOnly} onChange={(e) => setCfg(p.key, e.target.value)} />
                          ) : (
                            <input type={p.type === 'number' ? 'number' : 'text'} style={{ ...input, minWidth: 140, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }} value={val} placeholder={p.placeholder} disabled={readOnly} onChange={(e) => setCfg(p.key, e.target.value)} />
                          )}
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const lbl: CSSProperties = { fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--fl-text-muted)' }
const input: CSSProperties = { padding: '5px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5 }
const miniBtn: CSSProperties = { padding: '4px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
