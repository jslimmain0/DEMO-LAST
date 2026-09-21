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

- 상태·가이드: `flowlink_status`(승인 대기 플러그인 수도 함께) · `flowlink_guide`(flow=노드 레퍼런스·nodes·protocol·mock·**plugin**·rules 원문)
- 워크스페이스·폴더: `workspace_list` `workspace_get`(폴더 트리+워크플로+Mock 한눈에) `workspace_export/import` · `folder_list/create/update/delete`
- 프로토콜: `protocol_list/get/upsert/preview/delete`
- Mock: `mock_list(workspace)/get/upsert(workspace)/send/log/delete` · `mock_versions/version`(조회·복원·고정) `mock_state/reset/clear_log` `mock_usages`(어느 워크플로가 쓰는지) `codec_try`
- 워크플로: `flow_list(workspace, folder)/get/upsert(workspace, folder)/update`(이름·설명·폴더 이동)`/delete` · `flow_versions/version`(조회·복원·고정) `flow_run_input`
- 실행: `flow_run` `execution_get/list`(status·workspace 필터) `execution_resume`(input 노드 값 입력·client 노드 대신 호출·form 명세 반환) `execution_rerun` `node_run`(노드 하나만) `suite_run`(폴더/여러 워크플로 일괄)
- 환경·시크릿: `env_list/put/rename/delete` · `secret_list`(이름만)
- 플러그인(쓰기): `plugin_list`(쓸 수 있는 승인본 — 변환·코덱) `transform_preview`
- 플러그인(만들기, JS 스크립트): `plugin_script_list/get` · `plugin_script_try`(저장 없이 샌드박스 1회 실행, 컴파일 오류는 "N행 M열") ·
  `plugin_script_upsert`(초안 저장) · `plugin_script_submit`(승인 요청/철회) · `plugin_script_wait`(승인/반려를 기다렸다가 사용자에게 알림)
- `http_request`(Mock·콜백·웹훅·외부 URL 에 실제 HTTP 요청 — curl/파이썬 대신 이걸로 테스트)

화면 몫으로 남긴 것: 트리거(스케줄·웹훅), 관리자(사용자 승인·purge, **플러그인 승인/반려**), 앱 내 AI, 설정(relay·notify), 시크릿 값 저장.
(플러그인 JAR 업로드는 없어졌다 — 플러그인은 화면 `/plugins` 또는 위 `plugin_script_*` 로 JS 를 적고 관리자가 승인한다.)

노드 종류·필드는 `flowlink_guide(flow)` 가 각 노드 JSON 예시로 설명한다(start/end/set/if/assert/switch/http/form/wait/input/transform/tcp/note/group).
### 암복호화·해시·서명은 플러그인으로 — 붙이는 자리 넷

| 어디에 | kind | 붙이는 곳 |
|---|---|---|
| 전문의 필드 하나(카드번호·계좌번호) | `fieldCodec` | 프로토콜 spec 의 `Field.plugin = { id, config }` |
| 전문 본문 전체(헤더는 평문) | `messageCodec` | 프로토콜 spec 의 `messagePlugins` |
| Mock 요청/응답 | `transform` | Mock spec 의 `codec.request[] / codec.response[]` |
| 워크플로 값 하나 | `transform` | TRANSFORM 노드의 `transformId` |

쓸 수 있는 id 는 `plugin_list`(승인본만). 없으면 만든다: `plugin_script_upsert` → `plugin_script_try` → `plugin_script_submit` → `plugin_script_wait`.
스크립트 안에서는 `fl.*` 만 쓴다(Java·파일·네트워크 없음) — AES/SEED/ARIA/DES/3DES(CBC·ECB·CTR·CFB·OFB·GCM), RSA(암복호화·서명), ECDSA, JWT, HMAC·해시·PBKDF2,
CRC/BCC/LRC, 난수·gzip·인코딩. 전체 목록과 시그니처는 `flowlink_guide(plugin)`(편집기 📖 레퍼런스와 같은 원천).
키·IV 는 스크립트에 박지 말고 파라미터로 받아 `{{ 이름@secret }}`(시크릿 볼트)·`{{ 키@env }}`(환경 변수)로 채운다 — 서버가 실행 환경으로 푼다.
시크릿 값은 MCP 로 저장할 수 없다 — 필요한 이름을 사용자에게 요청하고 채워질 때까지 기다린다. 환경 변수도 이름만 정해 묻고 값을 받아 `env_put` 한다(임시 키·더미 값으로 대신 채우지 않는다).
알고리즘·모드·패딩·키 출처처럼 코드로 알 수 없는 건 추측하지 말고 그때그때 사용자에게 1~2개씩 물어라(`flowlink_guide(rules)` 7번).

### 막히면 보고하고 기다린다

같은 곳에서 두 번 실패하면 억지로 뚫지 말고 멈춘다. **사용자 소스 코드는 고치지 않는다** — 전문·응답이 안 맞으면 소스가 틀렸을 수도 있지만 그 판단은 사용자 몫이다.
규격을 임의로 바꾸거나 assert 를 지워 "일단 통과"시키는 우회도 하지 않는다. 하려던 것 / 막힌 지점(에러 원문·실행 id·mock 로그) / 원인 후보 / 결정해 줄 것, 네 줄로 보고하고 입력을 기다린다(`flowlink_guide(rules)` 8번).

쓰는 법은 그냥 말로: "이 소스의 잔액조회 전문으로 프로토콜 만들고 TCP Mock 세운 뒤 조회→검증 워크플로 만들어 실행해줘. 코드에 없는 값은 메모로 남겨."
→ 에이전트가 guide → protocol_upsert/preview → mock_upsert/send → flow_upsert/run → execution_get/mock_log 순으로 돌고 편집기 링크와 "확인 필요" 메모 목록을 준다.

## 개발

스모크: `npm test` — ① OAuth 한 바퀴는 가짜 FlowLink 로 자급자족(외부 의존 없음), ② 툴 시나리오는 `FLOWLINK_URL=http://localhost:18081`(격리 dev 인스턴스) 가 떠 있을 때만 돈다.
