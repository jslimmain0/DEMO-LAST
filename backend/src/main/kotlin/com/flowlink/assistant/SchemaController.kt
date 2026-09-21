package com.flowlink.assistant

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

/**
 * 스키마 레퍼런스 공개 — 어시스턴트 시스템 프롬프트(플로우/Mock/프로토콜 JSON 규격)를 외부 에이전트(MCP)도 같은 원문으로 읽는다.
 * 비밀 없음(규격 설명뿐)이라 무인증. 규격이 바뀌면 프롬프트 하나만 고치면 앱 AI 와 MCP 가 같이 따라온다.
 */
@RestController
class SchemaController {
    @GetMapping("/api/v1/schemas")
    fun schemas(): Map<String, String> = mapOf(
        "flow" to FlowSchemaPrompt.SYSTEM,
        "mock" to MockSchemaPrompt.SYSTEM,
        "protocol" to ProtocolSchemaPrompt.SYSTEM,
        "rules" to AGENT_RULES,
        "plugin" to pluginGuide(),
    )

    /** 스크립트 플러그인 작성 규격 — 화면 편집기와 MCP 가 같은 원문. fl 매니페스트는 코드에서 생성(추가 시 자동 반영). */
    private fun pluginGuide(): String = buildString {
        append(PLUGIN_GUIDE)
        append("\n## fl.* 헬퍼\n")
        for (e in com.flowlink.plugin.script.FlApi.MANIFEST) append("- `${e.signature}` — ${e.doc}. 예: `${e.example}`\n")
    }

