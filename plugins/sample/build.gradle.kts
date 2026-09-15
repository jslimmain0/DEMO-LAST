// 참고용 변환 플러그인 — 새 플러그인을 만들 때 이 디렉터리를 통째로 복사해 시작하면 된다.
//
// 핵심 규칙:
//  1) SPI(:spi)는 compileOnly — 런타임엔 앱(FlowLink)이 같은 FQCN 클래스를 제공하므로 JAR 에 번들하지 않는다.
//  2) 구현 클래스를 META-INF/services/com.flowlink.transform.FlowTransform 에 등록(ServiceLoader).
//  3) 외부 라이브러리가 필요하면 implementation(...) 으로 추가 — 아래 jar 설정이 JAR 안에 함께 넣어서
//     **앱(backend)에 그 의존성이 없어도** 이 JAR 하나로 굴러간다.
//  4) 빌드: ./gradlew :sample:jar → build/libs/flowlink-plugin-sample.jar
plugins {
    kotlin("jvm")
}

group = "com.flowlink.plugin"
version = "0.1.0"

kotlin {
    jvmToolchain(21)
}

repositories {
    mavenCentral()
}

dependencies {
    compileOnly(project(":spi"))
    compileOnly(kotlin("stdlib"))   // 앱이 런타임에 제공 — JAR 에 안 넣는다(gradle.properties 참조)

    // 외부 라이브러리는 implementation 으로 — 아래 jar 설정이 JAR 에 함께 넣는다.
    // implementation("org.apache.commons:commons-lang3:3.14.0")

    testImplementation(project(":spi"))
    testImplementation(kotlin("stdlib"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.2")
}

tasks.withType<Test> {
    useJUnitPlatform()
    jvmArgs("-Dfile.encoding=UTF-8", "-Dsun.jnu.encoding=UTF-8")
}

tasks.jar {
    archiveFileName.set("flowlink-plugin-sample.jar")

    // 자족(self-contained) JAR — implementation 으로 건 외부 라이브러리를 JAR 안에 함께 넣는다.
    // compileOnly(SPI·stdlib)는 runtimeClasspath 에 없으므로 자동으로 빠진다. 의존성이 없으면 이 블록은 아무 일도 안 한다.
    // ⚠ 앱이 **이미 쓰는** 라이브러리(jackson 등)를 넣어도 앱 것이 이긴다(TransformRegistry 의 URLClassLoader 는 parent-first).
    //    앱과 다른 버전을 꼭 써야 하면 Shadow 플러그인으로 패키지를 relocate 할 것.
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) })
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "module-info.class")
}

// 로컬 개발 편의 — 런타임 플러그인 디렉터리(= 이 워크스페이스 루트 plugins/, 앱의 기본값 "plugins")에 바로 배치.
// 앱 재시작(또는 아무 JAR 업로드)이면 로드된다. Copy 태스크가 아니라 단순 복사인 이유: 목적지가 이 빌드의
// 루트라 Gradle 이 "다른 태스크 출력과 겹친다"고 검증 실패한다(출력 선언 없는 태스크면 그 대상이 아니다).
tasks.register("deploy") {
    dependsOn(tasks.jar)
    doLast {
        val jar = tasks.jar.get().archiveFile.get().asFile
        val dest = rootProject.projectDir.resolve(jar.name)
        // 앱이 떠 있으면 URLClassLoader 가 JAR 를 물고 있어 Windows 에서 덮어쓰기가 막힌다 → 앱을 먼저 내릴 것.
        check(!dest.exists() || dest.delete()) { "JAR 가 잠겨 있다(앱 실행 중?) — scripts/stop.ps1 후 다시: $dest" }
        jar.copyTo(dest, overwrite = true)
        logger.lifecycle("배치: $dest")
    }
}
