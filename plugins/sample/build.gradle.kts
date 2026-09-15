// 참고용 변환 플러그인 — 새 플러그인을 만들 때 이 디렉터리를 통째로 복사해 시작하면 된다.
//
// 핵심 규칙:
//  1) SPI 는 compileOnly — 런타임엔 앱(FlowLink)이 같은 클래스를 제공하므로 JAR 에 번들하지 않는다.
//     좌표 com.flowlink:transform-spi 는 settings.gradle.kts 의 includeBuild("../backend") 가
//     backend/transform-spi 모듈로 치환한다(리포 밖에서 쓸 땐 SPI JAR 를 files(...) 로 물리면 된다).
//  2) 구현 클래스를 META-INF/services/com.flowlink.transform.FlowTransform 에 등록(ServiceLoader).
//  3) 빌드: ./gradlew :sample:jar → build/libs/flowlink-plugin-sample.jar
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
    compileOnly("com.flowlink:transform-spi:0.1.0-SNAPSHOT")

    testImplementation("com.flowlink:transform-spi:0.1.0-SNAPSHOT")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.10.2")
}

tasks.withType<Test> {
    useJUnitPlatform()
    jvmArgs("-Dfile.encoding=UTF-8", "-Dsun.jnu.encoding=UTF-8")
}

tasks.jar {
    archiveFileName.set("flowlink-plugin-sample.jar")
}

// 로컬 개발 편의 — 런타임 플러그인 디렉터리(리포 루트의 plugins/)에 바로 배치. 앱 재시작(또는 아무 JAR 업로드)로 로드.
tasks.register<Copy>("deploy") {
    dependsOn(tasks.jar)
    // 목적지가 이 빌드의 루트(.gradle 잠금 파일 포함)라 Gradle 이 스냅샷을 못 뜬다 — 증분 추적 불필요한 복사.
    doNotTrackState("런타임 플러그인 드롭 디렉터리로 복사")
    from(tasks.jar)
    into(rootProject.projectDir)
}
