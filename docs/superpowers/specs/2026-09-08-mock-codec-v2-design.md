# Mock 2.0 — 코덱 입력/범위 · 시크릿/환경 토큰 · 예상 요청 정의 + 칩 입력 · 요청 기록 활용 (설계)

작성: 2026-09-08 · 브랜치 `feat/mock-codec-transfer` · 상태: 승인(사용자 "진행해줘") → 구현 중

## 0. 배경 · 사용자 요구
1차 코덱(2026-09-08)은 "전문 전체 → 첫 입력 포트, 나머지 빈 값"으로 좁게 정해 버렸다. 사용자 피드백:
- **일부 필드에만** 적용하거나 **전체**에 적용하는 것을 고를 수 있어야 한다.
- 플러그인의 **key/iv 같은 다른 입력 포트·파라미터도 입력**받아야 한다.
- 그 값에 **시크릿 볼트(Vault)·환경 변수** 를 쓸 수 있어야 한다.
- Mock 을 전체적으로 워크플로만큼 편하게 — 단, **워크플로를 흉내 낼 필요는 없다**(Mock 은 "요청을 받는 쪽"이라 성격이 반대).
- 칩(데이터 삽입) 입력: 어떤 요청이 올지 모르니 **"올 것을 미리 정의"** 하는 방식으로.
- 환경 스위처 같은 UI 는 Mock 에 안 어울림 → 넣지 않음. 시크릿/환경 값은 **Mock 별 환경 설정**(전자)으로.

## 1. 통합 토큰 문법 (백엔드 `MockTemplate`)
Mock 의 모든 템플릿 자리(응답 본문·헤더·setState 값·콜백 URL/본문·코덱 입력값/파라미터·TCP 응답 필드 값)에서 두 문법을 모두 받는다.

| 워크플로 문법(칩 호환) | 기존 dot 문법(유지) | 값 |
|---|---|---|
| `{{ x@body }}` | `{{body.x}}` | 요청 본문 필드(JSON 최상위/urlencoded). **점 경로** `{{ user.addr.city@body }}`·`{{ items[0].id@body }}` 는 본문 JSON 을 파고든다 |
| `{{ x@query }}` / `{{ x@path }}` / `{{ x@header }}` / `{{ x@state }}` | `{{query.x}}` … | 기존과 동일 |
| `{{ body }}` `{{ method }}` `{{ uuid }}` `{{ seq }}` `{{ now }}` | 동일 | 기존 |
| **`{{ 이름@secret }}`** | — | 시크릿 볼트(공통 + Mock 환경 오버레이 + Vault) |
| **`{{ 키@env }}`** | — | Mock 에 설정한 환경의 변수(환경 미설정이면 빈 문자열) |
| `{{ x@req }}` (TCP) | `{{req.x}}` · `{{req}}` · `{{req:o:l}}` | TCP 요청 레이아웃 필드 |

- 구현: `MockTemplate`(순수) — `MockContext(req, pathParams, seq, state, secrets, env, tcpReqFields)` 를 받아 문자열을 렌더. `MockRuntime`·`TcpMockEngine`·코덱이 공유(지금은 각자 정규식).
- 미해석 토큰은 빈 문자열(기존 규약).
- **환경 설정**: `MockSpec.environment: String?`(편집기 "시크릿 환경" 셀렉트, 기본 없음=공통 시크릿만). 서빙은 서버에서 도니 브라우저 활성 환경과 무관.
- **테넌트**: 게이트웨이/TCP 리스너는 `TenantContext.setTenantId(server.tenantId)` 로 감싸 시크릿/환경 조회(요청 끝에 clear). 시크릿·환경 값은 서버별 **10초 TTL 캐시**(Transit/Vault 왕복을 요청마다 안 하게).
- **마스킹**: 요청 기록(journal)의 headers/bodyText/decodedBody 와 콜백 발사 로그에서 시크릿 값을 `••••••` 로(SecretMasker 재사용). 응답 본문은 사용자가 의도한 출력이라 마스킹 안 함(보내보기 결과에 그대로 보임 — 문서에 명시).

