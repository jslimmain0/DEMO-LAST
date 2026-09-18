// FlowLink 플러그인 워크스페이스 — 앱(backend)과 완전히 분리된 **독립 Gradle 빌드**.
//   빌드:  cd plugins && ./gradlew :sample:jar    → sample/build/libs/flowlink-plugin-sample.jar
//   배치:  ./gradlew :sample:deploy               → plugins/ (앱이 읽는 런타임 JAR 디렉터리, FLOWLINK_PLUGINS_DIR)
//   업로드: POST /api/v1/plugins (관리자) — 즉시 reload
//
// 계약은 클래스 이름 하나뿐이다 — 각 플러그인 프로젝트가 src 에 FlowTransform.kt 사본을 들고 컴파일하고,
// JAR 에서는 빼서(build.gradle.kts 의 exclude) 런타임엔 앱이 제공하는 같은 FQCN 을 쓴다.
// → 이 디렉터리(또는 sample/ 하나)만 복사해 가도 리포 밖에서 그대로 빌드된다.
rootProject.name = "flowlink-plugins"

// 새 플러그인: sample/ 을 통째로 복사 → 아래 include 에 추가.
include("sample", "des-cipher")
