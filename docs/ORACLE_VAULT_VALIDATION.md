# 실제 Oracle + Vault 통합 검증

검증 서비스는 기존 H2 lab 및 PC 앱과 별개인 `flowlink-oracle-vault-test` Compose 프로젝트다. Oracle은 `gvenzl/oracle-free:23.26.3-slim`(실제 배너: Oracle AI Database 26ai Free 23.26.3.0.0), Vault는 HashiCorp Vault 1.17이다. 주소는 앱 http://127.0.0.1:18183, Oracle 11521, Vault 18200이며 전부 localhost 바인딩이다. PC 앱은 기존 native H2/OS 사용자 키를 계속 사용한다.

현재 지원 계약은 **Vault Transit 암복호화 + AppRole 인증**이다. 값은 Oracle `flowlink_secret.enc_value`에 `vault:v1:...` 암호문으로 저장하고, 실행 중 `{{ 이름@secret }}`로 해석한다. KV v2의 외부 경로에서 secret을 읽는 기능은 현재 구현되어 있지 않다. Transit은 입력 평문 자체를 저장하는 서비스가 아니다([공식 문서](https://developer.hashicorp.com/vault/docs/secrets/transit)).

실제 JDBC 검사에서 Spring Boot 3.3.5 BOM의 ojdbc11 21.9.0.0은 동일 SQLPlus 성공 계정으로 ORA-01017을 반환했다. ojdbc11 23.26.2.0.0으로 바꾸면 같은 독립 Java JDBC 검사 및 앱 연결이 성공했다. 이 버전으로 의존성을 고정했다. Oracle의 [JDBC 다운로드 안내](https://www.oracle.com/database/technologies/appdev/jdbc-downloads.html) 및 [JDBC 시작 안내](https://www.oracle.com/uk/database/technologies/getting-started-using-jdbc.html)를 참고한다.

## 재현

Java 21, Docker Desktop과 최신 `backend/flow-server/build/libs/flowlink-server.jar`가 필요하다. Node 24는 프론트엔드 재빌드에만 필요하다. 프론트 빌드 변경 없이 backend `:flow-server:bootJar`만으로 API 검증할 수 있다.

```powershell
$env:JAVA_HOME='C:\Users\jslim\.jdks\corretto-21.0.10'
Push-Location backend
.\gradlew.bat :flow-server:bootJar
Pop-Location
powershell -ExecutionPolicy Bypass -File scripts/test/oracle-vault.ps1 -Initialize
```

`-Initialize`는 빈 신규 lab에서만 사용한다. 기존 `.run/oracle-vault/infra.env`가 있으면 초기화를 거절한다. 재실행은 스위치 없이 한다. 무작위 dummy credentials와 AppRole IDs/JWT는 gitignore된 `.run/oracle-vault/`에만 저장하며 출력하지 않는다. 해당 폴더는 공개/커밋하지 않는다.

초기 검증은 최신 init.sql을 신규 스키마에 실행한다. 별도 `flowlink_upgrade` 사용자에는 현재 Git HEAD의 기존 init.sql을 실행한 뒤 agent-execution, agent-tasks, workspace-resources 업그레이드를 순서대로 실행한다. 따라서 이 checkout의 기존 release HEAD를 기반으로 하는 업그레이드 검사다. 신규 init에 업그레이드를 중복 실행하지 않는다.

## 2026-10-03 실제 실행 결과

최종 0.3.2 JAR(`index-B5uFZJXI`)로 다른 작업자가 초기화 없이 재실행해 28개 검사와 종료 코드 0을 확인했다. 기존 H2 서버와 개인 런타임은 건드리지 않고 Oracle 검증 서버 18183만 갱신했다.

- 신규 Oracle init 및 기존 release + 세 업그레이드 SQL 성공. 실제 Oracle 사전에서 신규/업그레이드 스키마의 테이블·컬럼·자료형 집합 차이는 0이었다.
- 전용 13개 검사 성공: JWT/워크스페이스 저장, write-only 목록, 공간별 값 분리, 공통/환경 override, 미지정 환경 공통 fallback, DB 실제 Transit ciphertext, 실행 로그 마스킹, 30초 AppRole lease 갱신, 앱 및 Oracle 컨테이너 재시작 뒤 값 복호화/JDBC 재연결, 실제 HTTP 요청/echo 응답 바인딩과 마스킹, Vault 일시 장애 fail-closed/복구, 컨테이너 로그 평문 비노출.
- 잘못된 AppRole로 별도 앱 기동 실패 검사 성공.
- 기존 REST/엔진 회귀 14개 성공: 상태/순차 HTTP Mock, SET/ASSERT, IF, SWITCH, INPUT 재개, 중단, client HTTP 재개, FORM 재개, 실제 WAIT 콜백, 브라우저 없는 WAIT 타임아웃, WEBHOOK 및 비활성화, 실제 SCHEDULE, suite, HTTP 실패 알림.

Vault 장애는 `docker pause/unpause`로 검증하여 dev Vault 키를 보존한다. **Vault dev 모드는 인메모리이므로 Vault 프로세스를 재시작하면 키가 사라진다.** 앱 재시작 성공은 운영 Vault 저장소의 내구성 검증을 뜻하지 않는다. 운영은 영속 저장소/unseal/백업을 별도로 구성해야 한다. 현재 Docker dev Vault는 검증용이다. JDBC 변경 후 전체 Gradle 306 테스트(실패 0)도 통과했다. AppRole는 encrypt/decrypt 두 경로만 허용하고 root token으로 앱을 실행하지 않는다([AppRole 공식 문서](https://developer.hashicorp.com/vault/docs/auth/approle)).

MCP 프로토콜/도구 및 IDE 등록은 이 검증에서 호출하지 않는다. 서버 실행 에이전트는 하나이며 Oracle/Vault는 지원 서비스다.
