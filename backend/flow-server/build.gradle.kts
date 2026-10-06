plugins {
    `java-library`
    kotlin("plugin.jpa")
}

description = "공용 백엔드와 개인 H2에서 재사용하는 저장·관리 구현"

dependencies {
    api(project(":flow-agent"))
    implementation(project(":flow-mcp"))
    // 공통 서비스의 공개 타입에 등장하는 Spring/Jackson API는 두 호스트가 공유한다.
    api("org.springframework.boot:spring-boot-starter-web")
    api("org.springframework.boot:spring-boot-starter-validation")
    api("org.springframework.boot:spring-boot-starter-aop")
    api("org.springframework.boot:spring-boot-starter-websocket")
    api("org.springframework.boot:spring-boot-starter-data-jpa")
    api("org.springframework.boot:spring-boot-starter-security")
    api("org.springframework.boot:spring-boot-starter-oauth2-resource-server")
    api("org.springframework:spring-expression")
    api("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    implementation("org.graalvm.polyglot:polyglot:24.1.2")
    implementation("org.graalvm.polyglot:js-community:24.1.2")
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")
    runtimeOnly("com.oracle.database.jdbc:ojdbc11:23.26.2.0.0")
    runtimeOnly("com.h2database:h2") // 서버 격리 검증용
}

springBoot { mainClass.set("com.flowlink.server.ServerApplicationKt") }
tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("flowlink-server.jar")
}

// desktop이 재사용하는 일반 JAR에는 중앙 서버의 시작점·로그인 발급·배포·협업 구현을 넣지 않는다.
tasks.named<Jar>("jar") {
    archiveFileName.set("flowlink-server-library.jar")
    exclude("com/flowlink/server/**", "com/flowlink/distribution/**", "com/flowlink/presence/**")
    exclude("com/flowlink/security/AppJwt*", "com/flowlink/security/AuthConfig*",
        "com/flowlink/security/GithubAuthService*", "com/flowlink/security/GithubLoginController*")
    exclude("application-dev.yml", "application-agent-lab.yml", "application-oracle.yml", "static/**")
}
