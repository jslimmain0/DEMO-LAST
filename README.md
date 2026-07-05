# FlowLink

REST API 워크플로 오케스트레이션 플랫폼. HTTP·폼·콜백·변환 노드로 워크플로를 그려 실행하고,
미완성 API 는 내장 **Mock 서버**로 세워 전체 흐름을 먼저 테스트한다. UI 는 전부 한국어.

## 빠른 시작 (Windows / PowerShell)

가장 쉬운 방법 — 전체 스택을 한 번에 띄운다(각자 창으로):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-all.ps1    # 기동
powershell -ExecutionPolicy Bypass -File scripts\dev-stop.ps1   # 종료
```

준비되면 **http://localhost:5173** 를 연다.

## 띄우는 프로세스는 2개

**backend + frontend** 둘이면 모든 기능이 돈다. 콜백 수신(구 relay)과 Mock 대상 시스템은 **백엔드에 통합**돼
별도 프로세스가 없다.

| 서비스 | 주소 | 필요 시점 |
|---|---|---|
| **backend** | http://localhost:18080 | **항상 필수** — API + 실행 엔진 + wait 콜백 수신 + 내장 Mock (H2 파일 DB, Postgres/Docker 불필요) |
| **vite** | http://localhost:5173 | **항상 필수** — 프론트 UI (`/api` → :18080 프록시) |

- **워크플로를 만들고 HTTP/SET/IF/검증/변환을 실행** → backend + vite 면 끝.
- **결제창 → 콜백 → 재개** 흐름도 그대로 → `wait` 노드 콜백은 **백엔드가 `/relay/{execId}/cb/{nodeId}` 로 직접 받아** 자동 재개한다(별도 relay 프로세스 불필요).
- **`demos/*.json` 데모**를 재현하려면 → 한 번 `node demos/seed-mock.mjs` 로 내장 Mock(slug `demo`)에 대상 라우트를 심는다.
- 미완성 API 흉내는 UI 상단 **"Mock 서버"** 탭(백엔드 내장, `/mock/{slug}/**`)으로 별도 프로세스 없이 만든다.

### 개별 실행

```powershell
# backend (H2 파일 DB — 재시작해도 데이터 유지)
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -H2

# 프론트 (frontend/)
npm install; npm run dev            # http://localhost:5173

# (데모만) 내장 Mock 에 대상 라우트 시드 — 1회, 의존성 0
node demos/seed-mock.mjs            # 백엔드(:18080)에 slug `demo` mock 생성/갱신
```

## 말로 워크플로 만들기 (AI 스킬)

자연어로 설명하면 워크플로(노드 그래프)를 만들어 등록하는 도구가 함께 들어 있다.
같은 기능을 **Claude Code**(플러그인)와 **GitHub Copilot**(지침/프롬프트) 양쪽에서 쓸 수 있다.
> 전제: backend(18080)가 떠 있어야 등록/실행이 된다.

### Claude Code — `flowlink-workflow` 플러그인

```bash
claude --plugin-dir ./flowlink-workflow      # 플러그인 로드
```

로드한 뒤 대화로 요청하면 `make-workflow` 스킬이 자동 발동한다:

> **"결제창 띄우고 콜백 받아서 승인 검증하는 워크플로 만들어줘"**
> **"로그인해서 토큰 받고 주문 넣는 플로우 짜줘"**
> **"OTP 발송하고 사용자한테 입력받아 검증하는 워크플로"**

동작: ① 흐름 파악 → ② `{name, nodes, edges}` 그래프 설계(노드 스키마·토큰 문법 근거) →
③ REST API 로 등록(`POST /flows` → `POST /flows/{id}/versions`) → ④ **에디터 URL**(`/flows/{id}`) 안내.
에디터에서 **▶ 실행**하면 팝업·콜백·입력을 거쳐 완결된다.

### GitHub Copilot

Claude 와 **같은 `make-workflow` 스킬**을 Copilot 에서도 쓴다(SKILL.md 는 Claude·Copilot 공통 표준이라 본문이 공유된다). 세 방식:

- **Agent Skill** (권장): [`.github/skills/make-workflow/`](.github/skills/make-workflow/SKILL.md) — **Copilot CLI · VS Code/JetBrains 에이전트 모드 · 클라우드 에이전트 · 코드 검토**가 워크플로 생성 요청을 감지하면 `SKILL.md`(+ `reference/`·`scripts/`)를 컨텍스트에 자동 로드한다([Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills), 2025-12+). `gh skill` 로 관리·공유도 가능.
- **자동 지침**: [`.github/copilot-instructions.md`](.github/copilot-instructions.md) — 리포에서 작업할 때 Copilot Chat 이 자동으로 읽는 지침(워크플로 생성 규칙 요약).
- **슬래시 명령**: [`.github/prompts/make-workflow.prompt.md`](.github/prompts/make-workflow.prompt.md) — Copilot Chat 에서 `/make-workflow`(VS Code 설정 `chat.promptFiles: true`).

### 등록 헬퍼 단독 사용

스킬 없이 그래프 JSON 을 직접 등록할 수도 있다:

```bash
node flowlink-workflow/skills/make-workflow/scripts/register-flow.mjs graph.json          # 등록
node flowlink-workflow/skills/make-workflow/scripts/register-flow.mjs graph.json --run     # 등록 + 실행
node flowlink-workflow/skills/make-workflow/scripts/register-flow.mjs graph.json --import  # 한 방(v1)
# → { flowId, editorUrl } 출력
```

노드 타입·토큰 문법·API 상세는 [`flowlink-workflow/README.md`](flowlink-workflow/README.md)와
그 안의 `skills/make-workflow/reference/` 참고.

## 더 보기

- **[CLAUDE.md](CLAUDE.md)** — 아키텍처·구조·최근 변경 상세 (유지보수 진실원)
- **[backend/README.md](backend/README.md)** — 백엔드 구현 범위·API·실행
- **[demos/README.md](demos/README.md)** — 데모 워크플로 · [demos/pay-mock](demos/pay-mock/README.md)(내장 Mock + 검증 노드)
- **[flowlink-workflow/](flowlink-workflow/README.md)** — 자연어→워크플로 AI 스킬(플러그인)
- **[docs/](docs/)** — 설계 문서·토론 로그 · `legacy/` — 동결된 원본 프로토타입
