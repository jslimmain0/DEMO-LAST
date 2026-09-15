rootProject.name = "flowlink"

// 모듈러 모놀리스 — 경계는 패키지로 표현한다(단일 Gradle 모듈). 경계가 안정되면
// 아래처럼 물리 모듈로 분리하고 ArchUnit 으로 강제한다.
//
//   include("flowlink-core", "flowlink-definition", "flowlink-execution",
//           "flowlink-trigger", "flowlink-security", "flowlink-app", "flowlink-worker")
//
// 변환 SPI(com.flowlink.transform.FlowTransform)는 이 앱의 일반 소스다.
// 플러그인 프로젝트는 리포 루트 plugins/(독립 Gradle 빌드)에 있고, 거기 같은 규격의 사본을 두고 compileOnly 로 문다.
