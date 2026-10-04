# MSI 0.3.0 → 0.3.1 검증 준비

- 현재 설치 cfg는 0.3.0이며 HKCU Windows Installer 제품 EC3A853F842AC493F8A95A7550B25813, Version=196608(0.3.0), source는 backend/build/windows-installer-validated-0.3/FlowLink-0.3.0.msi다.
- jpackage21/WiX3, UpgradeUUID b06c875d-2e09-4b64-9e3d-2f52e871d069 유지. 0.3.1은 별도 backend/build/windows-installer-0.3.1 출력.
- package-desktop.ps1 app-version와 DistributionController metadata/Content-Disposition filename을 0.3.1로 변경했다. 아직 packaging/installation은 실행하지 않았다.
- private identity backup은 .run/upgrade-0.3.1-preparation에 준비했다. 현재 브라우저 검사 중인 앱은 중지하지 않았다. DB 백업은 해당 앱 정상 종료 후 실행한다.

최종 jar 확인 후 실행 예정:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1 -Type msi -SkipBuild -JdkPath C:\Users\jslim\.jdks\corretto-21.0.10 -WixPath .run\wix3 -OutputDir backend\build\windows-installer-0.3.1
```

이후 root의 브라우저 검증 종료를 확인하고 해당 native Java/FlowLink 프로세스만 정상 종료한다. 사용자 데이터 디렉터리 전체를 private .run backup에 복사하고 H2 DB, OS 사용자 저장 키, device ID, 암호화된 server-session, 저장 자원 fixture IDs/counts를 기록한다. 같은 per-user 범위의 MSI를 /i로 정상 업그레이드하여 UpgradeCode 유지/새 ProductCode/설치 Version=0.3.1을 확인한다. 새 native launcher는 Hidden으로 기동하며 MCP/IDE 등록은 클릭/호출하지 않는다. 앱 REST로 이전 개인 자원·server session·device ID 보존 및 재실행을 확인한다. 백업의 credential/key 내용을 출력하지 않는다.
