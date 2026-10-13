# 역할별 빌드

## TCP 연결과 수신 경계 (2026-10-13)

TCP 노드·Mock·프록시는 같은 프로토콜의 요청/응답 경계를 사용한다. `framing`은 요청, `responseFraming`은 응답이며 응답 설정을 생략하면 요청 설정을 따른다. 기존 명세는 길이 필드와 `includesSelf` 동작을 그대로 유지한다. 새 옵션을 사용하지 않은 명세의 fingerprint도 유지하며 DB 테이블·컬럼·기존 자원은 변경하지 않는다.

- `mode: length`: 헤더 어느 위치에든 길이 필드를 둘 수 있다. 형식은 `ascii-decimal`, `ascii-hex`, `binary`(1/2/4/8바이트, big/little endian)다. `lengthAdjustment`를 지정하면 **전체 바이트 = 선언 길이 + 보정값**이다. 예를 들어 길이 필드 6바이트 제외는 `6`, 헤더 20바이트 제외는 `20`, 종료자까지 포함한 길이에서 2바이트를 제외해 읽으면 `-2`다. 생략하면 기존 `includesSelf` 규칙을 적용한다.
- `mode: fixed`: `fixedLength` 바이트를 정확히 수신한다. 길이 필드와 헤더가 없는 전문도 가능하며 요청·응답 길이를 다르게 지정할 수 있다. 조립 결과와 고정 길이가 다르면 전송 전에 실패한다.
- `mode: delimiter`: `delimiterHex`(예: CRLF=`0D0A`)를 끝에 붙여 전송하고 해당 경계까지 수신한다. 종료자는 wire 기록에 포함하고 본문 해석 전에 제거한다. 본문에 종료자 또는 본문 끝과 겹치는 종료자 패턴이 있으면 전송 전에 거부한다.

`transport.connection: execution`은 동일 실행·소유자·목적지·전문/코덱 버전의 TCP 노드 사이에서 연결을 재사용한다. 기본값 `once`는 이전처럼 요청마다 닫는다. 완료·취소·UNKNOWN과 앱 종료 시 연결을 정리하며, 유휴 만료 또는 실패한 연결에서 다음 요청을 자동 재전송하지 않는다. `transport.idleTimeoutMs`는 유휴 제한이며 기본 30초, 1초~1시간이다. 재시작 후 기존 TCP 세션을 복원하거나 다른 실행과 연결을 공유하지 않는다.

고정 ACK는 `transport.requestAckHex`(요청 뒤 받는 ACK), `responseAckHex`(응답 뒤 보내는 ACK)로 정의한다. 둘 다 지정하면 **요청 → 요청 ACK → 응답 → 응답 ACK** 순서다. Mock과 프록시도 각 연결에서 같은 순서를 따른다. ACK는 1~1024바이트, 종료자는 1~64바이트 HEX이며 전체 전문 상한은 1MiB다. 거래별로 달라지는 ACK, 로그인/heartbeat, 서버 Push는 이 고정 ACK 계약에 포함하지 않는다.

편집기 조립 미리보기의 요청/응답 선택은 각 방향의 프레이밍을 적용한다. API의 `frameDirection: send | recv`는 경계만 선택하며, 기존 코덱 실행 방향인 `direction`은 유지한다. 두 값 모두 생략한 기존 호출은 송신 동작을 유지한다.

### TCP Mock의 연결된 세션 관리 (2026-10-14)

Mock의 연결 화면은 외부 앱에서 들어온 실제 소켓의 상대 주소·연결/활동 시각·수신 전문 수·상태·남은 유휴 시간을 표시한다. `1분 연장`은 선택한 대기 세션의 현재 종료 기한에 60초를 더한다. 처리 중인 연결은 연장하지 않으며, 연장 후 남은 시간은 최대 1시간이다. 새 데이터 송수신과 다음 요청 대기에서는 프로토콜의 기본 유휴 시간으로 다시 계산한다.

관리 API는 `GET /api/v1/mock-servers/{id}/tcp-sessions`(읽기 권한), `POST /api/v1/mock-servers/{id}/tcp-sessions/{sessionId}/extend`와 `{ "extendMs": 60000 }`(쓰기 권한)다. 연장은 정의를 저장하거나 전문을 전송하지 않는다. 세션은 실행 호스트의 메모리에만 존재하며 상대 앱 종료·만료·Mock 중지·정의 변경·앱 재시작 후 목록에서 제거된다. 종료된 연결을 복구하거나 외부 앱의 자체 타임아웃을 연장하지 않는다. 기존 DB 스키마·데이터·프로토콜은 유지한다.

