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
  이후엔 클라이언트가 토큰을 기억한다(앱 JWT, 기본 30일). 만료되면 다시 브라우저가 열린다. 게스트 스위치와 무관하게 MCP 는 항상 로그인이다.
  승인 전(PENDING) 사용자는 프로토콜/환경 저장이 403 — `flowlink_status` 로 상태 확인.

표준 MCP Authorization(OAuth 2.1) 그대로다: 무토큰 `POST /mcp` → 401 + `WWW-Authenticate` → `/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`
→ `POST /register`(동적 클라이언트 등록) → `GET /authorize`(로그인 페이지) → `POST /token`(PKCE) → `Authorization: Bearer <앱 JWT>`. 인가 서버는 MCP 서버 자신이고,
issuer 는 요청 Host 로 계산한다(설정값 없음). 등록된 클라이언트는 `~/.flowlink/mcp-clients.json` 에 남아 재시작에도 유지된다. 코드는 `src/oauth.js`.

## 서버

`scripts/start.sh` 가 `FLOWLINK_URL=http://localhost:<port> FLOWLINK_MCP_PORT=18090 node mcp/src/index.js` 로 띄운다(`FLOWLINK_MCP_PORT=0` 이면 안 띄움, `FLOWLINK_MCP_HOST` 로 바인드 주소).
세션 없음(요청마다 독립 McpServer) · 엔드포인트 `POST /mcp` · 헬스 `GET /health`. 요청은 FlowLink 서버에서 나가므로 `http_request` 의 `localhost` 는 서버 자신이다.

## 툴

`flowlink_status` · `flowlink_guide`(flow=노드 레퍼런스·nodes·protocol·mock·rules 원문) ·
`plugin_list`(변환·코덱 플러그인) `transform_preview` · `protocol_list/get/upsert/preview/delete` ·
`mock_list/get/upsert/send/log/delete` · `flow_list/get/upsert/run` `execution_get/list` · `env_list/put` ·
`http_request`(Mock·콜백·웹훅·외부 URL 에 실제 HTTP 요청 — curl/파이썬 대신 이걸로 테스트).

노드 종류·필드는 `flowlink_guide(flow)` 가 각 노드 JSON 예시로 설명한다(start/end/set/if/assert/switch/http/form/wait/input/transform/tcp/note/group).
TRANSFORM 노드나 Mock 코덱은 `plugin_list` 로 사용 가능한 플러그인 id·파라미터를 먼저 확인한다(목록에 없으면 만들지 않는다).

쓰는 법은 그냥 말로: "이 소스의 잔액조회 전문으로 프로토콜 만들고 TCP Mock 세운 뒤 조회→검증 워크플로 만들어 실행해줘. 코드에 없는 값은 메모로 남겨."
→ 에이전트가 guide → protocol_upsert/preview → mock_upsert/send → flow_upsert/run → execution_get/mock_log 순으로 돌고 편집기 링크와 "확인 필요" 메모 목록을 준다.

## 개발

스모크: `npm test` — ① OAuth 한 바퀴는 가짜 FlowLink 로 자급자족(외부 의존 없음), ② 툴 시나리오는 `FLOWLINK_URL=http://localhost:18081`(격리 dev 인스턴스) 가 떠 있을 때만 돈다.