    companion object {
        /** 스크립트 플러그인 작성 규격 — 화면 편집기와 MCP 가 같은 원문. fl 매니페스트는 코드에서 생성(추가 시 자동 반영). */
        const val PLUGIN_GUIDE: String = """
# 스크립트 플러그인(JS) 작성 규격
스크립트의 **마지막 표현식이 플러그인 객체**다. 샌드박스: 표준 JS + `fl.*` 만(Java/파일/네트워크 없음), 호출당 2초.
저장: 화면(/plugins) 또는 MCP plugin_script_upsert(초안) → plugin_script_try(시험) → plugin_script_submit(승인 요청) → **관리자 승인(화면)** 후에만 레지스트리에 올라간다.
승인 전 그 id 를 쓰는 TRANSFORM 노드·코덱은 실행 시 실패하므로 옆에 메모 노드로 '플러그인 승인 필요' 를 남긴다.
승인 요청 뒤: 사용자에게 '승인 대기 중 — 관리자 승인 필요' 라고 알리고 plugin_script_wait 로 기다린다. 승인되면 사용자에게 다시 알리고 이어서 배선, 반려면 사유를 전하고 초안을 고쳐 재요청.
예제: 화면 '예제에서 시작…' 에 레거시 des-cipher 포팅(des-encrypt/des-decrypt — DES/ECB, zero 패딩, hex)이 있다. 키를 hex/base64 로 받으면 `fl.hex.dec(k, { as: 'bytes' })` 로 바이트 키를 넘긴다.

## 암복호화·해시·서명이 필요하면 값을 지어내지 말고 플러그인을 쓴다 — 붙이는 자리는 셋
| 어디에 | 무엇을 | kind | 붙이는 법 |
|---|---|---|---|
| 전문의 **필드 하나**(카드번호·계좌번호…) | 그 필드 값만 암복호/마스킹 | `fieldCodec` | 프로토콜 spec 의 `Field.plugin = { id, config }` (protocol_upsert) |
| 전문 **본문 전체** | 본문 bytes 통째 암복호(헤더는 평문, 길이 계산 전) | `messageCodec` | 프로토콜 spec 의 `messagePlugins: [{ id, config }]` |
| **Mock 코덱 단계** | 요청이 매칭에 들어가기 전 / 응답이 나가기 전 | `transform` | Mock spec 의 `codec.request[]` · `codec.response[]` (target: body/fields/header) |
| **워크플로 값 변환** | 노드 사이에서 값 하나를 바꿈 | `transform` | TRANSFORM 노드의 `transformId` + 입력 포트 |
쓸 수 있는 id 는 plugin_list(승인본만). 필요한 게 없으면 **만들어라**: plugin_script_upsert(초안) → plugin_script_try(시험) → plugin_script_submit(승인 요청) → plugin_script_wait(결과).
키·IV 는 스크립트에 박지 말고 파라미터로 받아 `{{ 이름@secret }}`·`{{ 키@env }}` 로 채운다(서버가 실행 환경으로 푼다).

## 모르면 묻는다 — 추측이 제일 비싸다
암호 규격은 코드로 알 수 없다. 막히는 그 순간 짧게 1~2개만 물어라(한꺼번에 설문지처럼 묻지 말 것):
알고리즘·모드·패딩(AES-CBC/PKCS5? SEED? 레거시 DES zero 패딩?) · 키/IV 를 어디서 받나(시크릿 이름) · 키 인코딩(utf8/hex/base64) ·
입출력 인코딩(base64/hex) · 대상 범위(필드 하나인지 본문 전체인지) · 문자셋(EUC-KR?).
답을 기다리는 동안에는 파라미터와 `{{ 이름@secret }}` 토큰으로 자리를 비워 두고 뼈대를 만들어 둔다 — 값은 지어내지 않는다.

변환(transform):  ({ id, label, description?, inputs?: [{key,label,type?}], outputs?: [{key,label,type?}], params?: [{key,label,type?,defaultValue?,options?,placeholder?}], apply(inputs, config) { return { 출력키: 값 } } })
필드 코덱:        ({ id, label, kind: 'fieldCodec', params?, encode(value, ctx) { return 문자열 }, decode(value, ctx) { return 문자열 } })
전문 코덱:        ({ id, label, kind: 'messageCodec', params?, encode(bytes, ctx) { return 바이트배열 }, decode(bytes, ctx) { return 바이트배열 } })
ctx = { config, direction: 'send'|'recv', field: {name,len,type,pad}|null, message: {필드명: 값} }. id 는 [a-z0-9-] 1~64자(소문자·숫자·하이픈, 첫 글자는 하이픈 불가).
입력·파라미터 값에는 `{{ 이름@secret }}`(시크릿 볼트)·`{{ 키@env }}`(환경 변수)를 쓸 수 있다 — 워크플로는 실행 환경, Mock 은 spec.environment, 프로토콜 미리보기·시험 실행(plugin_script_try)은 environment 인자의 환경으로 서버가 푼다. 비밀·환경별 값은 직접 적지 말고 토큰으로.
"""

        /** 에이전트가 소스 코드에서 워크플로/프로토콜/Mock 을 만들 때 지킬 규약 — 코드에 없는 값은 지어내지 않는다. */
        const val AGENT_RULES: String = """
# FlowLink 에이전트 규약
1. 코드에서 확인되지 않는 값(계좌번호·키·유효한 시나리오 순서)은 지어내지 않는다. 값 자리는 토큰으로 비워 둔다:
   - 환경마다 다른 값 → {{ 키@env }} (env_put 으로 환경 변수 등록 가능)
   - 비밀 → {{ 이름@secret }} (시크릿 볼트는 사용자가 화면에서 채운다)
   - 실행 도중 사람이 넣는 값(OTP·인증번호·승인번호) → **input 노드**(실행이 거기서 멈추고 폼이 뜬다, MCP 는 execution_resume 으로 값 전달) → {{ 키@입력노드id }}
   - 실행을 시작할 때 한 번 주는 값 → flow_run 의 input → {{ 키@input }}
   토큰만 꽂아 놓고 끝내지 말고 **채워 달라고 요청하고 기다린다**: 시크릿은 MCP 로 값을 저장할 수 없으니 "시크릿 볼트에 <이름> 을 넣어 주세요(화면 ⚙ → 시크릿)" 라고 이름·용도를 찍어 말한다.
   환경 변수는 env_put 으로 만들 수 있지만 **값은 사용자에게 받는다** — 이름만 정해 묻고 답이 오면 넣는다. 테스트용 임시 키·더미 주소·샘플 계좌번호로 대신 채우고 "됐다" 고 하지 마라(그 값으로 돈 실행은 거짓 성공이다).
   그 값이 없어도 되는 나머지 작업은 계속 진행하고, 무엇을 기다리는지 한 줄로 남긴다.
2. 확인이 필요한 자리마다 옆에 note(메모) 노드를 두고 "확인 필요: …" 로 적는다. 사용자는 워크플로 페이지에서 메모만 훑는다.
3. 외부 시스템 호출(대외 전문·타 서비스 API)은 Mock 으로 먼저 세운다: TCP 는 protocol_upsert → mock_upsert(type=TCP, protocolId) → 워크플로 TCP 노드의 host:port 를 mock 으로,
   HTTP 는 mock_upsert(type=HTTP) → HTTP 노드 baseUrl 을 mock base URL 로.
4. 만든 뒤 반드시 실행·확인한다. 워크플로는 flow_run(실패 시 execution_get / mock_log 로 원인). Mock 은 HTTP=http_request 로
   그 mock 의 base URL+경로를 호출해 응답을 보고, TCP=mock_send 로 전문을 보낸다. wait 콜백·웹훅도 http_request 로 쏜다.
   **curl·파이썬·셸로 직접 쏘지 말고 http_request/mock_send 를 써라**(그게 이 서버에 붙어 있는 경로다). 결과는 "돌아가는 초안 + 확인 목록(메모)".
5. 워크플로에는 START 와 END 가 있어야 하고, 검증은 assert 노드(예: {{ 응답코드@노드 }} == '0000')로 남긴다.
6. 암복호화·해시·서명·마스킹은 **플러그인**으로 한다(직접 계산한 값을 전문에 박지 마라). 붙는 자리: 프로토콜 필드 하나=`Field.plugin`(fieldCodec) ·
   전문 본문 전체=`messagePlugins`(messageCodec) · Mock 코덱 단계=`codec.request/response`(transform) · 워크플로=TRANSFORM 노드 `transformId`(transform).
   plugin_list 로 사용 가능한 플러그인 id·파라미터를 먼저 확인한다.
   목록에 없는 id 는 지어내지 않는다. 필요한 변환이 없으면 plugin_script_upsert 로 초안을 만들고 plugin_script_try 로 검증한 뒤 plugin_script_submit 으로 승인 요청한다(규격은 flowlink_guide(plugin)).
   승인은 관리자(사람)가 화면에서 하므로, 승인 전에는 그 id 를 쓰는 노드 옆에 메모 노드로 '플러그인 승인 필요' 를 남긴다.
   승인 요청 뒤엔 사용자에게 승인 대기 중임을 알리고 plugin_script_wait 로 결과를 기다려 승인/반려를 다시 알린다.
7. 모르면 그때그때 묻는다 — 추측해서 만든 전문·암호 규격은 전부 다시 만들어야 한다. 막힌 것만 1~2개 짧게 물어라
   (알고리즘·모드·패딩 / 키·IV 를 담을 시크릿 이름 / 키·출력 인코딩 / 적용 범위(필드 vs 전문) / 문자셋 / 거래코드·필드 자릿수).
   답을 기다리는 동안에도 멈추지 말고, 값 자리는 `{{ 이름@secret }}`·`{{ 키@env }}` 토큰과 note 노드로 비워 둔 채 뼈대를 만들어 둔다.
8. 막히면 억지로 뚫지 않는다 — 같은 곳에서 두 번 실패하면 멈추고 보고한 뒤 입력을 기다린다.
   **사용자 소스 코드는 고치지 않는다.** 전문이 안 맞거나 응답이 이상하면 소스가 틀렸을 수도 있지만, 그건 사용자가 판단할 몫이다(고치라는 지시가 있을 때만 고친다).
   "일단 되게" 만드는 우회도 금지: 규격 임의 변경, assert·검증 삭제/완화, 실패를 무시하는 기본값, 하드코딩한 응답으로 덮기.
   보고는 네 줄이면 된다 — 하려던 것 / 막힌 지점(에러 원문·실행 id·mock 로그 같은 증거) / 원인 후보 1~2개 / 사용자가 결정해 줄 것.
   막힌 것 말고 남은 작업은 계속 진행해도 된다(막힌 자리는 note 노드로 표시).
"""
    }
}
