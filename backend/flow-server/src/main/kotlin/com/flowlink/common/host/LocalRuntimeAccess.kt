package com.flowlink.common.host

/** 개인 저장소를 호스팅하는 앱이 제공한다. 서버에는 이 빈이 존재하지 않는다. */
interface LocalRuntimeSession {
    val deviceId: String
    val encryptionKey: String
}

interface LocalServerConnection {
    fun connectionIdentity(): LocalServerIdentity
}

data class LocalServerIdentity(val serverUrl: String, val login: String?, val connected: Boolean)
