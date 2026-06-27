package com.flowlink.execution.engine;

import com.flowlink.common.json.JsonService;
import com.flowlink.core.graph.GraphNode;
import com.flowlink.core.graph.TcpField;
import com.flowlink.core.graph.TcpRespField;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 고정길이 금융 전문 TCP 노드 실행기.
 * 요청 필드를 바이트 단위 고정길이로 조립해 길이-프리픽스 전문으로 전송하고,
 * 응답 전문을 응답 필드 길이대로 잘라 출력으로 만든다. (인코딩 노드/필드별 선택)
 */
@Component
public class TcpNodeExecutor {

    private final TokenResolver tokens;
    private final SsrfGuard ssrfGuard;
    private final JsonService json;

    public TcpNodeExecutor(TokenResolver tokens, SsrfGuard ssrfGuard, JsonService json) {
        this.tokens = tokens;
        this.ssrfGuard = ssrfGuard;
        this.json = json;
    }

    public NodeResult execute(GraphNode node, ExecutionContext ctx) {
        String host = tokens.resolveTokens(node.tcpHost() == null ? "" : node.tcpHost(), ctx);
        int port = node.tcpPort() == null ? 0 : node.tcpPort();
        Charset nodeCs = charset(node.tcpEncoding(), Charset.forName("EUC-KR"));
        int timeout = node.tcpTimeoutMs() == null || node.tcpTimeoutMs() <= 0 ? 5000 : node.tcpTimeoutMs();
        int prefixLen = node.tcpPrefixLength() == null ? 0 : node.tcpPrefixLength();
        boolean includesSelf = Boolean.TRUE.equals(node.tcpPrefixIncludesSelf());

        // 1) 요청 전문 본문 조립(바이트 고정길이)
        Map<String, Object> reqValues = new LinkedHashMap<>();
        java.io.ByteArrayOutputStream bodyBuf = new java.io.ByteArrayOutputStream();
        for (TcpField f : node.tcpRequest() == null ? List.<TcpField>of() : node.tcpRequest()) {
            String v = resolveField(f, ctx);
            if (f.name() != null && !f.name().isBlank()) {
                reqValues.put(f.name(), v);
            }
            Charset cs = charset(f.encoding(), nodeCs);
            byte[] field = fixedField(v, f.lengthOrZero(), f.pad(), f.padChar(), cs);
            bodyBuf.writeBytes(field);
        }
        byte[] body = bodyBuf.toByteArray();

        // 2) 길이 프리픽스
        byte[] message;
        if (prefixLen > 0) {
            int declared = includesSelf ? body.length + prefixLen : body.length;
            byte[] prefix = prefix(declared, prefixLen);
            byte[] m = new byte[prefix.length + body.length];
            System.arraycopy(prefix, 0, m, 0, prefix.length);
            System.arraycopy(body, 0, m, prefix.length, body.length);
            message = m;
        } else {
            message = body;
        }

        String reqText = "TCP " + host + ":" + port + " (" + nodeCs.name() + ", " + message.length + "B)\n" + printable(message, nodeCs);

        // 3) SSRF
        try {
            ssrfGuard.checkHostPort(host, port);
        } catch (SsrfBlockedException e) {
            return NodeResult.fail(0, reqText, "⚠ 차단됨(SSRF 가드): " + e.getMessage());
        }

        // 4) 송수신
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), timeout);
            socket.setSoTimeout(timeout);
            OutputStream out = socket.getOutputStream();
            out.write(message);
            out.flush();

            InputStream in = socket.getInputStream();
            byte[] respBody;
            if (prefixLen > 0) {
                byte[] pre = readN(in, prefixLen);
                int declared;
                try {
                    declared = Integer.parseInt(new String(pre, StandardCharsets.US_ASCII).trim());
                } catch (NumberFormatException e) {
                    return NodeResult.fail(0, reqText, "⚠ 응답 길이 프리픽스 파싱 실패: '" + new String(pre, StandardCharsets.US_ASCII) + "'");
                }
                int bodyLen = includesSelf ? declared - prefixLen : declared;
                if (bodyLen < 0) {
                    return NodeResult.fail(0, reqText, "⚠ 잘못된 응답 길이: " + declared);
                }
                respBody = readN(in, bodyLen);
            } else {
                respBody = in.readAllBytes();
            }

            // 5) 응답 슬라이싱 → 출력
            Map<String, Object> value = new LinkedHashMap<>();
            int offset = 0;
            for (TcpRespField rf : node.tcpResponse() == null ? List.<TcpRespField>of() : node.tcpResponse()) {
                int len = rf.lengthOrZero();
                int end = Math.min(offset + len, respBody.length);
                byte[] slice = Arrays.copyOfRange(respBody, Math.min(offset, respBody.length), end);
                String decoded = new String(slice, charset(rf.encoding(), nodeCs));
                if (rf.name() != null && !rf.name().isBlank()) {
                    value.put(rf.name(), decoded);
                }
                offset += len;
            }
            String resText = "응답 " + respBody.length + "B\n" + printable(respBody, nodeCs);
            return new NodeResult(true, null, reqText, resText, value, value, reqValues, null);
        } catch (Exception e) {
            return NodeResult.fail(0, reqText, "⚠ TCP 요청 실패: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    private String resolveField(TcpField f, ExecutionContext ctx) {
        if (f.bound() != null) {
            return tokens.stringify(tokens.resolveBinding(f.bound(), ctx));
        }
        String v = f.value();
        return (v != null && v.contains("{{")) ? tokens.resolveTokens(v, ctx) : (v == null ? "" : v);
    }

    private static byte[] readN(InputStream in, int n) throws java.io.IOException {
        byte[] buf = in.readNBytes(n);
        if (buf.length < n) {
            throw new java.io.IOException("응답이 조기 종료됨 (" + buf.length + "/" + n + " 바이트)");
        }
        return buf;
    }

    private static byte[] prefix(int declared, int width) {
        String s = String.format("%0" + width + "d", declared);
        byte[] b = s.getBytes(StandardCharsets.US_ASCII);
        if (b.length > width) {
            // 길이 오버플로 — 하위 width 자리만(방어적)
            return Arrays.copyOfRange(b, b.length - width, b.length);
        }
        return b;
    }

    private static byte[] fixedField(String value, int length, String pad, String padChar, Charset cs) {
        byte[] raw = (value == null ? "" : value).getBytes(cs);
        if (length <= 0) {
            return new byte[0];
        }
        if (raw.length == length) {
            return raw;
        }
        if (raw.length > length) {
            return Arrays.copyOf(raw, length); // 초과 시 절단
        }
        byte[] out = new byte[length];
        byte pb = padByte(padChar, cs);
        if ("left".equalsIgnoreCase(pad)) {
            int padCount = length - raw.length;
            Arrays.fill(out, 0, padCount, pb);
            System.arraycopy(raw, 0, out, padCount, raw.length);
        } else { // 기본 right
            System.arraycopy(raw, 0, out, 0, raw.length);
            Arrays.fill(out, raw.length, length, pb);
        }
        return out;
    }

    private static byte padByte(String padChar, Charset cs) {
        String p = (padChar == null || padChar.isEmpty()) ? " " : padChar;
        byte[] b = p.getBytes(cs);
        return b.length > 0 ? b[0] : (byte) ' ';
    }

    private static Charset charset(String name, Charset def) {
        if (name == null || name.isBlank()) {
            return def;
        }
        try {
            return Charset.forName(name);
        } catch (Exception e) {
            return def;
        }
    }

    private static String printable(byte[] bytes, Charset cs) {
        String s = new String(bytes, cs);
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            sb.append(c < 0x20 ? '.' : c);
        }
        return sb.toString();
    }
}
