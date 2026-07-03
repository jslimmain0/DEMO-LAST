package com.flowlink.mock;

import com.flowlink.common.json.JsonService;
import com.flowlink.mock.MockHttp.FiredCallback;
import com.flowlink.mock.MockHttp.MockRequest;
import com.flowlink.mock.MockHttp.MockResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * "가짜 결제 게이트웨이(PG)" 프리셋 — kind=PG mock 서버의 고정 엔드포인트 세트.
 *
 * <p>커스텀 규칙으로는 표현 불가능한 <b>상태</b>(TID 원장·부분취소 잔액·빌키·가상계좌 입금)를
 * 서버 ID 별 인메모리로 관리한다(재시작 시 소실 — suspensions 와 동일 계보).
 * 금액은 assert 비교 단순화를 위해 전부 <b>문자열</b>로 응답한다. 성공 resultCode 는 '0000'.
 *
 * <p>노티(승인/취소/입금)는 요청의 notiUrl 로 urlencoded POST — "OK" 응답이 아니면
 * {@link MockCallbackDispatcher}가 2초 간격 최대 3회 재발송.
 */
@Component
public class MockPgSimulator {

    private static final Logger log = LoggerFactory.getLogger(MockPgSimulator.class);
    private static final Charset EUC_KR = Charset.forName("EUC-KR");
    public static final String DEFAULT_SECRET = "demo-secret";

    private final JsonService json;
    private final MockCallbackDispatcher dispatcher;
    private final Map<UUID, PgState> states = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(1, r -> {
        Thread t = new Thread(r, "mock-pg-va");
        t.setDaemon(true);
        return t;
    });

    public MockPgSimulator(JsonService json, MockCallbackDispatcher dispatcher) {
        this.json = json;
        this.dispatcher = dispatcher;
    }

    // ---------- 상태 ----------

    static final class PgState {
        final Map<String, PgAuth> authTokens = new ConcurrentHashMap<>();
        final Map<String, PgTx> ledger = new ConcurrentHashMap<>();
        final Map<String, Map<String, String>> billKeys = new ConcurrentHashMap<>();
        final Map<String, PgVa> vaccounts = new ConcurrentHashMap<>();
        final AtomicLong seq = new AtomicLong(1000);
    }

    record PgAuth(String mid, String orderId, String amount, AtomicBoolean used) {
    }

    static final class PgTx {
        final String tid;
        final String orderId;
        final long amount;
        long remain;
        String status; // APPROVED | PARTIAL | CANCELLED
        final String approvedAt;

        PgTx(String tid, String orderId, long amount) {
            this.tid = tid;
            this.orderId = orderId;
            this.amount = amount;
            this.remain = amount;
            this.status = "APPROVED";
            this.approvedAt = Instant.now().toString();
        }
    }

    static final class PgVa {
        final String acctNo;
        final String orderId;
        final String amount;
        volatile boolean deposited;
        volatile String depositedAt;

        PgVa(String acctNo, String orderId, String amount) {
            this.acctNo = acctNo;
            this.orderId = orderId;
            this.amount = amount;
        }
    }

    private PgState state(UUID serverId) {
        return states.computeIfAbsent(serverId, k -> new PgState());
    }

    // ---------- 엔드포인트 라우팅 ----------

    public MockResponse handle(UUID serverId, String slug, MockRequest req, String secret) {
        PgState st = state(serverId);
        String key = req.method() + " " + req.path();
        return switch (key) {
            case "GET /auth", "POST /auth" -> authPage(slug, req);
            case "POST /auth/confirm" -> authConfirm(st, req);
            case "POST /approve" -> approve(st, req);
            case "POST /keyin" -> keyin(st, req, secret);
            case "POST /billkey" -> billkeyIssue(st, req);
            case "POST /billkey/approve" -> billkeyApprove(st, req);
            case "POST /billkey/delete" -> billkeyDelete(st, req);
            case "POST /cancel" -> cancel(st, req);
            case "GET /tx" -> txLookup(st, req);
            case "POST /va" -> vaIssue(st, req);
            case "GET /va/status" -> vaStatus(st, req);
            case "POST /legacy/euckr" -> legacyEucKr(st, req);
            case "POST /legacy/949" -> legacy949(req);
            case "GET /legacy/xml" -> legacyXml(st);
            case "POST /legacy/urlenc" -> legacyUrlenc(st, req);
            case "POST /legacy/raw" -> legacyRaw(req);
            case "GET /legacy/text" -> legacyText(st);
            case "POST /legacy/confirm" -> legacyConfirm(req);
            case "GET /secure" -> secure(req);
            case "GET /__routes" -> routesInfo();
            default -> jsonRes(404, Map.of("resultCode", "9404", "resultMsg", "없는 PG 엔드포인트: " + key));
        };
    }

