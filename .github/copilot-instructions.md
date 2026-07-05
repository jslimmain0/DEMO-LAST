# FlowLink — GitHub Copilot 지침

REST API 워크플로 오케스트레이션 플랫폼. Backend: Spring Boot 3.3.5 / Kotlin (Java 21 toolchain) (`:18080`). Frontend: React 19 + Vite (`:5173`). UI 텍스트는 한국어.

프로젝트 전반 가이드는 [CLAUDE.md](../CLAUDE.md), [backend/README.md](../backend/README.md) 참조.

---

## 자연어로 워크플로 만들기

사용자가 **"~하는 워크플로 만들어줘"**(예: "결제창 띄우고 콜백 받아 승인 검증하는 플로우", "로그인해서 주문 넣는 워크플로", "OTP 발송하고 입력받아 검증")라고 하면, FlowLink **노드 그래프(JSON)**를 만들어 REST API로 등록한다.

전용 **Agent Skill**: `.github/skills/make-workflow/` — Copilot CLI·VS Code/JetBrains 에이전트 모드·클라우드 에이전트가 관련 요청 시 `SKILL.md`를 자동 로드한다(2025-12+ [Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)). Copilot Chat 슬래시 명령이 편하면 `/make-workflow`(`.github/prompts/make-workflow.prompt.md`)도 그대로 쓸 수 있다.

### 참조 스키마 (코드에서 추출된 정확한 스펙)
- 노드 타입별 필드: `flowlink-workflow/skills/make-workflow/reference/nodes.md`
- 그래프 구조·엣지·토큰 문법·패턴: `flowlink-workflow/skills/make-workflow/reference/graph-and-tokens.md`
- 등록/실행 REST API: `flowlink-workflow/skills/make-workflow/reference/api.md`
- 등록 헬퍼: `flowlink-workflow/skills/make-workflow/scripts/register-flow.mjs`

### 핵심 규칙
- 노드 타입: `start / end / set / if / assert / http / form / wait / input / transform`
- 모든 노드에 고유 `id`(영숫자 8자 권장). 토큰 `{{ key@id }}`의 `@` 뒤는 **노드 이름이 아니라 `id`**.
- **http의 `cat`은 `"generic"`**, 나머지는 `type`과 같은 값.
- **IF 분기 엣지에만** `fromPort:"true"`/`"false"`. 나머지 엣지는 생략(기본 `out`).
- 결제/인증 **콜백 패턴**: `form`(결제창, 콜백필드 값=`{{ url@wait노드id }}`) → `wait`(콜백 대기, `outputs`에 콜백 키 선언) → `assert`/`if`(`{{ resultCode@wait노드id }}` 판정). form 표시는 `formDisplay:"popup"`(기본)|`"iframe"`.
- HTTP 응답을 다음 노드에서 쓰려면 그 http에 `outputs:[{key}]` 선언 후 `{{ key@httpid }}`.
- SpEL 조건(if/assert)은 읽기전용 샌드박스 — 비교·논리·산술·문자열 `+`만(`.contains()`/`.startsWith()` 불가).

### 등록
```bash
# {name,nodes,edges} 그래프 JSON 을 만든 뒤:
node flowlink-workflow/skills/make-workflow/scripts/register-flow.mjs graph.json          # create+saveVersion
node flowlink-workflow/skills/make-workflow/scripts/register-flow.mjs graph.json --import # 한 방(v1)
node flowlink-workflow/skills/make-workflow/scripts/register-flow.mjs graph.json --run    # 저장+실행
# → { flowId, editorUrl } 출력. editorUrl 을 사용자에게 안내(에디터에서 ▶ 실행).
```
브라우저 협업 노드(form/wait/input)가 있으면 API 단독 실행은 WAITING에서 멈추므로 **에디터에서 ▶ 실행**해야 완결된다.

---

## 코드 컨벤션
- 백엔드 패키지: `com.flowlink` (core·definition·execution·mock·transform·security). 도메인은 UUID + `tenant_id`.
- 프론트: `frontend/src` (routes·canvas·panels·store·api·lib). Zustand=캔버스 클라 상태, React Query=서버 데이터.
- 새 노드 타입 추가 체크리스트는 CLAUDE.md 참조.
