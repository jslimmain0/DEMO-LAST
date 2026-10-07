description = "중앙 서버·GitHub 로그인·공용 저장소·배포·MCP 호스트"

dependencies {
    implementation(project(":flow-core"))
    implementation(project(":flow-mcp"))
    runtimeOnly("com.oracle.database.jdbc:ojdbc11:23.26.2.0.0")
    runtimeOnly("com.h2database:h2") // 서버 격리 검증용
}

springBoot { mainClass.set("com.flowlink.server.ServerApplicationKt") }
tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("flowlink-server.jar")
}

// 소개 페이지와 Windows 화면은 동일한 번들 글꼴을 사용한다. SPA는 desktop에만 포함한다.
tasks.named<ProcessResources>("processResources") {
    from(rootProject.file("../frontend/public/fonts")) {
        include("*.woff2", "OFL.txt")
        into("static/fonts")
    }
}
