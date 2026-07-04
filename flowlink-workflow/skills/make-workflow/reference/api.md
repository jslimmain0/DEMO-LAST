# 등록 · 실행 API 레퍼런스

백엔드 base: `http://localhost:18080` · 모든 경로는 `/api/v1` 접두어. dev 프로파일은 인증 없음(permitAll).
(브라우저/Vite 컨텍스트에서는 프록시로 `/api/v1` 만 써도 됨.)

## 워크플로 등록 (2가지 방법)

### A) create + saveVersion (권장 — 2 POST)
1. **`POST /api/v1/flows`** — flow 컨테이너 생성(빈 v1 자동 생성).
   - body: `{ "name": string(필수, ≤255), "description"?: string, "folderId"?: UUID }`
   - 응답 `201` FlowDetail: `{ id, name, currentVersion:1, graph:{nodes:[],edges:[]} }` → `id` 획득
2. **`POST /api/v1/flows/{id}/versions`** — 그래프를 새 버전(v2, 현재 버전)으로 저장.
   - body: `{ "graph": { "name"?, "nodes":[...], "edges":[...] }, "note"?: string }`
   - GraphValidator 검증(노드 id 필수·유니크, edge from/to가 실존 노드, ≤200 노드). `graph.name`이 있으면 flow 이름도 갱신.
   - 응답 `201` FlowVersionSummary: `{ versionNo:2, ... }`

### B) import (한 방 — 1 POST)
- **`POST /api/v1/flows/import`** — 새 flow의 v1로 그래프를 곧바로 적재.
  - body: `{ "name"?: string, "nodes":[...], "edges":[...] }` (name/nodes/edges만 사용)
  - 응답 `201` FlowDetail(graph = 가져온 그래프)

## 실행

- **`POST /api/v1/flows/{flowId}/runs`** — 수동 실행(동기).
  - body(선택): `{ "input"?: {...}, "versionNo"?: int, "relayRunId"?, "relayBase"? }`. 바디 없으면 `{}`.
  - 응답 `200` ExecutionDetail: `{ id, status(RUNNING|SUCCEEDED|FAILED|WAITING|CANCELLED), nodes:[...], pendingForm, pendingWait, pendingInput, pendingClient }`
  - **순수 서버 노드**(start/end/set/http server/if/assert/transform/tcp)만이면 한 번에 SUCCEEDED/FAILED 완결.
  - **브라우저 협업 노드**(form/wait/input/client http)가 있으면 `status=WAITING` + `pending*`을 반환 → 에디터에서 ▶ 실행해야 콜백/팝업/입력을 거쳐 완결된다. (API 단독으로는 wait에서 멈춤)

## 조회

- `GET /api/v1/flows` — FlowSummary[]
- `GET /api/v1/flows/{id}` — FlowDetail(현재 graph 포함)
- `GET /api/v1/flows/{id}/export` — import로 재적재 가능한 그래프 JSON
- `GET /api/v1/flows/{flowId}/runs?limit=50` — 실행 이력
- `GET /api/v1/executions/{id}` — 실행 상세(노드별 로그)

## 헬퍼 스크립트

이 스킬 번들의 `scripts/register-flow.mjs`가 A/B를 처리한다:
```bash
node "${CLAUDE_SKILL_DIR}/scripts/register-flow.mjs" graph.json          # create+saveVersion
node "${CLAUDE_SKILL_DIR}/scripts/register-flow.mjs" graph.json --import # 한 방
node "${CLAUDE_SKILL_DIR}/scripts/register-flow.mjs" graph.json --run    # 저장+실행
cat graph.json | node "${CLAUDE_SKILL_DIR}/scripts/register-flow.mjs" -  # stdin
# → { flowId, versionNo, editorUrl } 출력
```
