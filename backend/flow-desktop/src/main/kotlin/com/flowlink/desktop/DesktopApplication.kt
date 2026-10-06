package com.flowlink.desktop

import com.flowlink.FlowlinkApplication
import com.flowlink.configureOutboundTls
import org.springframework.boot.builder.SpringApplicationBuilder

fun main(args: Array<String>) {
    configureOutboundTls()
    val launchArgs = DesktopLaunch.normalizeArguments(args)
    if (DesktopLaunch.openExisting(launchArgs)) return
    SpringApplicationBuilder(FlowlinkApplication::class.java, DesktopConfiguration::class.java).headless(false)
        .initializers({ context -> DesktopLaunch.validate(context.environment) })
        .run(*launchArgs)
}
