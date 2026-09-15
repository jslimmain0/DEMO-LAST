// FlowLink 플러그인 워크스페이스 — 앱(backend)과 분리된 **독립 Gradle 빌드**.
//   빌드:  cd plugins && ./gradlew :sample:jar    → sample/build/libs/flowlink-plugin-sample.jar
//   배치:  ./gradlew :sample:deploy               → plugins/ (앱이 읽는 런타임 JAR 디렉터리, FLOWLINK_PLUGINS_DIR)
//   업로드: POST /api/v1/plugins (관리자) — 즉시 reload
//
// SPI 인터페이스(com.flowlink.transform.FlowTransform)는 **앱 안(backend/transform-spi)** 에 그대로 있다.
// includeBuild 가 compileOnly("com.flowlink:transform-spi") 를 그 모듈로 치환하므로 별도 발행이 필요 없다
// (사외 개발자는 includeBuild 줄을 지우고 SPI JAR 를 compileOnly 로 물면 그대로 빌드된다).
rootProject.name = "flowlink-plugins"

includeBuild("../backend")

// 새 플러그인: sample/ 을 통째로 복사 → 아래 include 에 추가.
include("sample")
