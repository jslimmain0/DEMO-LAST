description = "서버 진입점·클라이언트 배포 API"

dependencies {
    implementation(project(":runtime"))
    runtimeOnly("com.oracle.database.jdbc:ojdbc11:23.26.2.0.0")
    runtimeOnly("com.h2database:h2") // 격리된 local/agent-lab 검증
    developmentOnly("org.springframework.boot:spring-boot-devtools")
}

springBoot { mainClass.set("com.flowlink.server.ServerApplicationKt") }
tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("flowlink-server.jar")
}
