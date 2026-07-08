# FlowLink 변환 플러그인 — 참고 구현 (멀티모듈)

변환(TRANSFORM) 노드에 꽂히는 **JAR 플러그인**의 참고 구현.
새 플러그인을 만들 때 이 모듈을 통째로 복사해서 시작하면 된다.

```
backend/
 ├─ transform-spi/    ← SPI(FlowTransform 인터페이스)만 담은 순수 모듈. 앱·플러그인이 공유하는 계약
 ├─ plugin-sample/    ← 이 모듈. SPI 를 compileOnly 로 물고 plain JAR 로 빌드
 │   ├─ src/main/kotlin/com/flowlink/plugin/sample/
 │   │   ├─ MaskTransform.kt        (mask — 단일 입출력 + 파라미터 3개, 기본형)
 │   │   └─ HmacSha256Transform.kt  (hmac-sha256 — 출력 2개(hex/base64), 멀티 출력형)
 │   └─ src/main/resources/META-INF/services/com.flowlink.transform.FlowTransform  ← ServiceLoader 등록
 └─ (루트)            ← Spring Boot 앱. implementation(project(":transform-spi"))
```

## 빌드 · 배포

```bash
gradle :plugin-sample:test    # 플러그인 단위 테스트
gradle :plugin-sample:jar     # → plugin-sample/build/libs/flowlink-plugin-sample.jar

# 방법 1 — 실행 중인 백엔드에 업로드(즉시 로드, 재시작 불필요)
curl -F "file=@plugin-sample/build/libs/flowlink-plugin-sample.jar" http://localhost:18080/api/v1/plugins

# 방법 2 — 로컬 플러그인 디렉토리(backend/plugins/)에 배치(다음 기동 때 로드)
gradle :plugin-sample:deploy
```

업로드 후 `GET /api/v1/transforms` 에 `mask`·`hmac-sha256` 이 나타나고,
에디터의 변환 노드 드롭다운에서 "마스킹(플러그인)" / "HMAC-SHA256 서명(플러그인)" 을 고를 수 있다.
선언한 `inputs()`/`params()` 대로 속성 패널 폼이 자동 생성되고, `outputs()` 의 key 는
하위 노드에서 `{{ hex@노드ID }}` 처럼 바인딩된다.

## 새 플러그인 만들기 (체크리스트)

1. 이 모듈을 복사(예: `plugin-내이름/`)하고 `settings.gradle.kts` 의 `include(...)` 에 추가
2. `FlowTransform` 구현 — `id()` 는 전역 유니크(내장과 겹치면 **플러그인이 내장을 덮어씀**), UI 텍스트는 한국어
3. `META-INF/services/com.flowlink.transform.FlowTransform` 에 구현 클래스 FQCN 을 한 줄씩 등록
4. 단위 테스트(순수 함수라 DB/스프링 불필요) 후 `jar` → 업로드
5. 의존성 규칙: **SPI 는 반드시 `compileOnly`**. 외부 라이브러리가 필요하면 plain jar 에는 안 들어가므로
   fat-jar(shadow) 로 묶되, 앱과의 클래스 충돌(같은 라이브러리 다른 버전)에 주의

## 주의

- **샌드박스 없음** — 업로드된 JAR 은 앱 전체 권한으로 실행된다(신뢰 JAR 전용, 운영에선 업로드를 관리자 권한으로 제한 필요. CLAUDE.md "알려진 한계" 참조)
- `apply()` 는 이름별 입력(Map) → 이름별 출력(Map). 실패 시 예외를 던지면 노드 실패(=실행 FAILED)로 기록된다
- 플러그인 교체는 같은 파일명으로 재업로드(덮어쓰기 + 즉시 reload). 삭제 API 는 아직 없음(파일 삭제 후 재시작)
