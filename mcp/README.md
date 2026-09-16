# flowlink-mcp

FlowLink 를 에이전트(Claude Code · VS Code Copilot · Copilot CLI · claude.ai 원격 MCP 등)가 다루게 하는 MCP 서버. 순수 JS, 빌드 없음(Node 20+).
툴 코드는 하나이고 전송이 둘이다:

| | **HTTP(서빙, 권장)** | **stdio(설치형)** |
|---|---|---|
| 뜨는 곳 | FlowLink 서버 옆(`scripts/start.sh` 가 jar 와 함께 띄움) | 사용자 PC |
| 붙는 법 | URL 한 줄 `http://<flowlink-host>:18090/mcp` | `npm i -g …tgz` 후 명령 등록 |
| 웹 에이전트(claude.ai 등) | 가능 | 불가 |
| 로그인 | 클라이언트 설정의 `Authorization: Bearer <토큰>` 헤더(화면 ⚙ → **MCP 토큰 복사**) | `flowlink_login` 툴(디바이스 코드) 또는 `FLOWLINK_TOKEN` |
| `http_request` 출발점 | FlowLink 서버(`localhost` = 서버 자신) | 내 PC(로컬 서비스 테스트 가능) |

## HTTP 모드 (서빙 — 설치 없음)

`scripts/start.sh` / `start.ps1` 이 jar 옆에 `node mcp/src/index.js --http` 를 띄운다(포트 `FLOWLINK_MCP_PORT`, 기본 18090, `0` 이면 안 띄움).
Streamable HTTP · **세션 없음**(요청마다 독립) · 엔드포인트 `POST /mcp` · 헬스 `GET /health`. 화면 설정(⚙)이 접속 주소와 등록 명령을 보여준다.

- **Claude Code**: `claude mcp add -s user -t http flowlink http://<flowlink-host>:18090/mcp`
  로그인이 필요한 서버면 `-H "Authorization: Bearer <토큰>"` 을 붙인다.
- **VS Code Copilot**: `MCP: Open User Configuration` 에
  ```json
  { "servers": { "flowlink": { "type": "http", "url": "http://<flowlink-host>:18090/mcp", "headers": { "Authorization": "Bearer <토큰>" } } } }
  ```
- **claude.ai / 웹 에이전트**: 커넥터에 같은 URL(사내망에서 닿아야 한다).

토큰은 브라우저에서 GitHub 로그인한 사용자의 앱 JWT 그대로다(설정 → MCP 토큰 복사, 로그인과 같은 기간 유효 — 기본 30일).
헤더가 없으면 게스트(게스트 스위치가 켜진 서버에서 읽기·워크플로·Mock 가능), 있으면 그 사용자로 저장된다. 서버는 이 토큰을 검증만 하고 따로 인증하지 않는다 — 사내 도구 전제.
`flowlink_login*` 툴은 로컬 토큰 파일이 전제라 HTTP 모드엔 없다.

직접 띄우기: `FLOWLINK_URL=http://localhost:18080 FLOWLINK_MCP_PORT=18090 node mcp/src/index.js --http` (`FLOWLINK_MCP_HOST` 로 바인드 주소, 기본 0.0.0.0).

## stdio 모드 — 설치 (한 번, 어느 폴더에서든)

FlowLink 서버가 자기 MCP 패키지를 직접 나눠준다 — 서버 버전과 항상 맞는다.

```bash
npm i -g http://<flowlink-host>:8888/mcp/flowlink-mcp.tgz     # → flowlink-mcp 명령
flowlink-mcp --help 대신: FLOWLINK_URL=http://<flowlink-host>:8888 flowlink-mcp   # stdio 라 그냥 대기하면 정상
```

업데이트는 같은 명령을 다시. 제거 `npm rm -g flowlink-mcp`.

## stdio 모드 — 등록 (사용자 레벨 — 프로젝트 무관)

