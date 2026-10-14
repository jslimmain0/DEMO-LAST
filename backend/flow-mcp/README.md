# 중앙 MCP

화면과 MCP는 같은 작업 순서를 따른다. 초기 연결 안내와 `flowlink_guide`에도 아래 구분을 제공한다.

`flowlink_status.capabilities`는 서버와 연결된 PC에서 직접 보고한 설치 버전·지원 schemaVersion·기능·한도를 분리한다. 오프라인/구형 PC의 미확인 기능은 `unknown`이며 필요한 v2 요청은 전송 전에 거절한다. `flowlink_update_status.release`는 배포 버전, `local.installedVersion`은 실제 PC 보고이며 둘을 혼동하지 않는다.

v2 프로토콜은 `transactions`와 독립 `ackMessages`를 보존한다. 거래별 요청/응답 경계·ACK 송신/수신, binary integer(1/2/4/8B)·NUL 패딩을 공통 컴파일러로 확인한다. `protocol_upsert`와 `mock_upsert`의 `dryRun=true`는 저장·버전·리스너 없이 검증한다. 활성화는 기존 `enabled` 계약을 따르며 리스너 포트 교체는 새 포트를 확보한 후 기존 포트를 닫는다.

`protocol_preview`는 `action=assemble|parse`, `transactionKey`, `phase=request|requestAck|response|responseAck`, `requestFields`, `responseFields`, `bytesB64`를 지원한다. ACK 단계는 거래 키가 필수이고 frameDirection을 함께 주지 않는다. `parse`는 정확히 한 개의 완전한 프레임을 받는다. 출력의 text/HEX/Base64/필드는 모두 시크릿을 가린다.

`mock_preview`는 저장 slug 또는 미저장 전체 spec+type과 합성 request를 받아 실제와 같은 규칙·응답·ACK 계획을 보여준다. HTTP는 method/path/headers/query/body, TCP는 key/values 또는 bytesB64다. 선택 `protocolSpec`은 이 미리보기에서만 사용한다. state/hits/seq는 읽은 snapshot과 virtualSeq를 표시하며 저장·네트워크·콜백·카운터 변경은 없다. 완전한 HTTP/TCP 예시는 `flowlink_guide(mock)`와 실제 JSON Schema에서 확인한다.

v2 `mock_send`는 실제 1회 요청이며 거래·단계·전송 결과·executionId를 반환한다. 이미 받은 응답은 마지막 ACK 실패 때도 보존한다. 시험 이력은 메모리 최근 1000건·JSON 합계 32MB로 앱 재시작 후 조회할 수 없으며 DB 워크플로 이력과 별도다. UNKNOWN은 해당 executionId로 `execution_get`을 조회하고 자동 재전송하지 않는다. 실제 앱/통신사 업무 전체 호환성을 시험 성공으로 추정하지 않는다.

| 화면 기능 | MCP 작업 |
|---|---|
| TCP Mock · 연결 설정 | `protocol_upsert`로 전문 규격을, `mock_upsert`로 리스너·프로토콜 참조를 저장 |
| TCP Mock · 연결 세션 | `mock_tcp_sessions(action="list")` 조회 후 해당 `sessionId`로 `action="extend"`. 정의 저장이나 전문 전송 없음 |
| 프로토콜 · 전문 미리보기 | `protocol_preview`로 현재 `spec`·값을 저장·전송 없이 조립 |
| 노드 · 입력 → 미리보기 → 테스트 → 결과 | 화면은 테스트 버튼에서 현재 설정을 먼저 저장. MCP는 수정 graph를 `flow_upsert`로 저장한 뒤 `node_run`, 요청·응답은 `execution_get`으로 확인 |
| 플러그인 · 테스트 패널 → 테스트 실행 → 저장 → 승인 요청 | 패널 열기는 실행하지 않음. `plugin_script_try`는 입력 생략 시 컴파일·메타만 조회하고 입력을 주면 현재 소스를 저장·승인 전에 시험. `plugin_script_upsert`로 초안을 저장한 뒤 반환 `id`로 `plugin_script_submit` 요청 |

