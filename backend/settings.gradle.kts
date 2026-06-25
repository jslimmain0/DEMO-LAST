rootProject.name = "flowlink"

// NOTE (모듈러 모놀리스 1단계):
// 지금은 단일 Gradle 모듈로 시작하고, 패키지(com.flowlink.core / definition / execution / trigger / security)
// 로 모듈 경계를 표현한다. 경계가 안정되면 아래처럼 물리 모듈로 분리하고 ArchUnit으로 경계를 강제한다.
//
//   include("flowlink-core", "flowlink-definition", "flowlink-execution",
//           "flowlink-trigger", "flowlink-security", "flowlink-app", "flowlink-worker")
