description = "Windows 트레이·로그인·디스패처·업데이트 앱"

dependencies {
    implementation(project(":flow-server")) {
        exclude(group = "com.oracle.database.jdbc", module = "ojdbc11")
        exclude(group = "com.flowlink", module = "flow-mcp")
        exclude(group = "io.modelcontextprotocol.sdk")
    }
    implementation(project(":flow-agent"))
    runtimeOnly("com.h2database:h2")
    developmentOnly("org.springframework.boot:spring-boot-devtools")
}

springBoot { mainClass.set("com.flowlink.desktop.DesktopApplicationKt") }
tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("flowlink-desktop.jar")
}
