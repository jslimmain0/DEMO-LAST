package com.flowlink.common.crypto

/**
 * 앱 저장 암호화 계약 — DB 시크릿·실행 재개 스냅샷·어시스턴트 토큰이 이 인터페이스로 암복호화한다.
 * 구현: StateCrypto(로컬 AES-GCM) · TransitCrypto(Vault Transit 위임) · RoutingCrypto(접두사 라우팅).
 */
interface CryptoProvider {
    fun encrypt(plain: String): String
    fun decrypt(encoded: String): String

    /** 여러 건 복호화 — 기본은 건별 호출, Transit 구현은 batch API 한 번으로 오버라이드한다. */
    fun decryptAll(values: List<String>): List<String> = values.map { decrypt(it) }
}
