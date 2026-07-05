---
mode: agent
description: 자연어 설명을 FlowLink 워크플로(노드 그래프)로 만들어 REST API로 등록한다.
---

# FlowLink 워크플로 생성

사용자가 말로 설명한 흐름을 FlowLink 노드 그래프(JSON)로 만들고 API로 등록한다.

## 참조 (정확한 스키마 — 반드시 근거로 삼을 것)
- #file:../../flowlink-workflow/skills/make-workflow/reference/nodes.md — 10개 노드 타입별 필드
- #file:../../flowlink-workflow/skills/make-workflow/reference/graph-and-tokens.md — 그래프 구조·엣지·토큰·패턴
- #file:../../flowlink-workflow/skills/make-workflow/reference/api.md — 등록/실행 API

## 절차
1. **요청 이해** — 흐름을 뽑는다: 노드 시퀀스, 분기(조건), 외부 호출(http), 사람 개입(결제창 form / 사용자 입력 input), 콜백 수신(wait), 검증(assert). 애매하면 핵심(대상 URL, 성공 조건)만 1~2개 되묻는다.
2. **백엔드 확인** — `curl -s http://localhost:18080/actuator/health` (없으면 `scripts\start.ps1 -H2` 안내).
3. **그래프 설계** — 위 참조로 노드/엣지 결정. 규칙:
   - 노드마다 고유 `id`(영숫자 8자). 토큰 `{{ key@id }}`의 `@` 뒤는 **노드 `id`**(이름 아님).
   - http의 `cat`은 `"generic"`, 나머지는 `type`과 같은 값.
   - **IF 분기 엣지에만** `fromPort:"true"`/`"false"`, 나머지 엣지는 생략.
   - 콜백 패턴: `form`(콜백필드=`{{ url@wait }}`) → `wait`(`outputs` 선언) → `assert`/`if`(`{{ resultCode@wait }}`).
   - http 응답 재사용: 그 http에 `outputs:[{key}]` → `{{ key@httpid }}`.
4. **작성 & 등록** — `{ name, nodes, edges }` JSON을 파일로 저장 후:
   ```bash
   node flowlink-workflow/skills/make-workflow/scripts/register-flow.mjs graph.json
   # 옵션: --import(한 방) · --run(저장+실행) · --base <url> · --name <이름>
   ```
5. **결과 안내** — 워크플로 이름·노드 구성·`editorUrl`(에디터에서 ▶ 실행)을 요약. 브라우저 협업 노드(form/wait/input)가 있으면 에디터에서 실행해야 팝업·콜백·입력이 완결됨을 알린다.

## 대표 패턴
- **결제창→콜백→검증**: `start → set(주문) → form(결제창, returnUrl={{ url@wait0001 }}) → wait(콜백, outputs resultCode/tid) → assert({{ resultCode@wait0001 }} == '0000') → end`
- **로그인→인증호출**: `start → http(로그인, outputs token) → http(주문, 헤더 "Bearer {{ token@httplogn }}") → end`
- **OTP 입력→검증→분기**: `start → http(발송) → input(waitFields otp) → http(검증, body otp={{ otp@input001 }}, outputs verified) → if({{ verified@httpverf }} == true)` → 성공/실패

주의: SpEL 조건은 비교·논리·산술·문자열 `+`만(`.contains()`/`.startsWith()` 불가). 그래프 검증 실패(중복 id, 없는 노드 참조)는 등록이 400으로 거절하니 에러 보고 수정.
