# 설계: 처음 쓰는 사람도 TCP 전문 요청·Mock 을 만들 수 있게 — 레이아웃 텍스트 계약 · 거울 생성 · 바이트 자 · [필드|텍스트] 전면 적용

**상태: 설계만(미구현).** 2026-09-11. 사용자 요청 원문:

> "TCP mock 이나, 워크플로우에서 요청하는거 짜는게 너무 힘들거든? 뭐가뭔지도 감도 안잡힐거같아 처음 짜는 사람은. 이거에 대한 파훼법이나 묘수를 에이전트 나눠서 찾아보고 괜찮은 방법으로 진행해. 그리고 필드로보기/텍스트로보기 이런거 웬만하면 모든 요소요소들에 다 넣어주고, 바꿀 때마다 컨버팅해서 텍스트로 보여주고 필드로 보여주고, 이게 상호 호환이 되어야 해."

두 축으로 나눠 다뤘다.

- **(A) 파훼법** — 처음 쓰는 사람이 워크플로 TCP 노드·TCP Mock(그리고 HTTP)을 만들 때 "뭐가 뭔지 감이 안 잡히는" 원인을 없애는 것.
- **(B) [필드 | 텍스트] 전면 적용** — 구조화 편집 요소마다 보기 전환을 두고, 전환할 때마다 실제로 변환(양방향·무손실)해 보여주는 것.

조사 방법: 에이전트 워크플로 — 현황 6관점(TCP 노드 / TCP Mock / HTTP 대조군 / 토글 전수 인벤토리 / 빈 상태·AI / 도메인 실무) → 서로 다른 각도의 독립 설계안 6개 → 안마다 2렌즈 심사(초보자 효과 / 구현 적합성, 코드 대조 반박 포함). 종합 단계는 토큰 절약을 위해 사람이 직접 작성(이 문서). 코드 인용은 조사·심사 시점(커밋 `595c321`) 기준이며 줄 번호는 참고용.

---

## 1. 진단 — 감이 안 잡히는 근본 원인 5개

| # | 원인 | 증거 |
|---|---|---|
| 1 | **화면이 전문 어휘를 설명하지 않는다** — 길이 프리픽스·'프리픽스 포함 길이'·패딩 방향(→/←)·패딩 문자·바이트 길이·인코딩이 라벨과 `title` 툴팁뿐 | [PropertyPanel.tsx](../../../frontend/src/panels/PropertyPanel.tsx) TCP 블록(≈1362-1440), [MockTcpEditor.tsx](../../../frontend/src/components/MockTcpEditor.tsx) 힌트 한 줄(55-62). 팔레트 'TCP 전문' 항목에 설명 없음(nodeFactory PALETTE 에 description 필드 자체가 없음) |
| 2 | **손에 든 것을 붙여넣을 입구가 없다** — 실무자는 정의서 엑셀(순번/항목명/길이/타입 AN·N/기본값)과 샘플 전문(로그)을 들고 시작하는데, 노드·Mock 모두 행 단위 손입력뿐. 타입 열(N/AN)을 담을 자리가 없어 매 행 "타입→패딩 방향" 을 머릿속에서 번역 | `TcpReqEditor`(1948-1990)·`TcpRespEditor`(1993-2014)·`TcpLayoutPanel`(85-130)·`TcpRuleDetail`(133-266) 전부 `+ 필드` 버튼만. `bulkPaste.parseOutputKeys` 는 HTTP 출력 키에만 |
| 3 | **같은 전문을 두 번 적는다 + 기본값이 서로 안 맞는다** — 노드 요청필드 ≅ Mock 요청 레이아웃, 노드 응답필드 ≅ Mock 규칙 응답필드(거울상)인데 복사/생성/동기화가 0. 새 노드(127.0.0.1:9000 · msgType 4B · result 10B · 프리픽스 4)와 새 Mock 시드(9091~ · 전문코드4+계좌번호10 · 응답 4필드 36B)가 달라 "그냥 연결"하면 첫 실행부터 실패. 백엔드 프리픽스 기본값도 비대칭(노드 null→0 / Mock 4) | [nodeFactory.ts](../../../frontend/src/canvas/nodeFactory.ts) 48-56 vs [MockServerService.kt](../../../backend/src/main/kotlin/com/flowlink/mock/MockServerService.kt) `defaultTcpSpec`(≈445-451) |
| 4 | **피드백이 숨어 있고 사후적이다** — 🔍 전문 미리보기는 버튼(노드, 응답 칼럼)이거나 다른 탭(Mock 트래픽 패널)이라 편집과 분리. 응답 길이 합이 실제와 달라도 조용히 밀리고('선언 36B vs 수신 40B' 대조 없음), 응답 값은 패딩 포함 원문(`'000001500000'`, `'홍길동 '`)이라 다음 노드 조건식이 그대로 실패 | [TcpNodeExecutor.kt](../../../backend/src/main/kotlin/com/flowlink/execution/engine/TcpNodeExecutor.kt) 응답 슬라이싱(≈181-192) trim 없음, `TcpRespField` 에 pad/type 없음. 단일 실행은 **저장된 버전**을 실행(`ExecutionService.runSingleNode`)이라 편집 중 값은 저장 전엔 반영 안 됨 |
| 5 | **[필드|텍스트] 가 드물고, 있는 곳도 손실·파괴적** — 구조화 편집 요소 ≈45개 중 양방향 변환 토글은 4곳(HTTP 본문/쿼리/헤더, 폼 hidden 필드). 그 4곳도 `bound` 를 `isTokenizable` 가드 없이 문자열화, number/boolean+토큰이 Raw 에서 문자열이 돼 돌아옴. Mock TCP 응답의 [필드|텍스트] 는 **변환 없이** 필드를 비운다(`responseFields: []`). TCP 노드는 텍스트 보기 자체가 없음 | [PropertyPanel.tsx](../../../frontend/src/panels/PropertyPanel.tsx) `switchBodyMode/switchKvRaw/switchFormRaw`(≈485-536), [MockTcpEditor.tsx](../../../frontend/src/components/MockTcpEditor.tsx) `switchMode`(146-150) |

