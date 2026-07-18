package com.flowlink.assistant

/**
 * 코드 내장 스킬 = 흔한 **플로우 조각**(재사용 building block). 그래프 JSON 문자열로 정의하고
 * SkillService 가 파싱해 제공한다. 캔버스 삽입·AI 조합에 쓰인다.
 */
object BuiltinSkills {

    /** 파싱 전 원형 — (id, name, description, nodeTypes, graphJson). */
    data class Raw(val id: String, val name: String, val description: String, val nodeTypes: List<String>, val graphJson: String)

    val RAW: List<Raw> = listOf(
        Raw("bi-oauth", "OAuth2 인증 호출", "OAuth2 client_credentials 로 보호된 API 호출", listOf("http"),
            """{"nodes":[
              {"id":"oauthcall","name":"보호 API 호출","type":"http","cat":"generic","x":80,"y":80,
               "method":"GET","baseUrl":"https://api.example.com","path":"/me","bodyType":"json","respType":"json","reqMode":"server","charset":"UTF-8",
               "auth":{"type":"oauth2_cc","tokenUrl":"https://idp.example.com/oauth/token","clientId":"my-client","clientSecret":"{{ CLIENT_SECRET@secret }}","scope":"read","clientAuth":"body"},
               "fields":{"params":[],"headers":[],"body":[]},"outputs":[{"key":"data","type":"object"}]}
            ],"edges":[]}"""),
        Raw("bi-pay", "결제창 + 콜백", "결제창(폼 팝업) → 콜백 대기 → 승인 여부 분기", listOf("form", "wait", "if"),
            """{"nodes":[
              {"id":"payform","name":"결제창 열기","type":"form","cat":"form","x":80,"y":80,"formAction":"https://pg.example.com/pay","formMethod":"POST","formDisplay":"popup",
               "fields":{"params":[],"headers":[],"body":[{"id":"b1","key":"returnUrl","value":"{{ url@paywait }}"}]},"outputs":[]},
              {"id":"paywait","name":"결제 콜백 대기","type":"wait","cat":"wait","x":300,"y":80,"waitTimeoutSec":180,"callbackRespType":"html","callbackRespBody":"<h2>결제 완료</h2>","outputs":[{"key":"resultCode","type":"string"},{"key":"tid","type":"string"}]},
              {"id":"payif","name":"승인 여부","type":"if","cat":"if","x":520,"y":80,"condition":"{{ resultCode@paywait }} == '0000'"}
            ],"edges":[{"id":"pe1","from":"payform","to":"paywait"},{"id":"pe2","from":"paywait","to":"payif"}]}"""),
        Raw("bi-otp", "OTP 입력 + 검증", "사용자 OTP 입력 → 값 검증 분기", listOf("input", "if"),
            """{"nodes":[
              {"id":"otpin","name":"OTP 입력","type":"input","cat":"input","x":80,"y":80,"waitMsg":"OTP 6자리를 입력하세요","waitFields":[{"id":"w1","key":"otp","label":"OTP","type":"string"}]},
              {"id":"otpif","name":"OTP 검증","type":"if","cat":"if","x":300,"y":80,"condition":"{{ otp@otpin }} == '123456'"}
            ],"edges":[{"id":"oe1","from":"otpin","to":"otpif"}]}"""),
        Raw("bi-tcp", "TCP 전문 왕복", "고정길이 TCP 전문 송수신 → 결과 검증", listOf("tcp", "assert"),
            """{"nodes":[
              {"id":"tcpsend","name":"전문 전송","type":"tcp","cat":"tcp","x":80,"y":80,"tcpHost":"127.0.0.1","tcpPort":9000,"tcpEncoding":"EUC-KR","tcpTimeoutMs":5000,"tcpPrefixLength":4,"tcpPrefixIncludesSelf":false,
               "tcpRequest":[{"id":"r1","name":"msgType","length":4,"value":"0012","pad":"right","padChar":" "}],"tcpResponse":[{"id":"o1","name":"result","length":4}],"outputs":[{"key":"result","type":"string"}]},
              {"id":"tcpasrt","name":"결과 검증","type":"assert","cat":"assert","x":300,"y":80,"condition":"{{ result@tcpsend }} == '0000'"}
            ],"edges":[{"id":"te1","from":"tcpsend","to":"tcpasrt"}]}"""),
        Raw("bi-status", "HTTP 상태 검증", "호출 결과의 httpStatus 를 assert 로 검증", listOf("http", "assert"),
            """{"nodes":[
              {"id":"stcall","name":"API 호출","type":"http","cat":"generic","x":80,"y":80,"method":"GET","baseUrl":"https://api.example.com","path":"/ping","bodyType":"json","respType":"json","reqMode":"server","charset":"UTF-8","fields":{"params":[],"headers":[],"body":[]},"outputs":[{"key":"data","type":"object"}]},
              {"id":"stasrt","name":"상태 200 검증","type":"assert","cat":"assert","x":300,"y":80,"condition":"{{ httpStatus@stcall }} == 200"}
            ],"edges":[{"id":"se1","from":"stcall","to":"stasrt"}]}"""),
    )
}
