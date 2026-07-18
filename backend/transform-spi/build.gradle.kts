// 변환 SPI — 앱과 플러그인이 공유하는 계약(인터페이스)만 담는 순수 모듈.
// 의존성 0(코틀린 stdlib 뿐). 플러그인은 이 모듈만 compileOnly 로 물면 된다.
plugins {
    kotlin("jvm")
}

group = "com.flowlink"
version = "0.1.0-SNAPSHOT"

kotlin {
    jvmToolchain(21)
    // 인터페이스 default 메서드를 진짜 JVM default 로 방출(+DefaultImpls 유지) — SPI 에 default 메서드(description() 등)를
    // 추가해도 **구 버전으로 컴파일된 플러그인 JAR** 가 AbstractMethodError 없이 상속하도록(바이너리 호환 = "기존 JAR 호환" 계약).
    compilerOptions {
        freeCompilerArgs.add("-Xjvm-default=all-compatibility")
    }
}

repositories {
    mavenCentral()
}
