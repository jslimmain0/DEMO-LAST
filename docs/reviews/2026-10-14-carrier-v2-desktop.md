# TCP v2와 데스크톱 작성·업데이트 검증

`359d45c`의 두 수정 요청서를 기준으로 구현했다. 기존 DB 테이블·컬럼·마이그레이션과 개인 키를 변경하지 않았으며 v1 정의를 자동 변환하지 않는다.

## 적용한 계약

- 공통 헤더의 AND/eq 조건으로 거래를 선택하고 거래별 요청·응답 경계와 ACK를 사용한다. HEX 송신/정확 비교, 독립 ACK 필드 조립/비교, 길이만 수신을 구분한다.
- binary 정수 1/2/4/8B, signed/endian, uint64 문자열, NUL 패딩, 바이트 길이·상한 검증을 지원한다. 알 수 없는 v2 속성과 모호한 거래는 무시하지 않는다.
- 프로토콜 검증·조립·파싱과 Mock 계획 미리보기는 전송하지 않는다. 실제 전송은 별도 시험 동작이다. UI·MCP·서버·PC가 공통 컴파일러를 사용한다.
- 구형/미확인 PC에는 v2 작업 패킷을 주지 않는다. MCP 사전 검사와 REST claim의 실행기 보고·fingerprint 검사가 함께 적용된다.
- 마지막 ACK가 실패해도 받은 응답과 안전한 단계 진단을 보존한다. UNKNOWN의 자동 재전송·자동 재개는 금지한다. 경계 간 출력은 허용 키만 전달하고 같은 호스트의 마스킹된 부분 응답은 보존한다.
- TCP 시크릿의 코덱 변환값은 TEXT·HEX·Base64·파싱 필드·시험 이력·로그·오류에서 보호한다. 합성 Base64 코덱으로 확인했으며 실제 전송과 내부 바인딩 값은 바꾸지 않는다.
- AI·Copilot·개인 지침·대화 이력은 desktop 호스트에서 실행한다. 서버에는 MCP용 공유 스키마만 제공한다. 기존 서버의 자격/이력은 자동 복사하지 않는다.
- 업데이트 알림에서 변경 사항 확인·하루 뒤 알림·버전 숨김/복원이 가능하다. 확인된 현재 버전 설치 성공에서만 다음 기동 전 회사 로그인을 한 번 해제한다. 취소·실패·불완전한 결과는 로그인과 개인 파일을 유지하고, 오래된 성공 기록은 새 실패로 표시하지 않는다.
- 새 MCP 흐름은 위→아래 배치와 핸들 방향을 함께 저장한다. 기존 배치는 보존한다. ASSERT는 명시된 업무 판정에만 최소 사용하도록 지침과 기본 예제를 수정했다. 기존 59개 도구 이름에 `mock_preview`를 더해 60개다.

## 검증

| 대상 | 결과 |
|---|---|
| backend | agent 215, core 219, desktop 39, MCP 42, server 54: 총 569개 통과, 실패·오류·건너뜀 0 |
| frontend | 82개 통과, TypeScript·production build 통과, lint 오류 0 |
| 모듈 경계 | agent/core/MCP plain JAR, DB·호스트·SDK·드라이버·진입점 검사 통과 |
| AI 호스트 | 격리 실제 JVM에서 desktop AI API 200, server AI API 404, server 공유 스키마 200, 오프라인 기본 예제의 불필요한 ASSERT 없음 |
| 설치 처리 | 합성 MSI 결과로 성공·재부팅·취소·실패·재실행 실패 및 오래된 성공 기록 판정 확인. 실제 MSI 설치는 하지 않음 |
| MCP wire | 새 H2·키·임의 포트·복사한 불변 JAR로 22개 검사 통과. 임시 MCP 자격 폐기·자체 JVM 종료 확인, 사용자 IDE 설정 변경 없음 |
| 브라우저 | 거래/ACK 작성, uint64 최댓값, Base64 해석, Mock 미리보기/fixture 초안 폐기, ACK 로그·부분 수신 세션, 513px 화면 확인 |