부수 사실(심사에서 확인): 프론트에 커밋된 테스트 러너/테스트 파일이 없다(`package.json` 에 test 스크립트 없음 — 지금까지의 "Node 타입스트리핑 단위테스트" 는 스크래치). 이번 작업의 순수 lib(문법·변환기)는 **리포에 남는 테스트**가 필요하다.

## 2. 설계안 6개와 심사 결과

| 각도 | 묘수 한 줄 | 평균 점수 | 심사가 살리라고 한 것(keep) | 심사가 반박한 것(refuted, 요지) |
|---|---|---|---|---|
| paste-first (정의서 붙여넣기) | 정의서 시트를 복사해 붙이면 패딩·바이트·오프셋이 자동으로 채워진 표가 되고, 같은 텍스트가 노드·Mock 양쪽에 붙는다 | 6.5 | 한 줄 DSL 4곳 공유 · 엑셀 TSV 헤더 매핑 · 타입 AN/N/X/9/PIC → 패딩 자동 번역 · 샘플 전문 대조 · 프리픽스 자릿수 감지 문구 | 필드명에 공백/`,`/`=`/`#` 이 올 수 있어 따옴표·이스케이프 없이는 왕복 무손실이 아님 · 테스트 러너 부재 · `previewTcp` 는 `@Transactional(readOnly)`(순수 계산이지만 DB 커넥션은 잡음) |
| one-definition (거울 생성) | `lib/tcpMirror.ts` 하나로 노드↔Mock 을 오가고 "이 Mock 을 부르는 노드 만들기 / 대상 Mock 만들기 / Mock 에서 가져오기" + 정합성 칩 | 7.0 | 순수 변환기+`mirrorDiff` · nodeFactory 기본값 = 백엔드 시드 · Mock 편집기 ▶ 노드 만들기 · 노드 패널 [Mock 에서 고르기] | fleet 감지는 `staleTime` 이 아니라 `refetchInterval` · 값 템플릿(`{{ x@set1 }}`)은 문자열 수준에서만 왕복 · 단일 실행은 저장본 실행 · 테스트 러너 부재 |
| guided (안내형+템플릿+룰러) | 템플릿 하나가 노드·Mock 양쪽의 "같은 전문"이 되고, 5단계 바로 한 단계씩, 매 키 입력마다 바이트 룰러 | 6.5 | 라이브 바이트 룰러 · 새 노드 기본값 = Mock 시드 · TCP Mock 첫 진입 = 시작하기 pane · 5단계 바(끄기 가능) | [Mock 에서 고르기]는 `mocksApi.list()`(단일 워크스페이스)가 아니라 `fleet()` · 규칙 하나만 실어도 `TcpMockEngine.preview` 는 매칭을 거침 · 스타일 상수는 module-local 이라 재사용 불가 |
| live-decoder (받은 전문부터) | `POST /api/v1/tcp/decode`(텍스트/HEX + 레이아웃 → 슬라이스) + `TcpByteRuler` 를 4곳에 항상 켜 두고 "[+ 남은 바이트 → 필드]" 로 실물을 깎아 정의 | 6.5 | 순수 decode 엔드포인트 · 단일 실행 응답을 디코더에 자동 투입 · 남은 바이트→필드 · 한글 경계 절단 ⚠ | 멀티바이트 셀 결합에 필요한 문자별 바이트 폭이 기존 `TcpPreview` 에 없음(DTO 확장 필요) · `lastRunQ` 는 모달에서만 활성 |
| ai-extract (AI 구조화 추출) | LLM 에게 "정의서를 필드 배열로 읽어 달라"(고정 스키마) → 서버가 바이트 검산 → 노드/Mock 적용 | 5.5 | 서버 검산 스트립 · ⚠미확정 행 + 사유 · 타입 토큰→패딩 번역 규칙 · 규약 문장→charset/prefix | stub 이 assistant 경로에 있어 github 모드에선 로그인·승인 없이는 못 씀(키 없이 완결이 아님) · 노드·Mock 을 각각 추출하면 불일치 재발 |
| text-everywhere (모든 요소 토글) | `TextForm<T>` 계약(toText/fromText+줄 단위 경고) + 공용 `FieldTextToggle` + 고정길이 DSL 4곳 공유 | 6.0 | `TextForm` 계약 · DSL 4곳 공유 · Mock TCP 응답 [필드|텍스트|템플릿(고급)] 3모드 · urlencoded percent 대칭화 | JSON bare 토큰은 정규식이 아니라 문자열 상태를 추적하는 스캐너로 · 응답 필드 문제는 백엔드 없이 안 풀림(trim) · 시드 값은 dot 문법 `{{req.계좌번호}}` |

