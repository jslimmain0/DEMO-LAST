package com.flowlink.execution.engine;

import com.flowlink.execution.config.ExecutionProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.util.Locale;
import java.util.Set;

/**
 * 서버사이드 HTTP 호출의 SSRF 방어. 스킴 화이트리스트 + 호스트 블랙리스트 + 사설/루프백/링크로컬 대역 차단.
 *
 * <p>주의(후속 보완): 여기서 DNS를 해석해 검사하지만, 실제 연결 시점에 다른 IP로 바뀌는
 * DNS 리바인딩은 막지 못한다. 운영에서는 해석된 IP를 고정(pinning)하거나 egress 프록시/allowlist 를 병행한다.
 */
@Component
public class SsrfGuard {

    private static final Logger log = LoggerFactory.getLogger(SsrfGuard.class);

    private final ExecutionProperties.Ssrf cfg;
    private final Set<String> allowedSchemes;
    private final Set<String> blockedHosts;

    public SsrfGuard(ExecutionProperties props) {
        this.cfg = props.ssrf();
        this.allowedSchemes = lower(cfg.allowedSchemes());
        this.blockedHosts = lower(cfg.blockedHosts());
    }

    public void check(URI uri) {
        if (!cfg.enabled()) {
            return;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!allowedSchemes.contains(scheme)) {
            throw new SsrfBlockedException("허용되지 않은 스킴: " + scheme);
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            throw new SsrfBlockedException("호스트가 없습니다: " + uri);
        }
        String hostLower = host.toLowerCase(Locale.ROOT);
        if (blockedHosts.contains(hostLower)) {
            throw new SsrfBlockedException("차단된 호스트: " + host);
        }

        if (cfg.blockPrivateNetworks()) {
            final InetAddress[] addresses;
            try {
                addresses = InetAddress.getAllByName(host);
            } catch (UnknownHostException e) {
                throw new SsrfBlockedException("호스트 해석 실패: " + host);
            }
            for (InetAddress addr : addresses) {
                if (isBlockedAddress(addr)) {
                    log.warn("SSRF 차단: host={} -> {}", host, addr.getHostAddress());
                    throw new SsrfBlockedException("사설/내부 대역으로의 요청은 차단됩니다: " + addr.getHostAddress());
                }
                if (blockedHosts.contains(addr.getHostAddress())) {
                    throw new SsrfBlockedException("차단된 IP: " + addr.getHostAddress());
                }
            }
        }
    }

    /** TCP 등 스킴 없는 host:port 검증(사설/내부/차단 대역 거부). */
    public void checkHostPort(String host, int port) {
        if (!cfg.enabled()) {
            return;
        }
        if (host == null || host.isBlank()) {
            throw new SsrfBlockedException("호스트가 없습니다.");
        }
        if (port < 1 || port > 65535) {
            throw new SsrfBlockedException("잘못된 포트: " + port);
        }
        if (blockedHosts.contains(host.toLowerCase(Locale.ROOT))) {
            throw new SsrfBlockedException("차단된 호스트: " + host);
        }
        if (cfg.blockPrivateNetworks()) {
            final InetAddress[] addresses;
            try {
                addresses = InetAddress.getAllByName(host);
            } catch (UnknownHostException e) {
                throw new SsrfBlockedException("호스트 해석 실패: " + host);
            }
            for (InetAddress addr : addresses) {
                if (isBlockedAddress(addr)) {
                    log.warn("SSRF(TCP) 차단: host={} -> {}", host, addr.getHostAddress());
                    throw new SsrfBlockedException("사설/내부 대역으로의 TCP 연결은 차단됩니다: " + addr.getHostAddress());
                }
                if (blockedHosts.contains(addr.getHostAddress())) {
                    throw new SsrfBlockedException("차단된 IP: " + addr.getHostAddress());
                }
            }
        }
    }

    private static boolean isBlockedAddress(InetAddress addr) {
        if (addr.isAnyLocalAddress() || addr.isLoopbackAddress()
                || addr.isLinkLocalAddress() || addr.isSiteLocalAddress()
                || addr.isMulticastAddress()) {
            return true;
        }
        byte[] b = addr.getAddress();
        // IPv4 100.64.0.0/10 (CGNAT)
        if (b.length == 4) {
            int first = b[0] & 0xFF;
            int second = b[1] & 0xFF;
            return first == 100 && second >= 64 && second <= 127;
        }
        // IPv6 unique-local fc00::/7
        if (b.length == 16) {
            return (b[0] & 0xFE) == 0xFC;
        }
        return false;
    }

    private static Set<String> lower(java.util.List<String> in) {
        return in == null ? Set.of()
                : in.stream().map(s -> s.toLowerCase(Locale.ROOT)).collect(java.util.stream.Collectors.toSet());
    }
}
