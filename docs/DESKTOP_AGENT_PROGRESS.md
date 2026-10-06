# FlowLink 개인 에이전트 — 첫 구현과 검증 결과

> 현재 구성과 설치 payload는 [역할별 빌드](../backend/README.md)를 따른다. 중앙 Kotlin MCP는 서버 `/mcp`에서 제공하고 MSI의 Node·로컬 stdio MCP는 제거했다. 아래 Node/stdio 설명과 테스트 수는 이전 릴리스 기록이다.

> **2026-10-03 상태:** 아래는 0.1·0.2 초기 구현 기록이다. **노드별 PC→서버→PC 혼합 실행은 0.3에서 구현했으며**, 최신 결과는 [0.3 구현·검증 보고](HYBRID_AGENT_RELEASE.md)를 기준으로 본다. 과거 MCP 검증 결과는 현재 버전의 검증이 아니다. 테스트 금지 요청 이후 MCP·IDE 호출 테스트는 실행하지 않았다.

현재 기반 검증: 백엔드 278개, 개인/서버 저장소 분리 REST 13개, PC·서버 기능 REST 각 14개, 재시작·암호화 시크릿·WAIT 복구 14개, 앱 세션 공동 편집 연결·로그아웃 차단 통과. 네이티브 MSI 0.1→0.2 업데이트 후 기존 개인 워크플로 ID·장치 ID·암호화 키를 유지했다. GitHub 로그인은 `agent-lab` 모킹이다. MCP 테스트 금지 요청 이후 MCP·IDE 호출 테스트는 실행하지 않았다.

2026-10-02 · `codex/trim-config` · Windows x64 시제품 0.1.0

## 구현한 범위

기존 Spring 실행 엔진을 PC와 서버에서 각각 구동한다. 개인 앱은 PC의 파일 DB를 사용하고, 서버 앱은 서버의 DB와 기존 GitHub 인증·워크스페이스 권한을 사용한다. 하나의 실행은 시작한 런타임에서 끝까지 처리한다. 노드별 원격 분산 실행이나 작업 전달 서비스를 새로 만들지 않았다.

PC에 설치하는 구성은 다음과 같다.

- Java 런타임 + 기존 화면/API + H2 + 트레이를 한 패키지에 포함한다. 브라우저를 닫아도 앱은 실행된다.
- 기존 Node MCP와 의존성을 함께 포함한다. IDE가 **stdio MCP**를 실행하므로 사용자가 Node를 설치하거나 로컬 MCP URL·토큰을 입력할 필요가 없다.
- 트레이: 화면 열기, MCP 연결, 서버 화면 열기/로그인, 에이전트 상태, 종료. 중복 실행은 기존 앱의 화면을 연다.
- VS Code는 공식 CLI로 사용자 MCP 설정에 등록한다. IntelliJ는 Copilot의 MCP 설정에 넣을 JSON을 복사한다. 개인 접속 키의 값은 JSON에 넣지 않는다.
- 화면과 MCP 상태에 `내 PC / 서버` 실행 위치를 표시한다. 서버 화면은 별도 브라우저 origin에서 기존 로그인 절차로 사용한다.

서버 HTTP MCP와 OAuth는 계속 사용할 수 있다. 현재 트레이의 서버 기능은 서버 화면을 여는 동선이며, 개인 화면 안에서 서버 API를 프록시하는 게이트웨이는 아직 없다.

## 개인 저장소와 보호

기본 개인 데이터 위치는 `%LOCALAPPDATA%\FlowLink`다. 설치 프로그램 파일과 개인 데이터를 별도 폴더에 둔다. 개발 실행은 `--flowlink.desktop.data-dir=...` 또는 `FLOWLINK_AGENT_DATA_DIR`로 테스트 저장소를 지정할 수 있다.

| 항목 | 위치/동작 |
|---|---|
| 정의·환경·시크릿·이력·대기 상태 | `db/flowlink.mv.db` — 개인 H2 파일 |
| 암호화 키 | `storage.key` — 개인별 생성, 재시작 시 유지 |
| 장치 ID | `device.id` — 재시작 시 유지 |
| MCP 접속 정보 | `agent.json` — loopback 주소와 매 기동마다 바뀌는 접근 키 |
| JAR 플러그인 | `plugins/` — 기존 기본 비활성 정책 유지 |
| 로그 | `logs/flowlink.log` — 5MB 회전, 7일 보관 |

관리 API는 `127.0.0.1`에 바인딩하고 Host·Origin과 접근 키를 검사한다. 트레이의 화면 열기는 30초짜리 일회용 티켓을 사용하며, 브라우저에는 HttpOnly·SameSite=Strict 쿠키를 발급한다. 설치형 MCP는 보호된 접속 파일을 읽고, 앱을 재시작하면 새 접근 키를 읽는다.

