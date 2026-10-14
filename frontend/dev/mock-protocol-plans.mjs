const warning = '프론트 Mock의 합성 결과입니다. 실제 코덱·EUC-KR·소켓 호환성은 실행기에서 확인하세요.'
const issue = (path, message, code = 'INVALID_SCHEMA') => ({ path, field: null, message, code, repairHint: '편집 중 정의와 합성 입력을 확인하세요.' })
const capabilities = ['transactionFraming', 'transactionAck', 'ackLengthOnly', 'ackMessageTemplates', 'ackFieldValidation', 'binaryIntegers', 'mockPreview', 'lengthAdjustment', 'fixedFraming', 'delimiterFraming', 'responseFraming', 'connectionReuse', 'approvedCodecs']
export const mockCapabilities = () => ({ available: true, installedVersion: '1.0.0-mock', schemaVersions: [1, 2], checkedAt: new Date().toISOString(), features: Object.fromEntries(capabilities.map(key => [key, 'supported'])), limits: { maxWireBytes: 1048576, maxAckBytes: 1024, minIdleTimeoutMs: 1000, maxIdleTimeoutMs: 3600000 } })
export function validateProtocol(spec) {
  const errors = [], transactions = spec?.transactions ?? []
  if (!spec || !Array.isArray(spec.messages)) errors.push(issue('messages', '전문 배열이 필요합니다.'))
  if (spec?.schemaVersion === 2) {
    if (!transactions.length) errors.push(issue('transactions', '거래를 하나 이상 추가하세요.'))
    transactions.forEach((transaction, index) => {
      const path = `transactions[${index}]`
      if (!transaction.key || transactions.some((other, i) => i !== index && other.key === transaction.key)) errors.push(issue(`${path}.key`, '거래 키가 비었거나 중복됩니다.'))
      if (!transaction.when?.length) errors.push(issue(`${path}.when`, '헤더 eq 조건을 지정하세요.'))
      for (const side of ['requestMessage', 'responseMessage']) if (!spec.messages.some(message => message.key === transaction[side])) errors.push(issue(`${path}.${side}`, '등록된 업무 전문을 선택하세요.'))
      for (const phase of ['requestAck', 'responseAck']) {
        if (!(phase in transaction)) errors.push(issue(`${path}.${phase}`, '생략할 ACK도 null로 명시하세요.'))
        const ack = transaction[phase]
        if (ack && (!ack.send || !ack.receive)) errors.push(issue(`${path}.${phase}`, 'ACK 송신·수신을 모두 지정하세요.'))
      }
    })
  }
  const requiredCapabilities = spec?.schemaVersion === 2 ? ['transactionFraming', ...(transactions.some(transaction => transaction.requestAck || transaction.responseAck) ? ['transactionAck'] : [])] : []
  return { valid: errors.length === 0, schemaVersion: spec?.schemaVersion ?? 1, requiredCapabilities, compiledSummary: { headerBytes: (spec?.header ?? []).reduce((sum, field) => sum + field.len, 0), transactions, ackMessages: spec?.ackMessages ?? [] }, warnings: [warning], errors }
}
const expand = (text, req, res) => String(text).replace(/\{\{\s*(req|res)\.([^{}\s]+)\s*}}/g, (_, source, key) => { const values = source === 'req' ? req : res; if (!(key in values)) throw issue(`${source}.${key}`, '필수 컨텍스트 필드가 없습니다.', 'MISSING_CONTEXT_FIELD'); return values[key] })
const hexBytes = hex => { const compact = String(hex ?? '').replace(/[\s:]/g, ''); if (!/^(?:[\da-f]{2})+$/i.test(compact)) throw issue('hex', 'HEX 두 자리씩 입력하세요.'); return Buffer.from(compact, 'hex') }
function encode(fields, values) {
  const slices = [], chunks = []; let offset = 0
  for (const field of fields) {
    const value = String(values[field.name] ?? ''), pad = field.pad ?? (['integer', 'binary'].includes(field.type) ? 'none' : field.type === 'numeric' ? 'left/zero' : 'right/space')
    let bytes
    if (field.type === 'integer') {
      if (!/^-?\d+$/.test(value) || ![1, 2, 4, 8].includes(field.len)) throw issue(`values.${field.name}`, '1/2/4/8 B 정수의 10진 문자열이 필요합니다.')
      const number = BigInt(value), bits = BigInt(field.len * 8), min = field.signed ? -(1n << (bits - 1n)) : 0n, max = field.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n
      if (number < min || number > max) throw issue(`values.${field.name}`, '정수 범위를 넘었습니다.')
      let wire = number < 0 ? (1n << bits) + number : number; bytes = Buffer.alloc(field.len)
      for (let i = 0; i < field.len; i++) { bytes[field.endian === 'little' ? i : field.len - i - 1] = Number(wire & 255n); wire >>= 8n }
    } else if (field.type === 'binary') bytes = hexBytes(value)
    else bytes = Buffer.from(value)
    if (bytes.length > field.len || (pad === 'none' && bytes.length !== field.len)) throw issue(`values.${field.name}`, `${field.len} B 길이를 확인하세요.`, 'FRAME_LENGTH_MISMATCH')
    const filled = Buffer.alloc(field.len, pad.endsWith('nul') ? 0 : pad.endsWith('zero') ? 48 : 32)
    bytes.copy(filled, pad.startsWith('left') ? field.len - bytes.length : 0)
    chunks.push(filled); slices.push({ name: field.name, offset, len: field.len, actualBytes: bytes.length, value }); offset += field.len
  }
  return { bytes: Buffer.concat(chunks), fields: slices }
}
export function protocolPreview(request) {
  const spec = request.spec, report = validateProtocol(spec), phase = request.phase ?? (request.frameDirection === 'recv' ? 'response' : 'request')
  const empty = { total: 0, wireLength: 0, hex: '', text: '', fields: [], errors: [], warnings: [warning], phase, validations: [] }
  if (!report.valid) return { ...empty, errors: report.errors }
  try {
    const transaction = spec.schemaVersion === 2 ? spec.transactions.find(row => request.transactionKey ? row.key === request.transactionKey : row.requestMessage === request.key || row.responseMessage === request.key) : undefined
    if (spec.schemaVersion === 2 && !transaction) throw issue('transactionKey', '거래를 선택하세요.')
    const isAck = phase.endsWith('Ack'), ack = isAck ? transaction?.[phase] : null
    const key = request.key ?? transaction?.[phase === 'request' ? 'requestMessage' : 'responseMessage']
    let fields, values, encoded
    if (isAck) {
      if (!ack) throw issue(phase, '생략된 ACK 단계입니다.')
      if (ack.send.kind === 'hex') encoded = { bytes: hexBytes(ack.send.hex), fields: [] }
      else { fields = spec.ackMessages?.find(message => message.key === ack.send.messageKey)?.fields ?? []; values = Object.fromEntries(Object.entries(ack.send.values ?? {}).map(([name, value]) => [name, expand(value, request.requestFields ?? {}, request.responseFields ?? {})])); encoded = encode(fields, values) }
    } else {
      const message = spec.messages.find(message => message.key === key)
      if (!message) throw issue('key', '업무 전문을 선택하세요.')
      fields = [...(spec.header ?? []), ...message.fields]; values = { ...request.values }
      if (phase === 'request') for (const condition of transaction?.when ?? []) values[condition.field] ??= condition.value
      const length = fields.reduce((sum, field) => sum + field.len, 0), frame = (phase === 'response' ? transaction?.responseFraming ?? spec.responseFraming ?? transaction?.framing ?? spec.framing : transaction?.framing ?? spec.framing)
      for (const field of fields) if (field.type === 'length') values[field.name] = String(length - (frame?.lengthAdjustment ?? (spec.includesSelf ? 0 : field.len)))
      if (request.action !== 'parse') encoded = encode(fields, values)
    }
    if (request.action === 'parse') {
      const base64 = request.bytesB64 ?? ''
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) || !base64) throw issue('bytesB64', '유효한 Base64를 입력하세요.')
      const bytes = Buffer.from(base64, 'base64'), receive = isAck ? ack.receive : null
      const layout = receive?.kind === 'fields' ? spec.ackMessages?.find(message => message.key === receive.messageKey)?.fields ?? [] : fields ?? []
      const expected = receive?.kind === 'length-only' ? receive.lengthBytes : receive?.kind === 'exact' ? hexBytes(receive.hex).length : layout.reduce((sum, field) => sum + field.len, 0)
      if (bytes.length !== expected) throw issue('bytesB64', `${expected} B 전체 프레임이 필요합니다.`, 'FRAME_LENGTH_MISMATCH')
      if (receive?.kind === 'exact' && !bytes.equals(hexBytes(receive.hex))) throw issue('bytesB64', 'ACK HEX가 일치하지 않습니다.', 'ACK_MISMATCH')
      let offset = 0
      encoded = { bytes, fields: layout.map(field => {
        const part = bytes.subarray(offset, offset + field.len)
        let value
        if (field.type === 'integer') {
          let number = 0n
          for (const byte of field.endian === 'little' ? [...part].reverse() : part) number = (number << 8n) + BigInt(byte)
          if (field.signed && number >= 1n << BigInt(field.len * 8 - 1)) number -= 1n << BigInt(field.len * 8)
          value = number.toString()
        } else value = field.type === 'binary' ? part.toString('hex') : part.toString('utf8').replace(/\0+$/, '').trim()
        const row = { name: field.name, offset, len: field.len, actualBytes: part.length, value }; offset += field.len; return row
      }) }
    }
    return { ...empty, total: encoded.bytes.length, wireLength: encoded.bytes.length, bytesB64: encoded.bytes.toString('base64'), hex: encoded.bytes.toString('hex'), text: encoded.bytes.toString('utf8'), fields: encoded.fields, transactionKey: transaction?.key, lengthAdjustment: 0 }
  } catch (error) { return { ...empty, errors: [error.path ? error : issue('spec', error.message ?? 'Mock 미리보기 실패')] } }
}
export function mockPlanPreview(body, item, protocol) {
  const spec = body.spec ?? item?.spec, input = body.request ?? {}, request = structuredClone(input)
  if (spec?.tcp) {
    const preview = protocolPreview({ spec: body.protocolSpec ?? protocol, ...input })
    if (preview.errors.length) return { unsaved: !!body.spec, sideEffects: false, request, response: {}, steps: [], warnings: [warning], validations: preview.errors }
    const fields = Object.fromEntries(preview.fields.map(field => [field.name, field.value]))
    const rule = spec.tcp.rules?.find(rule => (rule.when ?? []).every(condition => condition.op === 'eq' ? fields[condition.field] === condition.value : condition.op === 'ne' ? fields[condition.field] !== condition.value : condition.op === 'exists' ? condition.field in fields : condition.op === 'contains' ? String(fields[condition.field]).includes(condition.value) : false))
    const transaction = protocol?.transactions?.find(transaction => transaction.key === preview.transactionKey)
    const responseFields = rule ? Object.fromEntries(Object.entries(rule.then?.fields ?? {}).map(([name, value]) => [name, expand(value, fields, {})])) : {}
    const responseKey = transaction?.responseMessage ?? (protocol?.discriminator ? responseFields[protocol.discriminator] : 'response')
    const response = rule ? protocolPreview({ spec: protocol, key: responseKey, transactionKey: transaction?.key, phase: 'response', values: { ...fields, ...responseFields } }) : null
    const steps = ['REQUEST', 'REQUEST_ACK', 'RESPONSE', 'RESPONSE_ACK'].map((phase, index) => ({ phase, role: 'mock', direction: index === 0 || index === 3 ? 'RECEIVE' : 'SEND', actualBytes: index === 0 ? preview.total : index === 2 ? response?.total ?? 0 : 0, transactionKey: preview.transactionKey, durationMs: 0, status: index === 1 || index === 3 ? transaction?.[index === 1 ? 'requestAck' : 'responseAck'] ? 'PLANNED' : 'SKIPPED' : 'PLANNED' }))
    return { unsaved: !!body.spec, sideEffects: false, definition: item ? { id: item.id, version: item.currentVersion } : null, snapshot: { state: {}, seq: 0, virtualSeq: 1, hits: {} }, request: { ...request, ...preview }, response: response ?? {}, steps, transactionKey: preview.transactionKey, ruleId: rule?.id, warnings: [warning], validations: !rule ? [issue('rules', '매칭 규칙이 없습니다.', 'NO_MATCHING_RULE')] : response?.errors ?? [], requiredCapabilities: validateProtocol(protocol).requiredCapabilities, compiledSummary: validateProtocol(protocol).compiledSummary }
  }
  const route = spec?.routes?.find(route => (route.method === input.method || route.method === 'ANY') && route.path === input.path), rule = route?.rules?.[0]
  return { unsaved: !!body.spec, sideEffects: false, request, response: rule ? { status: rule.status ?? 200, body: rule.body ?? '', headers: rule.headers ?? [] } : {}, steps: [], ruleId: rule?.id, snapshot: { state: {}, seq: 0, virtualSeq: 1, hits: {} }, warnings: [warning], validations: rule ? [] : [issue('request.path', '매칭 라우트가 없습니다.', 'NO_MATCHING_RULE')], requiredCapabilities: [], compiledSummary: {} }
}

