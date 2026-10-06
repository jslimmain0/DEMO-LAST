package com.flowlink.server

import com.flowlink.FlowlinkApplication
import com.flowlink.configureOutboundTls
import org.springframework.boot.builder.SpringApplicationBuilder
import org.springframework.core.env.Environment
import org.springframework.core.env.Profiles

fun main(args: Array<String>) {
    configureOutboundTls()
    SpringApplicationBuilder(FlowlinkApplication::class.java, ServerFeatures::class.java).headless(true)
        .initializers({ context -> validateServerProfiles(context.environment) })
        .run(*args)
}

/** ConfigData의 활성·포함·그룹 프로파일을 해석한 뒤, DB와 서비스 빈 생성 전에 거부한다. */
internal fun validateServerProfiles(environment: Environment) {
    require(!environment.acceptsProfiles(Profiles.of("desktop"))) {
        "서버 배포물은 desktop 프로파일을 사용할 수 없습니다. Windows 앱 배포물을 실행하세요."
    }
}