사용자가 만든 Mock HTML은 `localhost` origin으로 보내 관리 화면의 `127.0.0.1` origin과 분리한다. Mock·콜백·웹훅은 기존 외부 수신 경로를 유지한다. TCP Mock도 개인 프로파일에서는 loopback에 바인딩한다. MCP의 자동 접속 자격 증명은 관리 API에만 붙으며 외부 테스트 URL·Mock·콜백에는 보내지 않는다.

개인 키 파일은 Windows 사용자 ACL(다른 OS에서는 소유자 권한)로 보호한다. **DPAPI/OS 키체인에 암호화해서 저장하는 구현은 아니다.** 시크릿과 대기 스냅샷은 이 키로 AES-GCM 암호화하고, 일반 정의·환경 전체 DB를 암호화하지는 않는다. 백업은 DB와 `storage.key`를 함께 보관해야 한다. DB만 있고 키가 없으면 새 키를 생성해 진행하지 않고 기동을 중단한다.

서버용 DB URL·GitHub 인증·Vault Transit·전체 인터페이스 바인딩 설정이 개인 프로파일을 덮어쓰면 DB 연결 전에 기동을 중단한다. 서버 설정과 개인 설정이 섞여 개인 데이터를 서버 DB에 쓰는 것을 막는다.

## 검증 결과

| 검증 | 결과 |
|---|---|
| 백엔드 전체 테스트 | 50개 스위트, **276개 통과**, 실패·오류·skip 0 |
| 기존 서버 HTTP MCP | 실제 격리 Docker 앱에서 **115개 통과** — OAuth, 도구, 전문, HTTP/TCP Mock, 플러그인, 실행·재개, 워크스페이스 등 |
| 설치 패키지 + 서버 경계 | **11개 통과** — 아래 시나리오 |
| 프론트 빌드 | 성공 |
| 프론트 lint | 성공, 기존 Fast Refresh 경고 16개 |
| VS Code CLI 등록 | VS Code **1.136.1 x64**, 임시 사용자 프로필의 `User/mcp.json`에 정상 등록 |
| 브라우저 | 개인 패키지의 일회용 티켓 → 실제 대시보드, `실행 위치: 내 PC`, 개인 워크스페이스와 트레이 MCP 안내 확인 |
| Java/Node 별도 설치 의존 | 자식 프로세스 PATH에서 설치된 Java·Node를 제외한 상태로 패키지와 내장 Node 실행 성공 |

경계 테스트는 PC와 Docker 안에 같은 포트의 HTTP·TCP 테스트 서버를 각각 만들고, 같은 `127.0.0.1` 주소로 호출한다. PC는 `LOCAL`, Docker는 `SERVER`를 반환해야 통과한다. 다음을 실제 프로세스로 확인했다.

1. 개인 관리 API의 무인증·외부 Origin·Mock origin 접근 차단.
2. 화면 티켓의 일회성, 쿠키 속성, 정적 화면 접근.
3. 중복 실행 시 기존 프로세스와 DB 유지.
4. 내장 Node의 SDK stdio 연결과 PC HTTP 요청, 관리 API 호출.
5. 로그인 없는 서버 API와 잘못된 JWT 차단, 테스트 JWT의 인증된 서버 접근.
6. 서버 MCP의 동일 localhost 요청이 컨테이너에서 실행됨.
7. PC 워크플로의 HTTP·TCP·EUC-KR·환경 변수·시크릿 전달과 로그 마스킹.
8. 동일 서버 워크플로의 HTTP·TCP·EUC-KR·환경 변수·시크릿 전달과 로그 마스킹.
9. PC와 서버의 정의·동일 이름 환경·시크릿이 서로 다른 DB에 저장됨.
10. 개인 프로세스 강제 종료/재시작 후 암호화 시크릿·WAIT 복원, 콜백 재개, 장치 ID 유지, 접근 키 교체와 기존 MCP 연결 재사용.
11. URL을 정규화해 `..`·인코딩된 경로 우회와 외부 주소로 관리 자격 증명이 전달되지 않음을 확인.

처음 강제 종료 검증에서 H2 기본 지연 기록 때문에 WAIT 스냅샷 일부가 소실됐다. 개인 DB에 `WRITE_DELAY=0`을 적용해 커밋을 즉시 기록하도록 고쳤고 최종 패키지로 재검증했다. VS Code CLI 경로도 버전별 설치 디렉터리 때문에 실패하여, 설치된 공식 `code.cmd`가 가리키는 경로를 사용하도록 고쳤다.

브라우저 검증용 개인 앱의 시작 시간은 약 **7.2초**(프로세스 시작부터 약 7.8초)였다. 대시보드 부트스트랩 후 JVM 프로세스의 Working Set은 약 **564MB**, Private Bytes는 약 **634MB**였다. 이 PC에서 측정한 값이며 일반적인 PC 성능이나 상한을 보장하는 수치는 아니다. 설치 크기와 메모리 최적화는 배포 전 확인할 항목이다.

