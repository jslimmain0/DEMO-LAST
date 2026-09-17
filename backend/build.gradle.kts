plugins {
    java
    kotlin("jvm") version "1.9.25"
    kotlin("plugin.spring") version "1.9.25"   // all-open: @Component/@Transactional 등 자동 open
    kotlin("plugin.jpa") version "1.9.25"       // no-arg: JPA 엔티티 기본 생성자
    id("org.springframework.boot") version "3.3.5"
    id("io.spring.dependency-management") version "1.1.6"
}

group = "com.flowlink"
version = "0.1.0-SNAPSHOT"
description = "Flowlink — REST API 워크플로 오케스트레이션 플랫폼 (엔터프라이즈 고도화)"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        freeCompilerArgs.add("-Xjsr305=strict")   // Spring 널 안전 애노테이션 엄격 적용
        // 인터페이스 default 메서드를 진짜 JVM default 로 방출(+DefaultImpls 유지) — 변환 SPI(FlowTransform)에
        // default 메서드를 추가해도 구 버전으로 컴파일된 플러그인 JAR 가 AbstractMethodError 없이 동작하게.
        freeCompilerArgs.add("-Xjvm-default=all-compatibility")
    }
}

repositories {
    mavenCentral()
}

dependencies {
    // --- Web / API ---
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-aop")
    implementation("org.springframework.boot:spring-boot-starter-websocket")   // presence 릴레이(/ws/presence)

    // --- Persistence (dev=Oracle — 스키마는 db/init.sql 을 한 번 실행, local=H2 ddl-auto) ---
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    runtimeOnly("com.oracle.database.jdbc:ojdbc11")         // Oracle 드라이버
    runtimeOnly("com.h2database:h2")        // local 프로파일(기본)·테스트

    // --- Security — GitHub 로그인(자체 JWT 를 resource-server 로 검증) ---
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-oauth2-resource-server")

    // --- 표현식 샌드박스(IF 노드) ---
    implementation("org.springframework:spring-expression")

    // --- Kotlin ---
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("org.jetbrains.kotlin:kotlin-reflect")

    // --- dev only ---
    developmentOnly("org.springframework.boot:spring-boot-devtools")

    // --- test ---
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.security:spring-security-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
    useJUnitPlatform()
    // 비ASCII 경로에서 포크된 테스트 워커의 클래스패스 디코딩 문제 방지
    jvmArgs("-Dfile.encoding=UTF-8", "-Dsun.jnu.encoding=UTF-8")
}

tasks.withType<JavaCompile> {
    options.encoding = "UTF-8"
}

tasks.named<org.springframework.boot.gradle.tasks.bundling.BootJar>("bootJar") {
    archiveFileName.set("flowlink.jar")
    // 프론트엔드(dist) 동봉 — 단일 jar 배포(SpaStaticConfig 가 classpath:/static/ 서빙 + SPA fallback).
    // 빌드 순서: ① frontend 에서 npm run build ② gradle bootJar → flowlink.jar 하나에 프론트+백엔드.
    // dist 가 없으면 그냥 빠짐(백엔드 단독 dev 빌드·bootRun/Vite 개발 구성 무회귀).
    from("../frontend/dist") { into("BOOT-INF/classes/static") }
}