## 중앙 공통 자원과 환경 출처 (2026-10-13)

새 작업 화면은 시크릿·프로토콜·플러그인을 서버 공용(`public`)에서 관리한다. 환경 변수는 내 PC와 서버에 각각 두며 실행 요청의 `envSource: local | server`로 출처를 지정한다. 같은 이름의 환경을 서로 합치지 않는다. PC 환경을 선택하면 중앙 시크릿은 공통 값만 사용하고, 서버 환경을 선택하면 그 환경의 중앙 시크릿을 적용한다.

`RunRequest.resourceWorkspaceId: public`은 워크플로 저장 공간과 자원 공간을 분리한다. 개인 흐름의 변환은 중앙 서버에 위임하고, PC HTTP/TCP는 필요한 중앙 시크릿만 인증된 실행기로 받아 사용한다. 프로토콜 정의는 PC에서 참조할 수 있지만 승인된 코덱·변환 코드는 서버에서 실행한다. 실행을 시작한 서버·계정을 고정하고 연결 실패나 없는 자원은 실행 오류로 반환한다. 실행기 전용 원문 응답은 브라우저 원격 프록시로 열지 않는다.

PC 요청의 URL·헤더·본문은 실행 기록에서 확인할 수 있다. 등록된 시크릿 값은 마스킹하며 위치 간 출력 키 제한도 유지한다. 단일 테스트의 재실행은 선택 노드·원래 버전·입력·환경을 보존한다. 원래 조건이 없는 과거 관리 실행 이력은 전체 흐름으로 임의 재실행하지 않고 에디터에서 새 실행을 요청한다.

이 변경은 기존 JSON/CLOB 컬럼을 사용한다. 새 테이블·컬럼·SQL 마이그레이션이나 기존 개인/팀 자원의 자동 이관은 없다. 자원 출처를 지정하지 않은 기존 API와 저장 명세는 이전 공간별 계약을 유지한다. 아래 2026-10-07의 개인 플러그인 금지 설명은 그 기존 계약에 대한 기록이다.

중앙 MCP도 같은 자원 계약을 사용하며 기존 58개 도구 이름을 유지한다. `mock_tcp_sessions`의 조회·연장을 추가해 총 59개다. 환경 도구의 `target`은 PC·서버 환경의 출처를 고르고, 시크릿·프로토콜·플러그인 도구는 서버 공용 자원을 사용한다. `flow_run`, `node_run`, `suite_run`은 `envSource`로 환경 출처를 선택한다. 새 흐름·Mock에는 공통 자원 명세를 넣고 기존 명세를 수정·복원할 때는 원래 자원 위치를 보존한다. 자세한 인자와 검증 방법은 [중앙 MCP 안내](flow-mcp/README.md)를 따른다.

HTTP·TCP만 호출 위치를 선택한다. 변수 지정·조건 분기·값 검증·경로 전환은 워크플로의 환경과 실행 컨텍스트에서 계산한다. 과거 그래프에 저장된 계산 노드의 목적지 공간·환경·위치는 실행할 때 무시하며 원본 버전은 보존한다.

HTTP 노드를 다른 실행 에이전트로 위임할 때 기본 출력에 `body`와 `httpStatus`를 포함한다. 텍스트·HTML 및 JSON 파싱 실패로 보존한 본문도 PC·서버 양쪽에서 전달하고 표시한다. 명시한 `agentOutputs` 제한과 시크릿 마스킹은 유지한다.

중앙 서버의 `/`와 `/download`는 로그인 없이 Windows 앱 다운로드와 설치 안내를 제공한다. 페이지에는 최신 MSI의 버전·용량·변경 사항을 표시하며, 작업 화면은 Windows 앱에서 연다. 서버 실행 전 `FLOWLINK_DISTRIBUTION_DIR`에 배포 폴더의 절대 경로를 지정하고, 그 폴더에 `FlowLink-버전-windows-x64.msi`와 `release-manifest.json`을 함께 게시한다. 미지정 시 서버 실행 위치의 `downloads/`를 사용한다. 게시에는 `flow-desktop/installer/Publish-DesktopRelease.ps1`을 사용한다.