- **VS Code Copilot**: `Ctrl+Shift+P` → `MCP: Open User Configuration` 에
  ```json
  { "servers": { "flowlink": { "type": "stdio", "command": "flowlink-mcp", "env": { "FLOWLINK_URL": "http://<flowlink-host>:8888" } } } }
  ```
  Copilot Chat 을 **Agent** 모드로 두고 🔧 툴 목록에서 flowlink 가 켜져 있으면 끝.
- **Claude Code**: `claude mcp add -s user flowlink -e FLOWLINK_URL=http://<flowlink-host>:8888 -- flowlink-mcp`
- **Copilot CLI**: `/mcp add` → 이름 `flowlink`, 명령 `flowlink-mcp`, env `FLOWLINK_URL=…`

리포를 체크아웃한 개발자는 설치 없이 루트 `.mcp.json`(Claude Code) / `.vscode/mcp.json`(VS Code) 이 소스(`mcp/src/index.js`)를 바로 띄운다(`cd mcp && npm i` 필요).

## 로그인 (stdio)

HTTP 모드는 위 헤더 토큰 한 가지다. stdio 는:

- **dev 모드**: 로그인 없음(전권).
- **github 모드(기본)**: 모든 API 로그인 필수. 에이전트가 `flowlink_login` 을 부르면 디바이스 코드가 나오고,
  사용자가 `github.com/login/device` 에서 코드를 입력하면 `flowlink_login_wait` 가 토큰을 `~/.flowlink/mcp-token.json` 에 저장한다.
  토큰은 장기 유효(기본 30일 — 서버 `FLOWLINK_AUTH_TOKEN_TTL_HOURS`)라 한 번 로그인하면 계속 쓴다. `FLOWLINK_TOKEN` env 로도 대체 가능.
- **github + 게스트 스위치(`FLOWLINK_AUTH_GUEST_ENABLED=true`)**: 에이전트가 로그인 없이 읽기·워크플로·Mock 을 쓸 수 있다
  (AI·프로토콜/환경 저장은 여전히 승인 사용자 필요). 브라우저 UI 는 이 스위치와 무관하게 항상 로그인 화면을 띄운다 —
  게스트 통로는 에이전트용이다. 로그인 필요 여부는 언제든 `flowlink_status` 로 확인한다.

## 툴

`flowlink_status` `flowlink_login` `flowlink_login_wait` `flowlink_logout`(로그인 3개는 stdio 전용) `flowlink_guide`(flow=노드 레퍼런스·nodes·protocol·mock·rules 원문) ·
`plugin_list`(변환·코덱 플러그인) `transform_preview` · `protocol_list/get/upsert/preview/delete` ·
`mock_list/get/upsert/send/log/delete` · `flow_list/get/upsert/run` `execution_get/list` · `env_list/put` ·
`http_request`(Mock·콜백·웹훅·외부 URL 에 실제 HTTP 요청 — curl/파이썬 대신 이걸로 테스트).

노드 종류·필드는 `flowlink_guide(flow)` 가 각 노드 JSON 예시로 설명한다(start/end/set/if/assert/switch/http/form/wait/input/transform/tcp/note/group).
TRANSFORM 노드나 Mock 코덱은 `plugin_list` 로 사용 가능한 플러그인 id·파라미터를 먼저 확인한다(목록에 없으면 만들지 않는다).

쓰는 법은 그냥 말로: "이 소스의 잔액조회 전문으로 프로토콜 만들고 TCP Mock 세운 뒤 조회→검증 워크플로 만들어 실행해줘. 코드에 없는 값은 메모로 남겨."
→ 에이전트가 guide → protocol_upsert/preview → mock_upsert/send → flow_upsert/run → execution_get/mock_log 순으로 돌고 편집기 링크와 "확인 필요" 메모 목록을 준다.

## 개발

스모크(격리 인스턴스 필요): `FLOWLINK_URL=http://localhost:18081 npm test` (+ `FLOWLINK_GH_URL=http://localhost:18082` 로 github 모드 검사).
서버 tgz 는 `gradle bootJar` 가 `backend/build/mcp/flowlink-mcp.tgz` 로 만들어 jar 의 `static/mcp/` 에 동봉한다(npm 불필요).
