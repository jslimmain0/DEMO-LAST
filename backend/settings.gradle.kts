rootProject.name = "flowlink"

include("runtime", "server-app", "desktop-app")

// server-app/desktop-app → runtime. 공통 런타임은 두 실행 모듈에 의존하지 않는다.
// 변환 플러그인은 리포 루트 plugins/의 독립 Gradle 빌드를 유지한다.
