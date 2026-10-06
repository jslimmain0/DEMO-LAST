# 앱 배포와 업데이트

Windows 앱·트레이·PC 실행 기능은 MSI 한 개로 함께 업데이트한다. 서버는 설치파일과 배포 정보를 제공하며, PC 앱은 자신이 연결한 회사 서버에서 버전을 확인한다. 중앙 MCP 서버는 서버 배포에 포함한다. Oracle·Vault 및 서버 컨테이너를 PC 앱이 교체하지 않는다.

## 사용 흐름

1. 앱 시작 후와 주기적으로 배포 버전을 확인한다. 웹 설정의 **앱 업데이트** 또는 트레이의 업데이트 메뉴에서 직접 확인할 수도 있다.
2. **설치파일 다운로드**를 누르면 백그라운드에서 받는다. 응답을 다른 서버로 리디렉션하지 않으며, 크기와 SHA-256이 배포 정보와 일치해야 설치할 수 있다.
3. **Windows 앱에서 설치**를 누르면 같은 네이티브 업데이트 창이 열린다. 모든 브라우저 창의 변경을 저장하고, PC Mock 수신이 일시 중단됨을 확인한다.
4. 앱이 새 실행과 변경 요청을 막은 뒤 실행·콜백 대기·에이전트 작업을 다시 조회한다. 남아 있으면 설치를 보류하고 기존 앱을 유지한다.
5. 보조 프로그램 준비 후 앱을 정상 종료하고 MSI를 실행한다. 강제 종료나 Windows 강제 재부팅을 하지 않는다. 실패·취소·재부팅 필요 결과를 남기고 앱을 다시 연다.

개인 H2·시크릿 키·로그인 세션은 사용자 데이터 디렉터리에 남는다. MSI 설치 디렉터리를 데이터 저장소로 쓰지 않는다. 서버 연결이 끊어지거나 업데이트 확인이 실패해도 개인 작업은 계속할 수 있다.

## 배포 준비

루트 `VERSION`이 서버 JAR·중앙 `flow-mcp` 라이브러리와 Windows MSI의 버전 기준이다. 같은 버전 번호로 내용이 다른 설치파일을 다시 배포하지 않는다. Maven/Gradle 개발 버전이나 파일명 추정으로 현재 버전을 표시하지 않는다. 설치 구현과 릴리스 게시 코드는 `backend/flow-desktop/installer/`에 있으며 루트 패키징·게시 명령은 호환 진입점으로 유지한다.

```powershell
# VERSION을 새 번호로 올린 뒤 실제 공개 HTTPS 서버 주소를 주입해 빌드한다.
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1 `
  -Type msi -JdkPath '<JDK 21 경로>' -WixPath '<WiX 3 경로>' `
  -ServerUrl 'https://flowlink.example.internal' -OutputDir 'backend/build/release'

# 빌드 결과의 distribution 전체를 서버에 게시한다. 선택적으로 인증서로 MSI 서명한 뒤 이 명령을 실행한다.
powershell -ExecutionPolicy Bypass -File scripts/Publish-DesktopRelease.ps1 `
  -InstallerPath 'backend/build/release/FlowLink-0.3.4.msi' `
  -Destination '<서버 다운로드 볼륨 경로>' `
  -ReleaseNotes '변경 내용'
```

게시 스크립트는 MSI 내부 제품명·버전·고정 UpgradeCode를 확인하고, 불변 파일 `FlowLink-{version}-windows-x64.msi`를 먼저 놓은 다음 `release-manifest.json`을 원자적으로 교체한다. 기존 같은 버전의 해시가 다르면 거절한다. MSI에 서명한다면 **서명 후** manifest를 생성해야 한다. 운영 환경의 기존 서명 인증서·배포 절차를 사용하며, 이 기능 자체가 발행자 서명을 생성하지는 않는다.

`FLOWLINK_DISTRIBUTION_DIR`은 두 파일이 있는 디렉터리다. `infra/server.compose.yml`은 `FLOWLINK_DOWNLOAD_DIR`을 그 디렉터리에 읽기 전용으로 마운트한다. `FLOWLINK_PUBLIC_URL`을 실제 외부 HTTPS 주소로 설정하면 중앙 MCP 주소는 같은 주소의 `/mcp`로 제공된다. 서버 JAR/MCP 변경은 해당 릴리스의 서버 이미지로 배포한다.

설치파일의 서버 주소는 `-ServerUrl` 또는 빌드 환경의 `FLOWLINK_PUBLIC_URL`로 반드시 지정한다. 다운로드한 웹페이지 주소를 MSI가 추론하지 않는다. 주소를 생략하면 패키징 전에 중단하며, HTTP 루프백은 명시적으로 지정한 로컬 검증용으로만 허용한다. 신규 설치는 이 주소를 사용하고, 이미 설치된 앱은 암호화 파일에 저장된 서버·계정을 우선한다. 앱 시작 후 MCP 안내 주소를 비동기로 갱신하며, 서버가 오프라인이어도 개인 작업과 저장된 로그인은 유지한다.

## 배포 정보 계약

`GET /api/v1/distribution`은 실행 중인 `serverVersion`과 다음 상태를 반환한다.

| 상태 | 의미 |
|---|---|
| AVAILABLE | manifest·설치파일 검증 및 현재 서버 호환 선언 통과 |
| MISSING | manifest 미게시. 최신 버전이라는 의미가 아님 |
| INVALID | JSON 형식·경로·파일 크기·해시 등이 맞지 않음 |
| INCOMPATIBLE | 파일은 확인했지만 현재 서버와의 호환 선언이 없음. 자동 업데이트 보류 |

manifest schemaVersion 1은 version, platform=windows, arch=x64, 고정 downloadPath, size, sha256, releaseNotes, compatibleServerVersions를 담는다. 호환 목록은 해당 조합을 검증한 서버 버전만 넣는다. 이는 미구현 에이전트 프로토콜의 호환성 보증이 아니다. 여러 서버 버전을 검증했다면 게시 스크립트의 `-CompatibleServerVersions`에 명시한다.

앱은 등록된 서버의 HTTPS와 같은 주소의 고정 다운로드 경로만 자동 다운로드에 사용한다. 로컬 실험용 localhost/127.0.0.1 HTTP는 허용한다. 일반 사내 HTTP 서버는 HTTPS를 구성하거나 수동 설치한다. SHA-256은 파일 일치 검증이며 서버 신원 확인을 대신하지 않는다.

## 이전 버전과 MCP

업데이터가 없는 **0.3.3 이하 앱은 최초 한 번 MSI로 직접 업그레이드**해야 한다. 이후 앱 안의 업데이트 흐름을 이용한다. 검증된 manifest가 없는 구 서버를 최신으로 표시하지 않는다.

중앙 MCP의 `flowlink_update_status`는 서버와 배포 버전을 읽고 설치 안내를 제공한다. 중앙 연결에서 PC 설치 버전을 알 수 없는 경우 그 사실을 표시한다. MCP가 무인으로 Windows 앱을 종료하거나 설치 명령을 실행하지 않는다. 이 변경에서 MCP 프로토콜·도구 호출·IDE 등록 테스트는 하지 않는다.

## 확인한 외부 계약

- Windows Installer의 진행 UI와 재부팅 억제 옵션: [Microsoft 표준 설치 명령 옵션](https://learn.microsoft.com/en-us/windows/win32/msi/standard-installer-command-line-options).
- MSI 업그레이드 식별자와 앱 버전 옵션: [JDK 21 jpackage](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jpackage.html).