    // ---------- 인증(결제창) ----------

    /** 결제창 HTML — form 노드 팝업이 여는 페이지. [인증하기]가 /auth/confirm 으로 제출된다. */
    private MockResponse authPage(String slug, MockRequest req) {
        Map<String, String> f = "GET".equals(req.method()) ? req.query() : req.bodyFields();
        String returnUrl = f.getOrDefault("returnUrl", "");
        if (returnUrl.isBlank()) {
            return htmlRes(400, pgShell("인증 요청 오류", "<p>returnUrl 필드가 없어 결과를 돌려줄 수 없습니다.</p>"));
        }
        String hidden = hiddenInputs(Map.of(
                "mid", f.getOrDefault("mid", ""),
                "orderId", f.getOrDefault("orderId", ""),
                "productName", f.getOrDefault("productName", ""),
                "amount", f.getOrDefault("amount", ""),
                "returnUrl", returnUrl));
        String amount = f.getOrDefault("amount", "-");
        String body = """
                <div class="row"><span>상품명</span><b>%s</b></div>
                <div class="row"><span>주문번호</span><b>%s</b></div>
                <div class="row"><span>결제 금액</span><b class="amt">%s원</b></div>
                <div class="btns">
                  <form method="POST" action="/mock/%s/auth/confirm">%s<input type="hidden" name="decision" value="approve"><button class="ok">인증하기</button></form>
                  <form method="POST" action="/mock/%s/auth/confirm">%s<input type="hidden" name="decision" value="cancel"><button class="no">취소</button></form>
                </div>
                <div class="note">모의 PG 인증창입니다 — 인증하면 returnUrl 로 authToken 이 전송됩니다.</div>
                """.formatted(
                MockHttp.escapeHtml(f.getOrDefault("productName", "(상품명 없음)")),
                MockHttp.escapeHtml(f.getOrDefault("orderId", "-")),
                MockHttp.escapeHtml(amount),
                MockHttp.escapeHtml(slug), hidden,
                MockHttp.escapeHtml(slug), hidden);
        return htmlRes(200, pgShell("MockPG 안전결제 인증", body));
    }

    /** 인증 확정 → authToken 발급 → returnUrl 로 자동 POST 브리지(실 PG merchant-return 패턴). */
    private MockResponse authConfirm(PgState st, MockRequest req) {
        Map<String, String> f = req.bodyFields();
        String returnUrl = f.getOrDefault("returnUrl", "");
        if (returnUrl.isBlank()) {
            return htmlRes(400, pgShell("오류", "<p>returnUrl 이 없습니다.</p>"));
        }
        Map<String, String> result = new LinkedHashMap<>();
        if ("cancel".equals(f.get("decision"))) {
            result.put("resultCode", "9999");
            result.put("resultMsg", "사용자취소");
            result.put("orderId", f.getOrDefault("orderId", ""));
        } else {
            String token = "AUTH-" + Long.toString(System.currentTimeMillis(), 36).toUpperCase() + "-" + st.seq.incrementAndGet();
            st.authTokens.put(token, new PgAuth(
                    f.getOrDefault("mid", ""), f.getOrDefault("orderId", ""),
                    f.getOrDefault("amount", ""), new AtomicBoolean(false)));
            result.put("resultCode", "0000");
            result.put("resultMsg", "인증성공");
            result.put("authToken", token);
            result.put("orderId", f.getOrDefault("orderId", ""));
            result.put("amount", f.getOrDefault("amount", ""));
        }
        String bridge = pgShell("인증 결과 전송 중…", "<p>인증 결과를 가맹점으로 전송하는 중…</p>")
                + "<form id=\"f\" method=\"POST\" action=\"" + MockHttp.escapeHtml(returnUrl) + "\">"
                + hiddenInputs(result)
                + "</form><script>document.getElementById('f').submit()</script>";
        return htmlRes(200, bridge);
    }

    // ---------- 승인 ----------

