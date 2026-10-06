plugins {
    `java-library`
    kotlin("plugin.jpa")
}

description = "공통 워크플로·환경·저장·관리와 실행 조정"

dependencies {
    api(project(":flow-agent"))
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
}

tasks.named<Jar>("jar") { archiveFileName.set("flowlink-core.jar") }
