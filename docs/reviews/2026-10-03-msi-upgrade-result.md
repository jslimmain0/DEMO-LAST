# MSI 0.3.1 실제 업그레이드 결과 (2026-10-03)

최종 frontend `index-Chfoo1-4.js`를 포함한 frozen JAR로 `package-desktop.ps1 -Type msi -SkipBuild`를 실행했다. Windows PowerShell 5.1에서 한글 문자열을 읽도록 해당 스크립트 UTF-8 BOM을 복원했다. 패키지는 `backend/build/windows-installer-0.3.1/FlowLink-0.3.1.msi`다.

- MSI ProductVersion=0.3.1, ProductCode={CF7BF245-F54B-328D-B26F-BC71A7FE4B6B}.
- UpgradeCode={B06C875D-2E09-4B64-9E3D-2F52E871D069}를 이전 설치와 동일하게 유지했다.
- 실제 사용자 설치 0.3.0에서 `msiexec /i ... /qn /norestart /l*v ...` 정상 업그레이드 종료 코드 0.
- HKCU Windows Installer 등록은 0.3.1(Version=196609), 설치 launcher cfg도 0.3.1.
- 설치된 app/flowlink.jar SHA는 final frozen JAR와 일치한다.
- 배포 중인 `.run/agent-lab/downloads/FlowLink.msi`도 0.3.1 파일로 교체했으며 패키지 SHA와 일치한다. 기존 다운로드는 private .run 백업으로 보존했다.

설치 전 native 0.3.0을 18180에서 실행해 보존 검사용 개인 flow/environment/secret/protocol/HTTP Mock을 생성하고 정상 종료했다. 사용자 데이터는 `.run/upgrade-0.3.1-preparation/`에 private offline 백업했다. 업그레이드 직후, 새 앱을 실행하기 전 H2 파일/device.id/storage.key/server-session.enc의 SHA가 모두 이전과 동일했다.

새 0.3.1 native launcher에서 REST 11개 검증이 통과했다: 개인 runtime/워크스페이스, 기존 flow IDs, graph, 환경 변수, write-only secret metadata, protocol, Mock, 저장된 서버 URL/계정, 기존 OS 사용자 키로 암호화된 secret의 복호화 및 실제 실행, 정상 종료. H2 오프라인 사전/사후 비교에서도 flow/flow_version/environment/secret/protocol/mock_server/workspace의 전체 ID 해시 및 행 수가 동일했다. device.id/storage.key도 같았다. 검증 실행으로 생성된 새 execution/node rows는 보존된 실행 결과이며 비교 대상의 기존 자원 행을 변경하지 않았다.

최초 실행 검사는 agentDeviceId를 누락해 WAITING으로 나타났고 이를 성공으로 기록하지 않았다. 실제 PC device ID를 넣은 정상 요청은 SUCCEEDED였으며 결과에는 secret 평문이 없었다.

preview 18182는 작업 전후 동일 PID 32200으로 계속 실행되었다. 업그레이드 검증은 native 18180만 사용했다. Docker 기존 H2 lab 데이터 및 Oracle/Vault는 변경하지 않았다. MCP 프로토콜/도구 및 IDE 등록은 호출하지 않았다. 정상 종료 후 native 18180은 꺼져 있으며 사용자는 설치된 FlowLink 바로가기로 실행할 수 있다.

private 실행 증거: release-manifest.json, build-manifest.json, msi-upgrade.log, after-results.json, h2-fixtures-before.json, h2-after.json. 자격증명/저장키가 포함된 .run 폴더는 커밋/공개하지 않는다.
