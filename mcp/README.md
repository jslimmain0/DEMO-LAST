# flowlink-mcp

FlowLink 를 에이전트(Claude Code · VS Code Copilot · Copilot CLI 등)가 다루게 하는 MCP 서버(stdio). 순수 JS, 빌드 없음(Node 20+).

## 설치 (한 번, 어느 폴더에서든)

FlowLink 서버가 자기 MCP 패키지를 직접 나눠준다 — 서버 버전과 항상 맞는다.

```bash
npm i -g http://<flowlink-host>:8888/mcp/flowlink-mcp.tgz     # → flowlink-mcp 명령
flowlink-mcp --help 대신: FLOWLINK_URL=http://<flowlink-host>:8888 flowlink-mcp   # stdio 라 그냥 대기하면 정상
```

업데이트는 같은 명령을 다시. 제거 `npm rm -g flowlink-mcp`.

## 등록 (사용자 레벨 — 프로젝트 무관)

- **VS Code Copilot**: `Ctrl+Shift+P` → `MCP: Open User Configuration` 에
  ```json
  { "servers": { "flowlink": { "type": "stdio", "command": "flowlink-mcp", "env": { "FLOWLINK_URL": "http://<flowlink-host>:8888" } } } }
  ```
  Copilot Chat 을 **Agent** 모드로 두고 🔧 툴 목록에서 flowlink 가 켜져 있으면 끝.
- **Claude Code**: `claude mcp add -s user flowlink -e FLOWLINK_URL=http://<flowlink-host>:8888 -- flowlink-mcp`
- **Copilot CLI**: `/mcp add` → 이름 `flowlink`, 명령 `flowlink-mcp`, env `FLOWLINK_URL=…`

리포를 체크아웃한 개발자는 설치 없이 루트 `.mcp.json`(Claude Code) / `.vscode/mcp.json`(VS Code) 이 소스(`mcp/src/index.js`)를 바로 띄운다(`cd mcp && npm i` 필요).

## 로그인

- **dev 모드**: 로그인 없음(전권).
- **github 모드(기본)**: 모든 API 로그인 필수. 에이전트가 `flowlink_login` 을 부르면 디바이스 코드가 나오고,
  사용자가 `github.com/login/device` 에서 코드를 입력하면 `flowlink_login_wait` 가 토큰을 `~/.flowlink/mcp-token.json` 에 저장한다.
  토큰은 장기 유효(기본 30일 — 서버 `FLOWLINK_AUTH_TOKEN_TTL_HOURS`)라 한 번 로그인하면 계속 쓴다. `FLOWLINK_TOKEN` env 로도 대체 가능.
- **github + 게스트 스위치(`FLOWLINK_AUTH_GUEST_ENABLED=true`)**: 에이전트가 로그인 없이 읽기·워크플로·Mock 을 쓸 수 있다
  (AI·프로토콜/환경 저장은 여전히 승인 사용자 필요). 브라우저 UI 는 이 스위치와 무관하게 항상 로그인 화면을 띄운다 —
  게스트 통로는 에이전트용이다. 로그인 필요 여부는 언제든 `flowlink_status` 로 확인한다.

## 툴

`flowlink_status` `flowlink_login` `flowlink_login_wait` `flowlink_logout` `flowlink_guide`(flow·protocol·mock·rules 규격 원문) ·
`protocol_list/get/upsert/preview/delete` · `mock_list/get/upsert/send/log/delete` · `flow_list/get/upsert/run` `execution_get/list` · `env_list/put`.

쓰는 법은 그냥 말로: "이 소스의 잔액조회 전문으로 프로토콜 만들고 TCP Mock 세운 뒤 조회→검증 워크플로 만들어 실행해줘. 코드에 없는 값은 메모로 남겨."
→ 에이전트가 guide → protocol_upsert/preview → mock_upsert/send → flow_upsert/run → execution_get/mock_log 순으로 돌고 편집기 링크와 "확인 필요" 메모 목록을 준다.

## 개발

스모크(격리 인스턴스 필요): `FLOWLINK_URL=http://localhost:18081 npm test` (+ `FLOWLINK_GH_URL=http://localhost:18082` 로 github 모드 검사).
서버 tgz 는 `gradle bootJar` 가 `backend/build/mcp/flowlink-mcp.tgz` 로 만들어 jar 의 `static/mcp/` 에 동봉한다(npm 불필요).