    /** 인증결제 승인 — authToken 단일사용·금액 일치 검증(위변조 방어는 구현하되 음성 데모는 없음). */
    private MockResponse approve(PgState st, MockRequest req) {
        Map<String, String> f = req.bodyFields();
        String token = f.getOrDefault("authToken", "");
        PgAuth auth = st.authTokens.get(token);
        if (auth == null) {
            return jsonRes(400, Map.of("resultCode", "3001", "resultMsg", "인증값이 없거나 만료되었습니다"));
        }
        if (!auth.used().compareAndSet(false, true)) {
            return jsonRes(400, Map.of("resultCode", "3003", "resultMsg", "이미 승인된 인증값(중복 승인 차단)"));
        }
        String amount = f.getOrDefault("amount", "");
        if (!auth.amount().isBlank() && !auth.amount().equals(amount)) {
            return jsonRes(400, Map.of("resultCode", "3002", "resultMsg", "금액 위변조 의심(인증 금액과 불일치)"));
        }
        return approveTx(st, auth.orderId(), amount, f.get("notiUrl"));
    }

    /** 수기(키인) 승인 — sign 이 있으면 sha256(mid+amount+secret) 검증. */
    private MockResponse keyin(PgState st, MockRequest req, String secret) {
        Map<String, String> f = req.bodyFields();
        if (f.getOrDefault("cardNo", "").isBlank()) {
            return jsonRes(400, Map.of("resultCode", "3101", "resultMsg", "cardNo 가 없습니다"));
        }
        String amount = f.getOrDefault("amount", "");
        String sign = f.get("sign");
        if (sign != null && !sign.isBlank()) {
            String expected = sha256Hex(f.getOrDefault("mid", "") + amount + secret);
            if (!expected.equalsIgnoreCase(sign)) {
                return jsonRes(400, Map.of("resultCode", "3102", "resultMsg", "서명 불일치"));
            }
        }
        return approveTx(st, f.getOrDefault("orderId", ""), amount, f.get("notiUrl"));
    }

    private MockResponse billkeyIssue(PgState st, MockRequest req) {
        Map<String, String> f = req.bodyFields();
        String cardNo = f.getOrDefault("cardNo", "");
        if (cardNo.isBlank()) {
            return jsonRes(400, Map.of("resultCode", "3101", "resultMsg", "cardNo 가 없습니다"));
        }
        String billKey = "BK-" + Long.toString(System.currentTimeMillis(), 36).toUpperCase() + "-" + st.seq.incrementAndGet();
        String masked = cardNo.length() > 4 ? "****-" + cardNo.substring(cardNo.length() - 4) : "****";
        st.billKeys.put(billKey, Map.of("mid", f.getOrDefault("mid", ""), "cardMasked", masked));
        return jsonRes(200, Map.of("resultCode", "0000", "resultMsg", "빌키발급", "billKey", billKey, "cardMasked", masked));
    }

    private MockResponse billkeyApprove(PgState st, MockRequest req) {
        Map<String, String> f = req.bodyFields();
        String billKey = f.getOrDefault("billKey", "");
        if (!st.billKeys.containsKey(billKey)) {
            return jsonRes(400, Map.of("resultCode", "4001", "resultMsg", "존재하지 않는 빌키"));
        }
        return approveTx(st, f.getOrDefault("orderId", ""), f.getOrDefault("amount", ""), f.get("notiUrl"));
    }

    private MockResponse billkeyDelete(PgState st, MockRequest req) {
        String billKey = req.bodyFields().getOrDefault("billKey", "");
        boolean removed = st.billKeys.remove(billKey) != null;
        return removed
                ? jsonRes(200, Map.of("resultCode", "0000", "resultMsg", "빌키삭제", "billKey", billKey))
                : jsonRes(400, Map.of("resultCode", "4001", "resultMsg", "존재하지 않는 빌키"));
    }

    /** 공통 승인 처리 — TID 발급·원장 기록·승인노티 발사. */
    private MockResponse approveTx(PgState st, String orderId, String amountStr, String notiUrl) {
        long amount = parseAmount(amountStr);
        if (amount <= 0) {
            return jsonRes(400, Map.of("resultCode", "3002", "resultMsg", "잘못된 금액: " + amountStr));
        }
        String tid = "TID" + Long.toString(System.currentTimeMillis(), 36).toUpperCase() + "-" + st.seq.incrementAndGet();
        PgTx tx = new PgTx(tid, orderId, amount);
        st.ledger.put(tid, tx);
        log.info("[mock-pg] 승인 tid={} order={} amount={}", tid, orderId, amount);
        fireNoti(notiUrl, List.of(
                Map.entry("type", "approve"), Map.entry("resultCode", "0000"),
                Map.entry("tid", tid), Map.entry("orderId", orderId),
                Map.entry("amount", String.valueOf(amount)), Map.entry("approvedAt", tx.approvedAt)));
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("resultCode", "0000");
        res.put("resultMsg", "정상승인");
        res.put("tid", tid);
        res.put("orderId", orderId);
        res.put("amount", String.valueOf(amount));
        res.put("approvedAt", tx.approvedAt);
        return jsonRes(200, res);
    }