점수는 5.5~7.0 으로 촘촘하다 — 한 안을 고르는 문제가 아니라 **각 안의 핵심을 한 패키지로 접붙이는** 문제라는 뜻이다. 심사관들이 독립적으로 같은 요구를 했다: (1) 문법은 결정론적 프론트 순수 lib 로, LLM 은 보강일 뿐 (2) 노드↔Mock 가져오기 없이는 초보자 손입력이 그대로 남는다 (3) 응답 값 trim 없이는 "첫 성공"이 안 난다 (4) 테스트를 리포에 남겨라.

## 3. 권고 패키지

### P1. 레이아웃 텍스트 계약 — 고정길이 전문 DSL 하나를 4곳이 공유 + 정의서 붙여넣기 (축 A·B 의 공통 뼈대)

- **무엇**: 순수 `frontend/src/lib/textForms.ts` 에 `TextForm<T> { id, label, placeholder, language?, toText(rows), fromText(text, prev) → { rows, warnings } | null }` 계약을 두고, 고정길이 전문 폼 `tcp` 를 **TCP 노드 요청/응답 · Mock 요청 레이아웃/응답 필드 4곳**이 공유한다. 공용 `components/FieldTextToggle.tsx`([필드 | 텍스트] 세그먼트 + textarea/CodeEditor + 라이브 요약 + 경고 줄)가 기존 필드 UI 를 children 으로 감싼다.
- **왜**: 정의서 → 텍스트 한 번 붙여넣기 = 필드 표. 같은 텍스트를 노드↔Mock 사이에 Ctrl+C/V. 타입 열(N/AN)을 DSL 이 직접 받아 패딩 번역을 없앤다.
- **초보자 전/후**: (전) 정의서 행마다 `+ 필드` → 이름 → 길이 → →/← → 패딩문자 (행당 5조작 × N행 × 노드·Mock 2회). (후) 엑셀에서 항목명·길이·타입 열을 복사 → 📋 붙여넣기 → 표 확인(총 바이트·샘플 대조 ✓) → 적용. Mock 에서 만든 것을 ⧉ 텍스트 복사 → 노드 📋.
- **문법(확정안, 심사 반박 반영)** — 한 줄 = 한 필드, 공백/탭/`,`/`|` 구분(엑셀 TSV 그대로):

  ```
  layout   ::= (line NL)*
  line     ::= blank | '#' comment | sep-row(마크다운 ---) | header-row | field
  field    ::= [seq SEP] name SEP length (SEP attr)* [ WS '=' WS value ]
  name     ::= bare | '"' quoted '"'          ; 공백·,·|·=·# 이 들어가면 toText 가 따옴표로 감싼다
  length   ::= DIGIT+ | pic                   ; pic = X(n) | 9(n) | S9(n)V9(m) | PIC X(n)  → 길이 합
  attr     ::= kind | padspec | enc
  kind     ::= 문자|숫자|한글|AN|X|A|C|K|N|9|S9  ; N/9/숫자 → pad=left,'0'  나머지 → right,' '
  padspec  ::= ('L'|'R') padchar               ; 명시 패딩. padchar 는 1문자, '_'=공백, '\,' '\#' 이스케이프
  enc      ::= EUC-KR|MS949|UTF-8|US-ASCII
  value    ::= 첫 '=' 이후 줄 끝까지(양끝 공백 제거). {{ 토큰 }} 그대로. 앞뒤 공백/개행이 필요하면 "…"
  ```
  예: `전문코드 4 문자 = 0200` / `계좌번호 12 숫자 = {{ acct@set1 }}` / `"송신 기관코드" 8 AN` / `잔액 15 L0 EUC-KR = {{ amt@prev }}` / `고객명 X(10)`.
  헤더 줄(항목명/길이/타입/기본값 …)이 있으면 열 매핑 모드, 순번 열은 버린다.
  **왕복 규칙**: `fromText(toText(rows)).rows ≡ rows`(id 제외) 를 모든 폼의 속성 테스트로 고정. 줄 단위 문법은 절대 전체 실패(null)를 내지 않고 실패 줄을 `warnings` 로 보고(그 줄은 텍스트에 남고 모델에서 빠짐). `prev` 로 id 승계(React key·TokenInput 안정)·토큰화 불가 `bound` 보존·마스킹 센티널 복원.
