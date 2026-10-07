# 역할별 빌드

중앙 서버의 `/`와 `/download`는 로그인 없이 Windows 앱 다운로드와 설치 안내를 제공한다. 페이지에는 최신 MSI의 버전·용량·변경 사항을 표시하며, 작업 화면은 Windows 앱에서 연다. 서버 실행 전 `FLOWLINK_DISTRIBUTION_DIR`에 배포 폴더의 절대 경로를 지정하고, 그 폴더에 `FlowLink-버전-windows-x64.msi`와 `release-manifest.json`을 함께 게시한다. 미지정 시 서버 실행 위치의 `downloads/`를 사용한다. 게시에는 `flow-desktop/installer/Publish-DesktopRelease.ps1`을 사용한다.

현재 다섯 모듈의 두 실행 JAR 버전은 0.3.9다. agent/core/호스트/드라이버/MCP SDK 패키징 경계와 임시 H2의 서버·개인 launcher 기동, 잘못된 프로파일·바인딩 거부를 확인했다. 최근 수정과 검증 범위는 [아키텍처 일치 검토](../docs/reviews/2026-10-07-architecture-consistency.md)를 따른다. 아래 날짜별 테스트 수는 당시 기록이다. desktop 검증은 임시 JSON과 모의 REST를 사용하며 실제 사용자 IDE 설정을 변경하지 않는다. MCP 프로토콜·도구 호출·IDE 등록 테스트는 수행하지 않았다.

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

플러그인 목록·작성·승인·실행은 공용·팀 워크스페이스의 중앙 서버에서만 제공한다. 개인 공간은 플러그인 관리 API(403), 승인본 로드, 변환 노드 실행, Mock/프로토콜 플러그인 사용을 허용하지 않는다. 기존 개인 플러그인 자료는 삭제하지 않고 비활성 상태로 보존한다. 개인 Mock·프로토콜에 남은 플러그인 참조는 직접 제거할 수 있다.

변환 노드는 실행 위치·목적지 공간·목적지 환경을 별도로 선택하지 않는다. 중앙 서버에서 현재 워크플로 공간과 선택 환경의 승인된 플러그인을 실행한다. 과거 변환 노드의 PC·다른 공간·환경 설정은 실행과 이력에 적용하지 않는다. HTTP/TCP 등 호출 노드의 PC/서버 실행 위치 선택은 유지한다. Mock 코덱·프로토콜 코덱도 공용·팀 서버에서만 실행하며 PC에 플러그인 코드를 배포하지 않는다.

중앙 시크릿은 공용·팀 공간의 서버 정책에 따라 Vault Transit/서버 키로 암호화하며, 화면에는 ‘시크릿’으로 표시한다. 개인 환경변수와 직접 입력한 개인 시크릿은 기존 H2·PC 키로 암호화해 오프라인에서도 사용한다. 개인 흐름의 서버 노드에서 중앙 시크릿 참조는 거부한다. Vault 주소·인증 토큰은 PC에 전달하지 않는다.

검증: scripts/test/module-launchers.ps1은 격리한 두 실제 JVM에서 중앙 플러그인 생성·승인·미리보기·기존 PC 설정을 가진 변환의 서버 실행/이력, 개인 API·흐름·Mock 사용 거부와 개인 시크릿 API 유지를 확인한다. MCP 프로토콜·도구 호출·IDE 등록은 검증하지 않는다.

환경과 프로토콜 정의는 해당 공간의 저장소를 사용한다. 개인 자료는 H2, 공용·팀 자료는 중앙 DB에 저장한다. HTTP/TCP 호출을 다른 위치에 위임하면 목적지 공간의 환경·프로토콜을 사용한다. TCP 편집기는 저장소와 목록 조회 상태를 표시하며, 목적지에 없는 프로토콜을 자동 대체하거나 기존 전문·필드를 지우지 않는다.

Mock·프로토콜 미리보기·플러그인 시험도 실제 실행처럼 존재하지 않는 환경을 거부한다. 환경·시크릿 조회 장애 시 빈 값으로 계속 실행하지 않고 중단하며, Mock 내부 예외 원문을 응답·로그에 노출하지 않는다. 배포 CI는 `npm test`와 두 실행 JAR의 모듈 경계 검사도 실행한다.
