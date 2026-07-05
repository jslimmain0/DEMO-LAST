# flowlink-workflow — 자연어 → FlowLink 워크플로 (Claude Code 플러그인)

말로 설명하면 [FlowLink](../) 워크플로(노드 그래프)를 만들어 REST API로 등록하는 Claude Code 플러그인.

> "결제창 띄우고 콜백 받아서 승인 검증하는 워크플로 만들어줘"
> "로그인해서 토큰 받고 주문 넣는 플로우 짜줘"
> "OTP 발송하고 사용자한테 입력받아서 검증하는 워크플로"

라고 하면 Claude가 노드/엣지 그래프를 설계해 등록하고, 에디터 URL을 알려준다.

## 설치

로컬 디렉토리로 바로 로드:
```bash
claude --plugin-dir ./flowlink-workflow
```
또는 `~/.claude/skills/`에 심어 자동 발견하게 두어도 된다(`.claude-plugin/plugin.json` + `skills/…` 구조 유지).

## 사용

FlowLink 백엔드가 떠 있는 상태(`http://localhost:18080`)에서, 대화로 워크플로를 요청하면 `make-workflow` 스킬이 자동 발동한다. 명시 호출은 `/flowlink-workflow:make-workflow`.

동작:
1. 요청에서 흐름(노드 시퀀스·분기·콜백)을 파악
2. `{ name, nodes, edges }` 그래프 JSON 설계
3. `scripts/register-flow.mjs`로 `POST /flows` → `POST /flows/{id}/versions` 등록
4. `editorUrl`(`http://localhost:5173/flows/{id}`) 안내 — 에디터에서 ▶ 실행

## 구조

```
flowlink-workflow/
├── .claude-plugin/plugin.json        # 매니페스트
└── skills/make-workflow/
    ├── SKILL.md                      # 스킬 지침(절차·규칙)
    ├── reference/
    │   ├── nodes.md                  # 10개 노드 타입별 필드
    │   ├── graph-and-tokens.md       # 그래프 구조·엣지·토큰 문법·패턴
    │   └── api.md                    # 등록/실행 REST API
    └── scripts/register-flow.mjs     # 그래프 → API 등록 헬퍼(Node 18+)
```

## 등록 헬퍼 단독 사용

```bash
node skills/make-workflow/scripts/register-flow.mjs graph.json           # create+saveVersion
node skills/make-workflow/scripts/register-flow.mjs graph.json --import  # 한 방(v1)
node skills/make-workflow/scripts/register-flow.mjs graph.json --run     # 저장 후 실행
node skills/make-workflow/scripts/register-flow.mjs graph.json --base http://다른호스트:18080
```

## GitHub Copilot 에서도

같은 스킬을 GitHub Copilot 이 [Agent Skill](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)(2025-12+)로 자동 발견하도록 리포에 미러해 뒀다 — [`.github/skills/make-workflow/`](../.github/skills/make-workflow/SKILL.md). `SKILL.md` 는 Claude·Copilot 공통 형식이라 스킬 본문(절차·규칙)이 그대로 공유된다. Copilot CLI · VS Code/JetBrains 에이전트 모드 · 클라우드 에이전트가 "워크플로 만들어줘" 요청 시 로드한다. (보조로 Copilot Chat 슬래시 `/make-workflow`(`.github/prompts/`)·자동 지침 `.github/copilot-instructions.md` 도 있다.)

## 참고

- 노드 타입: start / end / set / if / assert / http / form / wait / input / transform
- 토큰: `{{ key@노드id }}` (`@` 뒤는 노드 이름이 아니라 `id`)
- form→wait 콜백 패턴: 결제창 form의 콜백필드 값에 `{{ url@wait노드id }}`
- 브라우저 협업 노드(form/wait/input)는 API 단독 실행 시 WAITING에서 멈춤 → 에디터에서 ▶ 실행로 완결