- **샘플 전문 대조**: 붙여넣기 다이얼로그에 "샘플 전문(선택)" 한 줄 → 기존 `POST /api/v1/mock-servers/tcp-preview` 에 일회용 spec(charset·prefix·requestFields)을 실어 레이아웃대로 잘라 표에 샘플 값 열 표시 + `샘플 MB = 레이아웃 NB ✓/✗(남는 KB)` + 프리픽스 자릿수 감지 문구('앞 4자리 0014 = 본문 14B → 자기 미포함'). 이 문구가 곧 프리픽스 개념 교육이다.
- **데이터 모델**: 없음. 텍스트 보기는 뷰(로컬 상태). `TcpField/TcpRespField/MockTcpReqField/MockTcpRespField` 의 `encoding` 은 이미 있는 필드(UI 노출만 추가). 값 없는 폼(노드 응답·Mock 레이아웃)은 `= 값` 을 무시하되 경고.
- **백엔드**: 없음.
- **재사용**: `bodyConvert.ts`(kv/헤더/JSON 코어), `bulkPaste.ts`(parseDotEnv/parseOutputKeys/duplicateKeys 골격), `TcpBytes`/`TcpMockEngine.preview`(바이트 검산), `TokenInput`(값 칩), `CodeEditor`(`{{` 자동완성·미리보기 재사용).
- **기존 4토글 손실 수정(같은 계약으로 이관)**: `bound` 는 `isTokenizable` 가드(불가면 전환 거부+경고) · JSON number/boolean+토큰은 따옴표 없이 직렬화하고 되돌릴 때 `prev` 의 타입 승계(bare 토큰 파싱은 **문자열 상태를 추적하는 스캐너** — `codeFormat.protectTokens` 는 문자열 안 토큰을 구분 못 함) · urlencoded 값 percent 인코딩/디코딩 대칭 · 헤더 파싱 실패는 콜론 없는 줄만 경고(부분 허용).
- **Mock TCP 응답 파괴적 토글 대체**: [필드 | 텍스트 | 템플릿(고급)] 3모드 — '텍스트' = DSL(무손실), '템플릿' = 현행 평문 템플릿(`0000{{req.계좌번호}}` — responseFields 없음, 명시적 고급 모드). 필드→템플릿 전환은 확인 다이얼로그.
- **테스트**: **vitest 도입**(`frontend/package.json` `test` 스크립트) — `textForms` 폼별 왕복 속성 테스트·헤더 매핑·PIC·따옴표/이스케이프·실패 줄 경고. 브라우저 e2e(Playwright, 스크래치 관례)로 붙여넣기→표→적용→저장→서빙.
- **규모**: M~L(신규 lib 1 + 컴포넌트 1 + 다이얼로그 1, 편집기 4곳 + 기존 토글 4곳 수정).

