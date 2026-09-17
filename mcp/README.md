# flowlink-mcp

FlowLink 를 에이전트(Claude Code · VS Code Copilot · Copilot CLI · claude.ai 원격 MCP 등)가 다루게 하는 MCP 서버. 순수 JS, 빌드 없음(Node 20+).
FlowLink 서버 옆에 떠서(`scripts/start.sh` / `start.ps1` 이 jar 와 함께 띄움) Streamable HTTP 로 `http://<flowlink-host>:18090/mcp` 를 연다 — 설치 없음, 토큰 설정 없음.

## 붙이기

클라이언트 설정은 URL 한 줄. 화면 설정(⚙)이 정확한 주소와 등록 명령을 보여준다.

- **Claude Code**: `claude mcp add -s user -t http flowlink http://<flowlink-host>:18090/mcp`
- **VS Code Copilot**: `MCP: Open User Configuration` 에
  ```json
  { "servers": { "flowlink": { "type": "http", "url": "http://<flowlink-host>:18090/mcp" } } }
  ```
- **claude.ai / 웹 에이전트**: 커넥터에 같은 URL(사내망에서 닿아야 한다).

리포를 체크아웃한 개발자는 루트 `.mcp.json`(Claude Code) / `.vscode/mcp.json`(VS Code) 이 `localhost:18090` 을 가리킨다.

## 로그인

- **dev 모드**(FlowLink 인증 없음): 로그인 없음, 바로 쓴다.
- **github 모드**: 처음 연결할 때 클라이언트가 브라우저를 연다 → FlowLink 로그인 화면과 같은 GitHub 디바이스 로그인(코드 입력) → 끝나면 자동으로 돌아온다.
  이후엔 클라이언트가 토큰을 기억한다(앱 JWT, 기본 30일). 만료되면 다시 브라우저가 열린다.
  승인 전(PENDING) 사용자는 프로토콜/환경 저장이 403 — `flowlink_status` 로 상태 확인.
- **github + 게스트 스위치(`FLOWLINK_AUTH_GUEST_ENABLED=true`)**: 에이전트가 로그인 없이 수정하라고 켜 두는 스위치 — MCP 도 로그인을 강요하지 않고 게스트로 통과시킨다
  (읽기·워크플로·Mock 가능, 프로토콜/환경 저장·AI 는 403). 내 이름으로 하려면 클라이언트에서 flowlink 서버를 인증(로그인)하면 된다(Claude Code: `/mcp` → flowlink → Authenticate).

표준 MCP Authorization(OAuth 2.1) 그대로다: 무토큰 `POST /mcp` → 401 + `WWW-Authenticate` → `/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`
→ `POST /register`(동적 클라이언트 등록) → `GET /authorize`(로그인 페이지) → `POST /token`(PKCE) → `Authorization: Bearer <앱 JWT>`. 인가 서버는 MCP 서버 자신이고,
issuer 는 요청 Host 로 계산한다(설정값 없음). 등록된 클라이언트는 `~/.flowlink/mcp-clients.json` 에 남아 재시작에도 유지된다. 코드는 `src/oauth.js`.

## 서버

`scripts/start.sh` 가 `FLOWLINK_URL=http://localhost:<port> FLOWLINK_MCP_PORT=18090 node mcp/src/index.js` 로 띄운다(`FLOWLINK_MCP_PORT=0` 이면 안 띄움, `FLOWLINK_MCP_HOST` 로 바인드 주소).
세션 없음(요청마다 독립 McpServer) · 엔드포인트 `POST /mcp` · 헬스 `GET /health`. 요청은 FlowLink 서버에서 나가므로 `http_request` 의 `localhost` 는 서버 자신이다.

## 툴

워크스페이스·폴더는 **이름(또는 "상위/하위" 경로)** 으로 지목한다 — "개인 워크스페이스의 결제/카드 폴더에 워크플로 만들어줘"가 그대로 된다. 목록은 로그인한 사용자 기준(서버가 JWT 로 스코프: 공용 + 내 개인 + 내가 멤버인 팀; 게스트는 공용만).

- 상태·가이드: `flowlink_status` · `flowlink_guide`(flow=노드 레퍼런스·nodes·protocol·mock·rules 원문)
- 워크스페이스·폴더: `workspace_list` `workspace_get`(폴더 트리+워크플로+Mock 한눈에) `workspace_export/import` · `folder_list/create/update/delete`
- 프로토콜: `protocol_list/get/upsert/preview/delete`
- Mock: `mock_list(workspace)/get/upsert(workspace)/send/log/delete` · `mock_versions/version`(조회·복원·고정) `mock_state/reset/clear_log` `mock_usages`(어느 워크플로가 쓰는지) `codec_try`
- 워크플로: `flow_list(workspace, folder)/get/upsert(workspace, folder)/update`(이름·설명·폴더 이동)`/delete` · `flow_versions/version`(조회·복원·고정) `flow_run_input`
- 실행: `flow_run` `execution_get/list`(status·workspace 필터) `execution_resume`(input 노드 값 입력·client 노드 대신 호출·form 명세 반환) `execution_rerun` `node_run`(노드 하나만) `suite_run`(폴더/여러 워크플로 일괄)
- 환경·시크릿: `env_list/put/rename/delete` · `secret_list`(이름만)
- 플러그인: `plugin_list`(변환·코덱) `transform_preview`
- `http_request`(Mock·콜백·웹훅·외부 URL 에 실제 HTTP 요청 — curl/파이썬 대신 이걸로 테스트)

화면 몫으로 남긴 것: 트리거(스케줄·웹훅), 관리자(사용자 승인·purge), 앱 내 AI, 설정(relay·notify), 플러그인 JAR 업로드, 시크릿 값 저장.

노드 종류·필드는 `flowlink_guide(flow)` 가 각 노드 JSON 예시로 설명한다(start/end/set/if/assert/switch/http/form/wait/input/transform/tcp/note/group).
TRANSFORM 노드나 Mock 코덱은 `plugin_list` 로 사용 가능한 플러그인 id·파라미터를 먼저 확인한다(목록에 없으면 만들지 않는다).

쓰는 법은 그냥 말로: "이 소스의 잔액조회 전문으로 프로토콜 만들고 TCP Mock 세운 뒤 조회→검증 워크플로 만들어 실행해줘. 코드에 없는 값은 메모로 남겨."
→ 에이전트가 guide → protocol_upsert/preview → mock_upsert/send → flow_upsert/run → execution_get/mock_log 순으로 돌고 편집기 링크와 "확인 필요" 메모 목록을 준다.

## 개발

스모크: `npm test` — ① OAuth 한 바퀴는 가짜 FlowLink 로 자급자족(외부 의존 없음), ② 툴 시나리오는 `FLOWLINK_URL=http://localhost:18081`(격리 dev 인스턴스) 가 떠 있을 때만 돈다.
