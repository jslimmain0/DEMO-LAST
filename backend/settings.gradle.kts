rootProject.name = "flowlink"

// 모듈러 모놀리스 — 물리 모듈 분리 1단계 (플러그인 개발용 SPI 경계):
//   :transform-spi   변환 SPI(FlowTransform)만 담은 순수 모듈 — 앱/플러그인이 공유하는 계약
//
// 플러그인 프로젝트는 이 빌드 밖(리포 루트 plugins/ — 독립 Gradle 빌드)에 있고,
// 거기서 includeBuild("../backend") 로 이 :transform-spi 를 물어 컴파일한다.
// 나머지 경계(core/definition/execution/…)는 아직 패키지로 표현한다. 경계가 안정되면
// 아래처럼 물리 모듈로 추가 분리하고 ArchUnit 으로 경계를 강제한다.
//
//   include("flowlink-core", "flowlink-definition", "flowlink-execution",
//           "flowlink-trigger", "flowlink-security", "flowlink-app", "flowlink-worker")
include("transform-spi")