### P2. 거울 생성 — 한 번 정의, 양쪽 생성 (노드 ⇄ Mock)

- **무엇**: 순수 `lib/tcpMirror.ts` — `nodeToMockTcp(node)`(**노드 요청필드 → Mock 요청 레이아웃**(이름·길이·인코딩), **노드 응답필드 → Mock 규칙 응답필드**(이름·길이, 값은 비움)), `mockTcpToNode(spec.tcp, rule)`(역방향), `mirrorDiff(node, spec.tcp)`(포트·인코딩·프리픽스/포함·요청 길이 합·응답 필드별 길이). 버튼: Mock 편집기 헤더 **▶ 이 Mock 을 부르는 TCP 노드 만들기**(새 워크플로 생성 또는 노드 클립보드 `fl:node-clipboard` 에 넣고 "에디터에서 Ctrl+V" 안내), 노드 패널 **[Mock 에서 고르기 ▾]**(fleet 기반 — 모든 워크스페이스 TCP Mock, `listening/listenError` 표시, readable 만 선택) / **대상 Mock 만들기**(`mocksApi.create` + `updateSpec`, FlowDetail.workspaceId) / 정합성 칩(✓ 일치 · ⚠ 불일치 N ▾ 항목별 [Mock 값으로]).
- **왜**: 초보자는 한 화면(Mock 편집기)만 배우면 노드는 생성된다. "반대편에 이미 적힌 것을 옮겨 적는" 12개 조작이 사라지고, 포트/인코딩/프리픽스 불일치라는 첫 실패 원인이 칩으로 보인다.
- **기본값 정합**: `nodeFactory.makeNode('tcp')` 를 백엔드 `defaultTcpSpec` 과 **바이트 단위 같은 전문**(전문코드4+계좌번호10 / 응답 4필드, 포트 9091, 프리픽스 4·미포함, EUC-KR)으로 맞추고 단위테스트로 고정. 백엔드 노드 프리픽스 기본값(null→0)은 그대로 두되 프론트가 항상 명시.
- **데이터 모델/백엔드**: 없음(API 전부 존재: `/mock-servers`, `/spec`, `/fleet`, `/flows`, `/versions`). 교환 포맷은 저장 안 되는 클립보드 JSON `{kind:"flowlink-tcp-layout",version:1,side,encoding,prefixLength,prefixIncludesSelf,port,fields:[{name,length,pad?,padChar?,encoding?,value?}]}`(P1 의 DSL 텍스트와 1:1 — 클립보드에는 둘 다 실어 어디에 붙여도 되게).
- **주의(심사)**: fleet 감지는 `refetchInterval`(5초)로. 값 템플릿은 문자열로만 왕복(노드 `{{ x@set1 }}` 은 Mock 에서 의미 없음 → 생성 시 값은 비우고 경고). SSRF: 생성 노드 host 가 localhost 인데 oracle 프로파일은 allow-loopback 기본 true 라 무해, 외부 호스트는 미감지(오탐 없음).
- **테스트**: `tcpMirror` 왕복/diff 단위(vitest) + e2e(Mock → 노드 생성 → 저장 → ▶ 단일 실행 → 응답 4필드).
- **규모**: M.

### P3. 항상 켜진 바이트 자(ruler) + 응답 디코더

