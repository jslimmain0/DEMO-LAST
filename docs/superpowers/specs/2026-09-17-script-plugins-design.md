# 스크립트 플러그인 — 화면에서 적고, 관리자가 승인하고, 샌드박스에서 도는 변환/코덱

2026-09-17 · 브랜치 `refactor/trim-config`

## 왜

플러그인(변환·코덱)은 지금 **JAR 업로드**로만 들어온다. 사내망에서 파일 업로드는 승인 대상이라 개발자가 플러그인 하나
고치는 데 결재가 붙고, JAR 은 승인자가 내용을 읽을 수 없는 **전권 바이너리**(ServiceLoader 가 로드하는 순간 `static {}` 이
돈다)라 관리자 게이트가 유일한 방어였다.

이 설계는 채널을 바꾸는 게 아니라 **위험 등급을 낮춘다**: "읽을 수 없는 전권 바이너리" → "읽을 수 있는 순수 함수".
플러그인 소스를 화면에서 적고, 서버가 컴파일해 DB 에 두고, 관리자가 코드와 샘플 실행 결과를 보고 승인하면 레지스트리에
올라간다. 기존 SPI(`FlowTransform`, `CodecPlugin`)와 레지스트리는 그대로라 TRANSFORM 노드·Mock 코덱·프로토콜 코덱·MCP 는
무변경이다.

## 결정 (토론 결과)

| 결정 | 선택 | 기각 |
|---|---|---|
| 스크립트가 보는 API 표면 | **B. `fl.*` 헬퍼 + 표준 JS 만**(호스트 JVM 접근 없음) | A. 날 JVM(승인자가 매번 보안 리뷰, RCE 등급 유지) · C. 허용 목록(Jenkins Script Approval 의 영구 관리 부담) |
| 언어 | **JS (GraalJS)** | Groovy(Java 팀 편의 — `fl.*` 가 표면이면 이점 소멸, 샌드박스가 정적 검사 수준) · Kotlin script(컴파일러 60MB+) · Java(JDK 컴파일러 — 보일러플레이트, 샌드박스 없음) · Python(subprocess) |
| 승인 | **관리자 승인** — 초안 → 승인 요청 → 승인/반려, 승인본은 새 초안이 승인될 때까지 서빙 유지 | |
| JAR | **기본 비활성**(`flowlink.plugins.jar-enabled=false`), 업로드 API/UI 제거, 서버 디렉터리 배치만 | |

판단 기준: 변환/코덱은 정의상 `입력 → 출력` 순수 함수라 외부 시스템·파일에 닿을 일이 없다. B 에서 C 로 넓히는 건 언제든
되지만 A 에서 시작하면 이미 쓰인 플러그인 때문에 못 좁힌다.

## 1. 플러그인의 모양 — 스크립트의 값이 객체 하나

스크립트는 **마지막 표현식이 플러그인 객체**다. DSL 함수가 아니라 데이터 객체인 이유: 메타(id·입출력·파라미터)가 부작용
없는 값이라 컴파일만으로 UI 폼을 그릴 수 있고, LLM 이 가장 안 틀리는 형태다.

```js
// 변환(transform) — kind 생략 = 'transform'
({
  id: 'aes-card', label: '카드번호 AES', description: 'AES-CBC/PKCS5 → base64',
  inputs:  [{ key: 'input', label: '평문' }],                       // 생략 시 [{key:'input'}]
  outputs: [{ key: 'result', label: '암호문', type: 'string' }],    // 생략 시 [{key:'result'}]; type = string|number|boolean|json|array
  params:  [{ key: 'key', label: '키', placeholder: '{{ aesKey@secret }}' }, { key: 'iv', label: 'IV' }],
  apply(inputs, config) {
    return { result: fl.aes.encrypt(inputs.input, config.key, config.iv) }
  },
})
```
```js
// 필드 코덱 — 필드 값 ↔ 필드 값 (프로토콜 필드 `plugin`, Mock 코덱 fields 대상)
({ id: 'card-mask', label: '카드번호 마스킹', kind: 'fieldCodec',
   params: [{ key: 'keep', label: '뒷자리', defaultValue: '4' }],
   encode(value, ctx) { return fl.mask(value, 6, Number(ctx.config.keep)) },
   decode(value, ctx) { return value } })
```
```js
// 전문 코덱 — 본문 bytes ↔ bytes (헤더는 평문, 길이 계산 전에 적용)
({ id: 'body-aes', label: '본문 AES', kind: 'messageCodec',
   params: [{ key: 'key', label: '키' }],
   encode(body, ctx) { return fl.aes.encryptBytes(body, ctx.config.key) },
   decode(body, ctx) { return fl.aes.decryptBytes(body, ctx.config.key) } })
```