export function mockTcpSendResult(body, item, protocol, executionId) {
  const transaction = protocol.transactions.find(transaction => body.transactionKey ? transaction.key === body.transactionKey : transaction.requestMessage === body.key)
  const key = body.key ?? transaction?.requestMessage
  const request = protocolPreview({ spec: protocol, ...body, key, phase: 'request' })
  const plan = mockPlanPreview({ spec: item.spec, type: 'TCP', request: { key, values: body.values } }, item, protocol)
  const output = plan.response
  const error = request.errors[0] ?? plan.validations[0]
  const headerNames = new Set(protocol.header.map(field => field.name))
  const response = { key: transaction?.responseMessage ?? null, disc: null,
    header: Object.fromEntries((output.fields ?? []).filter(field => headerNames.has(field.name)).map(field => [field.name, field.value])),
    body: Object.fromEntries((output.fields ?? []).filter(field => !headerNames.has(field.name)).map(field => [field.name, field.value])),
    text: output.text ?? '', hex: output.hex ?? '', bytes: output.total ?? 0, chunks: output.total ? [output.total] : [], partial: false, warnings: [warning] }
  const steps = ['REQUEST', 'REQUEST_ACK', 'RESPONSE', 'RESPONSE_ACK', 'COMPLETE'].map((phase, index) => {
    const ack = index === 1 ? transaction?.requestAck : index === 3 ? transaction?.responseAck : null
    const ackPreview = ack ? protocolPreview({ spec: protocol, transactionKey: transaction.key, phase: index === 1 ? 'requestAck' : 'responseAck', requestFields: Object.fromEntries(request.fields.map(field => [field.name, field.value])), responseFields: { ...response.header, ...response.body } }) : null
    const actualBytes = index === 0 ? request.total : index === 2 ? response.bytes : ackPreview?.total ?? 0
    return { phase, role: 'client', direction: index === 0 || index === 3 ? 'SEND' : index === 1 || index === 2 ? 'RECEIVE' : null, expectedBytes: actualBytes, actualBytes, transactionKey: transaction?.key, durationMs: 0, status: error ? 'FAILED' : (index === 1 || index === 3) && !ack ? 'SKIPPED' : 'SUCCEEDED', validationMode: ack?.receive.kind }
  })
  return { request, response, elapsedMs: 120, transactionKey: transaction?.key, executionId, transportStatus: error ? 'FAILED' : 'SUCCEEDED', steps, warnings: [warning, '합성 전송 결과 · 실제 소켓·설치·콜백은 실행하지 않았습니다.'], ...(error ? { error: { ...error, phase: 'REQUEST' } } : {}) }
}
