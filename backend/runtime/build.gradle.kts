plugins {
    `java-library`
    kotlin("plugin.jpa")
}

description = "공통 도메인·DB·워크플로 실행·에이전트 호출·Mock 런타임"

dependencies {
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
}
