const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const exported = {}
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/apiError.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
vm.runInNewContext(code, { exports: exported })
const message = exported.apiErrorMessage
assert.match(message({ message: 'Request failed with status code 503' }), /서버가 잠시/)
assert.match(message({ message: 'Request failed with status code 403' }), /권한/)
assert.match(message({ message: 'Request failed with status code 401' }), /로그인/)
assert.equal(message({ message: 'Request failed with status code 500' }, '테스트를 완료하지 못했습니다'), '테스트를 완료하지 못했습니다 (HTTP 500)')
assert.equal(message({ response: { data: { message: '7행: apply 함수가 필요합니다' } }, message: 'Request failed with status code 400' }), '7행: apply 함수가 필요합니다')
assert.match(message({ response: { data: { message: ' ' } }, message: 'Request failed with status code 503' }), /서버가 잠시/)
assert.match(message({ code: 'ERR_NETWORK', message: 'Network Error' }), /연결/)
assert.match(message({ code: 'ETIMEDOUT' }), /시간이 초과/)
assert.equal(message(new Error('JSON 객체로 입력하세요')), 'JSON 객체로 입력하세요')
console.log('PASS: shared error messages localize generic HTTP/network errors while preserving precise server and validation diagnostics')