실소켓 시험에는 SKT 형태의 47B 정수 헤더/ACK와 서로 다른 거래번호, ACK 분할 수신, ACK+다음 요청 합쳐 보내기, ACK timeout/EOF/필드 불일치, LGU 9개 거래의 길이·ACK 차이, 같은 연결 재사용이 포함된다. CJH 형태의 선언 400/200에 +50 보정한 실제 450/250B, KPNC 형태의 독립 고정 450/250B도 직접 바이트를 읽고 쓰는 상대 소켓으로 확인했다. 통신사 업무 필드 전체를 재현한 시험은 아니다.

MCP wire는 dryRun의 정의/리스너 불변, preview의 state/seq/log/session 불변, 실제 624/266/30B와 계획 일치, 구형 PC의 REST claim 패킷/토큰/소켓 미전달, v1 4-way 지속연결·유휴 연장·종료, 중앙 자원·환경 출처·위임·재실행, TB 저장과 추가 ASSERT 없음을 확인했다.

실행 명령은 `frontend`의 `npm test`, `npm run lint`, `npm run build`와 다섯 Gradle 모듈의 `test`/호스트 `bootJar`, `scripts/test/module-artifacts.ps1`, `module-launchers.ps1`, `Test-DesktopUpdateHelper.ps1`, `mcp-resources.ps1`이다. MCP wire 검증은 이번 사용자의 명시적 요청 범위에서 실행했다. 프론트에는 Fast Refresh·큰 bundle 관련 경고가 남는다.

## 기존 설치 환경에서의 확인

- 서버 `http://127.0.0.1:18088`와 Windows 설치 앱 `http://127.0.0.1:18180`에 최종 JAR를 반영했다. 설치 앱의 업데이트 helper도 교체했다. 서버 데이터 volume과 환경 파일은 유지하고, 서버/PC 데이터와 기존 실행 파일을 교체 전 백업했다.
- 구형 PC가 접속한 상태에서는 v2 실행이 TCP 연결 전에 차단되고 v1은 계속 동작했다. 이후 양쪽 최종 버전에서 실제 capabilities 보고, PC의 중앙 프로토콜 사용, 서버 Mock의 624B 요청·266B 응답·30B ACK와 preview 일치를 확인했다.
- PC/서버 각각 외부 소켓을 연결해 MCP 세션 조회·유휴 60초 연장·같은 연결 재사용·종료를 확인했다. 시험용 MCP 자격만 폐기했으며 기존 로그인과 IDE 설정을 바꾸지 않았다.
- MCP가 생성한 7개 노드의 TB 좌표를 설치 앱에서 직접 열었다. 분기 포트를 올바르게 지정한 합성 SET/IF 흐름이 성공했고 추가 ASSERT는 0개였다. 화면은 `.run/change-requests/mcp-layout-installed.jpg`, 결과는 `.run/change-requests/layout-live.json`에 보관했다. 검증용 정의는 정리했다.
- 정리 후 기존 40개 워크플로/Mock/프로토콜 정의의 내용·버전 hash와 개인 키/장치/로그인 파일 4개의 hash가 작업 전과 동일했다. DB 스키마 변경은 없다. 증거는 `.run/change-requests/preservation-final.json`과 `live-installed-results-e6409968.json`이다.

## 인수 기준의 제한

- 단독 Mock TCP 시험 이력은 프로세스 메모리 최근 1000건·JSON 합계 32MB다. 재시작/퇴출 후 조회할 수 없고 `execution_list`에 포함되지 않는다. 기존 영속 워크플로 실행 저장소에 통합하는 조건은 충족하지 않았다. 큰 보관 본문은 생략 표시하며 최초 전송 응답은 보존한다.
- 별도 protocol 버전 저장소/도구와 중앙 public protocol 카탈로그 전체의 workspace 자동 복사는 추가하지 않았다. M02/M12는 기존 raw JSON·Mock 버전/복원·이관 계약의 v2 필드 보존 범위다. TCP import는 비활성 상태를 유지한다.
- 실제 통신사·SMS/PASS·결제 취소는 호출하지 않았다. 미확인 T1/U1·키 발급 규격, 통신사 업무 성공, 실제 KT 암호화 코덱의 업무 적합성은 미검증이다.
- 실제 MSI 업그레이드·새 MSI 배포·실제 사용자 로그아웃·IDE 재등록·실제 Copilot 모델 호출은 하지 않았다. 설치 앱은 기존 JAR와 helper를 보존 가능한 백업 후 교체해 시험했다. 배포 버전 번호는 0.3.21을 유지한다.
