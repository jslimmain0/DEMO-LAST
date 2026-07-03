package com.flowlink.mock;

import com.flowlink.execution.engine.SsrfGuard;
import com.flowlink.mock.MockHttp.FiredCallback;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * mock 의 콜백(웹훅) 발사기 — 승인노티/입금노티 패턴.
 * 응답 반환 후 비동기로 발사하고, retryUntilOk 면 응답 본문이 "OK" 가 아닐 때 2초 간격 최대 3회 재발송
 * (PG 노티 "OK 못 받으면 재발송" 규약의 축소판). 발사 대상 URL 은 SsrfGuard 를 통과해야 한다
 * (로컬 프로파일은 loopback 허용 → relay 콜백 가능).
 */
@Component
public class MockCallbackDispatcher {

    private static final Logger log = LoggerFactory.getLogger(MockCallbackDispatcher.class);
    private static final int MAX_ATTEMPTS = 3;
    private static final long RETRY_INTERVAL_MS = 2_000;

    private final SsrfGuard ssrf;
    private final ScheduledExecutorService exec = Executors.newScheduledThreadPool(2, r -> {
        Thread t = new Thread(r, "mock-callback");
        t.setDaemon(true);
        return t;
    });
    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    public MockCallbackDispatcher(SsrfGuard ssrf) {
        this.ssrf = ssrf;
    }

    public void fire(FiredCallback cb) {
        if (cb == null || cb.url() == null || cb.url().isBlank()) {
            return;
        }
        schedule(cb, 1, cb.afterMs());
    }

    private void schedule(FiredCallback cb, int attempt, long delayMs) {
        exec.schedule(() -> attempt(cb, attempt), Math.max(0, delayMs), TimeUnit.MILLISECONDS);
    }

    private void attempt(FiredCallback cb, int attempt) {
        try {
            URI uri = URI.create(cb.url());
            ssrf.check(uri);
            HttpRequest.Builder b = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", cb.contentType());
            HttpRequest req = switch (cb.method()) {
                case "GET" -> b.GET().build();
                default -> b.method(cb.method(),
                        HttpRequest.BodyPublishers.ofString(cb.body() == null ? "" : cb.body(), StandardCharsets.UTF_8)).build();
            };
            HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            boolean okAck = res.body() != null && res.body().trim().equals("OK");
            log.info("[mock-callback] {} {} → {} (시도 {}/{}, ack={})",
                    cb.method(), cb.url(), res.statusCode(), attempt, MAX_ATTEMPTS, okAck);
            if (cb.retryUntilOk() && !okAck && attempt < MAX_ATTEMPTS) {
                schedule(cb, attempt + 1, RETRY_INTERVAL_MS);
            }
        } catch (Exception e) {
            log.warn("[mock-callback] 발사 실패({}): {} — {}", attempt, cb.url(),
                    e.getMessage() == null ? e.toString() : e.getMessage());
            if (cb.retryUntilOk() && attempt < MAX_ATTEMPTS) {
                schedule(cb, attempt + 1, RETRY_INTERVAL_MS);
            }
        }
    }
}
