# FlowLink — 사용자 사용 관점 평가 (멀티에이전트)

> 사내 개발자/QA가 API 워크플로를 만들고 테스트·연동하는 **실사용 관점**에서, 서로 다른 에이전트가 독립적으로 판단·반박·개선안을 낸 뒤 종합한 문서. 각 항목은 실제 파일·기능 근거 기반.

생성: 2026-07-18 · 관점 4종(비판/긍정 + 각 반박) + 액션 4종(걷어내기/추가/합치기/나누기)

---

## 1. 비판적 판단 (사용자 관점)

> FlowLink는 노드 기반 API 워크플로 편집·실행과 내장 Mock, 협업 프레즌스, OIDC/RBAC, 내구 비동기 실행까지 놀랄 만큼 넓은 기능을 갖췄고 세부 UX(토큰 칩, 실행 애니메이션, cURL 붙여넣기, 폴더 탐색기)도 정성이 많이 들어갔다. 다만 '사내 개발자/QA가 실제 업무에 상시 투입'하는 관점에서 보면 결정적 마찰이 남아 있다. 자동 트리거(스케줄/웹훅)가 실동작하지 않아 사람이 에디터를 열고 눌러야만 도는 반자동 도구이고, HTTP 재시도/에러 정책·버전 롤백 UI·풍부한 실행 이력 검색 같은 '테스트 도구의 기본기'가 비어 있어 현실적인 신뢰성 시나리오와 사후 추적이 어렵다. 아키텍처는 단일 인스턴스·동기 블로킹 전제라 'SaaS' 표방과 달리 확장·HA가 막혀 있고, 무인증 콜백/mock과 무샌드박스 플러그인은 '사내망·비밀값' 전제에만 기대는 상시 리스크다. 무상태 mock과 last-write-wins 공동편집도 팀 사용에서 혼란을 만들 수 있다. 프로토타입에서 엔터프라이즈로 나아가는 야심과 완성도는 분명하나, 실사용 안착에는 자동화·재시도·이력·버저닝·확장성이라는 '지루한 기본기'의 보강이 먼저 필요하다.

### 1. 트리거가 사실상 MANUAL뿐 — 자동화·회귀 실행이 불가능  `[가중치 높음]`
TriggerType에 SCHEDULE/WEBHOOK/EVENT가 enum으로만 있고 실동작은 MANUAL 하나(CLAUDE.md·TriggerType.kt). 즉 '매일 밤 정기 회귀 테스트', '웹훅 오면 자동 실행' 같은 QA 자동화의 핵심 시나리오를 아예 못 만든다. 게다가 실행 드라이버가 브라우저 폴링 루프(Editor.tsx onRun의 while+GET /executions/{id})라, wait 콜백을 제외한 client/form/input 협업 노드는 탭을 닫으면 이어갈 수 없다. '워크플로 오케스트레이션'을 표방하지만 실제로는 사람이 에디터를 열고 ▶를 눌러야만 도는 도구에 가깝다.

### 2. HTTP 노드에 재시도·타임아웃 분기·에러 정책이 없음  `[가중치 높음]`
HttpNodeExecutor에 retry/backoff 개념이 전혀 없고, 첫 노드 실패 시 곧바로 실행 전체가 FAILED로 중단된다(FlowExecutor). 실제 사내 API는 5xx·일시 커넥션 오류·레이트리밋이 흔한데, QA가 '3회 재시도 후 실패 분기' 같은 현실적 시나리오를 구성할 방법이 없다. httpStatus를 assert로 검사하는 우회는 있으나 재시도 루프 자체가 그래프로 표현 불가(SWITCH는 수동 전환, IF는 단발 분기라 루프백이 어렵다). 신뢰성 테스트 도구로서 결정적 공백.

### 3. 실행 이력 조회가 빈약해 '어제 그 실패' 추적이 어렵다  `[가중치 높음]`
Executions 페이지는 runsApi.recent(50) 최근 50건(백엔드 clamp 최대 200)만 불러오고 페이지네이션이 없다. 필터는 클라이언트 측 상태 버튼 + 워크플로 이름 검색뿐 — 날짜 범위·노드명·트리거 조합 검색, 특정 기간 조회가 불가능하다. 실행량이 많은 팀에서 며칠 전 특정 실패 실행을 되짚기 사실상 불가. 대시보드의 '최근 실행'도 같은 recent(50) 한 번으로 전 카드를 커버(Dashboard.tsx L189)해, 워크플로가 많으면 오래된 워크플로 카드엔 최신 실행 상태가 아예 안 뜬다.

### 4. 단일 인스턴스 전제 — 'SaaS'라기엔 확장·HA가 없다  `[가중치 높음]`
워커 풀(pool-size=8)·suspension 인메모리 캐시·presence 방 상태·mock TCP 리스너·relay 수신이 전부 단일 JVM 스코프이고, CLAUDE.md도 '수평 확장(공유 큐)은 범위 밖'이라 명시. 실행이 동기 HTTP로 워커 스레드를 블로킹(CLAUDE.md '외부 HTTP에 호출 스레드 블로킹')하므로 느린 외부 API가 몇 개만 몰려도 풀 8개가 소진돼 429(TooManyRequests)로 거절된다. 팀 규모가 커지거나 무중단이 필요해지는 순간 구조적으로 막힌다.

### 5. 워크플로 버전 롤백·diff UI가 없다  `[가중치 높음]`
저장할 때마다 FlowVersion 불변 스냅샷이 쌓이고 카드에 v번호(flow.currentVersion)만 보이지만(Dashboard.tsx L593), 에디터/대시보드 어디에도 과거 버전을 열람·비교·복원하는 UI가 없다(client.ts에 saveVersion만, 버전 목록/롤백 호출 부재). 실수로 그래프를 망가뜨린 뒤 '전에 되던 버전으로 돌리기'가 앱 안에서 불가능하고, 내보내기 JSON 백업에 의존해야 한다. 여러 명이 같은 플로우를 만지는 팀에서 특히 위험.

### 6. HTTP 노드 설정의 옵션 폭발 = 높은 러닝커브  `[가중치 중간]`
PropertyPanel이 단일 1434줄 컴포넌트(CLAUDE.md가 리팩토링 후보로 명시)로, HTTP 노드 하나에 baseUrl/path 병합·params/headers/body 각각의 [필드↔Raw↔cURL] 전환·respType 7종(json/xml/urlencoded/form/query/text/binary)·charset 4종·reqMode(S→S/C→S)·필드 타입(string/number/boolean/json/array)이 얽혀 있다. 여기에 토큰 문법 {{key@node}}, 시드(putSeed), 구 bound 이관, keyed→text 전환 시 바인딩 끊김 경고 같은 개념까지 겹쳐, 처음 쓰는 QA가 '왜 내 바인딩이 비었지'를 스스로 진단하기 어렵다. 기능은 강력하지만 발견성이 낮다.

### 7. 실행 실패의 관측성이 얕다  `[가중치 중간]`
실행 상세 모달(Executions.tsx ExecutionDetailModal)은 노드별 requestText/responseText/output만 아코디언으로 보여준다 — 스택트레이스·재시도 이력·노드별 타이밍 시각화가 없다. 게다가 redaction이 deny-by-default라 운영 프로파일에선 요청/응답 본문이 저장되지 않아(capture.request-response-bodies 옵트인, h2 로컬만 true) '왜 실패했는지'를 사후에 재구성하기 어렵다. 디버깅이 목적인 도구인데 운영 환경 디버깅 정보가 기본적으로 비어 있는 역설.

### 8. 내장 Mock이 무상태라 현실적 시뮬레이션에 한계  `[가중치 중간]`
MockRuntime은 라우트 매칭+템플릿 렌더링만 하고 상태가 없다 — 서버별 {{seq}} 증가 카운터(MockGatewayController) 정도가 전부이며 재시작 시 리셋된다. CLAUDE.md도 '부분취소 잔액 원장 등은 범위 밖'이라 못박음. 그래서 '첫 호출은 승인, 재조회는 상태 변경', '부분 취소 후 잔액 반영' 같은 stateful 연동 테스트를 mock으로 못 세우고 별도 프로세스를 띄워야 한다. '미완성 시스템을 mock으로 세워 전체 흐름 검증'이라는 핵심 가치가 상태 있는 도메인에서 반감된다.

