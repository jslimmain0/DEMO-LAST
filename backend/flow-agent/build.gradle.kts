plugins { `java-library` }

description = "DB 없는 호출·Mock·콜백 런타임과 공유 실행 계약"

dependencies {
    api("org.springframework.boot:spring-boot-starter-web")
    api("org.springframework.boot:spring-boot-starter-validation")
    api("org.springframework:spring-expression")
    api("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
}

tasks.named<Jar>("jar") { archiveFileName.set("flowlink-agent.jar") }
