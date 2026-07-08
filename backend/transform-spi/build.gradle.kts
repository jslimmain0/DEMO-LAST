// 변환 SPI — 앱과 플러그인이 공유하는 계약(인터페이스)만 담는 순수 모듈.
// 의존성 0(코틀린 stdlib 뿐). 플러그인은 이 모듈만 compileOnly 로 물면 된다.
plugins {
    kotlin("jvm")
}

group = "com.flowlink"
version = "0.1.0-SNAPSHOT"

kotlin {
    jvmToolchain(21)
}

repositories {
    mavenCentral()
}