- **무엇**: 신규 순수 `POST /api/v1/tcp/decode { text? | hex?, charset, prefixLength, prefixIncludesSelf, fields:[{name,length}] } → { hex, totalBytes, fields:[{name,offset,length,text,charBytes[],truncated,padded,broken}], remaining, prefixVerdict }`(`TcpBytes.parseHex` 신설, `charBytes` 로 EUC-KR 2바이트 셀 결합 — 기존 `TcpPreview.Field` 에도 같은 필드 추가). `components/TcpByteRuler.tsx`: 바이트 셀을 필드 색띠로, 프리픽스 점선 셀, 남은 바이트 회색 `남은 NB`, 한글 경계 절단 빨강 `⚠`, 필드 행 focus ↔ 세그먼트 양방향 글로우. 노드 요청 필드 아래 **항상 켜짐**(🔍 버튼 제거, 300ms 디바운스 `tcp-preview`), 노드 응답 필드 아래 디코더(단일 실행/지난 실행 `responseText` 자동 투입 + [텍스트|HEX] 붙여넣기 + **[+ 남은 바이트 → 필드]**), Mock 요청 레이아웃·규칙 응답에도 같은 스트립(트래픽 TCP 기록 행 → [레이아웃 초안]/[규칙 초안]).
- **왜**: "정의를 먼저 쓰는" 대신 "실물을 넣고 맞춰가는" 경로. 응답 오프셋 누적 오류(원인 4)가 색띠 하나로 보인다. `선언 36B vs 수신 40B` 경고를 실행 결과에도 표시.
- **주의(심사)**: 실행 로그/journal 의 텍스트는 printable(제어문자→'.')이라 STX/ETX 류는 HEX 모드 안내. `lastRunQ` 는 도킹 패널에서도 활성화(현재 모달 전용).
- **백엔드**: `common/tcp/TcpDecoder.kt`(순수) + 컨트롤러 1 + `TcpBytes.parseHex/charSpans` + 단위 5종. 기존 `tcp-preview` 두 곳 DTO 확장.
- **규모**: M.

### P4. 응답 필드 후처리 — trim/타입 (첫 성공의 전제)

- **무엇**: `TcpRespField` 에 `trim: Boolean?`(기본 **새 노드 true**, 기존 그래프 null→false 로 무회귀) + `type: 'string'|'number'?` 추가. `TcpNodeExecutor` 응답 슬라이싱에서 trim(문자=후행 공백, 숫자=선행 0 제거) → number 면 숫자 원형(`resolveLiteral` 규약과 동일하게 조건식 숫자 비교 동작). DSL 의 kind(N/AN)가 이 값을 채운다(`잔액 12 숫자` → left '0' + trim + number).
- **왜**: 심사 3건이 독립적으로 "trim 없이는 다음 노드 조건식이 실패해 첫 성공이 안 난다" 고 지적. Mock 쪽 `TcpMockEngine.condPass` 는 이미 trim 후 비교라 비대칭이었다.
- **백엔드**: `GraphNode`/`TcpRespField` 필드 2개, `TcpNodeExecutor` 5줄, 단위 3종(문자/숫자/미지정 무회귀). 프론트 `TcpRespEditor` 에 trim 체크·타입 select(DSL 과 동기).
- **규모**: S.

### P5. 안내 — 5단계 바 · 용어 팝오버 · 첫 화면

- TCP 노드 속성·TCP Mock 편집기 상단 **5단계 바**(① 연결 ② 규약 ③ 요청 ④ 응답 ⑤ 시험, ✓/!/○, 클릭=그 섹션만 펼침, [도우미 끄기] localStorage) — 기존 섹션 컴포넌트를 그대로 쓰고 펼침 상태만 조정.
- 용어마다 **ⓘ 팝오버**(프리픽스·자기 포함·패딩·바이트·인코딩 — 각 2문장 + 규약 미니 예시 `0014|0200 1234567890`).
- **TCP Mock 첫 진입 = '시작하기' pane**(현재 규칙 1 상세, `MockServerEditor.tsx` ≈99-101) — 연결→레이아웃→규칙 순으로 안내 타일(기존 overview 타일 스타일). 팔레트 'TCP 전문' 항목에 설명("고정길이 전문을 소켓으로 보내고 응답을 잘라 씁니다").
- 새 HTTP 노드의 가짜 예시값(`https://api.example.com` + `/resource`, 출력키 data·id)은 **placeholder 로 강등**(대조군 조사에서 발견 — 초보자가 '지워야 할 값'과 '채울 값'을 구분 못 함).
- **규모**: S~M, 백엔드 없음.

### P6(선택). AI 추출 — 자유 서식 정의서만 LLM 으로

- P1 의 결정론 파서가 못 읽는 자유 서식(문장형 규약서, 스캔 표)일 때만 ✨ AI 에 "레이아웃 추출" 모드: 고정 스키마 출력(`{layout:{charset,prefixLength,prefixIncludesSelf,request:[…],response:[…]}}`, `parseModelJson(payloadKey="layout")` 재사용) → **결과를 P1 의 DSL 텍스트로 변환해 같은 붙여넣기 다이얼로그에 넣는다**(검산·적용 경로 공유, 노드·Mock 불일치 재발 방지). 키 없으면 버튼 자체를 숨김(stub 없음 — 심사: assistant 경로는 로그인·승인 게이트라 "키 없이 완결" 주장 불성립).
- **규모**: M(백엔드 프롬프트+서비스+검산, 프론트 버튼 1). 3차.