`protocol_upsert`의 `spec`은 요청 `framing`·응답 `responseFraming`(길이 필드/고정 바이트/HEX 종료자), `transport`(실행 중 연결 유지·유휴 제한·고정 ACK)를 지원한다. PC와 서버의 노드·Mock·프록시는 같은 정의를 사용하며 기존 옵션이 없는 명세는 이전 동작을 유지한다. 상세 규칙과 제한은 [TCP 연결과 수신 경계](../README.md#tcp-연결과-수신-경계-2026-10-13)를 따른다. 기존 MCP 도구 이름과 인증·IDE 설정은 유지한다.

`protocol_preview`는 `frameDirection: send | recv`로 요청/응답 경계를 선택하고, `direction: send | recv`로 코덱 컨텍스트 방향을 선택한다. 응답 길이만 검사하려면 `frameDirection=recv`를 사용한다. 두 인자 생략은 기존 송신 동작을 유지하며 미리보기는 네트워크로 전송하지 않는다. 실제 ACK 교환은 `mock_send`, 연결 유지 검증은 같은 실행의 TCP 노드 두 개를 `flow_run`으로 수행한다. 별도 `mock_send`·`node_run` 호출끼리는 연결을 공유하지 않는다.

`mock_tcp_sessions(target="local"|"server", workspace?, slug, action="list")`는 TCP Mock의 현재 연결을 조회한다. 반환 배열에는 연결별 `id`, 상대 주소·포트, 연결·마지막 활동 시각, 기본 유휴 제한, `state`(`starting`·`waiting`·`processing`), 대기 기한·남은 시간, 수신 전문 수가 있다. `action="extend", sessionId="조회한 id", extendMs=60000`으로 `waiting` 연결의 현재 기한에 시간을 더한다. `extendMs`는 1000~3600000ms이고 연장 후 기한은 현재부터 최대 1시간이다. 처리·시작 중 연장과 상한 초과는 400, 종료·알 수 없는 세션은 404다. 연장은 상대 앱에 전문을 보내지 않으며 다음 데이터 활동부터 기본 유휴 제한을 적용한다. 조회는 읽기 권한, 연장은 쓰기 권한을 요구한다. 연결은 DB에 저장하지 않으며 Mock 중지·설정 변경·앱 재시작 시 사라진다.

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

기존 59개 도구 이름을 유지하고 전송 없는 `mock_preview`를 추가해 총 60개다. 카탈로그는 `src/main/resources/flowlink-tools.json`에 있다. 저장 위치, 환경 출처, 요청 실행 위치는 다음처럼 구분한다.

| 선택 | 도구·필드 | 의미 |
|---|---|---|
| 워크플로·Mock 저장 위치 | `target`·`workspace` | `local`은 내 PC 개인 공간, `server`는 선택한 서버 공간(생략 시 public) |
| 환경 변수 출처 | `env_*`의 `target`, 실행 도구의 `envSource`·`envName` | 내 PC/local 또는 서버 공통/server의 환경 하나. 같은 이름도 별개이며 자동 병합하지 않음 |
| 시크릿·프로토콜·플러그인 | `secret_list`·`protocol_*`·`plugin_*`·`transform_preview` | 서버 public 공통 카탈로그. 기존 `target`·`workspace` 인자는 위치를 바꾸지 않으며 새 스키마에서는 광고하지 않음 |
| HTTP·TCP 요청 출발지 | 노드의 `executionAgent` | `local` PC 또는 `server` 서버. TRANSFORM은 서버에서 흐름의 선택 환경으로 실행 |

`flow_run`·`node_run`·`suite_run`은 선택한 출처의 `envName`과 `input`을 받는다. `node_run`의 `upstream` 계약도 유지한다. 공통 자원을 선택한 흐름에서 `envSource`를 생략하면 `target`을 따르며, 기존 metadata 없는 흐름은 출처 생략 시 이전 workspace 환경 계약을 유지한다. 이름 있는 환경을 찾을 수 없거나 조회가 실패하면 빈 값으로 실행하지 않는다. PC 환경을 선택할 때는 해당 변수 묶음을 고정해 전달하고 서버 시크릿은 공통 값만 사용한다. 서버 환경을 선택하면 서버의 해당 환경 시크릿도 적용한다. 호출자가 `resourceIdentity`·토큰·시크릿 원문을 graph/spec에 넣을 필요는 없다.

예를 들어 `env_put(target="local", name="개발", vars={...})`과 `env_put(target="server", name="개발", vars={...})`은 서로 다른 환경을 저장한다. `flow_run(target="local", id="...", envSource="server", envName="개발")`은 PC에 저장한 흐름을 서버 개발 환경으로 실행한다. 실제 HTTP·TCP 요청 위치는 각 노드 설정을 따른다.

새 `flow_upsert`는 `graph.resourceWorkspaceId="public"`, 새 `mock_upsert`는 `spec.resourceWorkspaceId="public"`을 기본으로 저장한다. 새 Mock의 `spec.envSource` 생략은 `target`을 따르며 PC Mock은 local/server 환경을 선택할 수 있고 서버 Mock은 server 환경을 사용한다. 기존 자료 수정은 명시한 metadata 또는 기존 metadata를 유지하고, metadata 없는 개인·팀 정의를 자동으로 공통 카탈로그에 복사하지 않는다. 전환할 때는 공통 카탈로그의 참조 ID를 확인한다. `execution_rerun`과 버전 복원도 원본 metadata·환경 출처·입력을 복원하며 현재 기본값으로 바꾸지 않는다.

`mock_list`는 `{mocks:[...], sources:[...]}`를 반환한다. `target="server"`는 선택한 서버 공간과 내 PC Mock을, `target="local"`은 내 PC와 서버 public Mock을 함께 조회한다. 각 `mocks` 행의 `target`을 후속 도구에 전달한다. `sources`에는 `target`·`available`과 확인 가능한 `workspaceId`·`httpStatus`·안내가 있어 PC 오프라인이어도 서버 목록을 사용할 수 있다. 두 위치가 모두 실패하면 도구 오류를 반환한다.

개인 저장 공간·PC 환경·PC 호출은 로그인한 Windows 앱이 온라인이어야 한다. 서버 공통 카탈로그 조회·관리는 PC 연결과 무관하다. 개인 H2 전체를 중앙 서버로 동기화하지 않고 계정·장치에 묶인 명령 채널을 사용한다. PC 실행 결과에도 실제 요청 본문을 표시하되 시크릿은 마스킹한다. 실제 통신 값은 그대로 전송하며 서버의 본문 저장 정책과 출력 마스킹 정책은 유지한다. PC가 중앙 전문을 사용할 때 정의만 전달하고 승인 코덱 스크립트는 서버에서 실행한다.

`flow_upsert`로 새 워크플로를 생성하면 기본으로 위에서 아래로 진행하는 컴팩트한 트리 배치와 `graph.layoutDirection="TB"`를 적용한다. 분기는 좌우에 유지하고 합류는 가운데 아래에 두며 START와 END의 시각 중심을 정렬한다. 노드 설정·바인딩·연결·주석은 유지한다. 기존 워크플로 수정은 좌표와 방향을 보존한다. `layout="compact-tree"`로 재배치하거나 `layout="preserve"`로 생성 시 입력 좌표를 유지할 수 있다. assert는 사용자 명시 업무 성공·독립 인수 조건에만 최소한으로 두며 모든 HTTP200·빈값·전송·프레임·ACK 검사를 노드로 반복하지 않는다. 기존 명시 assert는 보존한다.

빌드·모듈 경계는 [backend 안내](../README.md)를 따른다. 순수 계약 테스트는 도구 이름·JSON 스키마·출처·URI 정책을 검증한다. [실제 MCP 자원 검증 스크립트](../../scripts/test/mcp-resources.ps1)는 명시적으로 승인된 환경에서 `/mcp`의 도구 목록과 호출을 확인하며 IDE 등록 설정은 변경하지 않는다. 전용 자격의 REST 수명주기·임시 설정 병합·암호화·패키징 검증은 별도다. 역사적 Node MCP 검증 기록은 이 Kotlin 구현의 실연동 검증 결과가 아니다.

설정 형식 근거: [VS Code HTTP 서버 인증 헤더](https://code.visualstudio.com/docs/agents/reference/mcp-configuration#http-and-server-sent-events-sse-servers), [GitHub Copilot MCP 설정](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/extend-copilot-chat-with-mcp), [Microsoft APM의 IDE 설정 경로](https://microsoft.github.io/apm/integrations/ide-tool-integration/).
