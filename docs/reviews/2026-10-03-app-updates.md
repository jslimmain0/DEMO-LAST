# 앱 업데이트 구현과 검증

2026-10-03. 대상은 Windows 앱과 서버의 배포 정보다. 서버·클라이언트 구현, 생성한 MSI, 실제 설치 성공을 구분한다.

## 토론과 채택

제품 담당 `product_adoption_review`, 서버 담당 `continuous_product_discovery`, Windows 담당 `resource_experience`가 먼저 범위를 정하고 상호 반론을 교환했다. 루트는 패키징·버전 기준·실행 진입 차단·MCP 읽기 안내를 통합했다.

- 조회→다운로드→파일 검증→명시적 설치→재시작을 한 서비스로 연결한다. 웹·트레이·Windows 창이 같은 상태를 사용한다.
- 서버가 임의 설치 명령을 내려주지 않는다. 등록된 서버, HTTPS(실험용 loopback 예외), 고정 MSI 경로, 리디렉션 거부, 크기·해시 검증을 사용한다. 별도 코드 서명 체계를 만들어 서명 검증이 완료됐다고 주장하지 않는다.
- 실행·대기를 확인하기 전에 새 요청을 차단한다. 진행 중 작업을 강제 종료하지 않는다. Mock 중단과 브라우저 저장 확인은 사용자가 설치 창에서 확인한다.
- 서버 자체·Oracle·Vault의 자동 교체는 이 PC 업데이터 범위에 넣지 않는다. 중앙 MCP는 서버 배포로 교체하며 업데이트 조회와 안내만 제공한다.

리뷰로 고친 문제: 설치 보조 프로그램의 늦은 준비가 나중 설치로 이어질 수 있어 ready/commit을 분리했다. 헤더 수신 후 본문이 멈추는 경우를 위해 별도 watchdog을 추가했다. 서버가 바뀌면 이전 업데이트 상태를 폐기한다. 재기동 때 설치 결과와 실제 버전을 대조한다. 사용자 지정 설치 폴더는 MSI INSTALLDIR에 현재 경로를 명시해 유지한다.

## 구현

- 루트 `VERSION` → Gradle `flowlink-release.properties` → JAR·MSI 0.3.4. MCP 프로세스 0.4.1.
- `GET /api/v1/distribution`: 실행 서버 버전, 배포 상태, 검증된 release manifest 및 다운로드 주소.
- `GET /api/v1/desktop/update`, `POST .../check`, `POST .../download`, `POST .../open-window`. HTTP 설치 API를 만들지 않았다.
- 시작 30초 후와 6시간 간격 확인. 설치 결과 안내가 있는 첫 확인은 건너뛰고 다음 주기에 확인을 재개한다. 다운로드·설치는 명시적 행동이다.
- `Publish-DesktopRelease.ps1`: 실제 MSI 제품/버전/UpgradeCode 확인, 같은 버전 다른 파일 거부, MSI 선게시·manifest 원자 교체.
- `RuntimeUpdateGate`: 새 실행·단일 노드·에이전트 작업·dispatcher·PC API 변경/Mock/콜백 요청과 설치 준비의 경합 차단.
- `Apply-DesktopUpdate.ps1`: 해시·PID/시작 시각 검사, 설치 commit 대기, 정상 종료 대기, MSI 결과/로그, 기존 launcher 재시작 시도.

## 검증 근거