## 2. 코덱 v2 — 단계 입력·적용 범위

```jsonc
MockCodecStep {
  "id": "aes-cbc-decrypt",           // 변환 플러그인 id
  "target": "body" | "fields" | "header",   // 적용 범위(기본 body=전문 전체)
  "fields": ["card.no", "pin"],      // target=fields — HTTP: JSON(점 경로)/urlencoded 키, TCP: 레이아웃/응답 필드명
  "header": "X-Signature",           // target=header — 대상 헤더명
  "inputs": [                        // 플러그인의 입력 포트마다
    { "key": "input", "mode": "message" },                          // 전문(대상 값)이 들어가는 포트(정확히 1개)
    { "key": "key",   "mode": "value", "value": "{{ aesKey@secret }}" },
    { "key": "iv",    "mode": "value", "value": "{{ aesIv@env }}" }
  ],
  "config": [{ "key": "mode", "value": "CBC" }],   // 파라미터(템플릿 허용)
  "outputKey": "result"              // 출력 포트가 여럿일 때
}
```
- **하위호환**: 기존 `{id, config, inputKey, outputKey}` → `target=body`, `inputs=[{key: inputKey|첫 포트, mode: message}]`.
- **의미(요청 전 request)**: target=body → 본문 전체 디코딩(기존). target=fields → 지정 필드 값만 풀어 `bodyFields`/본문에 되돌려 씀(JSON 은 재직렬화, urlencoded 는 재인코딩). target=header → 그 헤더 값을 변환해 `{{ x@header }}` 에 반영. TCP: fields = 요청 레이아웃 필드명(슬라이스 후 값 치환).
- **의미(응답 후 response)**: target=body → 렌더된 본문 전체 인코딩(기존). target=fields → 렌더된 본문을 contentType 에 따라 파싱(json/urlencoded)해 필드만 감싸고 재직렬화(xml/html/text 는 코덱 오류). target=header → **입력 전문 = 렌더된 본문**, 출력을 지정 헤더에 기록(본문 HMAC 서명 → `X-Signature` 패턴). TCP: fields = 응답 필드명 — 패딩 전 값에 적용.
- 단계는 위에서부터 순서대로, **같은 target 의 값을 이어받는다**(body→body 체인). target 이 다른 단계는 각자 대상 값에 적용.
- `mode=value` 입력·config 값은 §1 토큰으로 렌더(시크릿·환경·요청 값).
- 실패 규약 불변(HTTP 500 JSON·TCP 연결 종료·WARN).

## 3. 예상 요청 정의(expect) + 칩 입력
- `MockRoute.expect: { body: [{key, type?, example?}], query: [{key, example?}], header: [{key, example?}] }`. 경로 파라미터는 패턴(`/users/{id}`)에서 자동.
- **용도**: ① 데이터 삽입 피커 소스(요청 본문/쿼리/헤더/경로) ② 조건 편집의 키 후보 ③ **▶ 테스트/규칙 테스트**의 샘플 요청(example 로 채움) ④ AI 프롬프트 컨텍스트.
- **요청 기록에서 채우기**: 기록 항목의 "예상 필드로" 버튼 → 그 요청의 body 키(JSON 최상위/urlencoded)·query 키·비표준 헤더를 expect 에 병합(example = 실제 값). 어떤 요청이 올지 모르는 문제를 **실제 온 요청**으로 해결.
- **칩 입력 적용**: 한 줄 값(헤더 값·setState 값·콜백 URL·조건 값·코덱 입력값/파라미터·TCP 응답 필드 값)은 `TokenInput`(칩). 여러 줄(응답 본문·콜백 본문)은 `{ }` 데이터 삽입 버튼(피커 → 캐럿 위치에 토큰 삽입, 워크플로 raw 본문과 동일). 칩 라벨은 소스 이름(요청 본문/쿼리/헤더/경로/상태/시크릿/환경/TCP 요청) — TokenInput 이 `sources` 이름으로 해석(캔버스 노드가 아니면).
- 피커 소스 순서: 요청(경로·쿼리·헤더·본문) → 상태(setState 키 합집합) → 시크릿(활성 환경 기준 적용되는 이름) → 환경 변수(설정 시) → TCP 요청 필드.

