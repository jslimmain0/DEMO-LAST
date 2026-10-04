# 로컬 에이전트 + Docker 서버 실사용 테스트

> **2026-10-03:** 현재 `agent-lab`은 GitHub 로그인 **모킹**으로 동작한다. 서버 `http://127.0.0.1:18080`, 네이티브 설치본 `/downloads/FlowLink.msi`, PC 앱 `:18180`이다. 아래는 초기 실사용 기록이다. **현재 혼합 실행·저장소 분리·재시작 복구 결과는 [0.3 구현·검증 보고](HYBRID_AGENT_RELEASE.md)**를 기준으로 본다. 아래 MCP 검증 기록과 실행 예제는 테스트 금지 요청 이전의 역사적 기록이며 현재는 MCP를 테스트하지 않는다.

2026-10-02. 설치된 개인 에이전트와 GitHub 인증 서버를 함께 켜 놓고 확인하는 개발 환경이다.

| 대상 | 접속 | 실행 위치 / 저장소 |
|---|---|---|
| 개인 화면 | 트레이 → 화면 열기 | PC :18180 / `%LOCALAPPDATA%\FlowLink` |
| 서버 화면 | [서버 열기](http://127.0.0.1:18080) | Docker / 별도 영속 볼륨 |
| 개인 MCP | 트레이 → MCP 연결 → stdio 설정 | IDE가 PC의 내장 Node 실행 |
| 서버 MCP | `http://127.0.0.1:18090/mcp` | Docker 안의 Node / 서버 OAuth 인증 |

서버는 GitHub 로그인을 강제하고 게스트 접근을 끈다. 로그인 버튼은 실제 GitHub 디바이스 코드를 발급한다. GitHub 페이지에서 계정 인증을 마치면 화면이 자동으로 열린다. 코드가 만료되면 **다시 시작**한다. 최초 로그인 계정은 기존 가입 정책에 따라 서버 관리자로 등록된다.

브라우저 로그인과 IDE 서버 MCP 로그인은 별도 세션이다. 서버 AI 어시스턴트는 기존 GitHub 로그인 연동으로 Copilot 연결을 시도하며, 실제 모델 사용은 계정 권한과 네트워크를 추가 확인해야 한다.

## 시작·종료

```powershell
# 이미 빌드된 jar로 시작. 이번 서버 기동에 사용한 명령.
powershell -ExecutionPolicy Bypass -File scripts\start-agent-lab.ps1

# 소스 재빌드: JDK 21, Node 24+, npm 필요
powershell -ExecutionPolicy Bypass -File scripts\start-agent-lab.ps1 -Build

docker compose -f infra/agent-lab.compose.yml ps
docker compose -f infra/agent-lab.compose.yml logs --tail 100

# 볼륨을 보존하고 종료
docker compose -f infra/agent-lab.compose.yml down
```

서버·MCP 포트는 `127.0.0.1`에 공개한다. 데이터와 MCP 등록 정보는 `flowlink-agent-lab_server-data` 볼륨에 보존한다. 저장 암호화 키는 스크립트가 한 번 생성하고 사용자 전용 ACL의 `.run/agent-lab/secrets.env`에 저장한다. JWT 서명키는 서버 DB가 생성·보존한다. 복원할 때는 볼륨과 키 파일을 함께 보관한다.

서버 MCP는 서버와 네트워크를 공유한다. 서버 MCP의 `localhost` 요청은 Docker, 개인 stdio MCP의 요청은 PC를 가리킨다. 개인 DB와 서버 DB는 별개다. 서버 화면을 열었다고 개인 데이터가 업로드되지는 않는다.

## IDE 연결

VS Code 사용자 MCP 구성의 기존 `servers`에 아래 항목을 추가한다.

```json
{
  "servers": {
    "flowlink-server-lab": {
      "type": "http",
      "url": "http://127.0.0.1:18090/mcp"
    }
  }
}
```

서버 시작·GitHub 인증 후 Copilot Agent의 도구 목록을 확인한다. [VS Code 공식 안내](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

IntelliJ는 GitHub Copilot Chat의 Agent 모드 → 도구 설정 → Add MCP Tools에서 구성한다. 개인 에이전트는 트레이가 복사한 `servers` 안의 `command`·`args`를 사용한다. [GitHub의 JetBrains 구성 안내](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp?tool=jetbrains). IntelliJ에서 FlowLink 원격 OAuth가 끝까지 연결되는지는 아직 실검증 전이다.

처음에는 `flowlink_status`로 실행 위치를 확인한다. 개인·서버에 같은 이름의 환경을 만들되 값을 `LOCAL`, `SERVER`로 다르게 넣어 저장소와 호출 출발지가 분리되는지 확인한다.

## 확인한 결과

| 항목 | 결과 / 범위 |
|---|---|
| 실제 서버 | 서버·MCP 모두 Docker healthcheck 통과 |
| 실제 접근 제어 | 관리 API·MCP 무토큰 요청 모두 401 |
| 실제 GitHub | 디바이스 코드 발급 성공. 사용자 계정 인증 완료 확인은 대기 |
| 기존 MCP 스모크 | **115개 통과**. OAuth는 모의 GitHub, 도구는 별도 격리 Docker 앱에서 실행 |
| 추가 기능 스모크 | **14개 통과**. 아래 기능을 격리 Docker 앱에서 실제 실행 |
| 실제 브라우저 | 숫자·JSON 오류 검사 → 입력 재개, client HTTP fetch, FORM iframe 표시·실행 완료 |
| 이전 설치형 검증 | [검증 기록](DESKTOP_AGENT_PROGRESS.md)의 백엔드 276개, 로컬/서버 경계 11개 |

추가 14개: 상태·순차 HTTP Mock, SET/ASSERT/START/END, IF 비활성 분기, SWITCH 선택, INPUT 재개, 대기 취소, client HTTP 재개, FORM 재개, WAIT 콜백, 브라우저 없는 WAIT 타임아웃, 웹훅 발화·비활성 거절, 스케줄러 실발화, 3개 워크플로 스위트, 실패 알림 HTTP 전달.

기존 115개에는 전문·미리보기·EUC-KR, TCP Mock 왕복, 플러그인 초안·시험·승인, 버전 복원·고정, 실행 이력·재실행, 개인 워크스페이스·폴더, 환경 CRUD, HTTP Mock, 동시 MCP 호출이 포함된다. 모든 버튼·계정 조합의 검증 완료를 의미하지 않는다.

![격리 서버에서 실제 FORM iframe과 실행 성공 확인](../.run/agent-lab/form-browser.png)

추가 검증은 별도 `flowlink-lab-regression` 컨테이너(:18181)에서 실행한다. 자동 검증 후 이 인스턴스는 종료하며 개인 데이터·실사용 서버 DB는 건드리지 않는다.

```powershell
# 별도 격리 dev 앱을 띄운 뒤 mcp/에서 실행. 로그인 필수 실사용 서버에 실행하지 않는다.
$env:FLOWLINK_URL='http://127.0.0.1:18181'
$env:FLOWLINK_EXECUTION_URL='http://127.0.0.1:18080' # 해당 컨테이너 내부 앱 주소
npm test
npm run test:features
```

## 직접 확인할 순서

1. GitHub 로그인 → 대시보드 → 새로고침 → 로그아웃 → 다시 로그인.
2. 개인·서버 각각 워크플로·환경을 만들고 실행 위치·저장소 분리 확인.
3. HTTP Mock/HTTP/ASSERT, 전문/TCP Mock/TCP를 실행하고 성공·실패·이력·재실행·버전 확인.
4. 사용자 입력에 잘못된 숫자/JSON → 올바른 값 → 확인. 다음 실행에서 취소.
5. FORM 가짜 결제창, WAIT 콜백·타임아웃·중단. PC 외부에서 localhost 콜백을 보내려면 아직 미구현인 서버 중계가 필요하다.
6. 공통/환경 시크릿과 로그 마스킹, 스위트, 웹훅·스케줄, 플러그인 승인, Mock 요청 기록.
7. Copilot의 개인 stdio/서버 HTTP MCP에서 `flowlink_status`와 실제 도구 호출. IDE 실검증은 SDK 검증과 별개다.
8. 두 번째 GitHub 계정으로 가입 대기·승인·팀 멤버·viewer/editor·차단 확인. 두 번째 계정 검증은 아직 진행 전이다.
9. 서버 재시작 후 로그인·워크플로·환경·시크릿·이력 유지와 WAIT 복원. 진행 중인 GitHub 디바이스 로그인은 서버 재시작 시 다시 시작해야 한다.

Vault/Oracle 외부 연동, 실제 Copilot 모델 호출, IntelliJ OAuth, 설치 업데이트·코드 서명은 별도 환경 또는 사용자 인증이 필요한 검증이다. 위 통과 수에 포함하지 않는다.
