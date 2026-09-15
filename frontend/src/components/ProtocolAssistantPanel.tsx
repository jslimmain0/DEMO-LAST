import { assistantApi } from '../api/client'
import type { ProtocolSpec } from '../api/types'
import { tableLen } from '../lib/protocolSpec'
import { AssistantSidePanel } from './AssistantSidePanel'

/** 얕은 형태 검증 — LLM 제안을 편집기에 넣기 전 크래시 방지(의미 검증은 저장 시 백엔드 validate). */
export function validateProtocolSpecShape(spec: unknown): string | null {
  if (spec == null || typeof spec !== 'object') return 'spec 이 객체가 아닙니다.'
  const s = spec as ProtocolSpec
  if (!Array.isArray(s.header)) return 'header 가 배열이 아닙니다.'
  if (!Array.isArray(s.messages)) return 'messages 가 배열이 아닙니다.'
  for (const m of s.messages) if (m == null || typeof m !== 'object' || !Array.isArray(m.fields)) return '전문 항목이 {key, fields[]} 형태가 아닙니다.'
  return null
}

/** 프로토콜 AI — 명세서 표를 붙여넣거나 말로 설명하면 프로토콜(헤더·전문 표)을 만들고 고친다. 적용은 부모 onApply(spec)로. */
export function ProtocolAssistantPanel({ spec, onApply, onClose }: { spec: ProtocolSpec; onApply: (spec: ProtocolSpec) => void; onClose: () => void }) {
  return (
    <AssistantSidePanel<ProtocolSpec>
      title="프로토콜 AI"
      intro={'명세서 표를 통째로 붙여넣거나 말로 설명해 보세요.\n예: "헤더는 전문길이4·거래코드4, 0210 요청은 계좌번호13 고객명20 금액15, 0211 응답은 응답코드4 잔액15", "고객명을 30바이트로 늘려줘", "0410 잔액이체 전문 추가".'}
      placeholder="명세서 표 붙여넣기 또는 설명 (Enter, 줄바꿈은 Shift+Enter)"
      request={(messages, model) => assistantApi.protocolChat({ messages, spec, model })}
      summarize={(s) => `헤더 ${tableLen(s.header ?? [])}B · 전문 ${s.messages?.length ?? 0}개${(s.messages ?? []).slice(0, 4).map((m) => ` · ${m.key}(${tableLen(s.header ?? []) + tableLen(m.fields ?? [])}B)`).join('')}`}
      validate={validateProtocolSpecShape}
      onApply={onApply}
      onClose={onClose}
      appliedToast="프로토콜을 편집기에 적용했습니다. 저장 버튼으로 반영하세요."
    />
  )
}