### 횡단 — 단일 실행이 저장본을 실행하는 문제

`▶ 이 노드만 실행` 은 `currentVersion` 그래프를 실행한다. 위 흐름(붙여넣기 → 바로 실행)이 "저장 안 한 값은 반영 안 됨" 으로 첫 시도에서 깨지므로, **실행 전 dirty 면 자동 저장(확인 토스트)** 또는 `POST …/nodes/{id}/run` 에 편집 중 노드 본문 실어 보내기(`tcp-preview` 와 같은 override 규약) 중 하나를 P2 와 같은 배치에 넣는다. 권장: 후자(저장 부작용 없음).

## 4. [필드 | 텍스트] 텍스트 문법 확정안 (축 B — 인벤토리 전부)

원칙: (1) 요소마다 **자연스러운 텍스트 표현** 하나(사람이 이미 다른 도구에서 쓰는 형태) (2) `TextForm` 계약으로 왕복 속성 테스트 (3) 파싱 실패는 줄 단위 경고, 텍스트는 보존 (4) 전환 시 실제 변환 — 텍스트 편집은 300ms 디바운스로 필드에 반영(현행 EnvManager 와 동일), 필드 편집은 즉시 텍스트 재생성.

| 요소 | 텍스트 폼 | 예시 | 왕복/손실 메모 | 단계 |
|---|---|---|---|---|
| TCP 노드 요청 필드 · Mock 규칙 응답 필드 | `tcp`(값 있음) | `계좌번호 12 숫자 = {{ acct@set1 }}` | 무손실(이름 따옴표·padChar 이스케이프) | 1차 |
| TCP 노드 응답 필드 · Mock 요청 레이아웃 | `tcp`(값 없음) | `고객명 10 문자 EUC-KR` | 무손실. `= 값` 은 경고 후 무시. outputs 이름 재동기화 유지 | 1차 |
| HTTP 본문(json/urlencoded/form) | 현행 Raw + 손실 수정 | `{"amount": {{ amt@prev }}}` | bare 토큰 스캐너·타입 승계·bound 가드 | 1차 |
| HTTP 쿼리 · 폼 hidden 필드 | `kv-url` | `a=1&b={{ x@n1 }}` | percent 대칭화, 중복 키 보존 | 1차 |
| HTTP 헤더 · Mock 응답 헤더 · 코덱 시험 헤더 | `headers` | `X-Api-Key: {{ key@secret }}` | `headersToRaw/rawToHeaders` 재사용, 콜론 없는 줄만 경고 | 1차/2차 |
| 환경 변수 · 실행 입력값 · 이전 노드 값 · transform 입력/파라미터 · Mock 예상 본문/쿼리 | `kv`(.env) | `apiKey=abc` / `[파라미터]` 섹션 | 한글 키 허용으로 파서 완화, 따옴표 벗기기 규칙 명시. 예상 본문은 샘플 JSON 도 허용(점 경로 평탄화+타입 추론) | 2차 |
| SET 변수 | `kv` + 시크릿 마커 | `secret token={{ TOKEN@secret }}` | 시크릿 값은 `••••••` 센티널로 직렬화, `prev` 로 복원(값 유출 없음) | 2차 |
| 출력 키 · 입력(input) 필드 | `key:type [라벨]` | `amount:number` / `otp:number 인증번호` | 📋 여러 키 추가(parseOutputKeys)를 이 폼으로 흡수 | 2차 |
| 스위치 트랙 | `*id: 라벨` | `*1: Mock 전문` | id 변경은 엣지 fromPort 와 연결 — 삭제 줄은 엣지 제거 확인 | 3차 |
| Mock HTTP 규칙 조건 · Mock TCP 규칙 조건 | `cond` | `body.orderId eq A1` / `계좌번호 startswith 110` / `contains BAL1` | 무손실. 미지 op 는 경고 | 2차 |
| Mock setState | `state` | `cnt += 1` / `status = approved` | 무손실 | 2차 |
| Mock HTTP 규칙 전체 | `HTTP 200 json UTF-8` 첫 줄 + `delay 300` + 헤더 + 빈 줄 + 본문 | HTTP 응답 메시지 형태 | 콜백은 별도 섹션 `[callback POST url]`. 본문은 BigTextEditor 그대로 | 3차 |
| 코덱 단계 | `step` | `request fields:card.no,pin aes-decrypt key={{ aesKey@secret }} iv=…` | 플러그인 id·config 키 검증(경고) | 3차 |
| 시크릿 볼트 | 등록 전용 `kv` | `[env:staging]` 섹션 + `API_TOKEN=abc` | 값 열람 불가라 **일방향**(문서화) | 3차 |
| Mock 정의 JSON 모달 · 워크플로 그래프 JSON 모달 | 편집 가능 JSON(CodeEditor) + [적용] | — | 저장 포맷 그대로(무손실). 적용 전 `validateMockSpecShape`/`graphValidate` | 2차 |
| Mock/워크스페이스 내보내기·가져오기 · cURL · OpenAPI | 현행 유지 | — | cURL 은 템플릿(의도된 손실) — `toCurl` 에 Params·타입 반영 손실 2건만 수정. OpenAPI→Mock 은 parameters/requestBody 를 expect 로 | 3차 |
| 트리거 목록 · 스칼라 설정 | 제안 없음 | — | 목록/표가 아님 | — |

