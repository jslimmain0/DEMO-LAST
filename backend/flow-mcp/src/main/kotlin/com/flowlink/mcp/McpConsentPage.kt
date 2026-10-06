package com.flowlink.mcp

import org.springframework.web.util.HtmlUtils

/** SAS validates the submitted state and owns approval/cancellation and consent storage. */
internal object McpConsentPage {
    fun render(clientName: String, login: String, clientId: String, state: String, contextPath: String): String {
        fun escape(value: String) = HtmlUtils.htmlEscape(value)
        val fields = """<input type="hidden" name="client_id" value="${escape(clientId)}"><input type="hidden" name="state" value="${escape(state)}">"""
        val action = escape("$contextPath/authorize")
        return """<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlowLink 연결 허용</title>
<style>body{margin:0;background:#0f1115;color:#eef1f6;font:16px/1.6 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}.card{box-sizing:border-box;width:min(480px,calc(100% - 32px));padding:32px;background:#1b1e25;border:1px solid #343944;border-radius:20px}h1{font-size:24px;margin:8px 0 20px}.brand,.account{color:#aab4c4;font-size:14px}strong{overflow-wrap:anywhere}.permissions{padding:16px;background:#11151b;border-radius:12px}.actions{display:flex;gap:12px;margin-top:24px}.actions form{flex:1}button{width:100%;border:1px solid #4c5565;border-radius:10px;padding:12px;color:#eef1f6;background:#262c36;font:inherit;cursor:pointer}.approve{background:#6876e8;border-color:#6876e8}button:focus-visible{outline:3px solid #b4c3ff;outline-offset:3px}</style></head>
<body><main class="card"><div class="brand">FlowLink · MCP 연결</div><h1>이 앱의 연결을 허용할까요?</h1><p><strong>${escape(clientName)}</strong>에서 FlowLink 계정 접근을 요청했습니다.</p><p class="account">로그인 계정: <strong>${escape(login)}</strong></p><div class="permissions">허용하면 이 계정의 권한 범위 안에서 워크스페이스·워크플로·환경·Mock을 조회하거나 관리하고 워크플로를 실행할 수 있습니다.</div><p>등록된 앱 이름만으로 신뢰할 수 있는 앱인지 보장되지는 않습니다. 연결하려던 앱이 맞는지 확인하세요.</p><div class="actions"><form method="post" action="$action">$fields<button type="submit">취소</button></form><form method="post" action="$action">$fields<input type="hidden" name="scope" value="flowlink"><button type="submit" class="approve">연결 허용</button></form></div></main></body></html>"""
    }
}
