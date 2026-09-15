// 변환 SPI 사본 — 플러그인이 컴파일할 때만 쓰는 계약(런타임엔 앱이 같은 클래스를 제공).
// 소스는 backend/src/main/kotlin/com/flowlink/transform/FlowTransform.kt 와 동일해야 한다(파일 상단 경고 참조).
plugins {
    kotlin("jvm")
}

group = "com.flowlink"
version = "0.1.0"

kotlin {
    jvmToolchain(21)
    // 앱과 동일 — 인터페이스 default 메서드를 진짜 JVM default 로(구 플러그인 JAR 바이너리 호환).
    compilerOptions {
        freeCompilerArgs.add("-Xjvm-default=all-compatibility")
    }
}

repositories {
    mavenCentral()
}

dependencies {
    compileOnly(kotlin("stdlib"))   // 앱이 런타임에 제공(gradle.properties 참조)
}
