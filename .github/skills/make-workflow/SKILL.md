---
name: make-workflow
description: 자연어 설명을 FlowLink 워크플로(노드 그래프)로 변환해 REST API로 등록한다. 사용자가 "~하는 워크플로 만들어줘", "결제창 띄우고 콜백 받아 검증하는 플로우 짜줘", "로그인해서 주문 넣는 워크플로" 같이 FlowLink 워크플로 생성을 요청할 때 사용.
---

# FlowLink 워크플로 생성

사용자가 말로 설명한 흐름을 FlowLink 노드 그래프(JSON)로 만들고 API로 등록한다.

## 절차

1. **요청 이해** — 사용자 설명에서 흐름을 뽑아낸다:
   - 노드 시퀀스(무엇을 순서대로), 분기(조건), 외부 호출(HTTP), 사람 개입(결제창 form / 사용자 입력 input), 콜백 수신(wait), 검증(assert).
   - 애매하면 핵심만 1~2개 되묻는다(대상 URL, 성공 조건 등). 과하게 묻지 말 것.

2. **백엔드 확인** — 등록/실행 전 백엔드가 떠 있는지: `curl -s http://localhost:18080/actuator/health`. 없으면 사용자에게 실행을 안내(`scripts\start.ps1 -H2`).

3. **그래프 설계** — [reference/nodes.md](reference/nodes.md)(노드 타입별 필드)와 [reference/graph-and-tokens.md](reference/graph-and-tokens.md)(엣지·토큰·패턴)를 근거로 노드/엣지를 정한다. 핵심 규칙:
   - 모든 노드에 고유 `id`(영숫자 8자 권장). 토큰 `@`는 **노드 이름이 아니라 그 `id`**.
   - **http의 `cat`은 `"generic"`**, 나머지는 type과 같은 값.
   - **IF 분기 엣지에만** `fromPort:"true"`/`"false"`. 나머지 엣지는 생략.
   - **결제/인증 콜백 패턴**: `form`(결제창, 콜백필드 값 = `{{ url@wait노드id }}`) → `wait`(콜백 대기, `outputs`에 콜백 키 선언) → `assert`/`if`(`{{ resultCode@wait노드id }}` 판정). form은 팝업(기본) 또는 `formDisplay:"iframe"`.
   - HTTP 응답을 다음 노드에서 쓰려면 그 http에 `outputs:[{key}]` 선언 후 `{{ key@httpid }}`.
   - 좌표 x는 왼→오(예 40,260,480,700…), y는 대략 고정. (미관용, 실행 무관)

4. **JSON 작성 & 등록** — `{ name, nodes, edges }` 그래프를 파일(또는 stdin)로 만들어 헬퍼로 등록:
   ```bash
   node .github/skills/make-workflow/scripts/register-flow.mjs /path/to/graph.json
   # 옵션: --import(한 방 v1) · --run(저장+실행) · --base <url> · --name <이름>
   ```
   출력의 `flowId`·`editorUrl`을 사용자에게 알린다. 상세 API는 [reference/api.md](reference/api.md).

5. **결과 안내** — 등록된 워크플로 이름·노드 구성·`editorUrl`(에디터에서 열어 ▶ 실행)을 요약.
   - 브라우저 협업 노드(form/wait/input)가 있으면 API 단독 실행은 WAITING에서 멈추므로, **에디터에서 ▶ 실행**해야 팝업·콜백·입력을 거쳐 완결됨을 안내한다.

## 주의

- SpEL 조건(if/assert)은 읽기전용 샌드박스 — 비교·논리·산술·문자열 `+`만. `.contains()`/`.startsWith()` 불가.
- wait 콜백은 백엔드가 `/relay/{execId}/cb/{nodeId}` 로 직접 받아 자동 재개한다(별도 relay 프로세스 불필요). Mock 대상이 필요하면 내장 Mock 서버(`/mock/{slug}/**`, 상단 "Mock 서버" 탭)를 활용.
- 그래프 검증 실패(중복 id, 없는 노드 참조 등)는 saveVersion이 400으로 거절 — 에러 메시지를 보고 그래프를 고친다.
