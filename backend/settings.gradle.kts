rootProject.name = "flowlink"

include("flow-agent", "flow-core", "flow-server", "flow-desktop", "flow-mcp")

// desktop/server → core → agent. 중앙 MCP는 server에서만 로드한다.
// agent는 DB가 없고 core는 호스트의 DB 연결·중앙 로그인·Windows 구현에 의존하지 않는다.