    // ---------- 취소 · 조회 ----------

    private MockResponse cancel(PgState st, MockRequest req) {
        Map<String, String> f = req.bodyFields();
        PgTx tx = st.ledger.get(f.getOrDefault("tid", ""));
        if (tx == null) {
            return jsonRes(400, Map.of("resultCode", "5001", "resultMsg", "존재하지 않는 거래(TID)"));
        }
        synchronized (tx) {
            if (tx.remain <= 0) {
                return jsonRes(400, Map.of("resultCode", "5003", "resultMsg", "이미 전액 취소된 거래"));
            }
            long amt = f.get("amount") == null || f.get("amount").isBlank() ? tx.remain : parseAmount(f.get("amount"));
            if (amt <= 0) {
                return jsonRes(400, Map.of("resultCode", "5004", "resultMsg", "잘못된 취소 금액"));
            }
            if (amt > tx.remain) {
                return jsonRes(400, Map.of("resultCode", "5002",
                        "resultMsg", "취소 금액이 잔액을 초과", "remainAmt", String.valueOf(tx.remain)));
            }
            tx.remain -= amt;
            tx.status = tx.remain == 0 ? "CANCELLED" : "PARTIAL";
            String cancelTid = "CTID" + Long.toString(System.currentTimeMillis(), 36).toUpperCase() + "-" + st.seq.incrementAndGet();
            log.info("[mock-pg] 취소 tid={} amt={} remain={}", tx.tid, amt, tx.remain);
            fireNoti(f.get("notiUrl"), List.of(
                    Map.entry("type", "cancel"), Map.entry("resultCode", "0000"),
                    Map.entry("tid", tx.tid), Map.entry("cancelTid", cancelTid),
                    Map.entry("cancelAmt", String.valueOf(amt)), Map.entry("remainAmt", String.valueOf(tx.remain))));
            Map<String, Object> res = new LinkedHashMap<>();
            res.put("resultCode", "0000");
            res.put("resultMsg", "취소완료");
            res.put("tid", tx.tid);
            res.put("cancelTid", cancelTid);
            res.put("cancelAmt", String.valueOf(amt));
            res.put("remainAmt", String.valueOf(tx.remain));
            res.put("status", tx.status);
            return jsonRes(200, res);
        }
    }

    private MockResponse txLookup(PgState st, MockRequest req) {
        PgTx tx = st.ledger.get(req.query().getOrDefault("tid", ""));
        if (tx == null) {
            return jsonRes(404, Map.of("resultCode", "5001", "resultMsg", "존재하지 않는 거래(TID)"));
        }
        synchronized (tx) {
            Map<String, Object> res = new LinkedHashMap<>();
            res.put("resultCode", "0000");
            res.put("tid", tx.tid);
            res.put("orderId", tx.orderId);
            res.put("amount", String.valueOf(tx.amount));
            res.put("remainAmt", String.valueOf(tx.remain));
            res.put("status", tx.status);
            res.put("approvedAt", tx.approvedAt);
            return jsonRes(200, res);
        }
    }

    // ---------- 가상계좌 ----------