## 5. 구현 단계

**1차 — 초보자 진입을 바꾸는 핵심(백엔드 최소)**
1. vitest 도입 + `lib/textForms.ts`(`tcp`·`kv-url`·`headers`·json 스캐너) + 왕복 속성 테스트.
2. `components/FieldTextToggle.tsx`(+`SegToggle` 추출) → TCP 4곳 + 기존 HTTP 4토글 이관(손실 수정) + Mock TCP 응답 3모드.
3. `components/TcpLayoutPaste.tsx`(📋 정의서 붙여넣기 / ⧉ 텍스트 복사, 샘플 대조 = `tcp-preview` 일회용 spec, 프리픽스 감지 문구) — 4곳 버튼.
4. `lib/tcpMirror.ts` + nodeFactory 기본값 = 백엔드 시드 + Mock 편집기 ▶ 노드 만들기 + 노드 [Mock 에서 고르기](fleet) / 대상 Mock 만들기 / 정합성 칩.
5. 단일 실행에 편집 중 노드 본문 override(백엔드 `runSingleNode` 파라미터 1개).
6. P4 trim/type(백엔드 소폭) — 1차에 포함(첫 성공 조건).
7. 가이드 03·10장 갱신, 브라우저 e2e(붙여넣기→표→적용→Mock→노드 생성→단일 실행 성공).

**2차 — 실물로 배우기 + 안내**
8. `POST /api/v1/tcp/decode` + `TcpByteRuler` + 항상 켜진 요청 자 + 응답 디코더([+ 남은 바이트 → 필드]) + 트래픽 TCP 행 초안 버튼 + 선언/수신 길이 경고.
9. 5단계 바 · ⓘ 팝오버 · TCP Mock 시작하기 pane · 팔레트 설명 · HTTP 예시값 placeholder 화.
10. 텍스트 폼 2차(kv/.env 계열·출력 키·조건·setState·JSON 모달 편집 가능).

**3차 — 나머지 인벤토리 + AI**
11. 규칙 전체·코덱 단계·스위치·시크릿 등록·cURL/OpenAPI 손실 수정.
12. P6 AI 추출(P1 다이얼로그로 합류).

## 6. 사용자가 정할 것(3개)

1. **DSL 표기** — 권고 `이름 길이 종류 [인코딩] [= 값]`(공백/탭 구분, 엑셀 TSV 그대로) vs 대안 `이름[길이,L0,EUC-KR] = 값`(대괄호). 둘 다 같은 파서로 받을 수 있지만 **직렬화(복사 결과)는 하나**여야 한다.
2. **응답 trim 기본값** — 새 노드만 true(기존 그래프 무회귀) 권고. 기존 그래프까지 true 로 바꾸면 패딩을 일부러 쓰던 조건식이 깨질 수 있음.
3. **AI 추출(P6) 포함 여부** — 3차로 두는 것을 권고(결정론 파서로 대부분 해결, Copilot 필요).

## 7. 부록 — 조사 산출물

워크플로 원본(현황 6 + 설계안 6 + 심사 12)은 세션 스크래치에만 있다(`wf-summary.md`). 문서에 넣지 않은 세부(각 안의 firstTimerStory 전/후 단계, 파일별 줄 번호, 심사 반박 전문)는 구현 착수 시 해당 안의 원문을 다시 참고한다 — 구현 계획(`docs/superpowers/plans/`)을 쓸 때 P1~P5 순서로 옮긴다.
