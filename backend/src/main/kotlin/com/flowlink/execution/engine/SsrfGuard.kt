package com.flowlink.execution.engine

import com.flowlink.execution.config.ExecutionProperties
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.util.Locale

/**
 * 서버사이드 HTTP 호출의 SSRF 방어. 스킴 화이트리스트 + 호스트 블랙리스트 + 사설/루프백/링크로컬 대역 차단.
 *
 * <p>주의(후속 보완): 여기서 DNS를 해석해 검사하지만, 실제 연결 시점에 다른 IP로 바뀌는
 * DNS 리바인딩은 막지 못한다. 운영에서는 해석된 IP를 고정(pinning)하거나 egress 프록시/allowlist 를 병행한다.
 */
@Component
class SsrfGuard(props: ExecutionProperties) {

    private val cfg: ExecutionProperties.Ssrf = props.ssrf
    private val allowedSchemes: Set<String> = lower(cfg.allowedSchemes)
    private val blockedHosts: Set<String> = lower(cfg.blockedHosts)

    fun check(uri: URI) {
        if (!cfg.enabled) {
            return
        }
        val scheme = if (uri.scheme == null) "" else uri.scheme.lowercase(Locale.ROOT)
        if (!allowedSchemes.contains(scheme)) {
            throw SsrfBlockedException("허용되지 않은 스킴: $scheme")
        }
        val host = uri.host
        if (host == null || host.isBlank()) {
            throw SsrfBlockedException("호스트가 없습니다: $uri")
        }
        val hostLower = host.lowercase(Locale.ROOT)
        if (blockedHosts.contains(hostLower)) {
            throw SsrfBlockedException("차단된 호스트: $host")
        }

        if (cfg.blockPrivateNetworks) {
            val addresses: Array<InetAddress> = try {
                InetAddress.getAllByName(host)
            } catch (e: UnknownHostException) {
                throw SsrfBlockedException("호스트 해석 실패: $host")
            }
            for (addr in addresses) {
                if (isBlockedAddress(addr)) {
                    log.warn("SSRF 차단: host={} -> {}", host, addr.hostAddress)
                    throw SsrfBlockedException("사설/내부 대역으로의 요청은 차단됩니다: " + addr.hostAddress)
                }
                if (blockedHosts.contains(addr.hostAddress)) {
                    throw SsrfBlockedException("차단된 IP: " + addr.hostAddress)
                }
            }
        }
    }

    /** TCP 등 스킴 없는 host:port 검증(사설/내부/차단 대역 거부). */
    fun checkHostPort(host: String?, port: Int) {
        if (!cfg.enabled) {
            return
        }
        if (host == null || host.isBlank()) {
            throw SsrfBlockedException("호스트가 없습니다.")
        }
        if (port < 1 || port > 65535) {
            throw SsrfBlockedException("잘못된 포트: $port")
        }
        if (blockedHosts.contains(host.lowercase(Locale.ROOT))) {
            throw SsrfBlockedException("차단된 호스트: $host")
        }
        if (cfg.blockPrivateNetworks) {
            val addresses: Array<InetAddress> = try {
                InetAddress.getAllByName(host)
            } catch (e: UnknownHostException) {
                throw SsrfBlockedException("호스트 해석 실패: $host")
            }
            for (addr in addresses) {
                if (isBlockedAddress(addr)) {
                    log.warn("SSRF(TCP) 차단: host={} -> {}", host, addr.hostAddress)
                    throw SsrfBlockedException("사설/내부 대역으로의 TCP 연결은 차단됩니다: " + addr.hostAddress)
                }
                if (blockedHosts.contains(addr.hostAddress)) {
                    throw SsrfBlockedException("차단된 IP: " + addr.hostAddress)
                }
            }
        }
    }

    private fun isBlockedAddress(addr: InetAddress): Boolean {
        // 로컬 배포: allow-loopback 이면 localhost/127.0.0.1/::1 은 허용(그 외 사설/내부 대역은 그대로 차단)
        if (addr.isLoopbackAddress) {
            return !cfg.allowLoopback
        }
        if (addr.isAnyLocalAddress
            || addr.isLinkLocalAddress || addr.isSiteLocalAddress
            || addr.isMulticastAddress
        ) {
            return true
        }
        val b = addr.address
        // IPv4 100.64.0.0/10 (CGNAT)
        if (b.size == 4) {
            val first = b[0].toInt() and 0xFF
            val second = b[1].toInt() and 0xFF
            return first == 100 && second in 64..127
        }
        // IPv6 unique-local fc00::/7
        if (b.size == 16) {
            return (b[0].toInt() and 0xFE) == 0xFC
        }
        return false
    }

    companion object {
        private val log: Logger = LoggerFactory.getLogger(SsrfGuard::class.java)

        private fun lower(input: List<String>?): Set<String> =
            input?.map { it.lowercase(Locale.ROOT) }?.toSet() ?: emptySet()
    }
}