    private MockResponse vaIssue(PgState st, MockRequest req) {
        Map<String, String> f = req.bodyFields();
        long amount = parseAmount(f.getOrDefault("amount", ""));
        if (amount <= 0) {
            return jsonRes(400, Map.of("resultCode", "3002", "resultMsg", "잘못된 금액"));
        }
        String acctNo = "9003" + String.format("%08d", st.seq.incrementAndGet() % 100_000_000);
        PgVa va = new PgVa(acctNo, f.getOrDefault("orderId", ""), String.valueOf(amount));
        st.vaccounts.put(acctNo, va);
        int sec = (int) Math.min(Math.max(parseAmount(f.getOrDefault("autoDepositSec", "2")), 0), 60);
        String notiUrl = f.get("notiUrl");
        scheduler.schedule(() -> {
            va.deposited = true;
            va.depositedAt = Instant.now().toString();
            log.info("[mock-pg] 가상계좌 입금 acctNo={} amount={}", acctNo, va.amount);
            fireNoti(notiUrl, List.of(
                    Map.entry("type", "deposit"), Map.entry("resultCode", "0000"),
                    Map.entry("acctNo", acctNo), Map.entry("orderId", va.orderId),
                    Map.entry("amount", va.amount), Map.entry("depositedAt", va.depositedAt)));
        }, sec, TimeUnit.SECONDS);
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("resultCode", "0000");
        res.put("resultMsg", "채번완료");
        res.put("acctNo", acctNo);
        res.put("bankName", "모의은행");
        res.put("orderId", va.orderId);
        res.put("amount", va.amount);
        res.put("autoDepositSec", String.valueOf(sec));
        return jsonRes(200, res);
    }

    private MockResponse vaStatus(PgState st, MockRequest req) {
        PgVa va = st.vaccounts.get(req.query().getOrDefault("acctNo", ""));
        if (va == null) {
            return jsonRes(404, Map.of("resultCode", "6001", "resultMsg", "존재하지 않는 계좌"));
        }
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("resultCode", "0000");
        res.put("acctNo", va.acctNo);
        res.put("deposited", va.deposited);
        res.put("amount", va.amount);
        res.put("depositedAt", va.depositedAt == null ? "" : va.depositedAt);
        return jsonRes(200, res);
    }

    // ---------- 레거시 규격 ----------

    /** EUC-KR urlencoded 왕복 — 생 EUC-KR 바이트 응답(레거시 스타일). */
    private MockResponse legacyEucKr(PgState st, MockRequest req) {
        String acctNo = req.bodyFields().getOrDefault("acctNo", "").replaceAll("[^0-9A-Za-z-]", "");
        String body = "resultCode=0000&approvalNo=" + (90_000_000 + st.seq.incrementAndGet())
                + "&custName=홍길동&acctNo=" + acctNo + "&amount="
                + req.bodyFields().getOrDefault("amount", "0");
        return new MockResponse(200, "application/x-www-form-urlencoded; charset=EUC-KR", Map.of(),
                body.getBytes(EUC_KR), 0, null);
    }

    /** 수신 Content-Type 에코 — MS949 요청의 windows-949 charset 부착 확인용. */
    private MockResponse legacy949(MockRequest req) {
        String ct = req.header("content-type");
        String body = MockHttp.toUrlEncoded(List.of(
                Map.entry("resultCode", "0000"),
                Map.entry("recvContentType", ct == null ? "" : ct)));
        return MockResponse.of(200, "application/x-www-form-urlencoded; charset=UTF-8",
                body.getBytes(StandardCharsets.UTF_8));
    }

    private MockResponse legacyXml(PgState st) {
        String xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><pg><resultCode>0000</resultCode><tid>XMLTID-"
                + st.seq.incrementAndGet() + "</tid><resultMsg>성공</resultMsg></pg>";
        return MockResponse.of(200, "application/xml; charset=UTF-8", xml.getBytes(StandardCharsets.UTF_8));
    }

    private MockResponse legacyUrlenc(PgState st, MockRequest req) {
        String body = MockHttp.toUrlEncoded(List.of(
                Map.entry("resultCode", "0000"),
                Map.entry("tid", "LEGTID-" + st.seq.incrementAndGet()),
                Map.entry("amount", req.bodyFields().getOrDefault("amount", "1000"))));
        return MockResponse.of(200, "application/x-www-form-urlencoded; charset=UTF-8",
                body.getBytes(StandardCharsets.UTF_8));
    }

    /** 고정 전문 CANCEL|{tid}|{amount} → OK|{tid}|CANCELLED (bodyType=raw + 토큰 삽입 시나리오). */
    private MockResponse legacyRaw(MockRequest req) {
        String body = req.bodyText() == null ? "" : req.bodyText().trim();
        String[] parts = body.split("\\|");
        if (parts.length < 3 || !"CANCEL".equals(parts[0])) {
            return MockResponse.of(400, "text/plain; charset=UTF-8",
                    "ERR|FORMAT".getBytes(StandardCharsets.UTF_8));
        }
        return MockResponse.of(200, "text/plain; charset=UTF-8",
                ("OK|" + parts[1] + "|CANCELLED").getBytes(StandardCharsets.UTF_8));
    }

