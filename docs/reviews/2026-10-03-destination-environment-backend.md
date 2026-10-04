# 실행 위치별 환경 해석: 백엔드 검증

회의 수렴 후 구현. HTTP 주소/TCP 호스트의 새 도메인은 추가하지 않고 기존 @env 토큰/바인딩을 유지한다. 신규 노드 필드는 tcpPortEnvKey 하나다.

- RunRequest.agentEnvironments: local 또는 server:<workspaceUUID|public> → 환경 이름. 빈 문자열은 명시적 공통 선택.
- 우선순위: node.agentEnvironment(빈 문자열 포함), map.containsKey, 동일 실행기/공간의 run.envName. 경계를 넘는데 선택이 없으면 실패하며 작업을 생성하지 않는다.
- AgentRunOptions와 DB 실행 스냅샷/rerun에 매핑 전달. 명시적 공통/override 선택에는 소유 실행기의 env seed를 전달하지 않는다.
- 목적지 실행기는 자신의 env/secret을 조회한다. forged crossBoundary request의 null 환경도 실패한다.
- 명시적 @env/@secret 토큰 및 binding 누락은 빈 문자열로 조용히 요청하지 않고 오류로 처리한다. HTTP headers/body 및 request-scope 참조도 검사한다.
- tcpPortEnvKey는 목적지 환경에서 숫자를 읽고 1..65535를 검증하며 기존 tcpPort보다 우선한다. 누락/빈/잘못된 값은 기존 포트로 fallback하지 않는다.
- inspect는 기존 dependencyHashes와 별도 targetDiagnostics를 반환한다. HTTP URL userinfo/query를 제거하고 활성 시크릿을 마스킹한다. 상류 주소는 deferred(null)+자동 치환 없음 경고. requester는 browser/agent로 구분한다. 자원 해석 확인은 네트워크 접속 가능 확인이 아니다.
- 명시 Mock은 동일 목적지 실행기의 Mock을 우선 사용한다. 레거시 browser+agentMock 조합은 실효 주소를 오진하지 않고 요청 방식 전환을 안내한다.
- 기존 단일 노드 API에 agent/공간/환경/Mock/map 설정이 있으면 onlyNodeId 실행 API를 사용하도록 명확히 실패한다. 기존 TCP preview는 envName query를 받으며 목적지 설정 노드는 목적지 preview API를 안내한다. owner 환경 이름의 존재도 검사한다.

## 검증

Java21 Gradle targeted agent/endpoint/desktop bindings PASS. 첫 full315 중5개 실패는 기존 managed integration fixture가 cross 목적지 환경을 선택하지 않아 변경 계약대로 FAILED가 된 것. fixture에 local:'' 선택을 추가하고 미선택 FAILED/noTask 생성 회귀를 추가했다. 수정 후 full318 tests, failures0/errors0 PASS(55s). 마지막 browser+Mock 진단 guard와 nonaddress 경고 조정 후 AgentTargetDiagnosticsTest/EndpointResolverTest focused7 PASS(9s). 총 테스트 소스319개.

실제 HttpNodeExecutor.build에서 같은 노드가 환경별 PC IP/server DNS를 사용하고 missing secret이 요청 전 실패하는 회귀 포함. 비밀 URL userinfo/query/path 마스킹, 포트 no-fallback, 환경 우선순위와 seed-noop 우회 방지, 명시 공통 선택 및 미선택 noTask 검증 포함.

MCP 프로토콜/도구/IDE 등록은 테스트하지 않았다. frontend/installer/native runtime/Docker 배포는 이 작업에서 변경하지 않았다.

추가 최소 보완: FORM/INPUT은 owner 자원을 사전 inspect하고 실제 실행 도달 시에도 누락 참조를 검사한다. FORM action+활성 body/raw만, INPUT waitMsg만 검사한다. legacy executionAgent/agentMock 설정은 실제 owner 협업 처리와 같이 inspect에서 무시한다. FORM URL은 sanitized/secret masked, requester browser/source owner-environment로 표시한다. WAIT callbackRespBody는 literal 반환이고 SWITCH는 고정 switchActive 선택이므로 참조 검사에서 제외한다. 비활성 FORM rawBody/port와 WAIT literal을 정상 처리하는 실제 engine 반례 포함. 최종 focused11 PASS(7s), 신규 총 테스트 소스322개.

