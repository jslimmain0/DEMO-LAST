
### 2026-10-07 · 워크벤치 0.3.18

- 코드 이미지: `flowlink/server:0.3.18-b05a57276f70a32c48a1f0bcc07cc8b523130be7`.
- 18183 Oracle·Vault 서버 교체, 기존 DB/키/컨테이너 볼륨 유지. 다운로드는 EC2 Docker 검증 환경 `http://127.0.0.1:18088/`에서 제공.
- EC2 release: `/opt/flowlink/releases/0.3.18-b05a57276f70a32c48a1f0bcc07cc8b523130be7`. 설치 파일 URL·릴리스·호환 검사와 server/proxy health 통과.
- MSI SHA-256: `061fe09fcf16cb25071bb8088fa7426f29d8b97f9fe8469170603e56317574dc`, 149415656 bytes. 공개 파일 전체 다운로드 검증 완료, MSI 설치 및 MCP 검증 미수행.
- 실제 UI 화면과 검증 기록: [시안 적용 기록](../docs/reviews/2026-10-07-frontend-image-concepts.md).

### 2026-10-07 · 글꼴·계산 컨텍스트 0.3.19

- 코드 이미지: `flowlink/server:0.3.19-0b55d724842637ea69d8a0395b49bbb9e87f5adb`.
- 18183 서버만 교체했고 Oracle·Vault 데이터와 볼륨을 유지했다. EC2 Docker release는 `/opt/flowlink/releases/0.3.19-0b55d724842637ea69d8a0395b49bbb9e87f5adb`이다.
- 18088 서버·프록시 health 및 공개 업데이트 정보 확인 완료. MSI 전체 다운로드 SHA-256은 `a1a93ef8b7666c33b1a53269405d5f74d3ea1438ace7fb2918b7f89071a3dd1d`, 151467752 bytes이다. 실제 설치 및 MCP 검증은 수행하지 않았다.
- 실행 위치 중복 재현/수정, 실제 글꼴 확인, 기존 팀 자료의 Vault 복호화 제한: [검증 기록](../docs/reviews/2026-10-07-typography-and-calculation-context.md).
