# 중앙 MCP

`flow-mcp`는 `flow-server`가 로드하는 Kotlin 라이브러리다. 같은 Tomcat의 `/mcp`에서 Streamable HTTP를 제공한다. 별도 Node 프로세스·18090 포트·PC stdio MCP는 사용하지 않는다. Windows MSI에는 Java 런타임과 개인 앱을 포함하며 Node/MCP 소스는 포함하지 않는다. Node/npm은 프론트엔드를 빌드하는 개발 PC에만 필요하다.

사내 서버의 HTTPS 주소 하나를 `FLOWLINK_PUBLIC_URL`로 지정하면 화면·API와 `/mcp`가 같은 주소를 사용한다. `FLOWLINK_MCP_ENABLED=false`로 중앙 MCP를 끌 수 있다. 개인 앱에는 이 라이브러리와 MCP SDK가 들어가지 않는다.

```json
{
  "servers": {
    "flowlink": {
      "type": "http",
      "url": "https://flowlink.example.internal/mcp"
    }
  }
}
```

Windows 앱에서 회사 계정에 로그인하면 중앙 서버가 FlowLink MCP 전용 Bearer 토큰을 발급한다. desktop은 VS Code·IntelliJ Copilot 사용자 설정에 중앙 URL과 인증 헤더를 자동 반영한다. IDE에서 별도로 회사 계정 OAuth 로그인할 필요는 없으며 도구 사용 승인은 IDE에서 진행한다. GitHub 토큰과 일반 앱 로그인 토큰을 IDE 설정에 넣지 않는다.

VS Code는 `%APPDATA%/Code/User/mcp.json`(Insiders·기존 사용자 프로필 포함)의 `headers.Authorization`, IntelliJ Copilot은 `%LOCALAPPDATA%/github-copilot/intellij/mcp.json`의 `requestInit.headers.Authorization`을 사용한다. 설치된 IDE의 사용자 설정 경로만 찾으며 다른 서버 항목은 보존한다. 사용자가 FlowLink 항목을 직접 변경했거나 JSON이 손상된 경우 자동 덮어쓰기를 중단하고 앱에서 확인을 안내한다. IDE를 처음 실행한 뒤 앱의 **IDE 자동 연결 → 설정 다시 확인**을 사용할 수 있다.

PC에는 발급받은 자격과 설정 소유권을 기존 개인 키로 암호화해 저장한다. IDE 사용자 설정에 쓰는 Bearer 토큰은 해당 사용자만 읽도록 파일 권한을 제한하고 프로젝트 설정에 쓰지 않는다. 만료 전에 새 토큰을 받아 설정을 갱신한다. 로그아웃·서버/계정 변경 때 앱이 만든 항목만 정리하고 중앙 자격을 해제한다. 서버가 오프라인이면 암호화된 해제 요청을 보관해 다시 처리한다. 설정 상태는 앱의 연결 화면에서 보며 실제 프로토콜 연결 성공을 대신하지 않는다.

중앙 `POST /api/v1/auth/mcp-tokens`, `POST /api/v1/auth/mcp-tokens/{id}/refresh`, `DELETE /api/v1/auth/mcp-tokens[/{id}]`는 일반 앱 로그인으로 보호한다. 전용 토큰은 `flowlink-mcp` audience·목적·scope와 앱 세션/장치/클라이언트에 묶이고 최대 7일 또는 원본 로그인 만료 중 빠른 시점에 만료된다. 일반 관리 API는 MCP 토큰을 거부한다. 서버는 토큰 원문 대신 해시를 영속 저장하며 `/mcp`에서는 만료·폐기·계정 승인·현재 DB 권한을 확인한다. 저장 경로는 `flowlink.mcp.tokens-file`(기본 서버 홈 `.flowlink/mcp-tokens.json`)이며 현재 단일 서버 JVM 구성이다.

Windows 자동 설정의 개인 작업은 토큰을 발급한 PC에 고정한다. 동일 계정의 다른 PC가 연결되어 있어도 해당 PC로 조용히 전달하지 않고 409로 거부한다. 서버 작업의 권한은 계정·워크스페이스 권한으로 판정한다.

Windows 자동 설정을 지원하지 않는 클라이언트의 표준 OAuth 코드·PKCE 호환 경로는 유지한다. Spring Authorization Server가 처리하며 발급하는 자격도 MCP 전용이다. 이 호환 경로는 Windows 장치 ID 없이 계정에 연결된 현재 PC를 사용한다. `flowlink.desktop.mcp-auto-configure=false`는 IDE 파일 변경을 끄며 트레이를 끈 격리 검증에서는 기본 비활성화한다.

기존 58개 도구 이름과 인자 계약은 `src/main/resources/flowlink-tools.json`에 보존한다. `target`은 개인/서버 저장 공간을 선택하고 `executionAgent`는 호출할 PC/서버 실행 위치를 선택한다. 개인 저장 공간이나 PC 작업은 로그인한 Windows 앱이 온라인이어야 한다. 개인 H2 전체를 중앙 서버로 동기화하지 않고 계정·장치에 묶인 명령 채널을 사용한다.

`flow_upsert`로 새 워크플로를 생성하면 기본으로 위에서 아래로 진행하는 컴팩트한 트리 배치를 적용한다. 분기는 좌우로 나누고 합류는 아래에 두며 START와 모든 END는 동일한 x 좌표에 둔다. 좌표만 바꾸며 노드 설정·바인딩·연결·주석은 유지한다. 기존 워크플로 수정은 좌표를 보존한다. `layout="compact-tree"`로 재배치하거나 `layout="preserve"`로 생성 시 입력 좌표를 유지할 수 있다. 이 규칙은 MCP 초기 안내·도구 설명·flow 가이드에도 제공한다.

빌드·모듈 경계는 [backend 안내](../README.md)를 따른다. 검증은 순수 계약/URI 정책/승인 화면, 전용 자격의 REST 발급·갱신·폐기, 임시 JSON 설정 병합과 암호화 수명주기, 패키징 경계를 대상으로 한다. MCP 프로토콜·도구 호출·실제 IDE 등록은 테스트하지 않는다. 역사적 Node MCP 검증 기록은 이 Kotlin 구현의 실연동 검증 결과가 아니다.

설정 형식 근거: [VS Code HTTP 서버 인증 헤더](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#http-and-server-sent-events-sse-servers), [GitHub Copilot MCP 설정](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/extend-copilot-chat-with-mcp), [Microsoft APM의 IDE 설정 경로](https://microsoft.github.io/apm/integrations/ide-tool-integration/).