## 실제 두 PC + Docker 서버 통합

최신 JAR SHA256: C54453D8A4D879804E892C88A09F441E32A0F9F783C785869C373A1A3D3477E3. frontend index-DW1fyy9Z.js 포함 확인.

서버18080를 기존 agent-lab compose 데이터 그대로 재배포하고, 기존 preview18182 업데이트 후 별도 peer PC18186(H2/data/device 분리)을 실행했다. scripts/test/environment-routing.ps1 17 checks 모두 PASS. 동일 팀 graph를 변경하지 않고 PC-A/PC-B 각각의 localhost 포트/환경 이름/시크릿과 서버의 Docker DNS server:18080/서버 환경/시크릿으로 실제 HTTP 실행 성공. 각 PC H2 환경 binding은 서로 승계하지 않았고 저장 후 재조회 성공. 실행 이력의 credential plaintext 없음. 누락 목적지 참조는 inspect에서 ready false, cross PC environment mapping 미선택은 FAILED로 공통 credential 자동 실행 없음.

fixture 스크립트 PS5.1 nested-array 파싱을 직접 pipeline 열거로 수정했고 빈 Properties.Count도 @(...).Count로 수정했다. 기대값 완화 없음. private evidence: .run/agent-lab/preview/environment-routing-result.json. installed18180 PID28968 유지, preview18182 PID33600, peer18186 PID59916 실행 유지. Oracle18183와 MSI는 변경하지 않았다. 기존 MCP 서비스는 서버 namespace 재생성에 맞춰 존재를 유지했지만 프로토콜/도구/IDE 등록 호출은 하지 않았다.

최종 UI 대비 CSS 최소 수정 반영 후 server18080/preview18182만 재갱신했다. 현재 JS index-Dtr3ZvFQ.js/CSS index-DwowFxS1.css를 두 runtime HTTP에서 확인. 최신 JAR SHA256 09B65EC2FE45A6D4BEB779C097E7826632EF71F9C9D6C34AE8E2850D4FB7DCFF. preview H2 binding GET와 revision은 재시작 전후 정확히 동일. preview PID65376. peer18186 PID59916은 17체크에 사용한 이전 index-DW1fyy9Z.js UI bundle/C544... JAR을 유지하며 backend 코드는 동일하다. installed18180 PID28968 및 MSI/Oracle 변경 없음. 17체크 반복 없이 binding 보존과 최종 asset 일치만 확인했다.

실제 Mock UI 검토 후 진단 갭 최소 수정: HTTP Mock 사전 진단이 base URL만 반환하던 것을 실행과 공유하는 resolveMockNode + EndpointResolver로 변경했다. node.path를 실제 엔진과 동일하게 이어 붙이며 자동 slash/path 변경은 하지 않는다. TCP Mock은 실제 listener host:port를 표시하고 overriding tcpPortEnvKey는 무시한다. query/userinfo 삭제·secretmask 유지. Mock에서는 고정 주소 자동치환 없음 경고를 제외하고 네트워크 미확인/상류 경로/외부 callback 경고를 유지한다. 상류 path가 미정이면 resolvedTarget null/source upstream-binding을 유지하며 완성 주소만 source destination-mock이다. requester agent 필드도 일치한다. actual HttpNodeExecutor.build와 동일 URL, slash 유지, secret path masking, upstream deferred, TCP listener override 회귀3개 추가. focused20 PASS(20s), 마지막 source 표기 계약 변경 후 focused4 PASS(7s). 실제 runtime inspect는 최신 JAR 준비 후 별도 확인한다.

최신 Mock 진단 JAR 재배포 후 실제 inspect4 체크 PASS: HTTP Mock resolvedTarget에 node.path /probe 포함, upstream path는 ready true/null target/source upstream-binding 유지, 기존 TCP Mock의 LISTENING 127.0.0.1:52638과 resolvedTarget 정확히 일치(기존 port7/tcpPortEnvKey 무시), Mock 고정주소 경고 없음. private evidence .run/agent-lab/preview/mock-target-inspection-result.json. server18080/preview18182 HTTP index-_HT7zFFH.js 확인. 최종 JAR SHA256 D567AD0B381432C1010D5D581A2D2F572B1147828BFFDD21EDB71A9EBDF2B5F3, preview PID26288. installed18180 PID28968/peer18186 PID59916/MSI/Oracle 변경 없음.