- 프론트 build/lint 통과. 번들 `index-BcjDk_Wq.js`; 기존 Fast Refresh·bundle 크기 경고는 남는다.
- 업데이트 집중 테스트 17개 통과: 버전 비교, manifest 경로·해시·호환 선언, 정상 다운로드 바이트, 잘린 본문/부분 파일 정리, 서버 변경, 신규 요청과 설치 경합.
- 기존 실행 회귀 17개 통과: ManagedExecutionIntegrationTest 9, AgentTaskServiceTest 7, DesktopDispatcherTest 1. 합계 34개. 마지막 상태 무효화·주기 확인 변경 후 업데이트 집중 17개와 bootJar를 다시 통과했다.
- 구 0.3.3 실제 MSI를 0.3.4로 잘못 게시하려는 시도는 MSI 내부 버전 검증에서 거부됐다.
- helper의 잘못된 해시/PID 격리 검증 통과. msiexec 성공 실행을 대신하는 테스트가 아니다.
- 실제 Swing에 available/ready fixture를 넣어 700/520 폭 및 긴 변경 내용의 위/아래를 렌더했다. 가로 잘림 검사 통과. [네이티브 검증](native-updater-2026-10-03.md).
- 18182 실제 CUA 브라우저에서 설정 → 앱 업데이트를 열었다. manifest 미게시를 최신으로 표시하지 않고, 설치·다운로드 버튼을 비활성화함을 확인했다. 1024×768에서도 내용과 버튼이 화면 안에 있다.
- 게시 후 같은 화면에서 업데이트 확인을 눌러 현재/배포 버전 모두 0.3.4, 새 버전 없음 표시와 동일 버전 재설치 비활성화를 확인했다. 변경 내용도 실제 배포 manifest와 일치했다. 화면: `docs/images/app-update-2026-10-03/current-notes-1024.png`. 임시 viewport 설정은 되돌렸다.

## 실제 배포 확인

최종 파일은 `backend/build/windows-installer-0.3.4-final/FlowLink-0.3.4.msi`다. 생성 후 18080 다운로드 볼륨에 게시하고 HTTP로 다시 받은 파일을 비교했다.

| 항목 | 확인값 |
|---|---|
| 서버 API | serverVersion 0.3.4, releaseStatus AVAILABLE, automaticUpdateAllowed true |
| MSI 크기 | 196,585,775 bytes |
| MSI SHA-256 | `49CDBD07934081E129DDFA3A5A4A2A23F515F6744636966CEF75E38A6C68CA76` |
| 서버·18182 JAR SHA-256 | `ABDF2B062B5207B52333B0C1C019DDF3ED97CEB9FFEA80BAD98FBD7226625C5F` |
| 서버 MCP 배포 package.json | 0.4.1. 파일 확인만 수행 |
| MSI 서명 상태 | NotSigned |

[검증 서버의 설치파일](http://127.0.0.1:18080/downloads/FlowLink-0.3.4-windows-x64.msi). 직접 다운로드 바이트의 크기·SHA-256과 서버 manifest가 최종 MSI와 일치했다. 최초 빌드 후보는 서버에 게시하지 않았으며, 사용자 지정 설치 경로 유지 보강을 포함한 `-final` 산출물만 서버에 게시했다.

## 검증 한계와 기존 앱

설치된 개인 앱 **18180은 0.3.3 그대로**다. 개인 DB·계정·IDE 설정을 변경하지 않았다. 새 MSI의 실제 업그레이드/취소/재부팅 성공 경로와 자동 재시작은 아직 실설치로 검증하지 않았다. 현재 MSI는 코드 서명되지 않은 검증용 산출물이며 서버 주소는 `http://127.0.0.1:18080`이다. 사내 배포 시 실제 HTTPS 주소를 넣어 빌드하고 조직의 서명·설치 검증을 거쳐야 한다.

MCP는 읽기 도구의 소스와 JavaScript 문법만 확인했다. MCP 프로토콜·도구 호출·IDE 등록 테스트는 수행하지 않았다. 기존 로컬 MCP 호환 파일이 MSI에 남아 있다는 점과 중앙 MCP/에이전트 분리 목표의 후속 구현은 업데이트 기능 완료 여부와 별개다.

운영 절차는 [APP_UPDATES.md](../APP_UPDATES.md), 전체 분리 목표와 아직 남은 구현은 [아키텍처](../FLOWLINK_TARGET_ARCHITECTURE.md)에 있다. 이 검증으로 제품 전체가 완성됐다고 선언하지 않는다.
