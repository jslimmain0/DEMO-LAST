package com.flowlink.desktop

import org.springframework.context.annotation.ComponentScan
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.context.annotation.FilterType

/** 개인 저장소 호스트에만 Windows 세션·디스패처·트레이·업데이트 기능을 등록한다. */
@Configuration
@Profile("desktop")
@ComponentScan(basePackages = ["com.flowlink.desktop", "com.flowlink.assistant"], excludeFilters = [
    ComponentScan.Filter(type = FilterType.ASSIGNABLE_TYPE, classes = [com.flowlink.assistant.SchemaController::class]),
])
class DesktopConfiguration
