# FlowLink Frontend (React · Vite)

워크플로 에디터 SPA. React 19 / Vite / @xyflow/react(캔버스) / Zustand(캔버스 상태) / React Query(서버 데이터) / axios.
UI 텍스트는 전부 한국어.

빌드 산출물(`dist/`)은 **백엔드 `bootJar` 시 flowlink.jar 에 동봉**되어 내장 톰캣이 화면+API 를 한 프로세스(:18080)로 서빙한다.
그래서 프론트는 API 주소를 하드코딩하지 않고 **`/api` 상대경로**만 쓴다(같은 오리진). dev 서버는 vite 프록시로 동일하게 맞춘다.

## 개발

```bash
npm install
npm run dev      # http://localhost:5173 — /api·/relay·/mock·/ws 를 :18080 백엔드로 프록시(vite.config.ts)
npm run build    # tsc -b && vite build → dist/ (백엔드 bootJar 가 이걸 동봉)
npm run lint     # oxlint
```
> 백엔드(:18080)가 떠 있어야 API·실행이 된다. 백엔드 기동은 리포 루트 `scripts/start.sh`(또는 `cd backend && sh gradlew bootRun`).

## 구조 (`src/`)

```
routes/    Dashboard(목록·검색·폴더) · Editor(에디터) · Executions(이력) · MockServers·MockServerEditor
store/     editorStore(Zustand — 캔버스 상태 source of truth) · presenceStore(협업 커서)
api/       client.ts(axios, baseURL /api/v1) · types.ts(백엔드 DTO 미러)
canvas/    FlowCanvas(ReactFlow 래퍼) · NodeCard · BranchNode(IF) · SwitchNode · Note/Group(주석)
           graphAdapter(toRF/fromRF) · nodeFactory · nodeMeta · Palette · NodeAddMenu · PresenceOverlay
panels/    PropertyPanel(노드 설정) · RunPanel(실행 로그) · KeyValueEditor
binding/   upstream(상위 노드 탐색) · TokenInput(인라인 토큰 칩) · BindingPicker(데이터 삽입)
openapi/   ImportDialog(워크플로 JSON/OpenAPI/cURL 가져오기) · parseOpenApi · schema
auth/      GitHub 로그인(디바이스 플로우) — auth.ts · AuthContext · GitHubLogin · usePermissions
components/ AssistantPanel(✨ AI) · Secrets/Env/Settings 다이얼로그 · toast · Modal 등
lib/       collab · presence · environments · curl · bodyConvert · runProgress · contrast · tokenGrammar
design/    theme(라이트/다크) · index.css(CSS 변수)
```

## 상태 분리

- **Zustand(editorStore)** = 캔버스 클라이언트 상태(nodes/edges/selectedId/dirty/undo).
- **React Query** = 서버 데이터(플로우·실행·시크릿·설정 등).
- 협업 presence 는 별도 presenceStore — editorStore 를 오염시키지 않는다(dirty/undo 불변).

## 인증(선택)

부팅 시 `GET /api/v1/auth/config` 로 모드를 발견한다. `mode: "github"` 면 [GitHubLogin](src/auth/GitHubLogin.tsx) 화면(디바이스 코드)을
띄우고, 성공 시 앱 JWT 를 localStorage 에 저장해 axios Bearer 로 붙인다. `mode: "none"`(dev)이면 로그인 없이 바로 들어간다.
`usePermissions()` 로 viewer/editor/admin UI 게이팅. **프론트엔드 전용 auth env 는 없다**(백엔드 config 로 자동 발견).

## 새 노드 타입 추가 (체크리스트)

1. `api/types.ts` — `NodeType` 유니온에 추가
2. `canvas/nodeFactory.ts` — `makeNode()` 프로토타입 + 팔레트 배열
3. `panels/PropertyPanel.tsx` — 타입별 설정 UI
4. `canvas/nodeMeta.ts` — 아이콘/라벨
5. 백엔드 `core/graph/NodeType` + `FlowExecutor.processNode()` 핸들러
