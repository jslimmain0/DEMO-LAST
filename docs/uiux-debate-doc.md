# Flowlink 프론트엔드 UI/UX 설계 스펙

> 문서 권위: 이 문서는 12라운드 A/B/C 협의의 단일 종합본이며, 프론트엔드 구현의 기준(SSOT)이다. 충돌 시 본 문서가 우선한다. 모든 코드 계약(토큰 문법·엣지 포트·검증 책임)은 백엔드 실측 소스(`TokenResolver.java`, `GraphValidator.java`, `GraphEdge.java`, `ExecutionController.java`, `ExecutionProperties.java`)와 1:1 정합 검증을 마쳤다.
> 버전: 1.0 (Authoritative) · 기준일: 2026-06-26 · 대상 스택: React 19 + TS + Vite 8 + @xyflow/react 12 + zustand 5 + @tanstack/react-query 5 + react-router-dom 7 (전부 `package.json` 실측 설치 확인됨)

---

## 0. 요약 & 핵심 UX 결정

12라운드에서 합의된 구속력 있는 결정. 각 항목은 구현 시 변경 불가(쟁점 재개는 §17 절차).

| # | 결정 | 근거/출처 | 영향면 |
|---|------|-----------|--------|
| **D1** | **2-티어 앱 셸**: 티어1(대시보드/이력/설정) = 전역 헤더+사이드 표준 셸 / 티어2(에디터) = 헤더 제외 `100dvh` 풀블리드 자체 상단바 | R1, C-major(RF 측정/줌은 풀스크린 고정 필요) | §3 |
| **D2** | **고빈도 캔버스 상태(노드 위치/선택/줌)는 zustand 단일 진실원**. 라우터·react-query에 묶지 않음. react-query는 서버 정의/실행만 | R1 C-blocking(controlled 모드 리렌더 폭발) | §6,§15 |
| **D3** | **실행은 동기 모델(Phase1)**: 실행→블로킹→`ExecutionDetail` 일괄 렌더. SSE/단계 힌트/취소 버튼은 백엔드 미지원 → **거짓 어포던스 금지**(비노출 또는 게이트 라벨). 장시간은 클라 타임아웃→`GET /runs` 폴링 전환 | R2·R5, 실측: `ExecutionController`에 cancel 없음 | §9 |
| **D4** | **토큰 문법은 백엔드 정규식과 1:1 계약**: `{{key}}` / `{{key@id}}` / `{{key@req:id}}` 3종. `token-grammar.ts` 단일 상수로 백엔드 `TokenResolver.tokenPattern()` 미러링 | R5 C-blocking, 실측 정규식 | §7 |
| **D5** | **노드 id 발급기 = `customAlphabet([A-Za-z0-9], 8)`**. nanoid 기본(`-`/`_` 포함)은 토큰 sourceId 클래스 `[A-Za-z0-9]+`와 충돌해 silent fail → 금지. import 시 위반 id 정규화 1패스 | R5 C-blocking, 실측 sourceId 정규식 | §7,§15 |
| **D6** | **검증 이중화**: 프론트=즉시 차단(전체 그래프 1패스), 백엔드=권위 거부. 단 백엔드 `GraphValidator`는 사이클/위상 미검증 → 프론트가 사이클·dangling을 떠안되 "프론트 단독 책임" 명시 | R5, 실측 `GraphValidator`(id중복+엣지존재만) | §6,§7 |
| **D7** | **출력 스키마 1차 = `outputs[].key` 평면 목록만**. 중첩 path·배열인덱싱·타입검증 제거(`TokenResolver`가 flat `map.get`뿐). type 미선언 시 배지="타입 미상", **타입 불일치 경고 미표시**(거짓 안심 방지) | R5 B/C-blocking 수렴, 실측 | §7 |
| **D8** | **키보드 동등성 = 기능 동등(WCAG 2.1.1) ≠ 픽셀드래그 동등**. 생성=팔레트 Enter→뷰포트 중앙, 연결=명령형(소스선택→대상 콤보박스), 자유배치=자동레이아웃 위임. 커맨드팔레트는 후순위 | R4·R5 B/C 균형 | §6,§11 |
| **D9** | **대시보드 상태 배지/필터는 백엔드 계약 게이트**: `recent()` 일괄 1쿼리로 수화(N+1 금지), 단 limit 미덮임 → 미수화 flow는 "실행 없음/미상" 버킷, **상태 필터는 수화 완료 전 disabled** | R3 B-blocking/C-major 수렴, 실측 `recent()`=전역 | §5 |
| **D10** | **1차 뷰 = 카드 그리드 단일 뷰**(+컴팩트 토글, 같은 컴포넌트). 테이블·가상스크롤은 백엔드 페이지네이션/정렬 생긴 후 별도 라운드(`@tanstack/react-virtual` 미설치) | R3 B/C 수렴 | §5,§13 |
| **D11** | **복제 = `POST /flows/import` 원자 경로**(export→이름 치환→import). 2-step versions 조립 폐기. 불가피 시 실패→자동 DELETE 보상 | R3 B/C 수렴, 실측 `importFlow` 단일호출 | §5,§10 |
| **D12** | **데이터손실 가드 1급**: unsaved route guard + `beforeunload`, 명시저장(버전 스냅샷)과 자동저장(드래프트) 구분, 멀티탭 `If-Match`/`updatedAt` 낙관적 잠금 → 409 충돌 다이얼로그(덮어쓰기/새버전), 멀티커서 배제 | R1 | §3,§10,§12 |

전체 수렴 상태: **부분 수렴**. 잔여 미해결은 전부 백엔드 계약 게이트(§17): lastRun 비정규화 API, 중첩 path(JsonPointer), capture 토글 DTO, 사이클 거부, import name/id 규약.

---

## 1. 협의 경과 (A vs B(사용성/접근성) vs C(구현/일관성))

### 1.1 라운드별 충돌·해소 요약

| R | 초점 | 핵심 충돌 | 해소(본 스펙 채택) |
|---|------|-----------|-------------------|
| 1 | IA·내비·앱셸·라우팅 | A 더미 제출(평가불가) / B: 캔버스서 내비 붕괴·드래그 의존 a11y0 / C: 고빈도 상태를 전역에 묶으면 리렌더 폭발 | 2-티어 셸(D1), 캔버스 상태 zustand 격리(D2), 키보드 우선 1급, 라우트 트리 확정 §3 |
| 2 | 디자인 시스템·다크모드·토큰 | B: 다크 대비 측정 부재·hue고정↔대비 충돌 / C: graph-adapter 누락, Radix 미설치, HEAD/binary 누락 | 다크 페어테이블 §4.2, HEAD 6번째 메서드=중립회색, graph-adapter 1급 산물, Radix 핀포인트(Dialog/Popover/Tooltip)만 |
| 3 | 대시보드 목록 | B-blocking+C: lastRun 점진수화 N+1·상태필터 거짓음성 / B: 카드+테이블 이중뷰 a11y 2배·가상스크롤 비용·undo 멀티탭 유실 | 일괄 `recent()` 수화+계약게이트(D9), 단일 카드뷰(D10), 복제 원자화(D11), undo sendBeacon flush |
| 4 | 캔버스 핵심 인터랙션 | A 빈 스텁 / B: 키보드·SR·ARIA 전무(2.1.1/4.1.2) / C: controlled 리렌더, 박스선택↔팬 제스처 배타, 복붙 바인딩 재매핑 부재 | 생성 3경로+키보드 대체(D8), 제스처 매트릭스 §6.3, 복붙 old→new id 재매핑 §6.6, RF memo+좁은 셀렉터 |
| 5 | 와이어링·IF·바인딩 토큰 | B+C-blocking: typed 스키마 토대 부재(capture off, flat resolver) / C: 토큰 직렬화 형식 오류·id 알파벳 충돌 / B: 키보드 와이어링 '동등' 실패·동기 취소 거짓약속 | 평면 key만(D7), 토큰 3종 계약(D4), id 알파벳 고정(D5), 기능적 동등(D8), 취소 비노출(D3) |
| 6–12 | (디자인시스템 세부·실행/디버깅·버전·a11y·온보딩·성능·반응형·컴포넌트분해·구현매핑) | 위 토대 위 세부 — 본 문서 §4~§16에 종합 | 잔여 게이트는 §17 |

