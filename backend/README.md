# 역할별 빌드

`runtime`은 기존 저장소·API·실행 엔진을 공유한다. `server-app`과 `desktop-app`은 각 역할의 실행 진입점과 배포 JAR를 만든다. 독립 에이전트 프로세스나 조정기 전면 분리를 완료했다는 뜻은 아니다.

프론트엔드를 먼저 빌드한 뒤 backend 디렉터리에서 실행한다.

```powershell
.\gradlew.bat :server-app:bootJar :desktop-app:bootJar
```

개발 기동은 `:server-app:bootRun` 또는 `:desktop-app:bootRun` 중 하나를 지정한다. 상대 경로의 기준은 기존처럼 `backend/`이며, 개인 앱은 로그인·DB·루프백 보호 설정을 자동 적용한다.

- 서버: `server-app/build/libs/flowlink-server.jar`. 루트 `scripts/start.ps1`, `scripts/start.sh`, 서버 Docker가 사용한다.
- Windows: `desktop-app/build/libs/flowlink-desktop.jar`. `scripts/package-desktop.ps1`이 MSI에 넣는다. 기존 개인 저장 위치와 MSI UpgradeCode는 유지한다.
- Oracle SQL: `runtime/src/main/resources/db/`. 기존 스키마 검증에서 사용하는 `git show HEAD:backend/src/...`는 역사 자료 경로이므로 유지한다.

```powershell
# 저장소 루트, 공개 서버 주소를 명시한다.
.\scripts\package-desktop.ps1 -ServerUrl https://flowlink.example.internal
```

`-SkipBuild`는 해당 desktop JAR와 VERSION이 일치할 때만 사용한다. Node/MCP 번들 구성은 이번 모듈 분리에서 바꾸지 않는다. 기존 출시 0.3.7 MSI는 이전 산출물이므로 새 분리 JAR 포함을 주장하지 않는다.

의존 방향은 `server-app → runtime ← desktop-app`이며 실행 모듈끼리는 의존하지 않는다.
DesktopSession·DesktopConnection은 기존 서버 코드 참조 때문에 아직 runtime에 남아 있다. 이는 미완성 역할 경계이며 독립 에이전트 실행을 보장하지 않는다.

검증 도구는 저장소 루트의 `scripts/test/module-artifacts.ps1`(JAR 내부 역할·드라이버·진입점)과 `scripts/test/module-launchers.ps1`(임시 H2로 실제 기동·개인 접근 보호·잘못된 설정 거부)이다. 기동 검사는 자신의 임시 프로세스만 종료한다.

2026-10-04 검증: 관련 JUnit 71건과 없는 API의 404 회귀 1건 통과. 두 실행 JAR 빌드·내부 구성 검사·실제 격리 기동 검사 통과. 기존 설치 앱과 배포된 MSI는 교체하지 않았다.