    private MockResponse legacyText(PgState st) {
        String text = "RESULT:OK APPROVAL_NO:" + (10_000_000 + st.seq.incrementAndGet()) + " DATE:20260704";
        return MockResponse.of(200, "text/plain; charset=UTF-8", text.getBytes(StandardCharsets.UTF_8));
    }

    private MockResponse legacyConfirm(MockRequest req) {
        String apprNo = req.bodyFields().getOrDefault("apprNo", "");
        if (apprNo.isBlank()) {
            return jsonRes(400, Map.of("resultCode", "7001", "resultMsg", "apprNo 가 없습니다"));
        }
        return jsonRes(200, Map.of("resultCode", "0000", "apprNo", apprNo));
    }

    /** Basic 인증(demo:demo1234) 필수 자원. */
    private MockResponse secure(MockRequest req) {
        String auth = req.header("authorization");
        String expected = "Basic " + java.util.Base64.getEncoder()
                .encodeToString("demo:demo1234".getBytes(StandardCharsets.UTF_8));
        if (!expected.equals(auth)) {
            return jsonRes(401, Map.of("resultCode", "8001", "resultMsg", "인증 필요(Basic demo:demo1234)"));
        }
        return jsonRes(200, Map.of("resultCode", "0000", "resultMsg", "인증됨", "grade", "VIP"));
    }

    private MockResponse routesInfo() {
        return jsonRes(200, Map.of(
                "kind", "PG",
                "endpoints", List.of(
                        "GET|POST /auth (결제창)", "POST /auth/confirm", "POST /approve", "POST /keyin",
                        "POST /billkey", "POST /billkey/approve", "POST /billkey/delete",
                        "POST /cancel", "GET /tx?tid=", "POST /va", "GET /va/status?acctNo=",
                        "POST /legacy/euckr", "POST /legacy/949", "GET /legacy/xml", "POST /legacy/urlenc",
                        "POST /legacy/raw", "GET /legacy/text", "POST /legacy/confirm", "GET /secure")));
    }

    // ---------- 헬퍼 ----------

    private void fireNoti(String notiUrl, List<Map.Entry<String, String>> pairs) {
        if (notiUrl == null || notiUrl.isBlank()) {
            return;
        }
        dispatcher.fire(new FiredCallback(300, notiUrl, "POST",
                "application/x-www-form-urlencoded; charset=UTF-8",
                MockHttp.toUrlEncoded(pairs), true));
    }

    private MockResponse jsonRes(int status, Map<String, ?> body) {
        return MockResponse.of(status, "application/json; charset=UTF-8",
                json.toJson(body).getBytes(StandardCharsets.UTF_8));
    }

    private MockResponse htmlRes(int status, String html) {
        return MockResponse.of(status, "text/html; charset=UTF-8", html.getBytes(StandardCharsets.UTF_8));
    }

    private static long parseAmount(String s) {
        try {
            return Long.parseLong(s == null ? "" : s.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    static String sha256Hex(String in) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(in.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String hiddenInputs(Map<String, String> fields) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : fields.entrySet()) {
            if (e.getValue() == null || e.getValue().isEmpty()) {
                continue;
            }
            sb.append("<input type=\"hidden\" name=\"").append(MockHttp.escapeHtml(e.getKey()))
                    .append("\" value=\"").append(MockHttp.escapeHtml(e.getValue())).append("\">");
        }
        return sb.toString();
    }

    private static String pgShell(String title, String inner) {
        return """
                <!doctype html><meta charset="utf-8"><title>%s</title><style>
                body{font-family:'Segoe UI',sans-serif;background:#f3f4f8;margin:0;padding:24px;color:#1f2430}
                .card{max-width:400px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(30,40,80,.12);overflow:hidden}
                .head{background:#0f766e;color:#fff;padding:16px 22px;font-weight:700;font-size:15px}
                .body{padding:22px}
                .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #eef0f5;font-size:13.5px}
                .amt{font-size:20px;color:#0f766e}
                .btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px}
                button{width:100%%;padding:13px 0;border:none;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer}
                .ok{background:#0f766e;color:#fff}.no{background:#eef0f5;color:#5a6072}
                .note{margin-top:14px;font-size:11.5px;color:#9aa1b2;text-align:center}
                </style><div class="card"><div class="head">%s</div><div class="body">%s</div></div>
                """.formatted(MockHttp.escapeHtml(title), MockHttp.escapeHtml(title), inner);
    }
}