### 1.2 A의 자기수정 기록(절차적 정직성)

A의 1·2·4라운드 제출이 더미 토큰(`'test'`, 빈 배열)이었음이 B·C·퍼실리테이터에 의해 실측 검증됨. 본 최종본은 **기존 구현(`App.tsx` 2-라우트, `api/client.ts`, `types.ts`, `index.css` 53줄)을 기준점으로 재구축**하여 그 오류를 정정한다. C가 지적한 "graph-adapter 부재", "토큰 1종 단정", "Radix 미설치 가정", "가상스크롤 미설치"는 모두 사실로 수용했다.

### 1.3 충돌 해소 원칙

- **백엔드 실측이 기준 진실**: 동기 실행, flat 토큰, cancel 부재, capture off는 UI 전제가 아니라 제약이다.
- **B(사용자가치) vs C(구현현실)**는 대부분 충돌이 아닌 양면 → "원칙은 B로 1급 확정, 비용은 C로 명시"로 통합.
- **거짓 어포던스 금지**: 백엔드가 못 받치는 버튼(취소·단계힌트·타입경고)은 그리지 않는다.

---

## 2. 디자인 원칙

1. **브랜드 보존 우선(Preserve, then elevate)** — 프로토타입의 보라 그라디언트(#6155f5→#8b7bff), 3-폰트(Space Grotesk/Plus Jakarta Sans/JetBrains Mono), 점 그리드, 카드형·둥근 모서리·부드러운 그림자를 픽셀 단위로 계승한다.
2. **접근성은 기능 동등(2.1.1)이지 픽셀 동등이 아니다** — 모든 마우스 기능에 키보드/SR 경로를 제공하되, 자유 배치 같은 본질적 포인터 작업은 자동레이아웃·명령형 대안으로 동등성을 달성한다.
3. **정직한 어포던스** — 백엔드가 지원하지 않는 동작은 노출하지 않는다. 불확실은 "미상"으로 표기(거짓 확신 금지).
4. **데이터 손실 방지가 화려함보다 우선** — 저장/버전/멀티탭/이탈 가드는 1급 요구.
5. **색 단독 정보 전달 금지(1.4.1)** — 메서드·카테고리·상태는 항상 색+아이콘+텍스트 3중 부호화.
6. **점진적 공개(Progressive disclosure)** — 토큰 `{{key@src}}` 같은 전문 표기는 닫힌 칩으로 은닉, 고급 사용자만 raw 노출.
7. **성능 예산은 수용기준** — 드래그 60fps, 초기 렌더 <500ms를 openQuestion이 아닌 AC로 고정.
8. **상태는 4종 항상**(빈/로딩/에러/성공) — 모든 화면·인터랙션에 결합 정의.

---

## 3. 정보구조 & 내비게이션 & 라우팅

### 3.1 사이트맵 (ASCII)

```
Flowlink
├─ /login                         (자리 예약 · permitAll 동안 미노출 · OIDC 게이트)
├─ /flows                         [티어1] 대시보드 — 워크플로 카드 그리드
│    └─ ?q= &cat= &sort= &view=   검색/필터/정렬/뷰 (URL 영속, 공유/뒤로가기 동작)
├─ /flows/:id                     [티어2] 캔버스 에디터 (풀블리드 셸)
│    ├─ ?node=:nodeId             선택 노드 딥링크 (속성패널 오픈)
│    ├─ ?panel=run|props|versions 우/하단 패널 상태 (좁은폭 상호배타)
│    └─ /runs/:runId              실행 상세 (하단 로그 패널 = completed run 뷰어)
├─ /flows/:id/versions            [티어1] 버전 목록
│    └─ /:no                      버전 상세 / diff (vs current 또는 vs :no2)
├─ /executions                    [티어1] 전역 실행 이력 (recent)
│    └─ /:execId                  실행 상세 (대시보드 진입)
└─ /settings                      [티어1] 환경설정 (테마·언어·자리예약: 사용자메뉴)
```

라우트 동작 규약:
- **딥링크**: `?node=` `?panel=` `/runs/:runId` `/versions/:no`는 새로고침·뒤로가기·공유에서 동일 상태 복원.
- **노드 선택은 URL `?node=` 반영하되 zustand가 진실원**(D2): URL→store 단방향 hydrate, store→URL은 `replace`(히스토리 오염 방지·드래그 중 미반영).
- **코드 스플릿 경계**: `/flows`(대시보드)와 `/flows/:id`(에디터+RF)는 별도 lazy chunk. RF/자동레이아웃(dagre)은 에디터 chunk 내 추가 lazy.
- **뒤로가기**: 에디터→대시보드 이동 시 unsaved 가드(D12) 통과 필요.

### 3.2 앱 셸 — 2티어 (ASCII)

티어1 (대시보드/이력/버전/설정):
```
┌─────────────────────────────────────────────────────────────┐
│ [≡] ◆Flowlink   대시보드  실행이력          🔍  🌙  ko/en  ⊙ │  role=banner
├──────┬──────────────────────────────────────────────────────┤
│ nav  │  <main role=main>                                     │
│ aside│   (페이지 콘텐츠)                                      │
│ ·flows│                                                       │
│ ·runs │                                                       │
│ ·set  │                                                       │
└──────┴──────────────────────────────────────────────────────┘
skip-link("본문 바로가기") → main 첫 포커스
```

티어2 (캔버스 에디터, `100dvh`, 전역 헤더 없음):
```
┌─────────────────────────────────────────────────────────────┐
│ ← │ [이름 입력]  v3 ●미저장   ⌘Z ⌘⇧Z │ 가져오기 내보내기 │ ▶실행 │ 💾저장 │ top-bar
├────┬───────────────────────────────────────────────┬─────────┤
│팔레트│            <canvas role=application            │ 속성패널 │
│     │             aria-label="워크플로 캔버스">        │ (선택   │
│start│         · · · · · 점그리드 · · · · ·            │  노드)  │
│http │         ┌──────┐      ┌──────┐                 │         │
│if   │         │ POST │──────│ IF   │                 │         │
│set  │         └──────┘      └──┬─┬─┘                 │         │
│wait │                       T│ │F                    │         │
│end  │      [미니맵▢]  [− 100% +] [⤢fit] [1:1]        │         │
├────┴───────────────────────────────────────────────┴─────────┤
│ ▾ 실행 로그  (마지막 실행: 성공 · 1.2s)         [지우기] [닫기] │  하단 패널
└─────────────────────────────────────────────────────────────┘
```

### 3.3 랜드마크·반응형

| 영역 | ARIA | 비고 |
|------|------|------|
| 전역 헤더 | `role=banner` | 티어1만 |
| 사이드 내비 | `<nav aria-label="주요">` | 티어1 |
| 본문 | `<main>` | skip-link 타깃 |
| 캔버스 | `role=application` + `aria-label` | 탐색키 가로채기 비용 명시(§6) |
| 속성/로그 패널 | `<aside>` / `role=region aria-label` | 한 번에 하나의 모달 패널 |

반응형 브레이크포인트:

| 폭 | 대시보드 | 에디터 |
|----|---------|--------|
| ≥1024 (데스크톱) | 3~4열 그리드 + 사이드나브 | 3패널 도킹(팔레트·캔버스·속성) |
| 768–1024 (태블릿) | 2열, 사이드나브 접힘 | 속성패널=슬라이드오버, 팔레트=접이식 |
| <768 (모바일) | 1열 카드 | **조회 완전동작, 편집은 게이트**(읽기전용 안내) — 철회 아님, 명시 제품결정 |
| 200% 확대 (reflow) | 가로스크롤 금지 | 패널 오버레이+캔버스 전체폭, 가로스크롤 금지(AC) |

---

## 4. 디자인 시스템

### 4.1 토큰 (라이트 기준 · `index.css` 실측 53줄 확장)

기존 토큰을 보존하고 2티어(원시→시맨틱)로 승격. 신규 토큰은 `--fl-*` 네임스페이스, JSX 인라인 `var()` 참조라 `data-theme` 재맵핑이 자동 적용됨.

**컬러 — 브랜드/표면**

| 토큰 | 라이트 | 다크 | 용도 |
|------|--------|------|------|
| `--fl-primary` | `#6155f5` | `#7d72ff` | 프라이머리 |
| `--fl-primary-2` | `#8b7bff` | `#a99bff` | 그라디언트 끝 |
| `--fl-primary-hover` (별칭→primary-2 deprecation) | `#5246e8` | `#6c61f0` | hover |
| `--fl-bg` | `#f6f7f9` | `#0f1117` | 배경 |
| `--fl-surface` | `#ffffff` | `#171a22` | 표면/카드 |
| `--fl-surface-2` | `#f0f2f6` | `#1e222c` | 패널/입력 |
| `--fl-text` | `#1a1d27` | `#e8eaf0` | 본문 |
| `--fl-text-muted` | `#73798a` | `#9aa0b2` | 보조 |
| `--fl-border` | `#e9ebf1` | `#2a2e3a` | 보더 |
| `--fl-focus` | `#6155f5` (3:1↑) | `#9b90ff` | 포커스 링 |

**컬러 — HTTP 메서드 6종**(HEAD 추가, 색+텍스트+아이콘 항상)

| 메서드 | 라이트 | 다크 | 전경대비 비고 |
|--------|--------|------|--------------|
| GET | `#16a34a` | `#3ecf72` | 칩 배경엔 흰 텍스트 4.5:1↑ |
| POST | `#2563eb` | `#5b8def` | |
| PUT | `#d97706` | `#f0a23b` | |
| PATCH | `#7c3aed` | `#a479f5` | |
| DELETE | `#dc2626` | `#f15b5b` | |
| **HEAD** | `#64748b`(중립회색) | `#8b94a6` | 신규 — `--fl-head` |

**컬러 — 노드 카테고리 9종 + 동일색 충돌 예외**

| 카테고리 | 라이트 | 다크 | 충돌·예외 |
|----------|--------|------|-----------|
| auth | `#6155f5` | `#7d72ff` | **brand primary와 동색** → 노드 헤더 아이콘+텍스트 라벨로 분리(색 단독 금지) |
| bank | `#0ea5a4` | `#2bc4c2` | teal — 색맹 시뮬레이션 검수 대상 |
| card | `#e0529c` | `#ed6fb0` | |
| generic | `#64748b` | `#8b94a6` | **end와 동색** → 아이콘+라벨로 분리 |
| set | `#d9822b` | `#ef9b46` | |
| if | `#7c3aed` | `#a479f5` | |
| wait | `#0891b2` | `#22acd1` | cyan — bank/start 인접쌍 검수 |
| start | `#16a34a` | `#3ecf72` | green — get과 인접쌍 |
| end | `#64748b` | `#8b94a6` | generic과 동색(위) |

> **예외 규칙(명문)**: auth↔primary, generic↔end는 동일 hex이므로 **색만으로 식별 금지**. 노드 카드 헤더에 카테고리 아이콘 + 한국어/영문 텍스트 라벨을 항상 동반한다(1.4.1).

**컬러 — 실행 상태 4+2종**

| 상태 | 색 | 아이콘 | 표기 |
|------|----|----|------|
| SUCCEEDED | `#16a34a` | ✓ | 성공 |
| FAILED | `#dc2626` | ✕ | 실패 |
| RUNNING | `#2563eb` | ◴(펄스) | 실행중 |
| WAITING | `#0891b2` | ⏸ | 대기(입력 필요) |
| PENDING | `#73798a` | ○ | 대기열 |
| CANCELLED | `#73798a` | ⊘ | 취소됨(표시전용, §9) |

**타이포 · 간격 · 반경 · 그림자 · 모션**

| 카테고리 | 토큰 | 값 |
|----------|------|----|
| 폰트 | head/ui/mono | Space Grotesk / Plus Jakarta Sans / JetBrains Mono (`font-display:swap`, JetBrains Mono `preload`) |
| 타입스케일 | `--fl-fs-xs…2xl` | 12/13/14/16/20/28 (line-height 1.4~1.25) |
| 간격 | `--fl-sp-1…8` | 4/8/12/16/20/24/32/48 |
| 반경 | `--fl-radius-sm/md/lg/pill` | 8/12/16/9999 (sm·pill 신규) |
| 그림자 | `--fl-shadow / -lg` | 기존 보존 (라이트), 다크는 보더 강조+그림자 약화 |
| 모션 | `--fl-ease / -dur-fast/-base/-slow` | `cubic-bezier(.2,.8,.2,1)` / 120/200/320ms |
| 모션 토큰 | `--fl-motion-*` (2급 강등) | `prefers-reduced-motion`서 0ms로 오버라이드 |

### 4.2 다크모드

- **단일 스코프**: `<html data-theme="dark">` 에서 `:root` 토큰만 재맵핑. 컴포넌트는 원시 hex 직접참조 금지(신규코드 한정 + CI grep `--c-*`/리터럴 금지 룰; stylelint은 JSX 인라인 미검사라 보류).
- **노드 카드 다크**: 카테고리 색은 헤더 액센트바·아이콘에만, 본문은 `--fl-surface`. 동색 충돌(auth/primary, generic/end)은 §4.1 예외로 해소.
- **RF 기본 CSS 오버라이드**: `@xyflow/react/dist/style.css` → `react-flow-adapter.css` 단일 어댑터에서 `--rf-*`(edge/handle/selection/minimap-mask)를 `--fl-*`로 매핑. **시각 어댑터(.css)와 데이터 어댑터(`graph-adapter.ts`)는 별개 산물**(R2 C-blocking).

### 4.3 컴포넌트 라이브러리 결정

- **Radix UI 핀포인트 채택**: `@radix-ui/react-dialog`, `-popover`, `-tooltip`만(미설치→순증, vite build dist 수치로 채택 확정). Tree/Combobox/Resizable은 자체 구현(별도 결정).
- **캔버스 내부(노드/엣지/바인딩 칩) a11y는 Radix 커버 밖** — 가장 어려운 a11y는 직접 구현(§6,§11).
- 폰트 측정 깜빡임 차단: 노드 width는 폰트 비의존(고정/내용 기반 min-width).

---

## 5. 화면별 설계

### 5.1 대시보드 `/flows`

```
┌─────────────────────────────────────────────────────────────┐
│  워크플로                              [+ 새로 만들기][가져오기]│
│  ┌──────────────────────────┐                                │
│  │🔍 검색…                   │  카테고리▾  정렬▾  [▦/▤뷰]      │
│  └──────────────────────────┘                                │
│  [전체] [성공⊘] [실패⊘] [실행중⊘] [대기⊘]  ← 상태칩(수화전 disabled)│
│                                                               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐             │
│  │ 결제 검증     │ │ KYC 온보딩   │ │ 환불 플로우  │ │ name링크   │
│  │ v3 · 8 노드   │ │ v1 · 3 노드  │ │ v7 · 14 노드 │ │            │
│  │ ✓ 2분 전      │ │ ○ 실행 없음  │ │ ✕ 1시간 전   │ │ 상태배지   │
│  │          [⋮] │ │          [⋮]│ │          [⋮]│ │ 케밥(형제) │
│  └─────────────┘ └─────────────┘ └─────────────┘             │
└─────────────────────────────────────────────────────────────┘
```

- **핵심 요소**: 카드(name 링크 + 메타 + lastRun 배지 + 케밥). 카드당 **포커스 스톱 정확히 2개**(name 링크 + 케밥, NVDA/VO 검증 AC). `<a>` 안 `<button>` 중첩 금지 → name 링크 + 형제 케밥 + `::before` 오버레이로 히트영역 확장.
- **상태 수화(D9)**: 마운트 시 `recent()` 1쿼리 → `flowId` groupBy → 최신 1건 조인. limit 미덮인 flow는 "실행 없음/미상" 버킷. 상태 필터칩은 **수화 완료 전 disabled**, 완료 후에도 미덮임 명시(거짓 음성 차단).
- **케밥 메뉴**: 열기 / 복제(D11 import 원자) / 내보내기 / 버전 / 삭제(undo).
- **삭제 undo**: 토스트 5초+호버/포커스 시 타이머 정지(2.2.1), `beforeunload`/`visibilitychange`서 보류 DELETE를 `sendBeacon` flush, 멀티탭 `BroadcastChannel`로 `['flows']` 동기화.

**상태 4종**

| 상태 | 표현 |
|------|------|
| 빈(첫 사용자) | 히어로 일러스트 + "첫 워크플로 만들기" CTA + **샘플 1클릭 복제**(First-run success path) |
| 로딩 | 카드 스켈레톤(고정 높이, 레이아웃 시프트 0) |
| 에러 | 인라인 배너 + 재시도 버튼(react-query refetch) |
| 권한(게이트) | viewer는 새로만들기/삭제 비노출(자리예약) |

### 5.2 캔버스 에디터 — §3.2 와이어프레임 참조. 인터랙션은 §6, 패널은 §8·§9.

### 5.3 실행 상세 뷰 `/flows/:id/runs/:runId`

```
┌─ 실행 #a1b2 ────────────────── 성공 · 1.24s · v3 · 방금 ───[×]┐
│ 타임라인(노드별)         │  선택 노드 상세                     │
│ ┌──────────────────┐    │  POST /charge      httpStatus 200   │
│ │1 ✓ start   0ms    │    │  ┌ 요청 ─────────────────────────┐  │
│ │2 ✓ POST    320ms  │◀── │  │ (capture off → "본문 미저장")  │  │
│ │3 ✓ IF      1ms    │    │  └───────────────────────────────┘  │
│ │4 ⏸ wait   대기중  │    │  ┌ 응답 ──────────── [복사][다운로드]┐ │
│ │5 ○ end    skipped │    │  │ { "id": "ch_…", … }            │  │
│ └──────────────────┘    │  └───────────────────────────────┘  │
│ aria-live=polite 요약    │  ┌ 출력 outputs ─────────────────┐  │
│                          │  │ id, status, amount            │  │
└──────────────────────────┴────────────────────────────────────┘
```

- 타임라인은 **스크린리더 1급 표면**(role=list, 각 노드 status 텍스트). 색+아이콘+텍스트 3중.
- **capture off**(실측 기본): 요청/응답 본문 자리에 "본문 미저장(보안 정책)" + 캡처 설정 링크는 **비노출**(백엔드 DTO 게이트, §17).
- `respType=binary`: 미리보기 불가 → "다운로드 링크"만(redaction 우선).
- 실패 시: 실패 노드 자동 선택 + "실패 노드로 캔버스 이동" 버튼.

### 5.4 버전 목록/Diff — §10 참조.

### 5.5 설정 `/settings`

테마 토글(라이트/다크/시스템), 언어(ko/en), 제스처 프리셋(휠=줌·Space/중클릭=팬, localStorage 기억), 스냅 토글 기본값. 사용자 메뉴·OIDC는 자리예약.

---

## 6. 캔버스 에디터 인터랙션 명세

각 인터랙션은 C 요구 포맷 **(1)트리거 (2)RF API 매핑 (3)zustand action (4)엣지케이스**로 기술.

### 6.1 노드 생성 (3경로, D8)

| 경로 | (1)트리거 | (2)RF API | (3)store action | (4)엣지케이스 |
|------|-----------|-----------|-----------------|--------------|
| 팔레트 클릭 | 팔레트 항목 click | `screenToFlowPosition(viewport center)` | `addNode(type, centerPos)` | 빈 캔버스→중앙, 줌상태 무관 |
| 팔레트 드래그 | dragstart→canvas drop | `screenToFlowPosition(dropXY)` | `addNode(type, dropPos)` | 패널 위 드롭=취소(no-op) |
| **키보드(필수)** | 팔레트 항목 **Enter** | viewport center + `setCenter` pan | `addNode` + `selectNode(new)` + 속성패널 포커스 | aria-live="노드 추가됨, 속성 편집" |

- 신규 노드 id = `customAlphabet([A-Za-z0-9],8)`(D5). 커맨드팔레트는 후순위(범위 외).

### 6.2 와이어링(연결)

| 경로 | (1)트리거 | (2)RF API | (3)store action | (4)엣지케이스 |
|------|-----------|-----------|-----------------|--------------|
| 포인터 | 핸들 드래그→타깃 핸들 | `onConnect` | `addEdge({from,to,fromPort})` | `isValidConnection`로 self/중복/타입 거부 |
| **명령형(키보드)** | 소스 노드 선택→"연결 추가"→대상 **콤보박스** | `onConnect` 합성 | `addEdge` | IF는 true/false **라디오** 선택 후 확정; aria-live assertive |

- **IF 다중 핸들**: `fromPort` = `'out' | 'true' | 'false'`(실측 `GraphEdge.fromPortOrDefault`='out'). `graph-adapter.ts`가 `fromPort↔sourceHandle` 라운드트립 보존(R2/R5).
- 연결 진입: aria-live "연결 모드, 대상 선택 또는 Esc", `C` 단축키/메뉴/치트시트 병기.

### 6.3 줌/팬 제스처 매트릭스

보수적 단일 기본(자동 전환 금지, 수동 토글 localStorage 기억). `panOnDrag↔selectionOnDrag` 동버튼 배타, `zoomOnScroll↔panOnScroll` 배타 반영.

| 동작 | 마우스 기본 | 트랙패드 프리셋 | RF 옵션 |
|------|------------|----------------|---------|
| 줌 | 휠 | Ctrl/⌘+휠(핀치) | `zoomOnScroll` / `zoomOnPinch`(ctrlKey 항상 허용) |
| 팬 | Space-hold 드래그 / 중클릭 드래그 | 2지 스크롤 | `panOnDrag=[1]`(middle) + Space 핸들러 |
| 박스선택 | Shift+드래그 | Shift+드래그 | `selectionOnDrag + selectionKeyCode=Shift` |
| fit / 1:1 / 줌% | `F` / `1` / 컨트롤바 | 동일 | `fitView` / `zoomTo(1)` / 라이브 `%` 표시 |

- **항상 보이는 컨트롤바**: `[− 100% +] [⤢fit] [1:1]` + 줌% 라이브. 미니맵: 카테고리색 + 뷰포트 사각형 + 클릭 점프.

### 6.4 다중선택·정렬·스냅

- 다중선택: Shift+드래그 박스 / Shift+클릭 토글 / `Ctrl+A` 전체.
- 정렬·분배: 좌/우/상/하/중앙 정렬, 가로/세로 균등분배 — **키보드 실행 가능**(메뉴 명령).
- 스냅: `G` 토글(그리드 스냅), 스마트 가이드(드래그 중 정렬선). 좌표는 백엔드 `x/y`와 정합(스냅 후 좌표 저장).
- 자동레이아웃: dagre/elkjs(미설치→도입제안, 기능플래그+lazy import). 키보드 사용자의 "자유배치 동등" 해결책.

### 6.5 Undo/Redo 커밋 단위

- 히스토리(zundo, `partialize`로 `nodes/edges/nodeData`만): **dragStop=1엔트리**, 선택/뷰포트 변경 **제외**, 속성수정 debounce 후 커밋.
- 단축키 캔버스 컨테이너 스코프 + `input/textarea/contenteditable` 포커스 가드(프로토타입 typing 가드 정식화).
- 파괴 삭제: 연결 엣지+바인딩 동시삭제 경고 토스트 + 5초 Undo. 영향 임계(의존 바인딩 ≥3)면 사전 확인 다이얼로그 승격.

### 6.6 복사/붙여넣기 — 바인딩 재매핑(B·C 공통)

- 복사: 선택 노드 id 집합 → old→new id 매핑 테이블 생성.
- 붙여넣기: 모든 필드 `{{key@sourceId}}` 토큰 파싱 → **내부참조는 new id로 치환, 외부참조는 유지+"외부 참조" 경고 배지**. 토큰 파싱/치환 공용 유틸 + 단위테스트(그리디/중첩/`@req:`/하이픈불가 sourceId).

### 6.7 전체 키맵

| 키 | 동작 | 키 | 동작 |
|----|------|----|------|
| `?` | 단축키 치트시트 | `Delete`/`Backspace` | 선택 삭제(+바인딩 경고) |
| `⌘/Ctrl+Z` / `⌘⇧Z` | undo / redo | `⌘/Ctrl+C` / `V` | 복사 / 붙여넣기(재매핑) |
| `F` / `1` / `0` | fit / 1:1 / reset zoom | `Ctrl+A` | 전체 선택 |
| `Space`(hold) | 팬 모드 | `G` | 스냅 토글 |
| `C` | 연결 모드 | `Esc` | 모드 취소/패널 닫기 |
| `Enter`(팔레트) | 노드 생성 | `⌘/Ctrl+S` | 저장 |

> **role=application 비용**(명시): 캔버스가 탐색키를 가로채므로 SR 사용자에게 브라우즈 모드 충돌 가능 → 캔버스 외부에 "노드 목록/명령" 대체 탐색 표면 제공(§11).

### 6.8 인터랙션 4상태

| 상태 | 표현 |
|------|------|
| 빈 | 빈 캔버스 CTA("팔레트에서 노드 추가 또는 샘플 불러오기") |
| 로딩 | 그래프 fetch 중 캔버스 스켈레톤 + fitView 지연 |
| 실행중 | 노드 펄스+스피너(아이콘+텍스트 이중부호화), 색은 보조 |
| 에러 | 실패 노드 빨간 테두리 + "실패 노드로 이동" |

---

## 7. 데이터 바인딩 / 토큰 매핑 UX

### 7.1 토큰 문법 계약 (D4 — 백엔드 정규식 1:1)

`token-grammar.ts`는 백엔드 `TokenResolver.tokenPattern()` 미러:
```
/\{\{\s*([\w.-]+)(?:@(req:)?([A-Za-z0-9]+))?\s*}}/
        └─key──┘     └req┘  └─sourceId─┘
```

| 형태 | 의미 | Binding.scope |
|------|------|---------------|
| `{{key}}` | bare — 가장 가까운 상위 노드 출력 | (없음) |
| `{{key@id}}` | 명시 소스 노드 | `null` |
| `{{key@req:id}}` | 요청값 스코프 | `'req'` |

- key 클래스 `[\w.-]+`(점·하이픈 허용), sourceId 클래스 `[A-Za-z0-9]+`(D5 id 발급기 정합).
- 프론트 `rewriteTokens`와 백엔드 동일 상수 공유. 단위테스트: `@req:` 접두·bare·점 포함 키·하이픈 불가 sourceId.

### 7.2 칩 UX (sourceId 은닉)

```
필드 입력 ────────────────────── [{ } 데이터 삽입] ← 모든 바인딩 가능 필드 표준 아이콘
┌────────────────────────────────┐
│ Authorization: [🔗 토큰 · auth] │ ← 닫힌 칩(라벨=key, 노드이름·카테고리; sourceId 은닉)
└────────────────────────────────┘
```

- 칩 라벨 합성: `Binding.nodeName`(폴백: id) + `cat` 아이콘 + `key`. **sourceId·`{{}}` 표기 비노출**(닫힌 칩). 고급 사용자만 "raw 토큰 보기".
- `rawBody`(json/xml/raw) 내 인라인 토큰: 코드 에디터에서 `{{}}` 노출 불가피 → 토큰 하이라이트+호버 카드(노드명·key)로 절충(원칙 위반 최소화).

### 7.3 출력 스키마 탐색 (D7 — 평면 key만)

```
┌ 데이터 삽입 ─────────────────[×]┐
│ 🔍 키 검색…                     │
│ ▸ POST 결제 (#a1b2c3d4)         │ ← 소스 노드(상위)
│    · id          [타입 미상]    │ ← outputs[].key 평면
│    · amount      [number]       │ ← type 선언 시만 배지
│    · status                     │
│ ▸ start (#z9y8…)  ⓘ 아직 실행 안함│
│    [한 번 실행해 응답 캡처]      │ ← 빈 스키마 1급 빈상태 CTA
└─────────────────────────────────┘
```

- **빈 스키마 빈상태**(1급): "아직 응답 구조 모름 → ①실행해 캡처 ②샘플 응답 붙여넣기 ③수기 입력(최후)". `outputs[]` 빈 카탈로그.
- 중첩 path·배열 인덱싱: **제거**(백엔드 JsonPointer 게이트, §17).
- 타입: `NodeOutput.type` 선언 시만 배지, 미선언="타입 미상". **타입 불일치 경고 미표시**(flat resolver엔 타입검증 없음 → 거짓 안심 방지).

### 7.4 유효성 & dangling 회복

- **검증 책임(D6)**: 프론트=즉시 차단(사이클·dangling·위상역전 전체 1패스), 백엔드=권위(id중복+엣지존재). 사이클/위상은 백엔드 미검증→프론트 단독 책임(주석 명시).
- **소스 삭제 사전 경고**: "의존 바인딩 N개 끊김"(삭제 후 빨간 경고 흩뿌리기 금지).
- **dangling 인라인 수리 3택**: 다른 소스 / 상수 전환 / 바인딩 제거. 검증 모달→해당 노드 fit+필드 포커스 점프+"깨진 바인딩 N개 일괄" 패널. dangling 칩은 sourceId 미노출·노드이름 표시·삭제/리네임 자동추적·빨간 경고칩·실행 전 차단.

---

## 8. 속성 패널 & HTTP 요청 빌더

```
┌ 속성 ───────────────────────[×]┐
│ ⬤POST  결제 요청          [이름]│ ← 카테고리 아이콘+라벨(색 단독 금지)
│ ┌─────────────────────────────┐ │
│ │메서드 [POST▾(6종)]           │ │ ← GET/POST/PUT/PATCH/DELETE/HEAD
│ │baseUrl [https://…] [{ }]     │ │ ← baseUrlBound 칩 가능
│ │path    [/charge]             │ │
│ ├ 탭: Params|Headers|Body|출력 ┤ │
│ │ Params  key  value   [{ }][×]│ │ ← NodeField.bound 칩
│ │  + 추가                      │ │
│ │ Body  타입[json▾]            │ │ ← json|urlencoded|form|raw|xml
│ │  {  "amount": {{amount@…}} } │ │ ← 토큰 하이라이트
│ │ respType [json▾]             │ │ ← json|text|xml|binary
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

- **노드 타입별 패널**: start/end(메타만) · set(vars: key/value/**secret 마스킹**·bound) · http(위) · if(condition + true/false 분기 라벨) · wait(waitMsg + waitFields).
- **reqMode 토글 제거**(D, R1): `reqMode=client` 폐기 확정 → client/server 토글 미노출(`types.ts` `ReqMode` 잔존은 오인 주의 주석).
- **시크릿**: `NodeVar.secret=true` → 값 `••••` 마스킹 + 표시 토글. 실행 로그 capture off와 정합.
- **BodyType별 에디터**: json/xml/raw=코드에디터(토큰 하이라이트), urlencoded/form=key-value 행. `jsonRaw` 플래그 보존.
- **바인딩 아이콘 표준화**: 모든 바인딩 가능 필드(baseUrl/params/headers/body/vars) 우측 `[{ }]`.

---

## 9. 실행/디버깅 경험

### 9.1 동기 모델(D3) — 정직한 어포던스

```
[▶ 실행] ──클릭──> 버튼 disable(중복방지) + 인라인 진행
   │
   ├─ <임계(예 8s): 블로킹 스피너 "실행 중…" (aria-live polite)
   │     └─ 완료 → ExecutionDetail 일괄 렌더 → 하단 로그 패널
   │
   └─ ≥임계 초과: 비차단 전환 → GET /flows/{id}/runs 폴링으로 완료 감지
         └─ "백그라운드 실행 중, 완료 시 알림"
```

| 상태 | UI |
|------|----|
| 실행 없음 | 하단 패널 "아직 실행 안 함 · ▶실행" |
| 실행중(블로킹) | 노드 펄스+스피너, 실행 버튼 disable |
| 완료 | ExecutionDetail 타임라인 일괄 |
| 실패 | 실패 노드 강조 + 에러 + 재시도(재실행) |

- **취소: 비노출**(실측 cancel 엔드포인트 없음). 불가피 표기 시 "요청 중단(서버 작업은 계속될 수 있음)" 정직 라벨. **단계 힌트 미표시**(동기 단일요청, 서버 push 없음).
- **WAITING**: 동기 응답이 WAITING으로 종료 가능(실측 `ExecutionStatus.WAITING`) → wait 노드 일시정지 배지 + 입력폼 포커스. 재개 경로는 백엔드 내구성 게이트(자리예약).

### 9.2 요청/응답 뷰어

- capture off 기본 → "본문 미저장(보안)". 켜진 경우만 요청/응답 표시(복사·다운로드).
- `respType=binary`: 미리보기 불가, 다운로드만.
- 비시각 피드백: 아이콘+텍스트 이중부호화(색 보조), 완료 요약 aria-live **assertive**.

### 9.3 재실행·SSE 대비

- 재실행: 같은 `RunRequest(input, versionNo)` 반복. 실패 노드부터 재시도는 백엔드 부분실행 게이트(미지원→전체 재실행).
- **SSE 대비**: 패널 구조 불변, **데이터소스 교체 범위로 격리**(폴링→SSE 스트림). RunPanel 타임라인이 스트리밍 수신 지점.

---

## 10. 버전관리 / Diff / 롤백 + Import/Export

### 10.1 저장 vs 버전 (D12)

| 동작 | API | 의미 |
|------|-----|------|
| 자동저장(드래프트) | 로컬(zustand persist) | 미저장 가드 대상 |
| 명시 저장 = 버전 스냅샷 | `POST /flows/{id}/versions {graph, note}` | 불변 스냅샷 |
| 메타 수정 | `PATCH /flows/{id}` | name/description |

- **낙관적 잠금**: `updatedAt`/`If-Match` → 409 시 충돌 다이얼로그 **[덮어쓰기 / 새 버전으로 / 비교]**(재시도 아님).
- 이탈 가드: unsaved route guard + `beforeunload`.

### 10.2 버전 목록 / Diff

```
┌ 버전 ──────────────────────────────────────┐
│ ● v3 (현재)  "쿠폰 분기 추가"  2분 전  alice │
│ ○ v2         "타임아웃 조정"   1일 전  bob   │ [현재와 비교][이 버전으로 복원]
│ ○ v1         "초기"            3일 전  alice │
├ Diff: v2 → v3 ─────────────────────────────┤
│ + 노드: IF 쿠폰여부 (#k2…)                  │ ← graph JSON 구조 diff
│ ~ 노드: POST 결제 — path 변경               │
│ - 엣지: start→end                           │
└─────────────────────────────────────────────┘
```

- Diff는 `graph` JSON 구조 비교(노드 추가/변경/삭제, 엣지, 필드/바인딩 변경). `versionGraph(id, no)`로 양쪽 로드.
- 복원(롤백) = 선택 버전 graph를 새 버전으로 저장(불변성 유지, 기존 버전 보존).

### 10.3 Import/Export

- Export: `GET /flows/{id}/export`(=`exportUrl`) 다운로드. 그래프 포맷 `{name, nodes, edges}`(프로토타입 export 동일).
- Import: `POST /flows/import`(`importFlow`). 모달에서 파일 드롭/붙여넣기 → 스키마 검증(노드 id `[A-Za-z0-9]+` 정규화 1패스, D5) → 생성.
- 복제(D11) = export→이름 "(사본)" 치환→import 원자 경로.
- 게이트: import의 name 중복 처리·신규 id 발급 규약(§17).

---

## 11. 접근성(WCAG 2.2 AA) & i18n

### 11.1 체크리스트

| SC | 항목 | 적용 |
|----|------|------|
| 1.3.1 | 정보·관계 | 랜드마크(§3.3), 캔버스 노드 목록 SR 표면 |
| 1.4.1 | 색 단독 금지 | 메서드/카테고리/상태 색+아이콘+텍스트(§4) |
| 1.4.3 | 대비 4.5:1 | 토큰 라이트/다크 측정(§4.1), teal/cyan/green 색맹 검수 |
| 1.4.11 | 비텍스트 대비 3:1 | 포커스 링·핸들·보더 |
| 2.1.1 | 키보드 | 노드 생성 Enter·명령형 연결·정렬 명령·전체 키맵(§6) |
| 2.1.2 | 키보드 트랩 없음 | role=application Esc 탈출, 패널 포커스 트랩 해제 |
| 2.4.3 | 포커스 순서 | 카드 2스톱, DOM=포커스 순서 |
| 2.4.7 | 포커스 가시 | `:focus-visible` 링(3:1) |
| 2.4.11 | 포커스 가림 안됨(2.2) | 도킹 패널이 포커스 요소 안 가림 |
| 2.5.7 | 드래그 동작(2.2 신규) | 모든 드래그에 비드래그 대안(생성/연결/삭제/팬) |
| 2.5.8 | 타깃 크기 24px(2.2) | 핸들·케밥·칩 최소 24×24 |
| 3.2.6 | 일관된 도움(2.2) | `?` 치트시트·도움 위치 일관 |
| 3.3.7 | 중복 입력 방지(2.2) | 복제·재실행 시 입력 재사용 |
| 4.1.2 | 이름·역할·값 | RF 커스텀 노드 ARIA, 칩 `aria-label` |
| 4.1.3 | 상태 메시지 | aria-live(실행/연결/추가 통지) |

- **NVDA/VoiceOver 워크스루를 수용기준화**(별도 캔버스 a11y 라운드). 1차 MVP=RF12 내장 키보드 + 팔레트 Enter + 명령형 연결.

### 11.2 i18n (ko/en)

- 라이브러리: `react-i18next`/경량 자체(미설치→도입제안). 키 네임스페이스: `common/dashboard/editor/run/version/a11y`.
- 메서드/상태/카테고리 라벨 번역, 토큰 문법은 비번역(코드 계약). 숫자/날짜 `Intl`. 본 스펙의 UX 용어는 ko 1차+en 병기.

---

## 12. 상태 / 피드백 / 온보딩 / 모션

- **상태 4종 강제**: 모든 화면·인터랙션(빈/로딩/에러/성공). 스켈레톤은 레이아웃 시프트 0.
- **에러 분류**: transient=토스트(자동 dismiss, 2.2.1 호버 정지) / actionable-inline=필드·노드 상주. `ApiError.details[]`→필드 인라인 매핑(실측 `ApiError.details: string[]`).
- **온보딩**: 첫 사용자 샘플 워크플로 1클릭 복제(First-run success path), 코치마크(최소), `?` 치트시트, 빈 캔버스 CTA, 툴팁 단축키 병기.
- **모션**: 패널/카드 진입(`--fl-dur-base`), 연결선 dashflow, 실행중 펄스 링. `prefers-reduced-motion`서 전부 0ms(모션 토큰 2급).

---

## 13. 성능 & 반응형 전략

### 13.1 성능 (수용기준, AC)

| 지표 | 목표 |
|------|------|
| 노드 드래그 | 60fps |
| 초기 그래프 렌더 | <500ms |
| 목표 규모 | 200 노드(`maxNodesPerRun`=200 실측)/유사 엣지 |

- **리렌더 격리(D2)**: 노드 컴포넌트 `React.memo` + zustand 좁은 셀렉터(`useStoreWithEqualityFn`, 자기 id 구독). nodes/edges는 RF controlled, **고빈도 위치 변경은 RF 내부 store** 사용·커밋만 zustand.
- `onlyRenderVisibleElements` 컬링, 줌아웃 LOD(라벨 생략), 노드 검색/필터+결과 fit, 서브그래프 그룹/접기.
- 대시보드: 1차 상위 N(200) 렌더 + "검색 사용" 안내, **가상스크롤 보류**(D10, 미설치·가변높이 카드 충돌).

### 13.2 반응형 — §3.3 표 참조. 200% reflow 가로스크롤 금지(AC), 모바일 편집 게이트·조회 완전동작.

---

## 14. 컴포넌트 인벤토리 & 폴더 구조

### 14.1 인벤토리

| 컴포넌트 | 역할 | Props 개요 |
|----------|------|-----------|
| `AppShellTier1` | 헤더+나브 셸 | `children` |
| `EditorShell` | 100dvh 풀블리드 | `flowId` |
| `WorkflowCard` | 대시보드 카드(2 포커스스톱) | `summary, lastRun, onOpen, onMenu` |
| `StatusBadge` | 상태 색+아이콘+텍스트 | `status` |
| `MethodTag` | 메서드 6색 칩 | `method` |
| `FlowCanvas` | RF 래퍼(role=application) | `nodes,edges,onConnect,…` |
| `NodeCard` | 커스텀 노드(카테고리별) | `data, selected` (memo) |
| `BranchNode` | IF true/false 핸들 | `data` |
| `Palette` | 노드 팔레트(클릭/드래그/Enter) | `onAdd` |
| `CanvasControls` | 줌%/fit/1:1/미니맵 | `viewport` |
| `PropertyPanel` | 노드별 속성 | `node, onChange` |
| `HttpRequestBuilder` | method/url/탭 | `node, onChange` |
| `KeyValueEditor` | params/headers 행 | `fields, onChange` |
| `BodyEditor` | bodyType별 에디터 | `bodyType, value, tokens` |
| `BindingChip` | 닫힌 토큰 칩(sourceId 은닉) | `binding, onEdit, dangling` |
| `BindingPicker` | 출력 스키마 탐색 팝오버 | `sources, onPick` |
| `RunPanel` | 하단 로그/타임라인 | `execution` |
| `NodeExecutionRow` | 노드별 실행행 | `node`(NodeExecutionView) |
| `VersionList` / `DiffView` | 버전·diff | `versions / a,b` |
| `ImportDialog` | import 모달(Radix Dialog) | `onImport` |
| `ConflictDialog` | 409 충돌(덮/새버전/비교) | `local, remote` |
| `Toast`/`ToastUndo` | 피드백·삭제 undo | `…` |
| `CheatSheet` | `?` 단축키 | — |
| `EmptyState`/`Skeleton`/`ErrorState` | 상태 4종 | `…` |

### 14.2 폴더 구조

```
src/
├─ api/            client.ts(실측) · types.ts(실측, 공유) · queries/(react-query 훅)
├─ app/            App.tsx · router.tsx · shells/(Tier1, EditorShell)
├─ routes/         Dashboard · Editor · RunDetail · Versions · Executions · Settings
├─ canvas/         FlowCanvas · nodes/ · edges/ · controls/ · graph-adapter.ts · react-flow-adapter.css
├─ store/          editorStore.ts(zustand+zundo) · selectors.ts
├─ binding/        token-grammar.ts(백엔드 SSOT 미러) · rewriteTokens.ts · BindingChip/Picker · __tests__/
├─ panels/         PropertyPanel · HttpRequestBuilder · RunPanel · …
├─ components/     ui/(Radix 래퍼: Dialog/Popover/Tooltip) · StatusBadge · MethodTag · EmptyState …
├─ design/         tokens.css(=index.css 확장) · theme.ts(다크 토글)
├─ i18n/           index.ts · ko.json · en.json
└─ lib/            ids.ts(customAlphabet 8) · validation.ts(graph 공유 순수함수) · format.ts
```

---

## 15. 구현 매핑

| 영역 | 결정 |
|------|------|
| 캔버스 | `@xyflow/react` v12 controlled, 커스텀 노드 memo, `screenToFlowPosition`, `isValidConnection`, 커스텀 키보드 핸들러(role=application) |
| 상태(D2) | **zustand** = 캔버스(nodes/edges/selection/viewport/nodeData) + zundo 히스토리. **react-query** = 서버 정의/실행(`flowsApi`,`runsApi`). 경계 엄수(refetch가 미저장 편집 덮어쓰기 금지) |
| 라우팅 | react-router-dom 7, 중첩+lazy, `?node/?panel/runId/versionNo` 딥링크, unsaved 가드 |
| API/타입 | `api/client.ts`·`types.ts` 실측 그대로 SSOT. `graph-adapter.ts`(toRF/fromRF, fromPort↔sourceHandle)만 신규. import만 직렬화에 사용 |
| 토큰 계약 | `token-grammar.ts`가 `TokenResolver` 정규식 미러(D4), `lib/ids.ts` customAlphabet(D5), `rewriteTokens` 단위테스트 |
| 검증 | `lib/validation.ts` 공유 순수함수(사이클·dangling·위상=프론트, 백엔드는 id중복+엣지존재 권위) |
| 폼 | 속성 패널 경량 제어 컴포넌트(react-hook-form 도입제안 가능), `ApiError.details[]`→필드 인라인 |
| 테스트 | rewriteTokens/graph-adapter/validation 단위테스트, NVDA/VO 워크스루 AC, 성능 예산 AC(60fps/<500ms) |
| 도입 제안(미설치) | Radix(Dialog/Popover/Tooltip), zundo, @dagrejs/dagre(기능플래그 lazy), i18next, react-virtual(보류) — 전부 **승인 필요** 표기 |

---

## 16. 빌드 로드맵

| Phase | 화면/기능 | 완료기준(AC) |
|-------|-----------|--------------|
| **P0 — 골격·계약** | 2티어 셸/라우팅, 디자인 토큰+다크, `graph-adapter.ts`, `token-grammar.ts`+`ids.ts`, 대시보드 단일 카드뷰(상태 게이트 disabled), 캔버스 CRUD(생성 3경로·포인터 연결·줌/팬·저장/버전), 속성 패널, 동기 실행+하단 로그 | 토큰 라운드트립(import) 무손실, id `[A-Za-z0-9]+`, 저장→실행→ExecutionDetail 렌더, 키보드 노드 생성, 60fps/200노드 |
| **P1 — 신뢰성·a11y** | 키보드 명령형 연결, 바인딩 칩/Picker(평면 key), dangling 검증·인라인 수리, undo(sendBeacon·2.2.1), 409 충돌 다이얼로그, 버전 diff/롤백, import/export·복제 원자, 실행 폴링 전환, i18n ko/en, WCAG AA 체크리스트 | NVDA/VO 워크스루 통과, dangling 회복 동선, 멀티탭 동기화, 200% reflow 무가로스크롤 |
| **P2 — 고도화** | 자동레이아웃(dagre, flag), 미니맵 LOD/컬링, 정렬·분배, 서브그래프 그룹, 컴팩트뷰, 온보딩 샘플 복제, 커맨드팔레트, (게이트 해제 시)상태 비정규화·SSE 스트림·중첩 path·capture 토글 | 대형 그래프 인지/성능, SSE 데이터소스 교체(패널 불변) |

---

## 17. 미해결 쟁점 & 다음 액션

**부분 수렴 — 잔여는 전부 백엔드 계약 게이트.** 프론트는 자리예약+게이트 표기로 진행, 계약 확정 시 해제.

| # | 게이트 | 막힌 프론트 기능 | 필요 백엔드 결정 | 1차 우회 |
|---|--------|-----------------|------------------|----------|
| G1 | **lastRun 수화** | 대시보드 상태 필터(D9) | `FlowSummary.lastRunStatus/At` 비정규화 또는 `?expand=lastRun` 또는 `POST /flows/last-runs` 배치 중 택1 | `recent()` 일괄 + 미덮임 "미상" 버킷, 필터 disabled |
| G2 | **중첩 path 토큰** | typed 칩·중첩 키 탐색(D7) | `TokenResolver`에 JsonPointer 추가 | 평면 key만 |
| G3 | **capture 토글** | 요청/응답 본문 표시 | `RunRequest`에 `captureBodies` DTO 확장 | "본문 미저장" + 링크 비노출 |
| G4 | **사이클 거부** | 검증 권위 이중화(D6) | `GraphValidator`에 사이클/위상 검증 | 프론트 단독 차단(주석 명시) |
| G5 | **import 규약** | 복제·import name/id(D11) | import의 name 중복 처리·신규 id 발급 규약 | 클라 이름 치환 + 실패 시 보상 DELETE |
| G6 | **취소/단계 힌트** | 실행 취소(D3) | cancel 엔드포인트·진행 push | 비노출(정직) |
| G7 | **wait 재개** | WAITING 재개 폼 제출(§9) | 내구성 재개·재개 엔드포인트 | 일시정지 배지·재개 자리예약 |
| G8 | **SSE 스트림** | 실시간 실행 피드백 | SSE/비동기 실행 | 폴링(데이터소스 격리) |
| G9 | **OIDC/권한** | 로그인·viewer/editor 내비 | OIDC + 권한 모델 | permitAll·자리예약 |

다음 액션(우선순위): (1) G1·G5 백엔드 협의(대시보드·복제 신뢰성 직결) → (2) P0 착수(셸·계약·캔버스 CRUD) → (3) NVDA/VO 워크스루 AC 수립 → (4) G2/G3 협의(바인딩·디버깅 깊이) → (5) P1.

> 관련 파일(절대경로): `C:\Users\jslim\Downloads\REST API 워크플로 시스템\frontend\src\api\types.ts` (공유 타입 SSOT), `...\frontend\src\api\client.ts` (API 계약), `...\frontend\src\index.css` (토큰 기반), `...\frontend\src\App.tsx` (라우팅 골격), `...\backend\src\main\java\com\flowlink\execution\engine\TokenResolver.java` (토큰 정규식 SSOT), `...\backend\src\main\java\com\flowlink\core\graph\GraphValidator.java` (검증 권위 범위), `...\backend\...\core\graph\GraphEdge.java` (fromPort 계약), `...\backend\...\execution\ExecutionController.java` (cancel 부재 확인), `...\backend\...\execution\config\ExecutionProperties.java` (capture off·maxNodes 200).