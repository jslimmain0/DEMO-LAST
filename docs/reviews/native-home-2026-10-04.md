# Windows 앱 홈·계정 화면 개선 (2026-10-04)

## 합의와 구현

웹 화면을 네이티브에 복제하지 않고, 작업 화면을 여는 홈과 회사 계정·자동 설정·업데이트 진입을 정리했다. 홈의 주 행동은 `워크스페이스 열기`이며 개인 작업은 로그인 없이 사용할 수 있다. 회사 계정은 토큰 존재를 실제 네트워크 접속 성공으로 표현하지 않고 `로그인 정보 저장됨`으로 표시한다.

알려진 회사 주소는 읽기 상태로 먼저 보여주고 `서버 변경`을 펼쳤을 때 입력을 노출한다. 주소가 없으면 입력은 처음부터 보인다. 인증 코드는 로그인 요청을 시작한 뒤에만 표시한다. 저장된 회사 계정으로 작업을 여는 주 행동과 다른 계정으로 로그인하는 보조 행동을 구분했다. 인증 성공 후에는 오래된 로그인 상태가 남은 홈을 닫는다.

IDE 안내에는 실제 `mcpUrl`이 있을 때 주소와 복사를 제공한다. 앱이 IDE 연결 상태를 확인하지 않는다는 한계를 명시한다. 로컬 MCP 등록이나 IDE 설정 변경은 실행하지 않는다.

색은 웹의 코발트·차분한 blue-gray와 맞추고, 큰 제목과 긴 안내 폼의 비중을 낮췄다. 기존 `buildWelcomeDialog`, `buildLoginDialog`, `buildStatusDialog`, `buildConnectDialog`, `buildUpdateDialog`를 유지했다. 인증·H2·포트·업데이트 설치 gate·종료 계약은 바꾸지 않았다.

## 검증

- root의 Kotlin 컴파일 결과에 회사 워크스페이스 열기와 인증 완료 후 홈 닫기 보완이 포함된 것을 source/class 시간으로 확인했다.
- `NativeShellPreview.java`의 saved/no-server/auth-waiting 상태를 실제 Swing 컴포넌트로 700/520px, 상단/하단 각각 렌더했다. 화면 범위 검사가 통과했다. 숨긴 패널은 범위 검사에서 제외하도록 renderer를 교정했다.
- 캡처는 `docs/images/native-home-2026-10-04/`에 저장했다. 맑은 고딕에서 서버 변경 화살표가 사각형으로 표시돼 해당 기호를 제거했다.
- 인증 대기는 widget 상태를 주입한 **시각 fixture**다. 실제 인증 시작/poll, 계정 변경, 네트워크 호출 또는 로그인 재사용 성공을 검증한 것이 아니다.
- 실제 설치 앱이나 개인 자료를 변경하지 않았으며 설치·MCP 호출·등록 테스트를 실행하지 않았다.

## 재현

root가 생성한 `.run/native-update-classpath.txt`를 이용해 `NativeUiPreview.java`, `NativeUpdatePreview.java`, `NativeShellPreview.java`를 javac로 `.run/native-shell-preview`에 컴파일한다. `NativeShellPreview docs/images/native-home-2026-10-04`는 PNG만 렌더한다. `--show-home` 옵션은 root가 네이티브 창을 관찰할 격리된 홈 fixture를 띄운다. fixture의 실제 작업 버튼 listener는 제거했고 닫기만 동작한다. 종료 때 해당 임시 디렉터리를 정리한다.

## 2차 배치 검증

첫 렌더에서 짧은 PC·회사 설명에 과도한 빈 높이가 붙어 보조 행동이 스크롤 아래로 밀린 문제를 제품 담당과 확인했다. text의 인공 여분 줄과 BoxLayout의 무제한 최대 높이를 제거하고 자연 높이를 제한했다. 브랜드와 제목은 위쪽 정렬, PC는 compact 상태 행, 회사는 현재 계정으로 바로 여는 행동을 포함한 요약으로 정리했다.

최신 Kotlin 클래스에서 재렌더해 saved-welcome-700.png를 직접 확인했다. 700×620 첫 화면에 PC 준비·회사 계정·서버·회사 열기·자동 설정/IDE/업데이트·다음 실행 checkbox가 모두 보인다. 520×380에서는 본문 스크롤을 허용하며 top/bottom 캡처에서 회사 열기와 하단 주 행동 접근을 확인했다. saved/no-server/auth-waiting 상태별 700/520/520×380 렌더 및 updater available/ready 700/520 렌더가 통과했다. 업데이트 안내는 자동 확인만 설명하며 다운로드·설치를 자동으로 수행한다고 표현하지 않는다.

root의 격리 mock 홈 실행은 Windows window inventory에서 창이 탐지되지 않았다. 따라서 실제 Windows 클릭·포커스 동작 검증은 미확인이고, 이번 증거는 실제 Swing 컴포넌트의 mock 렌더이다. 초기 0.3.6 캡처는 이후 최종 0.3.7 클래스의 렌더로 갱신했다.

### 텍스트 자체 잘림 보강

2차 box bounds 검사는 텍스트의 마지막 줄 누락을 검출하지 못했다. 긴 URL/한글 word wrap의 실제 줄수는 전체 글자폭을 나눈 값보다 클 수 있어, Swing TextUI root View의 preferredSpan(Y)로 높이를 측정하고 폭 변경 때 재검증하도록 교정했다. renderer도 재귀 invalidate/layout를 반복해 BoxLayout 캐시를 안정화했다. 모든 보이는 JTextArea의 document 마지막 offset modelToView2D가 자체 height 안에 들어오는지 검사한다.

최종 saved-login-520.png에서 URL의 internal/company/team과 안내의 ‘필요합니다.’까지 직접 확인했다. 실제 JDialog 외곽을 520×380으로 설정한 후 content504×341을 렌더하는 window520x380/top-bottom 경로도 추가했다. 저장 계정·서버 없음·인증 대기 전 경로가 끝줄 검사와 bounds 검사를 통과했고 로그인 하단 3개 행동이 읽힌다. 최신 홈 캡처의 버전은 0.3.7이며 700×620의 보조 행동과 checkbox도 첫 화면에 유지된다. 실제 Windows 클릭 검증 한계는 그대로다.

최종 기본 높이는 제품 교차 검토에 따라 홈 520px, 회사 계정 480px로 압축했다. 최소 외곽 창520×380, 본문 스크롤, 고정 footer와 텍스트 끝줄 검사는 유지한다. 이 마지막 높이 변경의 컴파일·재렌더는 root가 수행한다.
