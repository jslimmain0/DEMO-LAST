# Windows 업데이트 구현 검증

## 구현 계약

서버 연결 시 30초 후 및 6시간 간격으로 버전을 확인한다. 다운로드와 설치는 사용자가 시작한다. HTTPS 서버와 명시적인 루프백 개발 주소만 사용하고 redirect를 허용하지 않는다. 서버가 AVAILABLE 및 automaticUpdateAllowed를 반환한 manifest만 사용한다. schema/플랫폼/아키텍처/호환 서버 버전/정확한 상대 다운로드 경로/1GiB 상한을 검사한다. 크기와 SHA-256이 맞아야 ready가 된다. SHA-256은 발행자 서명을 대신하지 않는다.

메타데이터·다운로드 본문의 별도 watchdog이 입력 스트림을 닫아 읽기 시간을 제한한다. 요청 완료 전에 서버가 바뀌거나 ready 이후 서버가 바뀌면 설치 준비를 폐기한다. 실패한 부분 파일은 삭제한다.

설치는 Windows 창에서 모든 브라우저 작업 저장 확인 및 앱·Mock 수신 중단 확인 뒤 시작한다. RuntimeUpdateGate.freeze 안에서 RUNNING/WAITING 실행, PENDING/CLAIMED/RUNNING/UNKNOWN 작업과 dispatcher journal을 검사한다. gate는 다른 담당자가 신규 실행·task·dispatcher·관리 변경 경계에 연결했다. 브라우저 초안 유무를 native가 자동으로 확인했다고 주장하지 않는다.

helper는 고정 앱 launcher·파일 SHA·현재 PID 및 시작 시간(1ms 오차)을 확인하고 ready를 전달한다. native의 별도 commit이 20초 내 도착해야 설치를 진행한다. 앱 종료를 최대 90초 기다리고 강제 종료하지 않는다. MSI는 재부팅 없이 실행하고 취소·실패·재부팅 필요 결과 및 로그를 저장한다. 종료 후에는 실패해도 기존 launcher 재시작을 시도한다. 다음 앱 기동에서 결과와 예상/실제 버전을 대조하고 이전 실패·재부팅 안내를 첫 자동 확인을 건너뛰어 유지하고 다음 6시간 주기부터 확인을 재개한다.

## 검증

- 집중 Kotlin 테스트 17개 통과: DesktopUpdateTest, DesktopUpdateDownloadTest, RuntimeUpdateGateTest, DistributionControllerTest, ReleaseVersionTest. 정상 다운로드의 정확 바이트, 잘린 파일 거부와 부분 파일 삭제, 서버 변경 후 다운로드 거부, 해시 변조, manifest/버전과 gate 경합을 확인했다.
- `scripts/test/Test-DesktopUpdateHelper.ps1`의 잘못된 hash/PID 거부 테스트 통과. MSI 실행·앱 종료·재시작을 호출하지 않았다.
- `NativeUpdatePreview.java`는 mocked available/ready 상태를 실제 Swing 창에 넣어 700/520 폭과 긴 릴리스 안내의 상·하단을 렌더했다. 가로 잘림·내부 bounds 검사 통과. 이미지: `docs/images/native-update-2026-10-03/{available,ready}-{700,520}[-bottom].png`.
- 실제 MSI 업그레이드, Windows 앱 종료/재시작 성공 경로, 서명 검증, 다운로드 body의 실제 네트워크 stall 실증은 수행하지 않았다. 운영 18180과 실제 개인 자료를 변경하지 않았고 MCP를 호출하거나 등록하지 않았다.

## 재현 명령

`backend`에서 `./gradlew nativeUpdatePreviewClasspath -I ../scripts/test/native-preview-classpath.gradle`로 test runtime classpath를 만든다. 리포 루트에서 해당 `.run/native-update-classpath.txt`를 사용해 `NativeUiPreview.java`와 `NativeUpdatePreview.java`를 javac로 컴파일하고 후자를 `docs/images/native-update-2026-10-03` 인자로 실행한다. mock 상태 렌더이므로 실제 업데이트 성공 증거로 확대하지 않는다.
