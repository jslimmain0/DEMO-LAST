# 역할별 빌드

`flow-agent`는 HTTP·TCP 호출, Mock·콜백 처리와 작업 통신 규격을 담는 DB 없는 라이브러리다. `flow-server`는 인증·권한·저장소·워크플로·작업 관리와 중앙 협업·배포 API를 담당하고, `flow-desktop`은 Windows 화면·로그인·트레이·업데이트·개인 H2·작업 전달을 담당한다. `flow-mcp`는 중앙 서버에서 로드하는 Kotlin MCP 라이브러리이며 독립 프로세스가 아니다.

```text
flow-desktop → flow-server의 plain 라이브러리 → flow-agent
flow-server 실행 JAR → flow-agent + flow-mcp
```

중앙 MCP는 서버와 같은 포트의 `/mcp`이며 별도 Node·18090 프로세스는 없다. MSI에는 Java 런타임만 동봉하고 MCP는 중앙 URL로 연결한다. 자세한 연결·OAuth·검증 범위는 [flow-mcp 안내](flow-mcp/README.md)를 따른다.

desktop은 개인 H2 관리에 필요한 기존 백엔드 코드를 재사용한다. server의 plain JAR에는 중앙 서버 진입점·로그인 발급·배포·협업 WebSocket 코드가 포함되지 않으며, desktop의 실행 JAR에는 Oracle 드라이버와 중앙 MCP·SDK가 포함되지 않는다. agent 자체는 독립 실행 앱이 아니며 로컬·서버 호스트가 동일한 구현을 사용한다. 작업·권한·저장소 관리까지 agent로 옮긴 구조가 아니다.

호스트 구성은 `FlowlinkApplication`의 관리·agent 등록, `ServerFeatures`의 중앙 기능, `DesktopConfiguration`의 Windows 기능으로 명시한다. agent는 환경·시크릿·전문·플러그인·Mock을 호스트가 제공하는 계약으로 조회하며 저장소를 직접 참조하지 않는다. 콜백의 HTTP 수신은 agent, 내구 저장·실행 재개는 호스트가 담당한다. 기존 패키지 이름과 JSON/API 규격·개인 DB 위치는 유지한다.

프론트엔드를 먼저 빌드한 뒤 `backend/`에서 실행한다.

```powershell
.\gradlew.bat :flow-agent:jar :flow-mcp:jar :flow-server:bootJar :flow-desktop:bootJar
```

개발 기동은 `:flow-server:bootRun` 또는 `:flow-desktop:bootRun`을 지정한다. 상대 경로의 기준은 기존처럼 `backend/`이며 개인 앱은 로그인·DB·루프백 보호 설정을 자동 적용한다.

- 에이전트 라이브러리: `flow-agent/build/libs/flowlink-agent.jar`.
- 서버: `flow-server/build/libs/flowlink-server.jar`. 루트 `scripts/start.ps1`, `scripts/start.sh`, 서버 Docker가 사용한다.
- Windows: `flow-desktop/build/libs/flowlink-desktop.jar`. `flow-desktop/installer/package-desktop.ps1`이 MSI에 넣으며 기본 출력은 `flow-desktop/build/installer/`이다. 기존 개인 저장 위치와 MSI UpgradeCode는 유지한다.
- Oracle SQL: `flow-server/src/main/resources/db/`. 업그레이드 검증은 마지막 사전-agent 스키마인 `612501f` 커밋을 고정해 읽으며 현재 HEAD의 신규 설치 스키마와 구분한다.

```powershell
# 저장소 루트, 공개 서버 주소를 명시한다.
.\scripts\package-desktop.ps1 -ServerUrl https://flowlink.example.internal
```

루트 `scripts/package-desktop.ps1`과 `scripts/Publish-DesktopRelease.ps1`은 기존 명령을 유지하는 얇은 진입점이다. 설치 자료·업데이트 helper·릴리스 게시 구현은 `flow-desktop/installer/`가 소유한다. `-SkipBuild`는 해당 desktop JAR와 VERSION이 일치할 때만 사용한다. 기존 출시 0.3.7 MSI는 이전 산출물이므로 새 분리 JAR 포함을 주장하지 않는다.

검증 도구는 저장소 루트의 `scripts/test/module-artifacts.ps1`(agent plain JAR·역할·드라이버·진입점)과 `scripts/test/module-launchers.ps1`(임시 H2로 실제 기동·개인 접근 보호·잘못된 설정 거부)이다. 기동 검사는 자신의 임시 프로세스만 종료한다. 실제 사용자 앱·DB·Docker·MCP 연결 검증은 수행하지 않는다.

2026-10-04의 72개 테스트 및 두 실행 JAR 검증은 이전 `runtime/server-app/desktop-app` 구조의 기록이다. 이번 세 모듈 구조의 검증 결과와 구분한다.

2026-10-06의 이전 세 모듈 검증: agent 138개, server 190개, desktop 27개로 전체 355개 테스트 통과(실패·오류·건너뜀 0). 세 JAR 빌드 및 bytecode/DB 드라이버/중앙·Windows 기능 경계 검사 통과. 임시 H2와 임의 포트로 두 실제 launcher를 기동해 개인 API 보호, 중앙 로그인·배포 API의 서버 전용 제공, 잘못된 프로파일·외부 바인딩 거부를 확인했다. 네 모듈 변경의 검증 결과와는 구분한다.