현재 두 실행 JAR의 버전은 저장소 루트 `VERSION`을 따른다. agent/core/호스트/드라이버/MCP SDK 패키징 경계와 임시 H2의 서버·개인 launcher 기동, 잘못된 프로파일·바인딩 거부를 확인했다. 과거 검증 범위는 [아키텍처 일치 검토](../docs/reviews/2026-10-07-architecture-consistency.md)를 따른다. 아래 날짜별 테스트 수와 미검증 항목은 당시 기록이며, 실제 사용자 IDE 설정은 변경하지 않는다.

`flow-agent`는 HTTP·TCP 호출, Mock·콜백 처리와 작업 통신 규격을 담는 DB 없는 라이브러리다. `flow-core`는 공통 워크플로·환경·JPA 저장·권한·관리 API와 실행 조정을 소유한다. `flow-server`는 중앙 로그인·공용 DB 설정·협업·배포·PC 명령 중계를 담당하고, `flow-desktop`은 Windows 화면·로그인·트레이·업데이트·개인 H2 설정·작업 전달을 담당한다. `flow-mcp`는 중앙 서버에서 로드하는 Kotlin MCP 라이브러리이며 독립 프로세스가 아니다.

```text
flow-desktop → flow-core → flow-agent
flow-server → flow-core → flow-agent
flow-server → flow-mcp
```

중앙 MCP는 서버와 같은 포트의 `/mcp`이며 별도 Node·18090 프로세스는 없다. MSI에는 Java 런타임만 동봉하고 MCP는 중앙 URL로 연결한다. Windows 앱은 로그인한 계정의 전용 MCP 자격을 받아 IDE 설정을 지원한다. 자세한 연결·인증·검증 범위는 [flow-mcp 안내](flow-mcp/README.md)를 따른다.

desktop은 server 소스나 서버 JAR에 의존하지 않는다. 두 호스트가 core의 공통 관리 구현을 재사용하므로 화면·API·기존 개인 DB와 키를 유지한다. desktop에는 Oracle 드라이버와 중앙 MCP·SDK가 포함되지 않는다. agent 자체는 독립 실행 앱이 아니며 로컬·서버 호스트가 동일한 구현을 사용한다. 작업·권한·저장소 관리까지 agent로 옮긴 구조가 아니다.

호스트 구성은 core의 `FlowlinkApplication`이 공통 관리·agent를 등록하고 `ServerFeatures`가 중앙 기능, `DesktopConfiguration`이 Windows 기능을 추가하는 방식이다. 공통 부팅 클래스의 기존 FQCN은 유지한다. agent는 환경·시크릿·전문·플러그인·Mock을 core가 제공하는 계약으로 조회하며 저장소를 직접 참조하지 않는다. 콜백의 HTTP 수신은 agent, 내구 저장·실행 재개는 core가 담당한다.

앱의 회사 계정 GitHub 로그인은 중앙 서버 전용이며, AI 어시스턴트에서 쓰는 개인 Copilot 구독 계정 연결은 별도의 기존 OAuth 기능이다.

DB 연결과 프로파일은 각 호스트의 `src/main/resources/application*.yml`에 있다. core의 `application-core.yml`은 기존 UUID CHAR(36) 매핑과 공통 웹/ORM 설정만 제공한다. 개인 H2는 현재 Hibernate `ddl-auto:update`와 기존 리소스/시크릿 이관 코드로 업그레이드한다. 별도 Flyway 적용으로 기존 개인 DB를 바꾸는 작업은 하지 않는다. Oracle 신규/업그레이드 SQL은 server에 남긴다. 작업 프론트 `frontend/dist`와 SPA 라우팅은 desktop에만 동봉하며, 설치된 앱은 Java와 화면·관리 API·H2를 포함해 서버 없이 개인 작업을 실행할 수 있다.

개인 작업은 **Windows 앱의 ‘개인 워크스페이스 열기’**로 진입한다. 그 브라우저 화면의 개인 API는 PC의 `flow-desktop`에 요청하고, 공용·팀 작업만 중앙 서버에 요청한다. 중앙 서버 URL은 인증·API·MCP·다운로드 전용이며 `/flows`, `/plugins` 등 작업 화면을 제공하지 않는다. 개인 API 보호 때문에 로컬 URL을 직접 입력하는 대신 앱에서 화면을 연다. 서버 연결 실패는 개인 앱 종료·중앙 로그인 강제·개인 자료 삭제 사유가 아니다. 서버 노드·원격 Vault 등 외부 의존이 있는 작업에는 해당 연결이 필요하다.

