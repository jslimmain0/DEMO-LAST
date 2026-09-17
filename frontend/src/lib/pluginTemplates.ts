import type { PluginKind } from '../api/types'

export const kindLabel = (k: PluginKind): string => (k === 'fieldCodec' ? '필드 코덱' : k === 'messageCodec' ? '전문 코덱' : '변환')

/** 새 플러그인 골격 — 스크립트의 마지막 표현식이 플러그인 객체. */
export const PLUGIN_TEMPLATES: Record<PluginKind, { label: string; source: string }> = {
  transform: {
    label: '변환 — TRANSFORM 노드·Mock 코덱 단계에서 값 하나를 바꾼다',
    source: `// 변환 플러그인 — inputs 로 받은 값을 config 로 가공해 outputs 로 돌려준다.
({
  id: 'my-transform',          // 소문자·숫자·하이픈 (저장 후엔 바꿀 수 없음)
  label: '내 변환',
  description: '무엇을 넣으면 무엇이 나오는지 한 줄',
  inputs:  [{ key: 'input', label: '원문' }],
  outputs: [{ key: 'result', label: '결과' }],   // type: 'number' | 'boolean' | 'json' 이면 다운스트림에 그 타입으로
  params:  [{ key: 'key', label: '키', placeholder: '{{ aesKey@secret }}' }],
  apply(inputs, config) {
    fl.log('input =', inputs.input)
    return { result: fl.hmac.sha256(config.key, inputs.input) }
  },
})
`,
  },
  fieldCodec: {
    label: '필드 코덱 — 전문의 필드 값 하나를 보낼 때 감싸고 받을 때 푼다',
    source: `// 필드 코덱 — 프로토콜 필드의 plugin 으로 지정. encode = 송신 전(문자셋 인코딩 전), decode = 수신 후(패딩 제거 후).
({
  id: 'my-field-codec',
  label: '내 필드 코덱',
  kind: 'fieldCodec',
  params: [{ key: 'key', label: '키', placeholder: '{{ aesKey@secret }}' }, { key: 'iv', label: 'IV' }],
  encode(value, ctx) { return fl.aes.encrypt(value, ctx.config.key, ctx.config.iv) },
  decode(value, ctx) { return fl.aes.decrypt(value, ctx.config.key, ctx.config.iv) },
})
`,
  },
  messageCodec: {
    label: '전문 코덱 — 본문 바이트 전체를 감싸고 푼다(헤더는 평문)',
    source: `// 전문 코덱 — 본문 bytes ↔ bytes. 헤더(길이·거래코드)는 평문이고 길이 계산 전에 적용된다.
({
  id: 'my-message-codec',
  label: '내 전문 코덱',
  kind: 'messageCodec',
  params: [{ key: 'key', label: '키', placeholder: '{{ aesKey@secret }}' }, { key: 'iv', label: 'IV' }],
  encode(body, ctx) { return fl.aes.encryptBytes(body, ctx.config.key, ctx.config.iv) },
  decode(body, ctx) { return fl.aes.decryptBytes(body, ctx.config.key, ctx.config.iv) },
})
`,
  },
}
