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

설치된 Windows 앱의 MCP 연결 화면은 서버에서 받은 중앙 URL로 설정을 생성한다. VS Code·IntelliJ의 기존 MCP 목록에 추가하며, 기존 다른 서버 설정을 덮어쓰지 않는다. 앱 로그인과 IDE의 OAuth 승인은 별도 절차다. 표준 OAuth 코드·PKCE는 Spring Authorization Server가 처리하고, 로그인 뒤 한국어 권한 승인 화면에서 연결할 앱을 확인한다. 등록된 앱 이름만으로 발행자 신원이 검증되는 것은 아니다.

기존 58개 도구 이름과 인자 계약은 `src/main/resources/flowlink-tools.json`에 보존한다. `target`은 개인/서버 저장 공간을 선택하고 `executionAgent`는 호출할 PC/서버 실행 위치를 선택한다. 개인 저장 공간이나 PC 작업은 로그인한 Windows 앱이 온라인이어야 한다. 개인 H2 전체를 중앙 서버로 동기화하지 않고 계정·장치에 묶인 명령 채널을 사용한다.

빌드·모듈 경계는 [backend 안내](../README.md)를 따른다. 현재 검증 범위는 컴파일·순수 메타데이터/URI 정책/HTML 렌더링 및 패키징 경계다. MCP 프로토콜·도구 호출·IDE 등록은 테스트하지 않았다. 역사적 Node MCP 검증 기록은 이 Kotlin 구현의 실연동 검증 결과가 아니다.