- `ctx` = `{ config, direction: 'send'|'recv', field: {name,len,type,pad}|null, message: {필드명: 값} }` — 기존 `CodecCtx` 미러.
- `param` 타입은 기존 `TransformParam`(`string|number|select|textarea`, `options`, `defaultValue`, `placeholder`) 그대로.
- bytes 는 JS 쪽에서 `Uint8Array`. 서버 어댑터가 `ByteArray` ↔ `Uint8Array` 를 변환한다.
- 어댑터: `ScriptTransform : FlowTransform`, `ScriptFieldCodec : FieldCodec`, `ScriptMessageCodec : MessageCodec` — 기존 SPI 구현체라
  레지스트리·실행 엔진·Mock·프로토콜·MCP(`plugin_list`·`transform_preview`)가 스크립트 여부를 모른다.

## 2. `fl.*` v1

하나의 **매니페스트**(`GET /api/v1/plugins/api`)가 원천 — 편집기 자동완성·툴팁, MCP 가이드(`flowlink_guide topic:'plugin'`)가
같은 데이터를 쓴다. 항목: `path`(예 `fl.aes.encrypt`) · `signature` · `doc`(한 줄) · `example`.

| 네임스페이스 | 함수 | 구현 |
|---|---|---|
| `fl.b64` | `enc(text|bytes, {charset})`, `dec(b64, {as:'text'|'bytes', charset})` | `java.util.Base64` |
| `fl.hex` | `enc`, `dec` (같은 형태) | `HexFormat` |
| `fl.hash` | `sha256/sha1/md5(text|bytes, {out:'hex'|'b64'})` | `MessageDigest` |
| `fl.hmac` | `sha256(key, data, {out})` | `javax.crypto.Mac` |
| `fl.aes` | `encrypt/decrypt(text, key, iv?, {mode:'CBC'|'ECB', out:'b64'|'hex', charset})`, `encryptBytes/decryptBytes(bytes, key, iv?, {mode})` | `javax.crypto.Cipher` AES/…/PKCS5Padding |
| `fl.seed`, `fl.aria` | `encrypt/decrypt`, `encryptBytes/decryptBytes` (aes 와 같은 시그니처) | **BouncyCastle** `bcprov-jdk18on`(신규 의존성, ~6MB) |
| `fl.rsa` | `sign(pemPrivate, data, {alg:'SHA256withRSA', out})`, `verify(pemPublic, data, sig)` | `java.security.Signature` |
| `fl` | `bytes(text, charset)`, `text(bytes, charset)` | `Charset`(EUC-KR/MS949 포함) |
| `fl.pad` | `left/right(text, len, ch, {charset})` — 바이트 길이 기준 | 기존 `TcpBytes.fixedField` |
| `fl` | `mask(text, front, back, ch='*')` | 신규(샘플 MaskTransform 로직) |
| `fl` | `now(pattern?, zone?)` | 기존 `NowTokens` |
| `fl.json` | `parse`, `stringify` | JS 내장 위임 |
| `fl` | `log(...args)` | 실행 패널 콘솔로 수집(서빙 시엔 버림) |

기본값 = 회사 관례(UTF-8, CBC/PKCS5, base64 출력). 다른 조합은 이름 있는 옵션으로만. 표준 JS(`String`·`Math`·`Array`·
`Date`·`JSON`·`RegExp`)는 그대로. **`Java`·`Polyglot`·`globalThis` 호스트 접근 없음.**

## 3. 샌드박스 · 실행

- `org.graalvm.polyglot:polyglot` + `js-community`(JDK 21 인터프리터 모드 — 변환 용도엔 충분). `HostAccess.NONE`,
  `allowIO(false)`, `allowCreateThread(false)`, `allowNativeAccess(false)`, `allowHostClassLookup { false }`.
- `fl` 은 **Graal 프록시(`ProxyObject`/`ProxyExecutable`)** 로만 주입 — 호스트 리플렉션 경로가 존재하지 않는다.
- 호출당 **CPU 시간 상한**(`flowlink.plugins.script.timeout-ms`, 기본 2000 — 타이머 스레드가 `Context.interrupt`) + 문장 수 상한
  (`ResourceLimits.statementLimit`). 초과는 `CodecException`/`NodeResult.fail` 로 기존 오류 경로.
