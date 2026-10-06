plugins { `java-library` }

description = "중앙 서버 내 공식 MCP SDK 및 사용자별 REST 도구 어댑터"

dependencies {
    api("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-oauth2-authorization-server")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("io.modelcontextprotocol.sdk:mcp-core:0.17.2")
    implementation("io.modelcontextprotocol.sdk:mcp-json-jackson2:0.17.2")
}

tasks.named<Jar>("jar") { archiveFileName.set("flowlink-mcp.jar") }