테스트 서버의 인증은 격리된 테스트 JWT와 기존 OAuth 모의 로그인으로 검증했다. 실제 GitHub 로그인, 실제 IDE의 Copilot 도구 호출, 사내 프록시 TLS는 별도 검증이 필요하다. 기존 사용자 DB·컨테이너는 사용하지 않았으며 테스트가 만든 컨테이너는 종료 후 제거했다.

## 실행과 재현

빌드 PC에는 JDK 21, Node 24+, npm이 필요하다. 설치 PC에는 Java·Node를 따로 설치하지 않는다. Java는 Windows 인증서 저장소를 사용하고, MCP 연결 JSON의 Node 인자에는 `--use-system-ca`를 포함한다. [Node 공식 CA 안내](https://nodejs.org/learn/http/enterprise-network-configuration), [Java jpackage](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jpackage.html).

```powershell
# 화면 포함 빌드 + 실행 폴더 생성
powershell -ExecutionPolicy Bypass -File scripts\package-desktop.ps1

# 이미 빌드된 jar로 MSI 생성. WiX 3.x 경로는 빌드 PC에만 필요하다.
powershell -ExecutionPolicy Bypass -File scripts\package-desktop.ps1 `
  -SkipBuild -Type msi -WixPath C:\tools\wix3

# 실행 폴더에서 직접 실행
.\backend\build\desktop-release\FlowLink\FlowLink.exe
```

최종 실행 폴더는 `backend/build/desktop-release/FlowLink/`, 설치 파일은 `backend/build/windows-installer/FlowLink-0.1.0.msi`다. 생성물은 Git에 포함하지 않는다. MSI는 현재 사용자 설치이며 개인 데이터 폴더는 앱 업그레이드 대상과 분리한다.

MSI 크기는 약 **184MB**, 실행 폴더의 파일 합계는 약 **393MB**다. MSI의 기본 프로그램 설치 위치는 `%LOCALAPPDATA%\FlowLinkApp`이며 개인 데이터는 `%LOCALAPPDATA%\FlowLink`에 둔다. 서명된 정식 배포물이 아니며 새 Windows에서 설치·제거·업그레이드는 아직 검증하지 않았다.

```powershell
# 로컬/서버 실행 경계 테스트
docker build -f infra/agent-test.Dockerfile -t flowlink-agent-test .
cd mcp
npm run test:agent -- --bundle ../backend/build/desktop-release/FlowLink

# jar로 개발 실행을 검증하려면 --bundle을 생략한다.
# 기존 서버 MCP 회귀 검증은 별도 격리 dev 앱 주소로 실행한다.
$env:FLOWLINK_URL='http://127.0.0.1:테스트포트'
npm test
```

경계 테스트는 `.run/agent-smoke-*`에 자기 DB·로그를 만들며 테스트 데이터는 기존 개인 저장소와 분리된다. Docker 이미지도 검증 전용이다. 운영 서버 배포 이미지로 사용하지 않는다.

## 남은 작업과 다음 순서

첫 구현은 설치형 실행 경로의 타당성 검증이다. [전체 계획](DESKTOP_AGENT_PLAN.md)의 모든 단계가 완료된 상태는 아니다.

1. VS Code·IntelliJ의 실제 Copilot Agent에서 도구 목록/호출, 트레이 메뉴 클릭·종료 동선, 새 Windows 환경에서 MSI 설치·제거·업그레이드를 검증한다. 현재 CLI/SDK 검증을 IDE 실사용 검증으로 간주하지 않는다.
2. 포트 충돌 안내, 자동 시작·업데이트·코드 서명, 프록시·CA와 원격 IDE(WSL/SSH/Container) 지원 범위를 정한다. 현재 기본 개인 앱 포트는 18180이며 자동 포트 회피는 없다.
3. 실행 환경 선택 실패를 명확히 처리하고 이력에 환경·실행 위치 스냅샷을 남긴다. 기존 단일 노드 실행·재실행의 환경 전달 문제도 공통 실행 경로에서 고친다.
4. 서버 접속을 개인 화면에 통합하고, 전문·플러그인 참조까지 포함하는 명시적 복사를 완성한다. 환경·시크릿의 서버 내 워크스페이스별 범위도 구현한다. 현재 서버의 공통 범위 모델은 그대로다.
5. 외부 시스템이 PC로 콜백해야 할 때만 인증된 서버 중계를 추가한다. 현재 localhost 콜백은 PC 외부에서 직접 접근할 수 없다. 설정에 서버 주소만 입력하는 것으로 원격 콜백 중계가 생기지는 않는다.

정식 배포 전에는 DB와 키를 함께 백업·복원하는 동선, 로그/개인 데이터 보존 정책도 검증한다.