- **실행 = 호출마다 새 `Context`**(엔진 공유, `Source` 는 컴파일 시 캐시). Mock 서빙·워커 풀이 멀티스레드인데 Graal Context 는
  동시 사용 불가라 이게 가장 단순한 안전선. 실측 1~3ms. `ponytail:` 컨텍스트 풀은 핫패스 실측 후.
- 컴파일(`ScriptCompiler.compile(source)`): 평가해 객체를 얻고 메타를 검증(id 형식 `[a-z0-9-]{2,64}`, inputs/outputs/params 형태,
  kind 별 필수 함수 존재). 실패는 `ScriptError(line, col, message)` — 저장/시험 API 가 400 으로 그대로 돌려준다.

## 4. 저장 · 생명주기 · 승인

**테이블 `flowlink_plugin_script`**(`db/init.sql` 에 추가, local 은 ddl-auto):

| 컬럼 | 비고 |
|---|---|
| `id` uuid PK · `tenant_id` | 관례 |
| `plugin_id` varchar(64) | 스크립트 메타의 `id` — **테넌트 내 유니크**(레지스트리 키) |
| `name` varchar(120) · `kind` varchar(20) | 목록 표시용(kind 는 컴파일 결과에서 갱신) |
| `source` clob | 초안 |
| `live_source` clob null | 승인본 — 서빙 중인 코드 |
| `status` varchar(16) | `DRAFT` · `PENDING` · `APPROVED` · `REJECTED` |
| `sample_json` clob null | 제출자가 마지막으로 돌린 샘플(입력·설정·출력·콘솔) — 승인 화면에 첨부 |
| `submitted_by` · `submitted_at` · `reviewed_by` · `reviewed_at` · `review_note` | |
| `created_by` · `created_at` · `updated_at` | |

상태 전이:
- 승인 사용자: 생성/수정 = **초안 저장**(서버 컴파일 성공해야 저장 — `status` 는 `APPROVED` 면 유지, 아니면 `DRAFT`) →
  **승인 요청**(`PENDING`) → 철회(`DRAFT`). 승인본이 있는 플러그인을 수정하면 `live_source` 는 그대로 서빙되고 `source` 만 바뀐다.
- 관리자: **승인** = `live_source := source`, `APPROVED`, 레지스트리 reload · **반려** = `REJECTED` + 메모, `live_source` 유지.
- 삭제: 작성자 또는 관리자, **사용처 0 일 때만**(§6). 삭제 시 reload.
- 게이트: 읽기 = 로그인 사용자 · 쓰기/시험 = **승인 사용자**(`WorkspaceService.isApproved`, 시크릿과 같은 게이트) ·
  승인/반려 = **관리자**(`isAdmin`). 게스트 모드(`guest-enabled`)의 게스트는 읽기만.
- 테넌트: 행은 `tenant_id` 를 가지지만 레지스트리는 전 테넌트 승인본을 한 맵에 올린다(`plugin_id` 충돌은 나중 로드가 덮는
  JAR 관례와 동일). `ponytail:` 실사용은 단일 테넌트 — 테넌트별 레지스트리는 필요해질 때.

## 5. API

```
GET    /api/v1/plugins/api                      fl 매니페스트 (public — 편집기·MCP)
GET    /api/v1/plugins/scripts                  목록 {id, pluginId, name, kind, status, live: bool, usages: n, updatedAt, submittedBy}
GET    /api/v1/plugins/scripts/{id}             상세 (+source, liveSource, sample, reviewNote)
POST   /api/v1/plugins/scripts                  {name, source} → 컴파일 → 생성(DRAFT)            승인 사용자
PUT    /api/v1/plugins/scripts/{id}             {name?, source} → 컴파일 → 초안 갱신                승인 사용자
POST   /api/v1/plugins/scripts/try              {source, inputs?, config?, value?, direction?, bytes?} → 샌드박스 1회 실행
                                                → {meta, outputs|result, log[], durationMs} 또는 400 ScriptError   승인 사용자
POST   /api/v1/plugins/scripts/{id}/submit      DRAFT/REJECTED → PENDING (+sample 저장)             승인 사용자
POST   /api/v1/plugins/scripts/{id}/withdraw    PENDING → DRAFT                                       작성자
POST   /api/v1/plugins/scripts/{id}/approve     PENDING → APPROVED (live := source) + reload         관리자
POST   /api/v1/plugins/scripts/{id}/reject      {note} PENDING → REJECTED                             관리자
DELETE /api/v1/plugins/scripts/{id}             usages == 0 일 때만 + reload                          작성자·관리자
```
- `try` 는 `kind` 를 컴파일 결과로 판별해 transform 이면 `apply(inputs, config)`, fieldCodec 이면 `encode|decode(value, ctx)`,
  messageCodec 이면 bytes(base64 in/out). 컴파일만 원하면 입력 없이 호출 → `meta` 만 온다(편집기가 폼을 그리는 데 사용).
