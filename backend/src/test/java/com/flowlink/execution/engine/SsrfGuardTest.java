package com.flowlink.execution.engine;

import com.flowlink.execution.config.ExecutionProperties;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** SSRF 가드 — 사설/메타데이터/비허용 스킴 차단(네트워크 DNS 불필요한 케이스만). */
class SsrfGuardTest {

    private SsrfGuard guard() {
        ExecutionProperties props = new ExecutionProperties(
                null,
                new ExecutionProperties.Ssrf(true, true,
                        List.of("169.254.169.254"), List.of("http", "https")),
                null,
                200);
        return new SsrfGuard(props);
    }

    @Test
    void blocksCloudMetadataHost() {
        assertThrows(SsrfBlockedException.class,
                () -> guard().check(URI.create("http://169.254.169.254/latest/meta-data/")));
    }

    @Test
    void blocksLoopback() {
        assertThrows(SsrfBlockedException.class,
                () -> guard().check(URI.create("http://127.0.0.1:8080/internal")));
    }

    @Test
    void blocksPrivateRange() {
        assertThrows(SsrfBlockedException.class,
                () -> guard().check(URI.create("http://10.0.0.5/")));
        assertThrows(SsrfBlockedException.class,
                () -> guard().check(URI.create("http://192.168.1.1/")));
    }

    @Test
    void blocksDisallowedScheme() {
        assertThrows(SsrfBlockedException.class,
                () -> guard().check(URI.create("ftp://example.com/")));
        assertThrows(SsrfBlockedException.class,
                () -> guard().check(URI.create("file:///etc/passwd")));
    }

    @Test
    void allowsPublicLiteralIp() {
        // 8.8.8.8 은 공인 대역 → 통과(외부 DNS 호출 없음)
        assertDoesNotThrow(() -> guard().check(URI.create("https://8.8.8.8/")));
    }
}
