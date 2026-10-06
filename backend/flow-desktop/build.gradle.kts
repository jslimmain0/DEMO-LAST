description = "Windows 트레이·로그인·디스패처·업데이트 앱"

dependencies {
    implementation(project(":flow-core"))
    runtimeOnly("com.h2database:h2")
    developmentOnly("org.springframework.boot:spring-boot-devtools")
}

springBoot { mainClass.set("com.flowlink.desktop.DesktopApplicationKt") }
tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("flowlink-desktop.jar")
}