- `/admin/me` 응답에 `pendingPlugins` 카운트 추가(네비 배지 합산). 관리 콘솔용 목록은 위 `GET …/scripts?status=PENDING` 재사용.
- **제거**: `POST /api/v1/plugins`(JAR 업로드). `GET /api/v1/plugins` 는 남기되 jar-enabled 일 때만 파일명 반환.
- 기존 `GET /transforms`·`/codecs`·`/transforms/{id}/preview` 는 승인본만 보인다(레지스트리 경유) — 무변경.

레지스트리(`TransformRegistry.reload()`): `jar-enabled` 면 JAR 스캔 + **`ScriptPluginRepository.findAllApproved()` 를
컴파일해 어댑터로 등록**. 컴파일 실패 행은 WARN 로그 + 건너뜀(한 행이 전체를 못 죽인다 — JAR 도 같은 원칙으로 JAR 별 try 로 고친다).

## 6. 사용처(usages)

`plugin_id` 를 참조하는 곳: 워크플로 그래프의 `transformId`, Mock spec 의 `codec.request[].id/response[].id`(서버·라우트),
프로토콜 spec 의 `plugin.id`. 기존 `MockServerService.usageIndex()`(테넌트 30초 캐시, 문자열 스캔) 방식으로
`PluginUsageIndex` 를 만들어 `{pluginId → [{kind:'flow'|'mock'|'protocol', id, name}]}` 를 준다. 목록의 `usages` 카운트,
편집기 "사용처 N" 칩(클릭 = 목록 팝오버, 항목 클릭 = 해당 화면), 삭제 가드, 승인 화면 경고("승인하면 서빙 중인 Mock 3개에
즉시 반영")에 쓴다.

## 7. 편집기 (`/plugins`)

네비 "플러그인"(◇) → 페이지 = **좌 목록 | 우 편집기**(Mock 편집기 골격 재사용).

- **목록**: 검색(`/`), 상태 필(초안/승인 대기/승인됨/반려), kind 태그, 사용처 N, "승인본과 다름" 점(수정 중), `+ 새 플러그인` →
  **템플릿 3종**(변환 / 필드 코덱 / 전문 코덱) 중 택 — 골격이 채워진 채 열림.
- **편집기**: 기존 `CodeEditor` 에 `'javascript'` 언어 추가(`@codemirror/lang-javascript` 신규, 나머지 CodeMirror 스택 재사용).
  - 하이라이트·접기·줄번호·다크 · **정렬** Shift-Alt-F(`js-beautify` 의 `js` — 이미 설치, 추가 비용 0).
  - **자동완성**: `fl.` → 매니페스트(네임스페이스 → 함수, 툴팁에 시그니처·설명·예시). `inputs.`/`config.`/`ctx.` → 위에 선언한
    `inputs[].key`/`params[].key`/ctx 필드 제안(문서를 가볍게 파싱 — 정규식으로 충분).
  - **오류**: 클라이언트 즉시(lezer JS 파스 오류 → 거터 ⚠, 기존 HTML/XML 과 같은 `treeLinter`) + 서버 `ScriptError`
    (저장·실행 시, `line/col` → 같은 거터에 빨간 마커 + 상단 한 줄).
  - Ctrl+S 저장 · Ctrl+Enter 실행 · 미저장 이탈 경고 · **승인본 보기** 탭(읽기 전용, 수정 중일 때 "변경 전/후" 나란히 — 줄 단위
    LCS 로 바뀐 줄 하이라이트, 라이브러리 없음 ~40줄).
- **오른쪽 실행 패널**(폭 380, 접기 가능): 저장/타이핑 멈춤(600ms) 시 `try`(입력 없이) → `meta` 로 **입력·파라미터 폼이 자동
  생성**(kind 에 따라 transform: inputs+params / fieldCodec: value+direction+params(+message 필드 JSON) / messageCodec: bytes 를
  텍스트+charset 또는 hex 로). ▶ 실행 → 출력(JSON 트리 — 기존 `JsonTree`)·`fl.log` 콘솔·소요 ms·오류. 샘플 값은
  플러그인별 localStorage(`fl:plugrun:{id}`) + 승인 요청 시 서버 `sample_json` 으로도 저장.
- **상태 바**: 상태 필 + 반려 메모, 버튼 = [저장] [승인 요청 / 철회] (관리자면 [승인] [반려] 도 여기서), [삭제](사용처 0).
- **진입 단축**: TRANSFORM 노드 속성의 플러그인 선택기, Mock 코덱 단계 위저드/◈ 팝오버 — 목록 끝에 "＋ 새 플러그인 만들기 →
  /plugins?new=transform|fieldCodec|messageCodec". 승인되면 선택기에 나타난다(승인 전엔 안 보임 — 안내 문구).
- **관리 콘솔**: 현황 카드 "플러그인 승인 요청 N" + 섹션(가입 신청 카드와 같은 톤): 이름·kind·제출자·시각·사용처 경고,
  펼치면 **변경 전/후** + **샘플 실행 결과**, [승인]/[반려(메모)] `ConfirmChip`. 승인/반려 토스트.

## 8. JAR 격하

- `flowlink.plugins.jar-enabled`(env `FLOWLINK_PLUGINS_JAR_ENABLED`, 기본 `false`). 켜졌을 때만 `plugins/` 디렉터리 스캔.
- 꺼진 상태에서 디렉터리에 JAR 이 있으면 기동 시 WARN 한 줄로 파일명 나열("jar-enabled=false — 로드 안 함").
- `POST /api/v1/plugins` 업로드 엔드포인트 삭제, 프론트 업로드 버튼 삭제. `PluginController.list` 는 유지.
- `plugins/sample` 워크스페이스는 남긴다(예외 경로 — 외부 라이브러리가 진짜 필요한 경우). README 갱신은 이 브랜치의 문서
  정리 방침대로 하지 않는다.

## 9. 보안 정리

| 위협 | 대응 |
|---|---|
| 스크립트로 서버 장악 | 호스트 접근 없음(§3) — `fl` 프록시 외 JVM 도달 경로 없음 |
| 무한루프로 서빙 스레드 고갈 | CPU 시간·문장 수 상한, 호출당 컨텍스트 (⚠ 힙 상한은 없음 — Graal CE 한계, 승인 게이트로 보완) |
| 미승인 코드 실행 | `try` 는 샌드박스 안에서만, 승인 사용자만 호출, 결과는 호출자에게만 |
| 승인 우회 | 상태 전이는 서비스 레이어에서 `isAdmin` 검사(URL 규칙 아님 — github 모드 관례) |
| 시크릿 유출 | `try` 는 `{{ x@secret }}` 를 해석하지 않는다(리터럴 그대로) — 시크릿은 서빙 경로(Mock 템플릿/노드 바인딩)에서만 풀림 |
| 승인본 교체로 운영 Mock 오동작 | 승인 화면에 사용처 경고 + 샘플 결과 첨부, 반려/수정은 승인본 무영향 |

## 10. 검증

- 단위(`ScriptEngineTest`): `fl` 함수별(base64/hex/hash/hmac/aes 왕복/seed·aria 왕복/rsa 서명 검증/pad EUC-KR 바이트/mask/now) ·
  샌드박스(`Java`, `Polyglot`, `globalThis.java`, `import()` 접근 → ReferenceError/차단) · 타임아웃(`while(true)` → 2초 내 실패) ·
  컴파일 오류 줄 번호 · 메타 검증(id 형식, kind 별 필수 함수) · 어댑터(transform 출력 타입 코어션, fieldCodec ctx 전달,
  messageCodec bytes 왕복).
- 통합(`@SpringBootTest` `ScriptPluginLifecycleTest`): 초안 저장(컴파일 실패 400) → 승인 요청 → 관리자 승인 → `GET /transforms`
  에 등장 · 비관리자 승인 403 · 수정 후 반려해도 승인본 서빙 유지 · 사용처 있으면 삭제 400 · 게스트 쓰기 403.
- `try` API: transform/fieldCodec/messageCodec 각 1회 + 로그 수집 + 오류 줄 번호.
- 브라우저(Playwright 헤드리스, 격리 인스턴스): 템플릿으로 생성 → `fl.` 자동완성 → 오류 거터 → 실행 패널 폼 자동 생성 →
  ▶ 실행 결과 → 승인 요청 → 관리 콘솔 승인 → Mock 코덱 단계에서 선택 → 서빙 응답에 반영 → 사용처 1 → 삭제 거부.
- 무회귀: 기존 `:test` 전종 + `plugins/sample` JAR 을 `jar-enabled=true` 로 로드.

## 미루는 것

AI 로 초안 생성(어시스턴트 프롬프트) · MCP `plugin_upsert`(승인 큐로 들어가면 자연스러움 — 다음 단계) · 워크스페이스
export 에 스크립트 포함 · 버전 이력 · 컨텍스트 풀 · 테넌트별 레지스트리.
