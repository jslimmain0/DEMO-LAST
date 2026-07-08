// 참고용 변환 플러그인 — 새 플러그인을 만들 때 이 모듈을 통째로 복사해 시작하면 된다.
//
// 핵심 규칙:
//  1) SPI(:transform-spi)는 compileOnly — 런타임엔 앱(FlowLink)이 같은 클래스를 제공하므로
//     JAR 에 SPI 를 번들하지 않는다(plain jar 라 어차피 의존성은 안 들어감).
//  2) 구현 클래스를 META-INF/services/com.flowlink.transform.FlowTransform 에 등록(ServiceLoader).
//  3) 빌드: gradle :plugin-sample:jar → build/libs/flowlink-plugin-sample.jar
//     배포: 업로드(POST /api/v1/plugins) 또는 gradle :plugin-sample:deploy (로컬 plugins/ 에 복사)
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
    compileOnly(project(":transform-spi"))

    testImplementation(project(":transform-spi"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> {
    useJUnitPlatform()
    jvmArgs("-Dfile.encoding=UTF-8", "-Dsun.jnu.encoding=UTF-8")
}

tasks.jar {
    archiveFileName.set("flowlink-plugin-sample.jar")
}

// 로컬 개발 편의 — 백엔드 플러그인 디렉토리(backend/plugins/)에 바로 배치. 앱 재시작(또는 아무 JAR 업로드)로 로드.
tasks.register<Copy>("deploy") {
    dependsOn(tasks.jar)
    from(tasks.jar)
    into(rootProject.projectDir.resolve("plugins"))
}
