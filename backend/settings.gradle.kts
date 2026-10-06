rootProject.name = "flowlink"

include("flow-agent", "flow-server", "flow-desktop", "flow-mcp")

// flow-server → flow-agent/flow-mcp, flow-desktop → flow-server(일반 관리 라이브러리)/flow-agent.
// flow-agent에는 DB/관리 구현이 없고 중앙 flow-mcp와 SDK는 desktop에 포함하지 않는다.