## 4. Mock 고유 편의 기능(요청을 받는 쪽 관점)
1. **요청 기록 활용**: 항목마다 [예상 필드로] [규칙 초안] [재전송]. 규칙 초안 = 경로/메서드가 맞는 라우트가 없으면 라우트 생성, 있으면 그 라우트에 "요청 값 eq 조건 + 현재 응답 본문 복제" 규칙 추가. 재전송 = 기록된 메서드/경로/쿼리/본문으로 다시 호출(코덱 검증에 유용).
2. **규칙 ▶ 테스트**: 그 규칙의 eq 조건 + expect example 로 요청을 만들어 호출 → 응답 + "매칭된 규칙이 이 규칙인지"(journal matchedRuleId) 표시.
3. **코덱 시험해보기**: 코덱 섹션 하단 — 샘플 전문(+헤더 값) 넣고 실행 → 단계별 중간 결과(서버가 실제 시크릿으로 계산, `POST /mock-servers/{id}/codec-try` — 미저장 코덱/환경을 실어 보냄).
4. **TCP 전문 미리보기에 코덱 반영**(요청 디코딩 → 매칭 → 응답 → 인코딩까지, 단계별 표시).
5. **라우트/규칙 요약 배지**: 조건 수·코덱·콜백·상태·N회 — 긴 목록 훑기.
6. 기존 유지: export/import(코덱·expect·environment 포함), AI 어시스턴트(프롬프트에 §1·§2·§3 반영).

## 5. API
- `POST /api/v1/mock-servers/{id}/codec-try` {codec, environment, side: request|response, message, headers?, contentType?} → {steps:[{id, target, input, output}], result, headers} (requireRead — 시크릿 값은 노출 안 함, 결과 텍스트만; 시크릿 값 자체가 출력이면 마스킹).
- `POST /api/v1/mock-servers/tcp-preview` 에 codec·environment 추가(코덱 반영).
- `GET /api/v1/mock-servers/{id}/requests` 항목에 `headers/bodyText/decodedBody` 마스킹 적용.
- 스키마 변경 없음(spec_json). Oracle 마이그레이션 없음.

## 6. 보안·한계
- 시크릿은 Mock 응답에 평문으로 나갈 수 있다(사용자 의도) — 요청 기록/로그만 마스킹. 문서에 명시.
- `codec-try` 는 읽기 권한자에게 시크릿을 **간접** 노출할 수 있다(암호화 결과 등) — 시크릿 볼트 쓰기와 같은 승인 사용자로 게이트.
- 환경 변수는 평문. Mock 환경 설정은 시크릿/env 스코프 선택일 뿐 워크플로 활성 환경과 무관.
- 코덱 fields 대상은 JSON/urlencoded 만(xml/html/text 는 body 전체만).

## 7. 구현 순서
1. 백엔드: `MockTemplate`+`MockContext` 도입(MockRuntime/TcpMockEngine/코덱 공유) · `MockSpec.environment`·`expect`·코덱 v2 모델 · 시크릿/환경 공급자(캐시·테넌트) · 코덱 v2 실행(fields/header/inputs) · journal 마스킹 · codec-try/tcp-preview 확장 · 단위 테스트.
2. 프론트: 타입 · 코덱 편집기 v2 · 시크릿 환경 셀렉트 · expect 편집기 · TokenInput 소스 이름 해석 + 칩/`{ }` 삽입 · 조건 키 후보 · 요청 기록 액션 · 규칙 테스트 · 코덱 시험 · TCP 미리보기 코덱 · 요약 배지.
3. AI 프롬프트(MockSchemaPrompt) 갱신 · 가이드 10장 · CLAUDE.md · 라이브 e2e(HTTP/TCP 소켓/브라우저).