개인·회사 워크스페이스 모두 화면 주소는 PC 앱의 `http://127.0.0.1:18180`을 사용한다(별도 포트를 지정하면 해당 포트). 회사 공간의 API는 PC의 `/api/v1/remote`를 거쳐 중앙 서버로 전달한다. ‘개인 워크스페이스 열기’는 저장된 회사 공간 선택보다 우선하며, ‘회사 워크스페이스 열기’와 로그인 완료는 공용 공간으로 진입한다. 일회용 접속 주소와 리다이렉트는 PC 앱의 주소·포트를 사용하고, 이전 `runtime` 쿼리는 진입 시 `space`로 정규화한다.

서버가 없는 첫 시작과 로그인 실패 후 개인 생성·저장·조회·SET/ASSERT 실행은 `scripts/test/desktop-offline.ps1 -AgentFile <격리 개인 앱 agent.json>`으로 검증한다. 중앙 서버가 응답하지 않는 루프백 실험 설정에만 실행하며, 실험용 개인 흐름 하나를 남긴다. 서버 로그인·주소 조회·원격 API 전송의 연결 실패는 503 안내로 반환하고 저장된 로그인 정보는 유지한다.

프론트엔드를 먼저 빌드한 뒤 `backend/`에서 실행한다.

```powershell
.\gradlew.bat :flow-agent:jar :flow-core:jar :flow-mcp:jar :flow-server:bootJar :flow-desktop:bootJar
```

개발 기동은 `:flow-server:bootRun` 또는 `:flow-desktop:bootRun`을 지정한다. 상대 경로의 기준은 기존처럼 `backend/`이며 개인 앱은 로그인·DB·루프백 보호 설정을 자동 적용한다.

Java 21 가상 스레드는 두 호스트의 웹 요청과 워크플로·에이전트·PC 전달 작업에 적용한다. 작업마다 새 가상 스레드를 만들며 실행 상한은 유지한다: 워크플로 기본 동시 8/대기 100(기존 worker 설정), 에이전트 동시 4/대기 100, PC 전달 동시 4. 대기 상한을 넘긴 에이전트 작업은 외부 호출 없이 429 실패 결과를 저장한다. 테넌트는 명시적으로 전달하고 상속 ThreadLocal은 사용하지 않는다. 타이머·취소 감시 스레드는 기존 방식을 유지한다.

가상 스레드 변경 검증(2026-10-07): agent 144/core 160/server 53/desktop 31, 총 388개 테스트 통과. 실제 가상 스레드 실행·상속 컨텍스트 차단·대기 상한·종료 취소·거절 결과 커밋을 확인했고 두 JAR 빌드·모듈 경계·격리 launcher 기동도 통과했다. MCP 테스트와 MSI 재패키징·실행 중 앱 교체는 이번 변경에서 수행하지 않았다.

- 에이전트 라이브러리: `flow-agent/build/libs/flowlink-agent.jar`.
- 공통 관리 라이브러리: `flow-core/build/libs/flowlink-core.jar`.
- 서버: `flow-server/build/libs/flowlink-server.jar`. 루트 `scripts/start.ps1`, `scripts/start.sh`, 서버 Docker가 사용한다.
- Windows: `flow-desktop/build/libs/flowlink-desktop.jar`. `flow-desktop/installer/package-desktop.ps1`이 MSI에 넣으며 기본 출력은 `flow-desktop/build/installer/`이다. 기존 개인 저장 위치와 MSI UpgradeCode는 유지한다.
- Oracle SQL: `flow-server/src/main/resources/db/`. 업그레이드 검증은 마지막 사전-agent 스키마인 `612501f` 커밋을 고정해 읽으며 현재 HEAD의 신규 설치 스키마와 구분한다.

```powershell
# 저장소 루트, 공개 서버 주소를 명시한다.
.\scripts\package-desktop.ps1 -ServerUrl https://flowlink.example.internal
```

루트 `scripts/package-desktop.ps1`과 `scripts/Publish-DesktopRelease.ps1`은 기존 명령을 유지하는 얇은 진입점이다. 설치 자료·업데이트 helper·릴리스 게시 구현은 `flow-desktop/installer/`가 소유한다. `-SkipBuild`는 해당 desktop JAR와 VERSION이 일치할 때만 사용한다. 기존 출시 0.3.7 MSI는 이전 산출물이므로 새 분리 JAR 포함을 주장하지 않는다.

