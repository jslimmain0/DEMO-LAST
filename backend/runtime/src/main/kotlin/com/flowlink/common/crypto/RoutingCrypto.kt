package com.flowlink.common.crypto

/**
 * 접두사 라우팅 암호화 — **쓰기는 항상 primary(Transit)**, 읽기는 암호문 형식으로 판별해
 * `vault:` 접두사면 primary, 아니면 legacy(StateCrypto)로 복호화한다.
 * → Transit 전환 후에도 기존(레거시 AES-GCM) 데이터가 무중단으로 읽히고, 재저장 시 자연히 이관된다.
 */
class RoutingCrypto(
    private val primary: CryptoProvider,
    private val legacy: CryptoProvider,
) : CryptoProvider {

    override fun encrypt(plain: String): String = primary.encrypt(plain)

    override fun decrypt(encoded: String): String =
        if (isTransitFormat(encoded)) primary.decrypt(encoded) else legacy.decrypt(encoded)

    /** 혼재 목록: transit 건만 모아 배치 1회, 레거시는 건별 — 입력 순서 보존. */
    override fun decryptAll(values: List<String>): List<String> {
        val transitIdx = values.indices.filter { isTransitFormat(values[it]) }
        val transitPlain = primary.decryptAll(transitIdx.map { values[it] })
        val out = arrayOfNulls<String>(values.size)
        transitIdx.forEachIndexed { i, idx -> out[idx] = transitPlain[i] }
        for (idx in values.indices) {
            if (out[idx] == null) out[idx] = legacy.decrypt(values[idx])
        }
        return out.map { it!! }
    }

    companion object {
        /** Vault Transit 암호문 형식(vault:v{n}:...) 판별 — 이관 대상 선별에도 쓴다. */
        @JvmStatic
        fun isTransitFormat(value: String): Boolean = value.startsWith("vault:")
    }
}
