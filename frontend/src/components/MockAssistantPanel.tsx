import { assistantApi } from '../api/client'
import type { MockServerSpec } from '../api/types'
import { validateMockSpecShape } from '../lib/mockSpecValidate'
import { AssistantSidePanel } from './AssistantSidePanel'

/** HTTP Mock 서버 AI 어시스턴트 — 자연어로 mock spec(경로·응답·조건·콜백)을 만들고 고친다. 적용은 부모 onApply(spec)로. */
export function MockAssistantPanel({ spec, mockId, onApply, onClose }: {
  spec: MockServerSpec
  mockId: string
  onApply: (spec: MockServerSpec) => void
  onClose: () => void
}) {
  return (
    <AssistantSidePanel<MockServerSpec>
      title="Mock AI"
      intro={'만들고 싶은 가짜 API를 한국어로 말해 보세요. 예: "결제창 띄우고 콜백하는 mock", "GET /users/{id} 가 유저 JSON 주게", "1차는 pending, 2차는 approved".'}
      placeholder="예: 결제창 mock 만들어줘 (Enter)"
      request={(messages, model) => assistantApi.mockChat({ messages, spec, mockId, model })}
      summarize={(s) => `HTTP 라우트 ${s.routes?.length ?? 0}개`}
      validate={validateMockSpecShape}
      onApply={onApply}
      onClose={onClose}
      appliedToast="mock spec 을 적용했습니다. 저장 버튼으로 반영하세요."
    />
  )
}
