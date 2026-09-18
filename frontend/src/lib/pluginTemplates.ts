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

/** 예제 — 레거시 JAR 플러그인을 스크립트로 옮긴 것들. 화면의 "예제에서 시작…" 셀렉트가 초안으로 연다. */
export const PLUGIN_EXAMPLES: { key: string; label: string; source: string }[] = [
  { key: 'des-encrypt', label: 'DES 암호화 (레거시 des-cipher)', source: `// 레거시 JAR 플러그인 des-cipher(DesEncrypt) 를 스크립트로 옮긴 것 — DES/ECB, 기본 zero 패딩·hex. 키는 입력 포트(시크릿 바인딩 권장).
({
  id: 'des-encrypt',
  label: 'DES 암호화',
  description: '평문을 DES(ECB)로 암호화 → hex/base64. 레거시 호환용 zero 패딩이 기본.',
  inputs:  [{ key: 'input', label: '평문' }, { key: 'key', label: '키(8바이트)' }],
  outputs: [{ key: 'result', label: '암호문' }],
  params:  [
    { key: 'keyFormat', label: '키 형식', type: 'select', options: ['utf8', 'base64', 'hex'], defaultValue: 'utf8' },
    { key: 'padding', label: '패딩', type: 'select', options: ['zero', 'pkcs5'], defaultValue: 'zero' },
    { key: 'output', label: '암호문 인코딩', type: 'select', options: ['hex', 'base64'], defaultValue: 'hex' },
  ],
  apply(inputs, config) {
    const key = config.keyFormat === 'hex' ? fl.hex.dec(inputs.key, { as: 'bytes' })
      : config.keyFormat === 'base64' ? fl.b64.dec(inputs.key, { as: 'bytes' }) : inputs.key
    const opt = { mode: 'ECB', padding: config.padding || 'zero', out: config.output === 'base64' ? 'b64' : 'hex' }
    return { result: fl.des.encrypt(inputs.input, key, null, opt) }
  },
})
` },
  { key: 'des-decrypt', label: 'DES 복호화 (레거시 des-cipher)', source: `// 레거시 JAR 플러그인 des-cipher(DesDecrypt) 를 스크립트로 옮긴 것 — DES/ECB, 기본 zero 패딩·hex. 키는 입력 포트(시크릿 바인딩 권장).
({
  id: 'des-decrypt',
  label: 'DES 복호화',
  description: 'DES 암호문(hex/base64)을 평문으로. 키·패딩·인코딩을 암호화와 동일하게.',
  inputs:  [{ key: 'input', label: '암호문' }, { key: 'key', label: '키(8바이트)' }],
  outputs: [{ key: 'result', label: '평문' }],
  params:  [
    { key: 'keyFormat', label: '키 형식', type: 'select', options: ['utf8', 'base64', 'hex'], defaultValue: 'utf8' },
    { key: 'padding', label: '패딩', type: 'select', options: ['zero', 'pkcs5'], defaultValue: 'zero' },
    { key: 'output', label: '암호문 인코딩', type: 'select', options: ['hex', 'base64'], defaultValue: 'hex' },
  ],
  apply(inputs, config) {
    const key = config.keyFormat === 'hex' ? fl.hex.dec(inputs.key, { as: 'bytes' })
      : config.keyFormat === 'base64' ? fl.b64.dec(inputs.key, { as: 'bytes' }) : inputs.key
    const opt = { mode: 'ECB', padding: config.padding || 'zero', out: config.output === 'base64' ? 'b64' : 'hex' }
    return { result: fl.des.decrypt(inputs.input, key, null, opt) }
  },
})
` },
]
