# flowlink-mcp

FlowLink 를 에이전트(Claude Code 등)가 다루게 하는 MCP 서버(stdio). 빌드 없음 — Node 22.6+ 가 `.ts` 를 그대로 실행한다.

```bash
cd mcp && npm i
FLOWLINK_URL=http://localhost:8888 node src/index.ts      # 직접 실행(디버그)
```

Claude Code: 리포 루트의 `.mcp.json` 이 이 서버를 등록한다(`FLOWLINK_URL` 만 맞추면 됨). 다른 곳에서 쓰려면
`claude mcp add flowlink -e FLOWLINK_URL=http://host:port -- node D:/TP/FLOWLINK/mcp/src/index.ts`.

인증: dev 모드는 없음. github 모드는 `flowlink_login` → 브라우저에서 코드 입력 → `flowlink_login_wait` (토큰은 `~/.flowlink/mcp-token.json`), 또는 `FLOWLINK_TOKEN` env.

툴: `flowlink_status` `flowlink_login` `flowlink_login_wait` `flowlink_logout` `flowlink_guide` · `protocol_list/get/upsert/preview/delete` ·
`mock_list/get/upsert/send/log/delete` · `flow_list/get/upsert/run` `execution_get/list` · `env_list/put`.

스모크 테스트(격리 인스턴스 필요): `FLOWLINK_URL=http://localhost:18081 npm test`