### 9. 콜백·mock 엔드포인트 무인증 — '사내망 전제'의 상시 리스크  `[가중치 중간]`
wait 콜백(/relay/{execId}/cb/{nodeId})과 mock 게이트웨이(/mock/{tenant}/{slug}/**)가 모두 permitAll 무인증이며 CORS 오픈이고, 보안은 'execId/slug가 추측 불가한 비밀값'과 '사내 테스트망'이라는 전제에만 의존한다(CLAUDE.md 여러 곳). presence 토큰도 쿼리스트링에 실려 액세스 로그에 남을 수 있다. 실수로 프록시·터널이 외부로 열리는 순간 콜백 위조·mock 남용 표면이 그대로 노출된다. 도구가 커지고 팀 밖으로 공유될수록 이 전제가 깨지기 쉽다.

### 10. 실시간 공동 편집이 last-write-wins — 조용한 덮어쓰기  `[가중치 중간]`
collab이 CRDT가 아니라 100ms throttle 전체 그래프 스냅샷 last-write-wins(lib/collab.ts, CLAUDE.md 명시). 두 사람이 거의 동시에 서로 다른 노드를 편집하면 마지막 스냅샷이 이겨 상대 편집이 조용히 사라질 수 있고, presence 방 상태는 서버 재시작 시 소실된다. 저장 시엔 낙관적 락 409 다이얼로그가 있지만, 편집 중 실시간 병합은 보호되지 않아 '분명히 고쳤는데 되돌아가 있다'는 혼란이 팀 사용에서 나올 수 있다.

### 11. 플러그인 JAR이 무샌드박스 전권 실행  `[가중치 낮음]`
업로드한 변환 플러그인 JAR이 전체 권한으로 실행된다(CLAUDE.md 알려진 한계). RBAC platform-admin 게이트가 업로드 권한은 막지만, 일단 올라간 JAR의 코드 실행 자체엔 격리가 없어 임의 파일·네트워크 접근이 가능하다. 사내 도구라도 신뢰 경계가 명확하지 않은 조직에서는 공급망/내부자 리스크가 크다.

### 12. 자동화된 회귀 안전망이 얇다  `[가중치 낮음]`
백엔드 단위 테스트 중심(핵심 순수 함수 위주)이고 프론트는 자동 테스트가 없이 수동/Playwright 스팟 검증에 의존한다(CLAUDE.md 테스트 현황). 실행 정확성의 핵심인 1434줄 PropertyPanel과 폴링 실행 루프처럼 상태가 얽힌 큰 컴포넌트가 자동 회귀로 덮여 있지 않아, 기능이 계속 추가되는 이 코드베이스 특성상 미묘한 바인딩/실행 회귀가 사용자에게 먼저 발견될 위험이 있다.

---

## 2. 긍정적 판단 (사용자 관점)

FlowLink는 "API 워크플로 빌더"와 "목(mock) 대상 시스템 빌더"를 한 프로세스에 합쳐, 미완성 연동 상대를 즉석에서 세우고 그에 대고 전체 흐름을 실행·검증하는 사이클을 한 화면에서 돌릴 수 있게 만든 도구다. 실제 코드를 열어 보면 마케팅용 데모 수준이 아니라, 비동기 워커 풀·DB 내구화·이중 재개 방지 CAS·SSRF 가드·RBAC/테넌시·실시간 협업까지 사내 SaaS로 운영할 것을 전제한 설계가 일관되게 관철돼 있고, 프론트 에디터도 토큰 바인딩·실행 애니메이션·수십 개의 생산성 단축키까지 완성도가 높다. Postman(컬렉션 실행+환경변수)이나 n8n(비주얼 자동화), Temporal(내구 실행 프레임워크)이 각각 잘하는 것을 한 제품 경계 안에서 "개발자가 만들고 QA가 테스트하는" 사내 워크플로 특화로 묶어낸 점이 두드러진다.

### [가중치 high] 워크플로와 Mock 대상 시스템이 한 도구·한 프로세스에 통합
사내 연동 개발의 실제 마찰은 "붙을 상대 시스템이 아직 없다"는 것인데, FlowLink는 목 서버를 별도 프로세스(WireMock/Mockoon)로 세울 필요 없이 1급 리소스로 흡수했다. `MockServerEditor.tsx`에서 경로·조건·응답 템플릿·콜백·charset·지연을 정의하고 저장하면 `MockGatewayController`가 `/mock/{tenant}/{slug}/**`로 즉시 서빙한다. `MockRuntime`은 `/users/{id}` 경로 파라미터 매칭, `eq/ne/exists/contains` 조건, `{{path.x}}/{{query.x}}/{{body.x}}/{{uuid}}/{{seq}}` 템플릿을 순수 함수로 처리하고, `MockCallbackDispatcher`가 지연 후 콜백까지 쏜다. 워크플로 HTTP 노드의 baseUrl에 그 목 URL을 넣으면 "만들다 만 결제창→콜백" 같은 흐름을 상대 시스템 없이 끝까지 검증할 수 있다. 이 "빌더+목이 서로를 바로 호출"하는 폐루프는 Postman/n8n에는 없는 명확한 차별점이다.

### [가중치 high] 서버 재시작을 견디는 내구 비동기 실행 — Temporal급 보장을 훨씬 낮은 진입장벽으로
`ExecutionService`는 `POST /runs`가 즉시 RUNNING을 반환하고 전용 워커 풀(`flowlink-exec`, 큐 포화 시 429)에서 노드를 돌린다. 중단(wait/form/input/client) 상태는 `RunStateSnapshot`으로 떠서 `execution_suspension` 테이블에 AES-GCM 암호화(`StateCrypto`)로 영속되고, 재개 경쟁(콜백·타임아웃·수동 resume·⏹)은 전부 `claim()`의 조건부 DELETE 영향행수 1=승자로 직렬화해 이중 재개를 원자적으로 막는다. `recoverOnStartup()`은 기동 시 wait 타임아웃을 재무장하고, suspension 없는 RUNNING/WAITING 고아는 FAILED로, 행은 있는데 RUNNING인 실행은 WAITING으로 화해시킨다. n8n/Postman이 진행 중 실행을 재시작에 잃는 반면, 여기선 탭을 닫거나 서버가 재기동돼도 콜백/타임아웃으로 실행이 완결된다.

### [가중치 high] 콜백 대기(wait) 노드 — 결제/인증 게이트웨이의 비동기 콜백을 브라우저 없이 완결
비동기 콜백은 연동 테스트에서 가장 다루기 까다로운 패턴인데, 이를 1급 노드로 만들었다. `FlowExecutor`가 실행 시작 시점에 모든 wait 노드의 수신 URL(`{relayBase}/relay/{execId}/cb/{nodeId}`)을 `ctx.putSeed`로 미리 시드해, wait보다 앞선 노드(returnUrl/notiUrl 필드)에서도 `{{ url@노드 }}`가 해석된다. 외부 게이트웨이가 그 URL로 콜백을 때리면 `RelayController`→`recordWaitCallback`이 백엔드에서 직접 수신·파싱(JSON→urlencoded→body 폴백)해 재개하고, 콜백 발신자에겐 노드에 설정된 ACK(text/html/json)를 돌려준다. QA가 브라우저를 켜 둘 필요 없이 서버가 대기를 구동한다.

### [가중치 medium] 그래프를 이해하는 토큰 바인딩 — 상위 노드 출력을 자동 발견해 칩으로 꽂기
`{{ key@nodeId }}` 문법을 프론트(`tokenGrammar.ts`)와 백엔드(`TokenResolver`)가 미러링하고, `binding/upstream.ts`가 선택 노드의 조상들을 역방향 BFS로 훑어 바인딩 가능한 항목(선언 출력, HTTP `httpStatus`, wait `url`/`body`, TCP 응답 필드, SET 변수, 요청 스코프 `req:`)을 자동 수집해 피커 칩으로 제시한다. Postman의 `{{var}}`가 전역/환경 변수에 그치는 것과 달리, 여기선 그래프 위상에 따라 "이 노드가 실제로 참조할 수 있는" 값만 소스별로 노출된다. 정확히 토큰 하나면 숫자/불리언/객체 원형을 보존(`resolveLiteral`)해 다운스트림 타입이 깨지지 않는다.

### [가중치 medium] 실행 경과 실시간 표시 + 실패 지점 자동 안내
`Editor.tsx`의 `onRun` 폴링 드라이버가 0.4초(대기 중 1초) 간격으로 실행 스냅샷을 받아 `computeRunView`로 노드 배지(✓/✕/⊘/스피너)와 엣지 애니메이션을 그린다. `RunPanel`은 실패 시 첫 실패 노드를 자동으로 펼쳐 긴 그래프에서 실패 지점을 손으로 찾을 필요를 없애고, 전체/성공/실패/건너뜀 필터, 요청/응답/출력 각각의 복사 버튼, 그리고 실행 로그 전체를 `.txt`로 내보내는 기능(회귀 비교·버그 리포트용)을 갖췄다.

### [가중치 high] 같은 워크플로를 여러 명이 동시에 — 실시간 커서·편집중 배지·공동 편집
`presence.ts`(모듈 싱글턴 WebSocket, 50ms 커서 쓰로틀, 2초 자동 재접속)와 별도 `presenceStore`(editorStore의 dirty/undo/selected를 절대 오염시키지 않는 분리 설계)로 원격 커서, 이름표, 편집중 노드 링, 아바타 스택, 저장 토스트를 구현했고, 그 위에 `collab.ts`로 그래프 스냅샷을 중계하는 실시간 공동 편집까지 얹었다. Postman 컬렉션 공유나 n8n 워크플로 편집은 이런 구글독스식 멀티플레이어를 제공하지 않는다.

### [가중치 medium] 한국 사내/레거시 연동 친화 — EUC-KR/MS949, 고정길이 전문(TCP), XML/urlencoded/query 응답
`HttpNodeExecutor`는 요청 인코딩·응답 디코딩을 노드별 charset(EUC-KR/MS949/US-ASCII)으로 처리하고, MS949는 JVM 정규명 대신 IANA명(`windows-949`)으로 보정(`wireCharset`)해 비JVM 레거시(IIS/.NET/PHP)와 호환시킨다. 길이 프리픽스 기반 고정길이 금융 전문을 다루는 TCP 노드와 그에 대응하는 TCP 목까지 있다. 국내 금융/공공 레거시 연동에서 Postman/n8n이 특히 약한 지점을 정면으로 겨냥한 실용 기능이다.

### [가중치 medium] 보안 기본값이 켜져 있는 사내 도구 — SSRF 가드·본문 redaction·RBAC·테넌시
서버사이드 HTTP/TCP 호출은 `SsrfGuard`가 스킴 화이트리스트 + 사설/루프백/링크로컬/CGNAT/IPv6 ULA 대역을 막는다. 실행 로그는 deny-by-default로 HTTP 요청/응답 본문을 옵트인 전엔 저장하지 않는다. `SecurityConfig`는 OIDC 모드에서 viewer(GET)/editor·admin(쓰기)/platform-admin(플러그인)로 URL RBAC를 걸되, 플러그인 규칙을 GET 블랭킷보다 위에 둬 매처 순서까지 신경 썼다. IdP 비종속이라는 점도 실무적이다.

### [가중치 medium] 배포·운영 마찰이 낮다 — 단일 jar, 무설정 로컬, 접속 오리진 자동 콜백
`npm run build`→`bootJar`면 프론트 dist가 jar에 동봉돼 내장 톰캣이 화면+API를 한 포트(:18080)로 서빙하고, OIDC는 issuer-uri 설정 시 자동 활성/미설정이면 dev permitAll이라 로컬은 제로 설정, 운영은 env 하나로 켜진다. `RelayBaseResolver`가 콜백 수신 주소를 화면 설정→env→접속 오리진 자동→localhost 순으로 해석해, env 없이 기동한 jar에서도 wait 콜백이 완결된다. Postgres/Oracle/H2 프로파일 + Docker Compose 스택까지 준비돼 있다.

### [가중치 medium] 성숙한 에디터 생산성 — 워크플로 간 복붙·검색·자동정렬·문제 배지·단일 노드 실행
undo/redo, A→B 워크플로 간 노드 복붙(토큰 sourceId 재매핑 포함), Ctrl+F 노드 검색, 자동 정렬, 자동 저장, 집중 모드, 캔버스 우클릭·엣지를 빈 곳에 놓아 노드 추가+자동 연결이 있다. 단축키는 한/영(IME) 전환 버그를 물리 키 `e.code` 기준으로 고쳤고, `IssueBadge`는 미연결·빈 필수값을 헤더에 모아 클릭하면 해당 노드로 점프한다. `▶ 이 노드만 실행`은 그래프 전체를 돌리지 않고 노드 하나를 즉석 검증하게 해준다.

### [가중치 low] 엣지 케이스 방어의 일관된 성숙도
`MockGatewayController`는 전체 try/catch로 어떤 예외도 500 JSON으로 마감하고, Spring FormContentFilter가 소진한 PUT/PATCH urlencoded 본문을 파라미터 맵에서 복원하며, 응답은 `maxResponseBytes`로 상한을 걸어 잘라 읽는다. 프론트 폴링 루프는 백엔드 재시작 같은 일시 장애를 연속 임계까지 견디고, 워커 예외는 `Throwable`로 잡아 플러그인 JAR의 Error에도 실행이 RUNNING으로 고착되지 않게 한다.

---

## 3. 비판에 대한 반박

> 위 §1 비판을 다른 에이전트가 검증·반박한 결과. 판정: 뒤집힘/약화됨/유지됨.

### 1. (트리거가 사실상 MANUAL뿐 — 자동화·회귀 실행이 불가능)  `[약화됨]`
핵심 사실은 맞지만 두 지점에서 과장이다. (1) 실행 진입점은 브라우저 전용이 아니라 REST(POST /flows/{id}/runs)다 — P2 내구 비동기화(2026-07-16)로 이 엔드포인트는 즉시 RUNNING을 반환하고 워커 풀에서 돌며, wait 콜백/타임아웃은 백엔드 스케줄러가 구동해 '탭을 닫아도 완결'된다(e2e에서 백엔드 3회 재시작에도 rehydrate 완주 검증). 따라서 사내 cron/CI가 이 POST를 때리면 '매일 밤 회귀 실행'은 지금도 스크립트로 가능하다 — 실제 demos/e2e가 headless로 그렇게 돈다. (2) '탭 닫으면 못 이어감'은 wait를 제외한 client/form/input에만 해당하는데, 이 세 노드는 본질적으로 브라우저 사용자 상호작용(직접 fetch·팝업·입력 모달)이라 사람이 없으면 애초에 의미가 없다 — 무인 자동화 경로는 server 모드 HTTP+wait 콜백으로 온전히 표현된다. 남는 진짜 공백은 '앱 내장 CRON 스케줄러 UI'뿐이며 이는 문서화된 Phase2 항목이다. 오케스트레이션 표방이 허위라는 결론은 과하다.

### 2. (HTTP 노드에 재시도·타임아웃 분기·에러 정책이 없음)  `[약화됨]`
타임아웃 없음은 사실오류다 — HttpClientConfig가 connect 5s·read 30s(ExecutionProperties.Http, 설정 가능)로 항상 걸리며, 무한 블로킹이 아니라 시한부 실패로 떨어진다. 또 httpStatus를 출력에 실어(2026-07-17) `{{httpStatus@노드}} != 500` assert로 에러 판정 시나리오를 구성할 수 있고, 단일 노드 즉석 실행으로 QA가 반복 재현도 한다. 다만 '3회 재시도 후 분기' 같은 루프백은 정당한 공백으로 인정 — 실행 그래프가 Kahn 위상정렬 기반 DAG라 사이클(재시도 루프)을 표현할 수 없다(SWITCH 수동·IF 단발). 이는 '내구 비동기 실행'이 우선 해소하려던 신뢰성 부채의 남은 절반이지 도구 전체의 결정적 공백은 아니다.

### 3. (실행 이력 조회가 빈약해 '어제 그 실패' 추적이 어렵다)  `[유지됨]`
코드로 확인된 정확한 지적이다 — Executions.tsx는 runsApi.recent(50) 단발, 페이지네이션·날짜범위·노드명 검색이 없고 필터는 클라 측 상태버튼+이름검색뿐이며, Dashboard도 같은 recent(50) 한 번으로 전 카드의 '최신 실행'을 커버(L189)해 실행량이 많으면 오래된 카드의 상태가 비게 된다. 사내 단일팀·최근성 위주 사용을 감안해도, '디버깅/QA 추적'을 표방하는 도구에서 특정 기간 실패를 되짚는 기본 경로가 없는 건 실질적 한계다. 완화 장치나 트레이드오프 정당화가 빈약하므로 유지.

### 4. (단일 인스턴스 전제 — 'SaaS'라기엔 확장·HA가 없다)  `[약화됨]`
구조적 한계는 맞으나 '동기 HTTP로 워커 소진→429'는 반쯤 오해다. wait/input/form/client 중단 지점에서 suspension이 DB로 내구화되며 워커 스레드를 즉시 반납하므로(P2), 오래 대기하는 실행이 풀 8개를 붙잡지 않는다 — 실제 HTTP 호출 순간만 스레드를 쓴다. 429는 버그가 아니라 의도된 백프레셔(큐 100 초과 시 명시적 거절)로, 무한 큐잉으로 조용히 지연되는 것보다 QA에 정직하다. 수평확장·HA 부재는 CLAUDE.md가 스스로 '범위 밖'으로 명시한 사내 팀 도구의 의식적 스코프이며, pool-size·queue-capacity는 설정으로 상향 가능하다. 팀이 커지면 막힌다는 방향성은 맞지만 현 사용 관점에서 '구조적으로 막혔다'는 과장이다.

### 5. (워크플로 버전 롤백·diff UI가 없다)  `[약화됨]`
앱 내 롤백/diff UI 부재는 사실(client.ts에 saveVersion만, 버전 목록/복원 호출 없음). 다만 '위험'의 강도는 완화된다 — FlowVersion이 저장마다 불변 스냅샷으로 서버에 축적돼 데이터 자체는 소실되지 않고, 워크플로 가져오기/내보내기(JSON)로 임의 시점 복원 경로가 실재하며, 동시 편집은 낙관적 락 409 다이얼로그가 덮어쓰기를 막는다. 즉 '전 버전으로 돌리기'가 불가능한 게 아니라 '두세 번 클릭의 in-app UX가 없다'는 편의 공백이다. 팀 위험은 인정되나 데이터 손실 불가역성 뉘앙스는 과장이다.

### 6. (HTTP 노드 설정의 옵션 폭발 = 높은 러닝커브)  `[약화됨]`
옵션이 많다는 사실은 맞지만 '발견성이 낮다'는 결론은 실제 완화 장치를 무시한다. PropertyPanel/에디터는 keyed→text 전환 시 끊긴 바인딩 경고, body vs param 탭 힌트, client 모드 charset 경고, respType별 안내 문구, 인라인 토큰 칩+데이터 삽입 피커(BindingPicker), 단일 노드 즉석 실행으로 '왜 비었지'를 그 자리에서 진단하게 돕는다 — 대부분 적대적 리뷰에서 UX 항목으로 명시 반영된 것들이다. 1434줄은 사용자에게 보이지 않는 내부 유지보수 지표(문서가 리팩토링 후보로 자인)일 뿐 UX 복잡도와 등치되지 않는다. 옵션 대부분은 기본값으로 숨어 있고(charset UTF-8·reqMode server·bodyType json 기본) 필요할 때만 드러난다. 강력함의 대가라는 트레이드오프로 정당화된다.

### 7. (실행 실패의 관측성이 얕다)  `[약화됨]`
부분 사실오류가 있다 — ExecutionDetailModal은 노드별 durationMs 타이밍(L148)과 httpStatus(L147), 실행 레벨 error 메시지(L128)를 이미 표시한다. '노드별 타이밍 시각화가 없다'는 틀렸다. 스택트레이스 원문은 없으나 assert 실패·노드 에러 문자열은 노출된다. redaction deny-by-default는 관측성 약점이 아니라 의도된 보안 기본값(시크릿·PII가 ctx에 실리므로)이며, 필요한 팀은 capture.request-response-bodies 옵트인으로 켤 수 있고 로컬/h2는 이미 true다. '디버깅 정보가 기본 비어 있는 역설'은 보안-관측성 트레이드오프를 무시한 프레이밍이다.

### 8. (내장 Mock이 무상태라 현실적 시뮬레이션에 한계)  `[약화됨]`
사실이지만 의도된 스코프다. MockRuntime은 '범용 무상태 목'으로 명시 설계됐고, 상태 있는 시뮬레이터는 별도 프로세스를 baseUrl로 붙이라는 탈출구가 문서·아키텍처에 명시돼 있다 — mock이 못 하는 게 아니라 mock 밖에서 하라는 경계 설정이다. {{seq}}·{{uuid}}·조건 규칙(eq/ne/exists/contains)·다중 라우트 첫매칭·콜백 발사로 '결제창→콜백', '노티 자동 발사' 같은 흐름 검증이라는 핵심 가치는 stateless로도 충분히 달성된다(pay-mock 데모 검증). stateful 원장 시뮬레이션은 별도 도구의 몫이라는 게 정당한 설계 결정이며, '핵심 가치가 반감된다'는 상태형 도메인에 한정된 과대 일반화다.

### 9. (콜백·mock 엔드포인트 무인증 — '사내망 전제'의 상시 리스크)  `[약화됨]`
표면은 맞지만 다층 방어를 축소했다. mock은 P1에서 (tenant_id, slug) 팀 스코프로 격리됐고, 콜백 발사·mock 콜백에는 SsrfGuard(사설/루프백/메타데이터 차단)가 적용되며, /api 전체는 OIDC 모드에서 RBAC 게이트 뒤에 있다 — 무인증은 '외부 시스템이 부를 수밖에 없는' 콜백/mock 게이트웨이 두 경로에 한정되고 execId는 추측 불가 UUID다. 이는 실 결제 게이트웨이가 merchant returnUrl을 무인증으로 때리는 현실 제약을 그대로 반영한 의식적 트레이드오프(문서 명시)이지 방치가 아니다. '프록시가 실수로 열리면'은 임의 사내 서비스에 공통된 배포 실수이며 이 도구 고유 결함이 아니다. presence 토큰 쿼리스트링 노출도 이미 문서화된 수용 항목이다.

### 10. (실시간 공동 편집이 last-write-wins — 조용한 덮어쓰기)  `[약화됨]`
정확하나 위험도가 과장됐다. CRDT 아님은 설계 스펙이 애초 범위 밖으로 뒀던 것을 사용자 요청으로 얹은 부가기능이며, 100ms 창에 서로 다른 노드를 정확히 동시 편집해야만 발산하고 다음 편집/새로고침으로 수렴한다(문서 명시). 게다가 presence가 편집중 노드에 색 링+'✎ 이름' 배지를 실시간 표시해 '지금 누가 어디를 만지는지'가 보이므로 동시 충돌 자체가 사회적으로 회피된다. 저장 시엔 낙관적 락 409로 최종 안전망이 있다. 팀 사용의 지배적 패턴(턴 주고받기·한 명 편집+관전)은 매끄럽고, 조용한 유실은 드문 엣지케이스로 문서에 정직히 고지돼 있다.

### 11. (플러그인 JAR이 무샌드박스 전권 실행)  `[약화됨]`
사실이나 심각도(low)가 정확히 잡혔고 신뢰 경계가 좁다. 업로드는 RBAC platform-admin(전역) 전용으로, 적대적 리뷰에서 GET /plugins가 viewer에 새던 구멍까지 막아 '아무나 못 올린다'가 성립한다 — 즉 임의 코드 실행 권한을 가진 주체는 이미 플랫폼 최고 관리자로, JAR 없이도 서버를 통제할 수 있는 사람이다. 무샌드박스는 사내 신뢰된 변환 플러그인이라는 전제의 의식적 트레이드오프(문서의 알려진 한계)이며, 진짜 위험은 '신뢰 경계가 불명확한 조직'이라는 조건부다. 범용 플러그인 격리는 정당한 후속 과제이지 현 사용 관점의 결정적 결함은 아니다.

### 12. (자동화된 회귀 안전망이 얇다)  `[약화됨]`
'얇다'는 실제 검증 자산을 크게 과소평가한다. 백엔드 단위 77종(JwtRoleConverter·MockPathResolver·claim CAS @DataJpaTest·RunStateSnapshot·StateCrypto 등)에 더해, 기능별 headless e2e 스위트가 두껍게 존재한다 — P1 RBAC 27/27(Oracle 재실행 멱등), P2 내구성 22/22(백엔드 3회 재시작), P3 presence 11/11, 콜백/mock/demos 수십 케이스, OpenAPI 파서·bodyConvert 순수함수 수십 케이스. 프론트 단위 테스트 부재는 맞으나 폴링 실행 루프·바인딩·캔버스는 Playwright 브라우저 e2e로 반복 커버되고(칩 삽입·대기 배너·복붙 재매핑 실행 성공 등), 매 기능마다 적대적 멀티에이전트 리뷰가 회귀 가드로 붙었다. '미묘한 회귀가 사용자에게 먼저 발견될 위험'이 0은 아니나 '안전망이 얇다'는 사실과 배치된다.

---

## 4. 긍정에 대한 반박

> 위 §2 긍정을 다른 에이전트가 검증·반박한 결과. 판정: 뒤집힘/약화됨/유지됨.

### [판정 weakened] (긍정 1. 워크플로 + Mock 한 프로세스 통합)
목이 실제로 내장(`MockGatewayController`, 별도 프로세스 없음)인 것은 사실이나, 폐루프의 유용성은 조건부다. (a) 목이 **무인증**이다 — `/mock/**`가 permitAll이고, TCP 목은 `ServerSocket`을 모든 인터페이스에 바인딩("사내망 전제")한다. 단일팀 LAN 밖에선 쓸 수 없다. (b) 목이 **무상태**다(seq 카운터도 인메모리 재시작 리셋). 통합 테스트에서 정작 어려운 상태 있는 대상(잔액·재고·중복결제 방지)은 여전히 별도 프로세스로 세워야 한다. (c) TCP 목 포트 충돌/바인딩 실패가 mock 저장을 400으로 롤백시켜, 워크플로 도구의 가용성이 포트 상황에 얽힌다. 편의는 진짜지만 "단일팀·무상태·무인증·단일 인스턴스" 전제에서만 성립한다.

### [판정 weakened] (긍정 2. 내구 비동기 실행)
내구성이 **중단 지점에서만** 성립한다. `recoverOnStartup`은 suspension 행(=wait/client/form/input 게이트에서만 생성)이 없는 RUNNING/WAITING을 전부 `markFailed("서버 재시작으로 중단된 실행")`한다. 즉 **wait 없는 순수 서버측 HTTP 체인은 내구성이 0** — 실행 중 재시작하면 FAILED되고 처음부터 다시. Temporal류 범용 내구성이 아니라 "사람/콜백 게이트 체크포인트"이며 CLAUDE.md도 "HTTP 응답 등 비직렬화 상태 없음"이라 명시. 워커 풀·스케줄러·suspensions 캐시가 단일 JVM이라 "내구"가 곧 HA는 아니다. 배압도 비대칭이다: `run()`은 큐 포화 시 429지만 `resume()`은 포화 시 호출 스레드(톰캣)에서 직접 재개 체인 실행 — 부하 시 "즉시 반환" 약속이 깨진다. 암호키 미설정 시 공개된 dev 키로 스냅샷(시크릿·본문 포함)을 암호화하고 WARN만 남긴다.

### [판정 stands] (긍정 3. wait 노드 — 브라우저 없이 완결)
백엔드가 콜백을 직접 수신하고 타임아웃 스케줄러로 자가 재개하므로 탭을 닫아도 wait는 완결된다 — 견고하다. 다만 범위를 좁혀야 한다: "브라우저 없이"는 오직 wait/순수 서버 체인에만 해당하고, form/input/client pending은 여전히 브라우저 탭이 있어야 resume된다. 또 수신 엔드포인트는 무인증(execId UUID가 유일한 비밀)이고 콜백 페이로드 진위 검증(서명)이 없어 URL을 알게 된 누구나 재개를 위조할 수 있으며, 타임아웃 스케줄러도 단일 인스턴스다. 핵심 기능 자체는 성립하나 "사내 신뢰망" 전제가 붙는다.

### [판정 weakened] (긍정 4. 그래프를 이해하는 토큰 바인딩)
BFS·인라인 칩·원형 보존은 편리하다. 그러나 "그래프를 이해한다"는 대부분 프론트 피커용 BFS이고, 백엔드 `TokenResolver`는 nearest-upstream + `map.get(key)` 수준이라 **바인딩 유효성 검증이 없다** — 존재하지 않는 키/오타 토큰은 조용히 null/빈 문자열이 되고 경고가 없다. 조건식은 `SimpleEvaluationContext` 읽기전용이라 `.contains()`·`.startsWith()`가 차단돼 활용이 제약된다. 결정적으로 **시크릿 전파 누수**: 비시크릿 SET 변수가 상류 시크릿을 토큰 참조하면 평문으로 로그/DB에 실린다(후속 과제). "이해"는 발견/자동완성 수준이지 정합성·보안을 보장하지 않는다.

### [판정 weakened] (긍정 5. 실행 경과 실시간 표시)
실패 노드 자동 펼침·배지·로그 내보내기는 실재한다. 그러나 "실시간"은 SSE/WS가 아니라 **폴링**이다 — 실행당 초 2~3회 GET, 0.4초 간격이라 세밀하지 않고 관전자 N명 × 실행 M개가 N×M 폴링으로 스케일하지 않는다. "현재 실행 중" 노드는 동기 구간에선 클라이언트의 Kahn 위상정렬 미러로 **추정**한 값이지 실측이 아니고, baseline 비교는 두 탭에서 같은 플로우를 돌리면 다른 실행을 잡는 오탐이 있다. 단일 사용자·단일 탭에서만 정확한 근사 애니메이션이다.

### [판정 weakened] (긍정 6. 실시간 공동 편집)
설계 스펙은 CRDT를 의도적으로 범위 밖으로 뒀고, 이건 사후에 얹은 **비CRDT last-write-wins**다. 같은 100ms 창의 동시 편집은 한쪽이 조용히 유실되고 발산 가능. 편집마다 **전체 그래프 스냅샷을 통째로 브로드캐스트**(증분 아님)라 O(그래프 크기)로 큰 그래프에선 대역폭/CPU 부담이 크다. 방 상태는 인메모리, 단일 인스턴스라 수평 확장엔 sticky/공유 브로커 필요, OIDC 토큰은 쿼리스트링(로그 노출). "턴 주고받기·한 명 편집+관전"엔 매끄럽지만 진짜 동시 편집엔 명시적으로 취약하다.

### [판정 stands] (긍정 7. 한국 사내/레거시 연동 친화)
EUC-KR/MS949 charset, 바이트 고정길이 TCP 전문, TCP 목, XML/urlencoded/query respType은 실제로 구현·테스트돼 있어 국내 금융/레거시 연동에서 진짜 차별점이다. 약화 요소는 주변부에 그친다: client 모드 charset은 브라우저 UTF-8 제약으로 미보장(server 모드 필요), TCP는 평문 소켓만(TLS/상호인증 없음), 전문 프레이밍은 길이 프리픽스+고정길이만(BER-TLV 등 미지원). 핵심 강점은 견고하다.

### [판정 weakened] (긍정 8. 보안 기본값 켜짐)
여러 겹에서 약하다. (a) SSRF 가드는 check-time DNS 해석만 하고 connect-time IP 핀닝이 없어 DNS 리바인딩 갭이 주석에 명시돼 있으며, 기본 로컬/컴포즈 프로파일은 `allow-loopback: true`로 루프백 보호를 완화한다. (b) redaction deny-by-default가 **HTTP 노드에만** 적용된다 — **TCP 노드의 요청/응답 전문(계좌번호·고객명)은 capture 설정과 무관하게 항상 평문 저장**되고, h2 프로파일은 capture=true라 기본 로컬 모드에선 HTTP 본문도 전부 저장된다. 즉 "deny-by-default"가 출하 프로파일에서 꺼져 있고 TCP는 커버 안 됨. (c) 테넌시는 DB RLS가 아니라 앱 레벨 `tenant_id` 필터라 쿼리 하나만 빠뜨리면 교차 테넌트 유출이고, 실제로 `GET /flows/{id}/runs` 구멍을 한 번 출하했다. 플러그인 JAR은 무샌드박스 전권. 자세는 좋으나 출하 기본값·TCP·RLS 부재에서 실질적 구멍이 여럿이다.

### [판정 weakened] (긍정 9. 배포·운영 마찰 낮음)
단일 jar + h2 무설정은 진짜 장점이다. 그러나 "접속 오리진 자동 콜백"은 접속 오리진이 콜백 발신자에게 도달 가능할 때만 성립한다 — `requestOrigin()`은 `serverName/serverPort`를 그대로 쓰고 "프록시 뒤 X-Forwarded 해석은 후속"이라 인정한다. 리버스 프록시 뒤/실제 외부 게이트웨이는 여전히 터널/명시 base가 필요하니 "무설정"은 동일 호스트/LAN 목 루프에 한정된다. Compose 경로는 Oracle Free 첫 기동 수 분, issuer 이중 주소 해법 취약, secret·비번 데모값(운영 전 교체 필수). 단일 jar+OIDC SPA 셸 401 버그가 P4에서야 발견된 사실 자체가 SaaS 배포 경로가 덜 검증됐음을 보여준다.

### [판정 stands] (긍정 10. 성숙한 에디터 생산성)
워크플로 간 복붙(토큰 재매핑)·검색·자동정렬·문제 배지·단일 노드 실행·undo/redo는 실제로 갖춰져 일상 편집 효율을 올린다. 약점은 주변부다: 노드 클립보드가 서버가 아닌 브라우저 localStorage(탭/브라우저 스코프), 단일 노드 실행은 상류 바인딩이 null이라 충실도 제한, 패널 크기는 서버 미저장. 핵심 생산성 주장은 유지된다.

### [판정 weakened] (긍정 11. 엣지 케이스 방어의 일관된 성숙도)
검토된 핫스팟의 방어는 진짜다. 그러나 "일관된 성숙도"는 과장이다 — CLAUDE.md 변경 로그 자체가 **출하 후 발견된 회귀의 목록**이다: 폴더 CRUD가 `@get:JvmName`으로 전부 500(조용히 실패로 출하), SSE→폴링 전환 때 wait 대기 UI 파손, "연결 안 된 노드 실행" 버그는 1차 수정이 불완전해 두 번 재현, `GET /plugins` viewer 조회 구멍, `GET /flows/{id}/runs` 테넌트 구멍, 단일 jar+OIDC SPA 401이 P4에서야 발견. 방어가 **사전적·균일**하다기보다 **반응적·패치 구동**임을 보여준다. E2E는 대부분 수작 노드 스크립트라 커버리지도 균일하지 않다.

---

## 5. 걷어내야 할 것 (Remove)

> 혼란·부채·중복이라 제거/축소하면 나아지는 것.

### 1. HTTP 노드의 respType/bodyType 에서 'form' 과 'urlencoded' 중복 옵션 제거(하나로 통합)  `[우선순위 높음 · 노력 낮음]`
- **왜:** PropertyPanel.tsx 의 RESP_TYPES=['json','xml','urlencoded','form','query','text','binary'] 와 STRUCTURED_BODY=['json','urlencoded','form'] 에 'urlencoded' 와 'form' 이 둘 다 노출되는데, 백엔드는 완전히 동일하게 처리한다(HttpNodeExecutor parseResponse: case 'form','urlencoded' -> parseForm, 그리고 PropertyPanel 220행 'form==urlencoded (백엔드 동일 처리)' 주석까지 존재). 워크플로를 만드는 개발자 입장에서 드롭다운에 의미가 같은 항목이 둘 있으면 '뭐가 다르지?' 하고 멈칫하게 되는 순수 혼란 요소다. 기능 이득 0.
- **어떻게:** frontend/src/panels/PropertyPanel.tsx 의 RESP_TYPES·STRUCTURED_BODY·KEYED_RESP 에서 'form' 제거(백엔드 case 는 별칭으로 남겨 기존 그래프 로드 호환). respTypeLabel/bodyHint 의 'urlencoded/form' 분기도 정리. 라벨을 'urlencoded (a=1&b=2)' 하나로.

### 2. 실시간 공동 편집 그래프 중계(lib/collab.ts + editorStore.applyRemoteGraph + PresenceHandler 의 t:'graph' 릴레이) 제거 — presence(커서·편집중·저장 토스트)만 남기기  `[우선순위 높음 · 노력 중간]`
- **왜:** P3 설계 스펙 자체가 CRDT 공동편집을 '범위 밖'으로 명시했는데 그 위에 last-write-wins 전체 그래프 중계를 얹었다. collab.ts 주석이 스스로 인정하듯 두 사람이 같은 100ms 창에 편집하면 마지막 스냅샷이 이기고 드물게 발산한다 — 진짜 충돌 병합이 아니다. 사내에서 워크플로를 만드는 팀에게 '조용히 내 편집이 남의 것으로 덮여 사라지는' 동작은 커서 표시가 주는 편익보다 신뢰를 더 크게 깎는다. presence(누가 보고 있고 어디 편집 중인지)만으로 협업 인지 목적은 충족된다.
- **어떻게:** frontend/src/lib/collab.ts 삭제, Editor.tsx 의 startCollab/stopCollab 호출 제거, editorStore.ts 의 applyRemoteGraph 및 에코 방지 플래그 제거, backend PresenceHandler.kt 의 t:'graph' 무상태 릴레이 분기 제거(hello/join/leave/cursor/editing/saved 는 유지).

### 3. 이중 바인딩 표현 통합 — 구조체 바인딩 f.bound(+BindingChip/BindingPicker) 를 걷어내고 {{token}} 문자열 단일 모델로 수렴  `[우선순위 중간 · 노력 높음]`
- **왜:** 같은 개념(상위 노드 값 참조)이 두 방식으로 공존한다: 신형 인라인 토큰 문자열({{key@node}}, TokenInput)과 구형 구조체 f.bound(BindingChip). PropertyPanel.tsx(1434줄) 전반과 KeyValueEditor.tsx 에 'f.bound ? bindingToToken(f.bound) : f.value' 분기가 20곳 넘게 흩뿌려져 있고, isTokenizable 가드·비이관 예외까지 붙어 있다. BindingPicker 는 여전히 새 bound 를 써넣는 경로도 있어(예: SET 변수 picker onPick { bound: b }) 완전한 레거시도 아닌 '반쯤 이관된' 상태 — 유지보수자가 어느 쪽이 진실인지 매번 헷갈린다. 이 이중성이 PropertyPanel 비대의 핵심 원인.
- **어떻게:** BindingPicker onPick 을 bound 대신 토큰 문자열 삽입으로 통일, 로드 시 bound→토큰 일괄 이관(비토큰화 키만 예외 유지), 이관 완료 후 frontend/src/binding/BindingChip.tsx 와 f.bound 분기(PropertyPanel.tsx·KeyValueEditor.tsx·api/types.ts NodeField.bound) 단계적 제거. 시크릿 SET 행만 마스킹 위해 마지막에 다룸. 회귀 위험 있어 스냅샷 e2e 선행.

### 4. form 노드 표시 모드 2종(팝업 openFormPopup vs 페이지 내 iframe openFormIframe) 중 팝업 모드 제거, iframe 하나로  `[우선순위 중간 · 노력 낮음]`
- **왜:** lib/popup.ts 에 거의 동일한 hidden-form 조립 로직이 두 벌 있다. 팝업 모드는 브라우저 팝업 차단, 교차출처 재사용 창의 popup.document SecurityError, 창 이름 고착 등 방어 코드가 덕지덕지 붙는 반면, iframe 모드는 팝업 차단이 없고 결제창이 같은 페이지에 떠 UX·견고성이 명확히 우수하다(주석에도 그렇게 적혀 있음). 두 경로를 다 유지하면 Editor.tsx onRun 의 formDisplay 분기, 두 함수 테스트, 두 실패 모드를 계속 떠안는다. 결제창 데모라는 니치 기능에 과한 유지비.
- **어떻게:** frontend/src/lib/popup.ts 의 openFormPopup 제거, Editor.tsx onRun 의 formDisplay==='iframe' 분기 삭제(항상 iframe), PropertyPanel 의 formDisplay 토글 UI 제거, GraphNode.formDisplay 는 raw 라운드트립으로 무해 보존.

### 5. RunRequest 의 죽은 relayRunId/relayBase 필드 + 관련 하위호환 주석 제거  `[우선순위 중간 · 노력 낮음]`
- **왜:** backend/src/main/kotlin/com/flowlink/execution/dto/RunRequest.kt 의 relayRunId·relayBase 는 '구 relay.js 연동용, 무시함'이라 적혀 있고 ExecutionService.kt 171행도 '구 프론트가 아직 보냄 → 무시'라 하지만, 실제로 이 리포의 프론트(runsApi.run(flowId))는 더 이상 이 필드를 보내지 않는다(frontend/src 전체 grep 결과 0건). 즉 존재하지 않는 구 클라이언트를 위한 데드 필드 + 오해를 부르는 주석이다. 신규 유지보수자가 '이 relay 값이 어디서 오나' 추적하느라 시간 낭비.
- **어떻게:** RunRequest.kt 에서 두 필드 삭제, ExecutionService.kt 171~174행 주석·무시 로직 정리(relayResolver.resolve() 만 남김). 프론트 api/client.ts run 호출 확인.

### 6. CLAUDE.md 의 '대체됨' 콜백 3개 섹션(폼전송 WAIT type / {{__callbackUrl}} / {{__notiUrl}}·{{__corrId}}) 등 역사 기록 대량 축소  `[우선순위 중간 · 노력 낮음]`
- **왜:** CLAUDE.md 는 837줄인데 381~440행 '이전 변경(역사 기록용)' 3개 콜백 섹션은 2026-07-03 재설계로 전부 제거된 메커니즘의 상세 설명이다. 이 문서는 '유지보수용 가이드'로 정독을 요구하는데, 이미 코드에 존재하지 않는 {{__callbackUrl}}/{{__corrId}} 같은 토큰과 /executions/callback/{token} 엔드포인트를 장문으로 설명해 신규 작업자를 적극적으로 오도한다(현재 콜백은 /relay/{execId}/cb/{nodeId} 하나뿐). 문서 부채가 실제 기능처럼 읽힌다.
- **어떻게:** CLAUDE.md 381~440행 3개 (대체됨) 섹션을 2~3줄 요약(‘초기엔 토큰 URL·상관키 방식이었으나 relay 통합으로 폐기’)으로 압축하고 상세는 docs/superpowers/specs/2026-07-03-form-wait-relay-design.md 링크로 이관. 마찬가지로 다른 '대체됨' 노트도 링크화.

### 7. HTTP 노드 client(C→S, reqMode='client') 모드 제거 또는 실험 기능으로 강등  `[우선순위 중간 · 노력 중간]`
- **왜:** client 모드는 브라우저가 직접 fetch 하는 니치 경로인데, 그 대가로 PropertyPanel 에 'client 모드는 charset 미보장' 경고(684행), Content-Type charset 미부착 분기(233·285행), Editor.onRun 의 pendingClient/callClientRequest 루프, 백엔드 PendingClient DTO·drive 분기·runSingleNode 미지원 처리까지 전 계층에 특수 분기를 깐다. 사내에서 API 워크플로를 서버 실행으로 만드는 주 사용자에게 'CORS·charset이 브라우저에 좌우되는 모드'는 거의 안 쓰이면서 혼란(S→S / C→S 배지 의미 질문)만 유발. demo-06 하나가 의존하므로 완전 제거 전 데모 대체 필요.
- **어떻게:** 우선 PropertyPanel 에서 reqMode 토글을 '고급'으로 접고 기본 노출 축소. 완전 제거 시 api/types.ts ReqMode, NodeCard 배지, Editor callClientRequest, backend FlowExecutor isClientMode/PendingClient, HttpNodeExecutor.clientResult 제거. demos/demo-06-클라이언트모드.json 은 server 모드로 대체하거나 삭제.

### 8. 내장 Mock 콜백 디스패처의 'OK 미수신 시 2초×3회 재발송'(retryUntilOk) 규약 제거  `[우선순위 낮음 · 노력 낮음]`
- **왜:** MockCallbackDispatcher.kt 는 응답 본문이 정확히 'OK' 가 아니면 재발송하는 특정 PG 노티 규약의 축소판을 하드코딩했다(주석도 그렇게 인정). 그런데 CLAUDE.md 에 따르면 이미 '범용 무상태 목' 철학으로 상태 있는 MockPgSimulator·PG 프리셋을 의식적으로 걷어냈다 — 이 재시도 규약만 남아 철학과 배치된다. Mock 을 세우는 QA 입장에서 '왜 내 콜백이 3번 오지?'는 예측 불가한 마법이고, 필요하면 워크플로 자체로 재시도를 표현하는 게 맞다.
- **어떻게:** backend/src/main/kotlin/com/flowlink/mock/MockCallbackDispatcher.kt 의 retryUntilOk/MAX_ATTEMPTS/okAck 로직 제거(단발 발사만), MockSpec 의 retryUntilOk 필드와 MockServerEditor 의 해당 토글 제거. 콜백은 1회 fire-and-forget.

### 9. 정체불명 orphan 디렉토리 flowlink-workflow/(.claude-plugin skills) 정리 + demos 문서/파일 불일치 정정  `[우선순위 낮음 · 노력 낮음]`
- **왜:** 리포 루트 flowlink-workflow/ 는 .claude-plugin/skills 만 든 채 앱 빌드·배포·소스 어디에서도 참조되지 않는다(별개 플러그인 잔재로 보임). 또 CLAUDE.md·demos 문서는 demo-05(TCP 전문)를 언급하지만 demos/ 에 demo-05 파일이 없다(01~04·06만 존재). 워크플로를 처음 세팅하는 사람이 '이 디렉토리 뭐지', 'demo-05 어디갔지'로 헤맨다.
- **어떻게:** flowlink-workflow/ 가 실제 배포 플러그인이 아니면 삭제(또는 별도 리포로 분리). demos/README.md 와 CLAUDE.md 의 demo-05(TCP) 언급을 제거하거나 파일을 복원해 목록과 일치시킴.

### 10. TCP 전문 노드 + TCP Mock(TcpNodeExecutor·TcpMockRegistry) 를 별도 플러그인/옵션 모듈로 분리(코어에서 축소)  `[우선순위 낮음 · 노력 중간]`
- **왜:** 고정길이 길이프리픽스 금융 전문(레거시 뱅킹 TCP)은 'REST API 워크플로 오케스트레이션'이라는 제품 정체성과 이질적인 아주 좁은 도메인이고, 코틀린 이관 때 한 번 제거됐다가 부활한 이력이 그 애매함을 보여준다. 백엔드에 TcpNodeExecutor·TcpMockRegistry(ServerSocket 라이프사이클·포트 관리·인코딩 슬라이싱)와 프론트 팔레트/PropertyPanel/upstream TCP 분기를 상시 안고 간다. REST 워크플로를 만드는 대다수 사용자에겐 팔레트의 잡음이고, TCP 사용자는 소수다. (사용자가 명시 요청해 부활시킨 기능이라 완전 삭제보다 분리·옵션화가 현실적 → priority low)
- **어떻게:** NodeType.TCP 관련(backend engine/TcpNodeExecutor.kt, mock/TcpMockRegistry.kt, 프론트 팔레트·PropertyPanel TCP 섹션)을 feature flag(flowlink.features.tcp) 뒤로 넣어 기본 off, 또는 transform-spi 처럼 선택 모듈로 물리 분리. 코어 팔레트/문서에서 기본 노출 제거.

---

## 6. 추가해야 할 것 (Add)

> 실사용 가치가 큰데 빠져 있는 진짜 공백.

### 1. 환경(Environment) 전환 + 전역/공유 변수 — dev/staging/prod 를 한 번에 바꾸고 {{env.X}} 로 참조  `[우선순위 높음 · 노력 높음]`
- **왜:** 실사용 최대 공백. 지금은 baseUrl 이 HTTP 노드마다 하드코딩(GraphNode.baseUrl)이라, dev→운영 대상 전환하려면 워크플로 안 HTTP 노드 20개를 일일이 열어 고쳐야 한다. Bearer 토큰/공통 헤더/공통 호스트도 노드마다 중복. API 워크플로를 여러 환경에 대고 테스트·연동하는 사내 개발자/QA에게 Postman '환경' 수준의 개념이 없다는 건 치명적. 팀 스코프(tenant)로 공유되면 협업 가치도 큼.
- **어떻게:** 백엔드: environment 테이블(tenant_id·name·vars JSON, 활성 env 선택) + CRUD API. TokenResolver 에 {{env.KEY}} 해석 소스 추가(FlowExecutor 실행 컨텍스트 시드 — 이미 wait url 을 putSeed 로 시드하는 패턴 존재). 프론트: 에디터 상단에 환경 드롭다운(현재 활성 env 표시), 사이드바 ⚙ 설정 근처에 환경 관리 다이얼로그. baseUrl/헤더 입력은 이미 TokenInput 칩이라 {{env.API_BASE}} 삽입만 하면 됨(추가 UI 최소). RunRequest 에 envId 실어 실행 시 고정.

### 2. 버전 히스토리 조회·비교(diff)·복원 UI+API  `[우선순위 높음 · 노력 중간]`
- **왜:** FlowVersion(불변 스냅샷)이 저장 때마다 이미 쌓이고 RunRequest.versionNo 로 특정 버전 실행까지 가능한데, 정작 과거 버전을 '보거나 되돌리는' 경로가 전혀 없다(FlowController 에 GET versions 조차 없음, 프론트는 saveVersion 만 호출). 잘못 저장했을 때 복구 불가 = 사용자가 가장 무서워하는 상황. 데이터·모델이 이미 있어 투자 대비 효과가 매우 큰 '반쯤 만들어둔' 기능.
- **어떻게:** 백엔드: GET /flows/{id}/versions(목록, FlowVersionSummary 이미 존재)·GET /flows/{id}/versions/{no}(graphJson)·POST /flows/{id}/versions/{no}/restore(그 스냅샷을 새 버전으로 저장). 프론트: 에디터 도구 메뉴(⋯)에 '버전 기록' → 사이드 목록(작성자 triggeredBy 이미 기록·note·시각) → 선택 시 읽기전용 미리보기 + '이 버전으로 복원'. diff 는 노드/엣지 id 기준 added/removed/changed 요약이면 충분(그래프 JSON 비교 순수 함수).

### 3. 스케줄(cron) · 웹훅(인바운드) 트리거 실행  `[우선순위 높음 · 노력 높음]`
- **왜:** TriggerType 에 SCHEDULE/WEBHOOK/EVENT enum 만 있고 MANUAL 만 동작(문서화된 부채). 하지만 '야간 회귀 테스트를 매일 돌린다', '외부 시스템 이벤트가 워크플로를 깨운다'는 사내 연동/QA의 핵심 자동화 수요. P2 에서 실행이 이미 비동기 워커 풀+DB 내구화됐으므로 트리거만 붙이면 자연스럽게 완성되는 단계.
- **어떻게:** SCHEDULE: flow_trigger 테이블(cron 식·enabled·env) + Spring @Scheduled 폴러 또는 ScheduledExecutorService(ExecutionService 에 이미 scheduler 보유)로 due 플로우를 service.run 제출. WEBHOOK: 무인증/토큰 스코프 POST /hooks/{token} → 매핑된 flow 실행, 본문을 RunRequest.input 으로 주입. 프론트: 플로우 설정에 '트리거' 탭(cron 빌더·다음 실행 시각·웹훅 URL 복사). 스케줄 실행은 요청 오리진이 없으니 relay base 를 설정값/env 로(RelayBaseResolver 주석에 이미 명시된 조건).

### 4. 테스트 스위트 / 회귀 일괄 실행 + 통과·실패 리포트  `[우선순위 중간 · 노력 중간]`
- **왜:** ASSERT 노드로 판정은 되지만, '이 폴더의 20개 플로우를 한 번에 돌려 초록/빨강 리포트'가 없다. QA가 명시 대상('API 워크플로를 테스트하는 개발자/QA')인데 회귀 스위트 실행이 수동 1건씩이면 실효성이 낮다. 스케줄 트리거와 결합하면 '야간 회귀' 완성.
- **어떻게:** 백엔드: POST /suites/run(flowId 목록 또는 folderId) → 각 플로우 비동기 실행 후 상태 집계 반환/이력화. 프론트: 대시보드 폴더 뷰(이미 탐색기식)에 '이 폴더 전체 실행' 액션 + 결과 매트릭스(플로우×상태, 실패 클릭→ 기존 ExecutionDetailModal). 개별 실행·이력 저장은 기존 경로 재사용이라 조립 성격.

### 5. 실제 시크릿 볼트 — 저장·이름 참조({{secret.NAME}}), 로그/DB 마스킹 전파  `[우선순위 중간 · 노력 높음]`
- **왜:** SET secret 은 UI 마스킹(FlowExecutor '••••••')일 뿐 값 자체는 그래프/토큰에 평문으로 흐르고, 비시크릿 변수가 상류 시크릿을 참조하면 로그·DB(capture)에 평문으로 남는다(CLAUDE.md ⚠ 명시). Bearer/API 키를 넣어 외부 시스템에 연동하는 도구에서 시크릿이 실행 로그로 새는 건 실사용·보안 관점 실질 리스크.
- **어떻게:** 백엔드: secret 테이블(tenant 스코프, StateCrypto AES-GCM 재사용 — 이미 존재) + TokenResolver {{secret.NAME}} 해석 시 값 주입하되 NodeRecorder/capture 저장 직전 알려진 시크릿 값 문자열을 마스킹 치환. 프론트: 환경 관리와 같은 화면에 시크릿 관리(값은 쓰기 전용, 이후 마스킹 표시). 환경 기능과 한 묶음으로 설계하면 효율적.

### 6. 실행 실패 알림(웹훅/Slack/이메일)  `[우선순위 중간 · 노력 중간]`
- **왜:** 실행이 실패해도 사용자가 실행 이력 화면을 열어야만 안다. 스케줄/웹훅 트리거(무인 실행)가 붙는 순간 '실패를 즉시 통보'가 필수 — 없으면 무인 자동화의 가치가 반감. 사내 도구 특성상 Slack/Teams incoming webhook 한 개면 충분히 실용적.
- **어떻게:** tenant 설정에 알림 대상(webhook URL/이메일) 저장. ExecutionService 가 상태 FAILED 확정 시(이미 markFailed 지점 존재) 비동기로 발송(SsrfGuard 는 아웃바운드용이니 알림은 allowlist 예외 또는 별도 정책). 프론트 ⚙ 설정에 '알림' 섹션. MockCallbackDispatcher 의 파이어&포겟+재시도 패턴 재활용 가능.

### 7. 실행 이력 강화 — 재실행(Re-run) 버튼 + 서버측 페이지네이션·날짜/플로우 필터  `[우선순위 중간 · 노력 중간]`
- **왜:** Executions 화면은 recent(50) 고정 목록 + 클라이언트 이름검색뿐(Executions.tsx). 50건 넘어가면 과거 실행을 못 찾고, 실패한 실행을 '같은 조건으로 다시 돌리기'가 없어 매번 에디터를 열어 ▶ 를 눌러야 한다. 반복 테스트·디버깅 루프의 마찰.
- **어떻게:** 백엔드: GET /executions 에 cursor/offset·status·flowId·from/to 파라미터 추가(현재 limit 만). POST /executions/{id}/rerun(같은 flowVersion+input 재실행) 또는 프론트에서 flowId+versionNo 로 runsApi.run 호출. 프론트: 실행 상세 모달·행에 '다시 실행' 버튼, 필터를 서버 파라미터로 승격 + 더 보기.

### 8. 런타임 입력 파라미터 UI + 골든 응답 비교(diff)  `[우선순위 낮음 · 노력 중간]`
- **왜:** (a) RunRequest.input 필드가 백엔드엔 있는데 프론트에서 값을 넣을 UI가 없다(grep 확인 — 미사용) → 같은 플로우를 다른 입력으로 돌리는 파라미터화 실행 불가, INPUT 노드로 매번 모달 대기하는 우회뿐. (b) 회귀에서 '지난 응답 대비 이번 응답 무엇이 달라졌나'가 QA 핵심인데 응답 비교가 없다.
- **어떻게:** (a) 실행 버튼 옆 '입력값과 실행' → 간단 key/value(또는 JSON) 다이얼로그 → RunRequest.input, TokenResolver 에 {{input.X}} 소스 추가. (b) 실행 상세에서 '이전 실행과 비교' — 노드별 responseText/output JSON diff(순수 함수 + 하이라이트). 두 항목 모두 기존 DTO(NodeExecutionView.output/responseText) 재사용이라 백엔드 변경 최소.

### 9. 상태 있는(시나리오) Mock — 순차 응답·간단 상태 저장  `[우선순위 낮음 · 노력 중간]`
- **왜:** 내장 Mock 은 무상태(CLAUDE.md ⚠ '부분취소 잔액 원장 등 범위 밖'). 하지만 '1차 호출은 pending, 2차는 approved' '재고 차감' 같은 상태 시나리오는 실제 대상 시스템 흉내에 자주 필요 — 현재는 별도 프로세스를 세워야 해 도구의 '미완성 부분을 mock 으로 세워 전체 흐름 검증' 취지가 반쯤만 충족된다.
- **어떻게:** MockRuleSpec 에 '순차 응답 목록'(호출 회차별 다른 응답, seq 카운터 이미 있음) 또는 slug 별 간단 KV 상태 저장소(setState/getState 템플릿 함수). 완전한 원장까지는 과하니 '회차별 응답 + 이름있는 카운터/플래그' 정도로 범위를 좁히면 실용 대비 저비용. MockRuntime(순수) + 서버별 상태맵.

---

## 7. 합쳐야 할 것 (Merge)

> 나뉘어 있어 혼란/중복인 기능·화면·개념을 통합.

### 1. 흩어진 '가져오기' 경로를 단일 다이얼로그로 통합 (OpenAPI + 워크플로 JSON + cURL)  `[우선순위 높음 · 노력 중간]`
- **왜:** HTTP 워크플로를 만드는 사용자는 정의를 3군데서 각각 들여온다 — 에디터 탑바의 [API](OpenAPI→팔레트), [가져오기](워크플로 JSON), 그리고 HTTP 노드 속성 패널 안의 'cURL 붙여넣기' 버튼. 같은 '외부 정의를 노드로'라는 동작인데 진입점이 위치도 결과(팔레트 적재 vs 그래프 교체 vs 현재 노드 채움)도 제각각이라 '어느 버튼이 내가 원하는 것인지' 혼란스럽다. 특히 API와 가져오기 버튼이 나란히 있어 오조작이 잦다.
- **어떻게:** OpenApiImportDialog.tsx와 WorkflowIODialog.tsx를 탭 기반 단일 ImportExportDialog로 합치고(워크플로 JSON / OpenAPI / cURL / 내보내기), lib/curl.ts의 parseCurl을 그 다이얼로그의 한 탭으로 승격. Editor.tsx 탑바는 [가져오기][내보내기] 2버튼으로 축소, PropertyPanel.tsx:661의 인라인 cURL은 '현재 노드에 반영' 옵션으로 다이얼로그에서 대상(팔레트/새 노드/선택 노드) 선택하게.

### 2. 모달 오버레이/카드/Esc/백드롭 닫기를 공용 <Modal> 프리미티브로 통합  `[우선순위 높음 · 노력 중간]`
- **왜:** AskDialog·ConflictDialog·InputPromptDialog·SettingsDialog·OpenApiImportDialog·WorkflowIODialog·BindingPicker 7개가 동일한 `position:fixed; inset:0; background:rgba(26,29,39,.4)` overlay를 각자 복붙해 정의한다. zIndex(200/220/300)·배경 클릭 닫기·aria-modal·포커스 처리가 미묘하게 제각각이라, 사용자 입장에서 어떤 모달은 바깥 클릭으로 닫히고 어떤 건 안 닫히는 등 동작이 일관되지 않다. useEscapeClose는 이미 있으나 적용이 불균일.
- **어떻게:** components/Modal.tsx 신설(overlay+card+role=dialog+aria-modal+useEscapeClose+백드롭 클릭 닫기+선택적 large variant). 7개 다이얼로그를 이 컴포넌트로 이관하고 각자의 overlay/card CSSProperties 삭제. zIndex 레이어를 상수로 통일(피커>일반 모달>토스트).

### 3. 노드 실행 로그 렌더링을 RunPanel↔Executions 공용 컴포넌트로 통합  `[우선순위 중간 · 노력 중간]`
- **왜:** 에디터 하단 RunPanel(라이브 실행)과 Executions 상세 모달(이력 조회)이 동일한 노드 결과 목록(상태 배지 + requestText/responseText/output pre + 펼침)을 각자 구현한다(RunPanel.tsx, Executions.tsx:144-156). QA가 같은 실행 결과를 두 화면에서 보는데 복사 버튼·필터·펼침 동작이 한쪽에만 있는 등 불일치가 생긴다(RunPanel엔 필터/복사, Executions 모달엔 없음).
- **어떻게:** components/NodeExecutionLog.tsx로 노드 단건 카드(상태 아이콘·req/res/output pre·복사 버튼·펼침)를 추출하고 RunPanel.tsx와 Executions.tsx가 동일 컴포넌트를 쓰게. 상태 필터(all/ok/fail/skip)도 공용 훅으로.

### 4. IF·ASSERT 조건 편집 UI를 공용 <ConditionEditor>로 통합  `[우선순위 중간 · 노력 낮음]`
- **왜:** PropertyPanel.tsx:805-843에서 IF와 ASSERT가 TokenInput+CondSnippets+빈값 경고로 거의 동일한 조건 편집 UI를 중복 정의한다. 두 노드는 실행 의미(분기 vs 실패)만 다를 뿐 조건 작성 경험은 같아야 하는데, 안내 문구/스니펫이 갈라져 유지보수 시 한쪽만 고쳐지는 드리프트가 생긴다.
- **어떻게:** 조건식 TokenInput + CondSnippets + 빈값 경고를 ConditionEditor(mode: 'branch'|'assert')로 묶고 mode에 따라 하단 설명만 분기. PropertyPanel의 두 블록을 이 컴포넌트 호출로 대체. (노드 타입 자체는 실행 의미가 달라 유지.)

### 5. 흩어진 편집기 환경설정을 통합 설정 화면으로 수렴  `[우선순위 중간 · 노력 중간]`
- **왜:** 사용자 설정이 갈 곳이 없다 — SettingsDialog는 콜백 relay base 하나만 다루고, 그리드/미니맵 토글(fl:canvas:grid, fl:canvas:minimap), 자동저장(fl:editor:autosave), 패널 접힘/크기, 팔레트 최근(fl:palette:recent), 협업 닉네임(fl:nick)은 도구(⋯) 메뉴·캔버스 컨트롤·localStorage로 산재한다. '내 편집기 설정을 어디서 바꾸지'가 불명확.
- **어떻게:** SettingsDialog.tsx를 탭 구조(연결/콜백 · 에디터 · 표시 · 협업)로 확장해 위 localStorage 항목들을 한 화면에서 노출. 도구 메뉴/캔버스 컨트롤의 개별 토글은 진실원을 설정 화면과 공유(같은 localStorage 키 구독)하도록 정리.

### 6. 바인딩 표현 이원화(구 bound 구조체 vs 토큰 문자열) 단일화  `[우선순위 중간 · 노력 높음]`
- **왜:** 데이터 참조가 두 형태로 공존한다 — 구 `NodeField.bound`(BindingChip 구조적 칩)와 신 TokenInput 토큰 문자열. PropertyPanel 곳곳이 `f.bound ? bindingToToken(f.bound) : f.value`로 분기하고(200/277/298/323/349 등), SET 시크릿 행만 여전히 bound+BindingChip을 쓴다. 사용자는 같은 '바인딩'인데 어떤 필드는 칩으로, 어떤 필드는 인라인 토큰으로 보여 일관성이 깨진다.
- **어떻게:** 토큰 문자열을 단일 표현으로 확정하고 bound→토큰 이관을 완료(isTokenizable 불가 케이스만 예외 유지). BindingChip은 SET 시크릿 마스킹 전용으로 축소하거나, 시크릿도 마스킹된 TokenInput 변형으로 흡수. PropertyPanel의 bound 분기 제거로 직렬화 헬퍼(bindingToToken) 호출 지점 대폭 감소.

### 7. HTTP form/urlencoded 옵션 중복 제거(respType·bodyType)  `[우선순위 낮음 · 노력 낮음]`
- **왜:** 백엔드는 이미 form과 urlencoded를 동일 처리(parseResponse의 `case form,urlencoded`, bodyKind에서 form==urlencoded)하는데 UI(PropertyPanel respType/bodyType 드롭다운)는 'form'과 'urlencoded'를 별개 선택지로 노출한다. 사용자는 둘 중 무엇을 골라야 할지 근거 없이 고민하게 되고, 저장 그래프에 두 값이 섞여 혼란을 남긴다.
- **어떻게:** UI 드롭다운에서 form/urlencoded를 'urlencoded (form)' 한 옵션으로 통합하고 저장 시 하나로 정규화(로드 시 legacy 'form'→'urlencoded' 매핑). 백엔드 동작 무변경(이미 동일). PropertyPanel.tsx의 KEYED_RESP와 bodyKind 분기 단순화.

### 8. 필드↔Raw 전환 UI를 공용 <FieldOrRaw> 컴포넌트로 통합  `[우선순위 낮음 · 노력 중간]`
- **왜:** 쿼리(Params)·헤더(Headers)·본문(Body)·폼 전송(form)이 각각 자체 [필드|Raw] 토글 + 상태 플래그(paramsRaw/headersRaw/jsonRaw)와 switch 핸들러(switchKvRaw/switchFormRaw)를 중복 보유한다. 변환 로직은 bodyConvert로 공유되지만 토글 UI·플래그·미니세그 버튼이 네 곳에 반복돼, 한 곳의 UX 개선(예: 변환 경고 문구)이 나머지에 반영되지 않는다.
- **어떻게:** [필드|Raw] miniSeg + 변환 경고 + KeyValueEditor/textarea 스위칭을 FieldOrRaw 컴포넌트로 추출하고 Params/Headers/Body/form 슬롯이 rawFlag·rawValue·rows props만 넘기게. bodyConvert 호출은 컴포넌트 내부로.

---

## 8. 나눠야 할 것 (Split)

> 한 곳에 뭉쳐 비대·복잡한 책임을 분리.

### 1. PropertyPanel.tsx(1434줄)를 노드 타입별 서브패널 컴포넌트로 분리  `[우선순위 높음 · 노력 높음]`
- **왜:** 실사용에서 속성 패널은 노드를 클릭할 때마다 여는 가장 빈번한 화면인데, 한 파일에 http/if/assert/set/transform/tcp/form/wait/input/switch/note/group/start/end 14개 타입 섹션과 ReqModeToggle·WaitFieldsEditor·OutputsEditor·VarsEditor·TcpReqEditor·TcpRespEditor·CondSnippets 등 20여 개 헬퍼가 동거한다. HTTP 섹션만 619~805줄(~190줄)이고 bodyType/respType/charset/reqMode/raw토글 상태 헬퍼(switchBodyMode·switchKvRaw·switchFormRaw·changeBodyType·applyCurl·applyPreset)가 다른 타입 로직과 얽혀 있어, HTTP 하나 손대면 전체 파일을 다시 읽어야 하고 회귀 위험이 크다. 새 노드 타입 추가 체크리스트(CLAUDE.md 3번)가 매번 이 거대 파일 편집을 요구한다.
- **어떻게:** panels/nodes/ 디렉터리로 HttpPanel·IfAssertPanel·SetPanel·TransformPanel·TcpPanel·FormPanel·WaitPanel·InputPanel·SwitchPanel·AnnotationPanel(note/group) 분리. PropertyPanel은 공통 헤더(라벨/upstream·downstream 링크/단일노드 실행 버튼)와 node.type→서브패널 디스패치만 담당. VarsEditor/OutputsEditor/TcpReqEditor 등 서브에디터는 panels/editors/로 이동. 상태 헬퍼는 각 타입 패널로 코로케이션. props는 node·updateNodeData·sources만 전달.

### 2. HTTP 노드의 과적재된 모드 축(reqMode/respType/charset/bodyType + jsonRaw·paramsRaw·headersRaw raw토글)을 모델·UI·실행 3곳에서 정돈  `[우선순위 높음 · 노력 높음]`
- **왜:** GraphNode(types.ts)가 http 전용 필드만 15개 이상을 평면으로 갖고, 한 노드가 server/client 전송모드 × 6종 respType × 4종 charset × Params/Headers/Body 각각의 field↔raw 토글을 동시에 표현한다. 그 결과 PropertyPanel·bodyConvert·HttpNodeExecutor.build/parseResponse가 모든 조합을 방어해야 하고, CLAUDE.md에 'keyed→text 전환 시 바인딩 끊김', 'client 모드 charset 미보장', 'raw 모드 req 스코프 미적재' 같은 조합별 예외 경고가 누적돼 있다. 사용자가 실제로 겪는 혼란(‘보이는 것 ≠ 보내는 것’)의 근원.
- **어떻게:** GraphNode 안에 http: { req: {mode,charset}, body:{type,raw,rawText}, params:{raw,rawText}, headers:{raw,rawText}, resp:{type} } 형태의 중첩 http 서브객체로 묶어 http 전용 필드를 격리(raw 저장이라 마이그레이션은 graphAdapter.migrateNode에서 평면→중첩 승격). 백엔드 HttpNodeExecutor의 parseResponse/parseForm/parseXml/parseQuery/coerceJson을 HttpResponseParser 클래스로 분리해 build(요청 조립)와 parse(응답)를 물리 분리.

### 3. ExecutionService.kt(684줄)에서 suspension 내구화·재개 조정 책임을 SuspensionStore로 분리  `[우선순위 높음 · 노력 높음]`
- **왜:** 이 파일은 P2 내구 실행의 심장인데 동시에 너무 많은 책임을 진다: run/resume 오케스트레이션, 워커 풀 제출(inWorker), suspension DB persist·AES-GCM·rehydrate·조건부 DELETE CAS claim, wait 타임아웃 스케줄러, 기동 복구(recoverOnStartup), relay 콜백 수신, ExecutionDetail DTO 조립, 실행 목록. 동시성·내구성 버그(리뷰에서 claim CAS 레이스·rehydrate 실패 방치 등 이미 수정 이력)가 나올 지점인데 한 클래스라 테스트·추론이 어렵다.
- **어떻게:** ① SuspensionStore(persist/rehydrate/claim CAS/캐시 맵) ② WaitTimeoutScheduler(scheduleWaitTimeout/onWaitTimeout/재무장) ③ ExecutionRecovery(recoverOnStartup) ④ ExecutionQuery(get/listForFlow/listRecent/detail/toView) 로 추출하고 ExecutionService는 run/resume/recordWaitCallback 조정만 남긴다. StateCrypto 의존은 SuspensionStore로 이동. 기존 @DataJpaTest CAS 테스트는 SuspensionStore 단위 테스트로 승격.

### 4. Editor.tsx(723줄)에서 실행 폴링 드라이버 루프와 내장 모달들을 분리  `[우선순위 높음 · 노력 중간]`
- **왜:** onRun의 폴링 기반 실행 드라이버(269~391줄: RUNNING/WAITING 폴링·pendingInput/Form/Client 처리·resume·abort)가 패널 리사이즈 상태(paletteW/propertyW/runH·뷰포트 클램프), 단축키 핸들러(코드 기반 C/V/Z/Y/S), 오토세이브, 그리고 JsonViewModal·ShortcutsModal·NodeSearch·IssueBadge 컴포넌트 정의와 한 파일에 섞여 있다. 실행 프로토콜은 내구성의 클라 측 계약이라 독립적으로 테스트·수정돼야 하는데, 패널 UI 변경과 커밋이 뒤엉킨다.
- **어떻게:** 실행 루프를 useRunDriver(flowId) 훅으로 추출(POST→폴링→pending 핸들링→resume→execution/waitStatus 반환, callClientRequest/sleep 동반). 패널 크기·접기·오버레이 상태는 useEditorLayout 훅으로. JsonViewModal/ShortcutsModal/NodeSearch/IssueBadge는 각 파일로 이동. 단축키는 useEditorShortcuts로.

### 5. editorStore.ts(550줄) Zustand 스토어를 슬라이스로 분할  `[우선순위 중간 · 노력 중간]`
- **왜:** 단일 스토어가 캔버스 CRUD(onNodesChange/onConnect/addNode…), undo/redo 히스토리 스택, 클립보드 copy/paste/duplicate + sourceId 재매핑, 정렬/분배(align/distribute/nudge), 팔레트, runView, collab의 applyRemoteGraph를 전부 담는다. 협업(applyRemoteGraph는 히스토리 미적재·에코 방지)과 undo 히스토리가 같은 set() 안에서 상호작용해 회귀가 잘 난다.
- **어떻게:** Zustand slice 패턴으로 canvasSlice(nodes/edges/CRUD)·historySlice(past/future/undo/redo/snapshot)·clipboardSlice(copy/paste/duplicate/remap)·arrangeSlice(align/distribute/autoLayout/nudge)·collabSlice(applyRemoteGraph)로 분리해 한 create()에서 합성. dirty·selectedId 같은 공유 필드만 코어에 둔다.

### 6. FlowExecutor.kt(686줄)의 노드 타입 핸들러들을 NodeExecutor 전략으로 분리  `[우선순위 중간 · 노력 중간]`
- **왜:** drive 루프·resume·snapshot/rehydrate·topoOrder 같은 엔진 코어와, setNode/ifNode/switchNode/assertNode/transformNode/formResumeResult/waitResumeResult/inputResumeResult/tryParseCallbackBody 같은 노드별 처리 로직이 한 클래스에 있다. 노드 타입 추가 체크리스트(백엔드 processNode 핸들러)가 매번 이 파일을 키운다. HttpNodeExecutor·TcpNodeExecutor는 이미 분리돼 있어 나머지도 같은 패턴이 자연스럽다.
- **어떻게:** processNode의 when 분기를 NodeExecutor 인터페이스(execute(node,ctx):NodeResult, resume(node,st,input):NodeResult) 구현들(SetExecutor·IfExecutor·SwitchExecutor·AssertExecutor·TransformExecutor·FormExecutor·WaitExecutor·InputExecutor)로 추출하고 NodeType→executor 맵으로 디스패치. RunState/drive/topo/snapshot은 엔진 코어에 유지. tryParseCallbackBody는 WaitExecutor로 이동.

### 7. Dashboard.tsx(806줄)에서 폴더 트리·드래그앤드롭·선택모드를 분리  `[우선순위 중간 · 노력 중간]`
- **왜:** 탐색기식 대시보드가 flows/folders/runs 쿼리 + 7개 뮤테이션 + 검색/정렬 + 즐겨찾기 + 선택 모드 + 폴더 트리 walk + 카드/폴더/사이드바/브레드크럼 전반의 드래그앤드롭(dragRef·사이클 검증)을 한 컴포넌트에서 조율한다. FlowCard·Hero는 같은 파일에 있고 드래그 콜백이 프롭 드릴링으로 흩뿌려져, 폴더 이동 한 곳 고치려면 전체를 이해해야 한다.
- **어떻게:** 드래그앤드롭을 useFolderDnd 훅(dragRef·startFlowDrag/startFolderDrag·canDrop 사이클 검증·drop 핸들러)으로 추출. 폴더 트리 계산(walk/breadcrumb/tree order)은 lib/folderTree.ts 순수 함수로. FlowCard·Hero·FolderTile은 개별 파일로. Dashboard는 레이아웃·쿼리·현재 폴더 위치(URL)만.

### 8. MockServerEditor.tsx(603줄)를 라우트/규칙/템플릿/콜백/TCP 섹션 컴포넌트로 분리  `[우선순위 낮음 · 노력 중간]`
- **왜:** Mock 편집기 한 컴포넌트가 HTTP 라우트 목록·매칭 조건 규칙(AND, eq/ne/exists/contains)·응답 템플릿(charset/지연/contentType)·콜백 발사 명세·TCP 전문 mock 섹션을 모두 담는다. QA가 실제로 가짜 대상 시스템을 세우는 핵심 화면이라 자주 만지는데, HTTP 규칙과 TCP 리스너 설정이 한 파일이라 한쪽 변경이 다른 쪽을 흔든다.
- **어떻게:** RouteList·RouteRuleEditor·ResponseTemplateEditor·CallbackEditor·TcpMockSection으로 분리하고 MockServerEditor는 spec 상태·저장·탭 전환만. 각 섹션은 spec 일부 슬라이스와 onChange만 받는다.

### 9. TokenInput.tsx(593줄)에서 contentEditable 캐럿/ZWSP 저수준 로직을 훅으로 추출  `[우선순위 낮음 · 노력 중간]`
- **왜:** 인라인 토큰 칩 입력은 URL·조건식·SET 값 등 거의 모든 입력에 쓰이는 핵심 UX인데, DOM 재구성·IME 조합 보존·ZWSP 패딩(ensurePads)·붙여넣기 평문화·copy/cut 토큰 원문 직렬화·overflow 감지(ResizeObserver)·⤢ 큰 편집 다이얼로그가 한 컴포넌트에 있다. Chromium 캐럿 버그 회피 코드가 렌더링·직렬화와 얽혀, 하나 건드리면 IME/한글 조합 회귀가 나기 쉽다.
- **어떻게:** 직렬화(DOM↔토큰 문자열)와 캐럿/ZWSP 관리를 useContentEditableTokens 훅으로 추출(순수 serialize/parse 함수는 lib/tokenDom.ts로 단위 테스트 가능하게). 큰 편집 다이얼로그는 TokenInputDialog로 분리. TokenInput은 렌더 셸만.

---

## 종합

- **강점**: 워크플로+Mock 폐루프, wait 콜백 내구 재개, 그래프 인지 토큰 바인딩, 국내 레거시(EUC-KR/TCP) 친화, 실시간 협업, 단일 jar 배포 — 야심과 완성도가 분명하다.
- **핵심 마찰(반박에서도 유지된 비판)**: (1) 실행 이력 조회 빈약(페이지네이션·기간/노드 검색 없음) (2) 순수 HTTP 체인은 재시작 내구성 0 — 중단 지점에서만 내구 (3) 자동 트리거(스케줄/웹훅) 부재 (4) 버전 롤백/diff UI 부재 (5) 무인증 콜백/mock·앱레벨 테넌시·무샌드박스 플러그인 등 "사내 신뢰망" 전제 리스크.
- **우선 손볼 것(ROI 순)**: 실행 이력 강화(재실행·페이지네이션·필터) → 스케줄/웹훅 트리거 → 버전 히스토리/복원 → PropertyPanel·ExecutionService 분리(유지보수성) → 가져오기/모달 공용화(중복 제거).

> 참고: 이 문서는 에이전트 판단의 종합입니다. 반박에서 "유지됨"으로 남은 비판을 우선 신뢰하고, "약화됨/뒤집힘"은 트레이드오프·전제를 함께 보세요.
