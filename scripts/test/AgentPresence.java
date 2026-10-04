// Direct WebSocket presence regression. No MCP or IDE calls.
import java.net.URI;
import java.net.http.*;
import java.util.concurrent.*;

class AgentPresence {
    static class Listener implements WebSocket.Listener {
        final BlockingQueue<String> messages = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        final StringBuilder text = new StringBuilder();
        public void onOpen(WebSocket ws) { ws.request(1); }
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            text.append(data);
            if (last) { messages.add(text.toString()); text.setLength(0); }
            ws.request(1); return null;
        }
        public CompletionStage<?> onClose(WebSocket ws, int code, String reason) { closed.complete(code); return null; }
        String receive(String expected) throws Exception {
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (System.nanoTime() < end) {
                String message = messages.poll(1, TimeUnit.SECONDS);
                if (message != null && message.contains(expected)) return message;
            }
            throw new AssertionError("No presence message: " + expected);
        }
    }
    static void check(boolean value, String name) { if (!value) throw new AssertionError(name); System.out.println("PASS " + name); }
    public static void main(String[] args) throws Exception {
        String base = System.getenv("FLOWLINK_URL"), token = System.getenv("FLOWLINK_LOCAL_TOKEN");
        String flow = System.getenv("FLOWLINK_FLOW_ID");
        if (!URI.create(base).getHost().equals("127.0.0.1")) throw new IllegalArgumentException("Isolated loopback runtime required");
        HttpClient client = HttpClient.newHttpClient();
        URI uri = URI.create(base.replace("http:", "ws:") + "/remote/ws/presence?flowId=" + flow + "&name=presence-test");
        try {
            client.newWebSocketBuilder().header("Origin", base).buildAsync(uri, new Listener()).join();
            throw new AssertionError("Unauthenticated WebSocket accepted");
        } catch (CompletionException e) { check(e.getCause() instanceof WebSocketHandshakeException, "unauthenticated presence rejected"); }
        Listener a = new Listener(), b = new Listener();
        WebSocket one = client.newWebSocketBuilder().header("Origin", base).header("X-FlowLink-Local", token).buildAsync(uri, a).join();
        WebSocket two = null;
        try {
            a.receive("\"t\":\"hello\"");
            two = client.newWebSocketBuilder().header("Origin", base).header("X-FlowLink-Local", token).buildAsync(uri, b).join();
            check(b.receive("\"t\":\"hello\"").contains("lab-admin"), "remote room authenticated through app session");
            two.sendText("{\"t\":\"editing\",\"nodeId\":\"presence-check\"}", true).join();
            a.receive("presence-check"); check(true, "editing message forwarded in both directions");
            HttpResponse<String> logout = client.send(HttpRequest.newBuilder(URI.create(base + "/api/v1/desktop/logout"))
                .header("X-FlowLink-Local", token).POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
            check(logout.statusCode() == 200 && a.closed.get(10, TimeUnit.SECONDS) == 1000, "logout closes remote presence");
        } finally {
            one.abort(); if (two != null) two.abort();
            // Restore the lab login for browser verification.
            for (String path : new String[]{"/api/v1/desktop/login/start", "/api/v1/desktop/login/poll"}) {
                HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + path)).header("X-FlowLink-Local", token);
                if (path.endsWith("start")) request.POST(HttpRequest.BodyPublishers.noBody());
                check(client.send(request.build(), HttpResponse.BodyHandlers.ofString()).statusCode() == 200, "lab login restored");
            }
        }
    }
}