검증 도구는 저장소 루트의 `scripts/test/module-artifacts.ps1`(agent/core plain JAR·DB/호스트 경계·역할·드라이버·진입점)과 `scripts/test/module-launchers.ps1`(임시 H2로 실제 기동·개인 접근 보호·잘못된 설정 거부)이다. 기동 검사는 자신의 임시 프로세스만 종료한다. 실제 사용자 앱·DB·Docker·MCP 연결 검증은 수행하지 않는다.

2026-10-04의 72개 테스트 및 두 실행 JAR 검증은 이전 `runtime/server-app/desktop-app` 구조의 기록이다. 현재 다섯 모듈 구조의 검증 결과와 구분한다.

2026-10-06의 이전 세 모듈 검증: agent 138개, server 190개, desktop 27개로 전체 355개 테스트 통과(실패·오류·건너뜀 0). 세 JAR 빌드 및 bytecode/DB 드라이버/중앙·Windows 기능 경계 검사 통과. 임시 H2와 임의 포트로 두 실제 launcher를 기동해 개인 API 보호, 중앙 로그인·배포 API의 서버 전용 제공, 잘못된 프로파일·외부 바인딩 거부를 확인했다. 네 모듈 변경의 검증 결과와는 구분한다.

## 이전 0.3.8 네 모듈 통합 검증 (2026-10-07)

아래 결과는 flow-core 추출 전 기록이며 현재 다섯 모듈의 최종 검증 결과와 구분한다.

네 모듈 테스트 377개 통과: agent 140, server 202, desktop 27, MCP 8. 실패·오류·건너뜀 0. 프론트 lint/build도 통과했으며 기존 Fast Refresh·큰 bundle 경고는 남아 있다. MCP 8개는 순수 도구 계약·URI 정책·승인 화면 렌더링 검사이며 프로토콜 호출 검증이 아니다.

실제 격리 서버/개인 앱을 기동해 `scripts/test/desktop-bridge.ps1`로 PC의 개인 H2 조회, 동일 요청 ID 결과 유지, 다른 계정 404, 오프라인 409, 재연결 UNKNOWN을 확인했다. 서버는 명령/응답을 제한된 시간만 중계하며 개인 H2 전체를 저장하지 않는다. 통합 중 발견한 공통 오류 처리의 4xx→500 변환도 수정했다.

0.3.8 Windows MSI를 실제 제작했고 파일 목록에 개인 앱과 Java가 포함되며 Node/MCP/서버 JAR가 없는 것을 확인했다. 사용자 PC의 기존 설치 앱·계정·DB는 변경하지 않았다. Docker 가상 EC2 배포·MSI 다운로드 및 GitHub 환경 설정은 [배포 안내](../infra/ec2/README.md)를 따른다. 실제 GitHub 로그인·MCP·IDE 연동은 이번 검증에서 수행하지 않았다.

## 0.3.9 확정 아키텍처 검증 (2026-10-07)

다섯 모듈 테스트 387개 통과: agent 140, core 155, server 53, desktop 31, MCP 8. 실패·오류·건너뜀 0. 두 실행 JAR와 plain 라이브러리, desktop의 Oracle/서버/MCP SDK 제외 및 agent의 DB 제외 경계 검사를 통과했다. 프론트 lint/build는 기존 Fast Refresh·bundle 크기 경고만 남는다.

격리 REST로 MCP 전용 자격 발급·갱신·세션별 해제·서버 재시작 보존·관리 API 거부와 PC 장치 고정을 확인했다. 임시 JSON에서는 IDE별 인증 형식, 다른 항목 보존, 수동/동시 편집 보호, 암호화 저장, 갱신 후 재시도, 오프라인 해제 및 대기열 재시도를 확인했다. 실제 사용자 IDE 설정은 변경하지 않았다.

Oracle/Vault 도커에서 Transit·AppRole·환경별 시크릿·DB/앱 재시작·마스킹 13개와 잘못된 AppRole 기동 거부, 기존 REST 기능 14개를 검증했다. 개인 H2와 Oracle 서버 사이의 실제 PC→서버→PC 실행, 개인 흐름의 서버 노드 위임, 로그아웃 후 개인 실행, 환경/Mock/허용 출력 격리는 23개 검증을 통과했다. 기존 테스트 자료에서 누락된 목적지 환경 선택을 현재 검증 규칙에 맞게 명시했다.

