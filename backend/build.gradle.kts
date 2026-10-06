import io.spring.gradle.dependencymanagement.dsl.DependencyManagementExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension

plugins {
    base
    kotlin("jvm") version "1.9.25" apply false
    kotlin("plugin.spring") version "1.9.25" apply false
    kotlin("plugin.jpa") version "1.9.25" apply false
    id("org.springframework.boot") version "3.3.5" apply false
    id("io.spring.dependency-management") version "1.1.6" apply false
}

allprojects {
    group = "com.flowlink"
    version = rootProject.file("../VERSION").readText().trim()
    repositories { mavenCentral() }
}

subprojects {
    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlin.plugin.spring")
    apply(plugin = "io.spring.dependency-management")

    configure<DependencyManagementExtension> {
        imports { mavenBom("org.springframework.boot:spring-boot-dependencies:3.3.5") }
    }
    configure<KotlinJvmProjectExtension> {
        jvmToolchain(21)
        compilerOptions {
            freeCompilerArgs.addAll("-Xjsr305=strict", "-Xjvm-default=all-compatibility")
        }
    }
    dependencies {
        "testImplementation"("org.springframework.boot:spring-boot-starter-test")
        "testImplementation"("org.springframework.security:spring-security-test")
        "testRuntimeOnly"("org.junit.platform:junit-platform-launcher")
        "testRuntimeOnly"("com.h2database:h2")
    }
    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        jvmArgs("-Dfile.encoding=UTF-8", "-Dsun.jnu.encoding=UTF-8")
    }
    tasks.withType<JavaCompile>().configureEach { options.encoding = "UTF-8" }
}

val releaseProperties = tasks.register("releaseProperties") {
    val releaseFile = layout.projectDirectory.file("../VERSION")
    val output = layout.buildDirectory.file("generated/release/flowlink-release.properties")
    inputs.file(releaseFile)
    outputs.file(output)
    doLast {
        val value = releaseFile.asFile.readText().trim()
        require(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matches(value))
        output.get().asFile.apply { parentFile.mkdirs(); writeText("version=$value\n") }
    }
}

configure(listOf(project(":flow-server"), project(":flow-desktop"))) {
    apply(plugin = "org.springframework.boot")
    tasks.named<org.springframework.boot.gradle.tasks.run.BootRun>("bootRun") {
        workingDir = rootProject.projectDir
    }
    tasks.named<ProcessResources>("processResources") {
        dependsOn(releaseProperties)
        from(rootProject.layout.buildDirectory.dir("generated/release"))
        from(rootProject.file("../frontend/dist")) { into("static") }
    }
}

tasks.named("assemble") { dependsOn(subprojects.map { "${it.path}:assemble" }) }
tasks.named("check") { dependsOn(subprojects.map { "${it.path}:check" }) }