Windows 앱 로그인은 중앙 계정과 MCP 자격을 공유하고 자동 설정 상태를 트레이와 브라우저 설정에서 보여준다. `flow-mcp`의 [인증/설정 안내](flow-mcp/README.md), [확정 아키텍처 그림](../docs/FLOWLINK_ARCHITECTURE.html), [Docker 배포 안내](../infra/ec2/README.md)를 참고한다. 실제 GitHub 인증, MCP 프로토콜·도구 호출·IDE 등록은 이번 검증 범위에 포함하지 않았다.

## 중앙 플러그인·시크릿 (2026-10-07)

시크릿 등록·값 교체 시 입력값이 `vault:`로 시작하면 이미 생성된 Vault Transit 암호문으로 취급해 DB에 그대로 저장한다. 다른 값은 기존 저장 정책으로 암호화한다. 입력값은 공백 제거 없이 보존하며, 실행 시 저장된 Vault 암호문은 서버에 설정된 Transit 키로 복호화한다.

일반 원문은 Base64로 바꾸지 않고 입력한다. Vault API의 `plaintext`는 전송용 Base64이며 앱이 인코딩·디코딩을 처리한다. Transit이 꺼진 호스트에서는 `vault:` 암호문 등록·교체를 저장 전에 거부하고 기존 값을 보존한다. 플러그인에는 암호문 대신 `{{ 이름@secret }}`으로 참조한다. `fl.b64.dec`는 실제 Base64 입력에만 사용하며, 잘못된 입력의 오류에 원문을 포함하지 않는다.

플러그인 목록·작성·승인·실행은 공용·팀 워크스페이스의 중앙 서버에서만 제공한다. 개인 공간은 플러그인 관리 API(403), 승인본 로드, 변환 노드 실행, Mock/프로토콜 플러그인 사용을 허용하지 않는다. 기존 개인 플러그인 자료는 삭제하지 않고 비활성 상태로 보존한다. 개인 Mock·프로토콜에 남은 플러그인 참조는 직접 제거할 수 있다.

변환 노드는 실행 위치·목적지 공간·목적지 환경을 별도로 선택하지 않는다. 중앙 서버에서 현재 워크플로 공간과 선택 환경의 승인된 플러그인을 실행한다. 과거 변환 노드의 PC·다른 공간·환경 설정은 실행과 이력에 적용하지 않는다. HTTP/TCP 등 호출 노드의 PC/서버 실행 위치 선택은 유지한다. Mock 코덱·프로토콜 코덱도 공용·팀 서버에서만 실행하며 PC에 플러그인 코드를 배포하지 않는다.

중앙 시크릿은 공용·팀 공간의 서버 정책에 따라 Vault Transit/서버 키로 암호화하며, 화면에는 ‘시크릿’으로 표시한다. 개인 환경변수와 직접 입력한 개인 시크릿은 기존 H2·PC 키로 암호화해 오프라인에서도 사용한다. 개인 흐름의 서버 노드에서 중앙 시크릿 참조는 거부한다. Vault 주소·인증 토큰은 PC에 전달하지 않는다.

검증: scripts/test/module-launchers.ps1은 격리한 두 실제 JVM에서 중앙 플러그인 생성·승인·미리보기·기존 PC 설정을 가진 변환의 서버 실행/이력, 개인 API·흐름·Mock 사용 거부와 개인 시크릿 API 유지를 확인한다. MCP 프로토콜·도구 호출·IDE 등록은 검증하지 않는다.

환경과 프로토콜 정의는 해당 공간의 저장소를 사용한다. 개인 자료는 H2, 공용·팀 자료는 중앙 DB에 저장한다. HTTP/TCP 호출을 다른 위치에 위임하면 목적지 공간의 환경·프로토콜을 사용한다. TCP 편집기는 저장소와 목록 조회 상태를 표시하며, 목적지에 없는 프로토콜을 자동 대체하거나 기존 전문·필드를 지우지 않는다.

Mock·프로토콜 미리보기·플러그인 시험도 실제 실행처럼 존재하지 않는 환경을 거부한다. 환경·시크릿 조회 장애 시 빈 값으로 계속 실행하지 않고 중단하며, Mock 내부 예외 원문을 응답·로그에 노출하지 않는다. 배포 CI는 `npm test`와 두 실행 JAR의 모듈 경계 검사도 실행한다.
