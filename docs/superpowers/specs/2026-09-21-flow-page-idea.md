# flow = 페이지 — 노드 흐름이 곧 하나의 화면 (아이디어)

2026-09-21 · 브랜치 `docs/flow-page-idea` (`refactor/trim-config` 에서 분기) · **상태: 아이디어, 미착수**

## 한 줄

flow 의 graph 를 **페이지 레이아웃**으로 읽고, 실행 상태가 그 페이지를 위에서부터 채워 나간다.
노드 하나 = 페이지 섹션 하나. 새 노드 타입·엔진 변경 없이, 프론트 렌더러 하나와 INPUT 필드 속성 몇 개로 된다.

## 왜

- 실행 입력이 `RunInputDialog` 의 자유 형식 key/value 표뿐이라, 만든 사람 말고는 뭘 넣어야 할지 모른다.
- 결과는 `RunPanel` 의 노드별 로그라 "결과를 본다"기보다 "디버깅한다"에 가깝다.
- INPUT 노드가 이미 실행 중간에 폼을 띄운다(`PendingInputRequest` → `InputPromptDialog`). 반대편(보여주기)만 없다.

## 지금 상태 (조사 요약)

| 것 | 위치 | 비고 |
|---|---|---|
| 노드 타입 | `core/graph/NodeType.kt`, `frontend/src/api/types.ts:5` | START/END/SET/HTTP/IF/WAIT/FORM/INPUT/ASSERT/TRANSFORM/TCP/SWITCH/NOTE/GROUP |
| 필드 선언 모양 | `core/graph/WaitField.kt` — `id/key/label/type(string\|number\|boolean\|json)` | 코드베이스 유일의 "필드 스키마" |
| 실행 시작 | `POST /flows/{id}/runs`, `RunRequest.input` 자유 JSON | `{{ key@input }}` 으로 참조 |
| flow 별 저장 입력 | `GET/PUT /flows/{id}/run-input` (app setting `runinput:<flowId>`) | 평면 `Record<string,string>`, 라벨·타입 없음 |
| 실행 중 사용자 입력 | INPUT 노드 → suspension → `PendingInputRequest{fields}` → `ResumeRequest.formValues` | 이미 동작 |
| 실행 진행 | 프론트 폴링 `GET /executions/{id}` 400ms (`Editor.tsx onRun`) | SSE/WS 없음 (WS 는 presence 만) |
| 외부 노출 | 없음. 비인증 경로는 `/mock/**`, `/relay/**`, `/hooks/**` 뿐 | |

## 결정 (토론 결과)

| 질문 | 선택 | 기각 |
|---|---|---|
| 화면을 어떻게 만드나 | **graph 가 페이지.** NOTE/GROUP 이 본문·섹션, INPUT 이 폼, 실행 노드가 진행 카드, END 가 결과 | 별도 폼 빌더 · VIEW 노드 신설(위저드) — 개념이 늘고, 한 페이지에서 흐름이 안 보임 |
| 한 페이지 vs 단계별 | **한 페이지.** 섹션이 다 보이고 실행이 위에서부터 채운다(노트북 셀 느낌) | 단계별 위저드 — 어디까지 왔는지 안 보임 |
| 입력이 많아지는 문제 | **이미 값이 있는 건 안 물어본다.** 시크릿·환경은 절대 화면에 안 나옴 / `run-input` 저장값은 기본값·숨김 / 빈 것만 입력 박스 | 워크스페이스 값 전부를 입력 박스로 |
| 시작 폼 | **START 바로 뒤 INPUT 노드**가 시작 폼. START 에 스키마를 따로 두지 않음 | START 스키마 신설 |
| 셀렉트 박스 선택지 | **고정은 `options`, 동적은 앞 HTTP 노드 출력을 바인딩**(`optionsFrom`) | 별도 옵션 API·스키마 서버 |

## 노드 → 페이지 요소

| 노드 | 페이지에서 | 기본 표시 |
|---|---|---|
| NOTE | 설명 문구(본문 텍스트) | 표시 |
| GROUP | 섹션 제목·묶음 | 표시 |
| INPUT | 폼 섹션. 실행 전엔 첫 INPUT 만 열림, 뒤의 INPUT 은 도달하면 활성화 | 표시 |
| HTTP / TCP / TRANSFORM | 진행 카드: 대기 → 실행 중 → 결과 요약, 펼치면 전체 | 요약 |
| IF / SWITCH | 안 탄 가지의 섹션은 흐리게 접힘 | 요약 |
| WAIT | 콜백 대기 카드 + 카운트다운 | 요약 |
| FORM | 팝업 열기 버튼 | 요약 |
| ASSERT | 통과/실패 배지 | 요약 |
| SET | 기본 숨김, "계산된 값" 토글 | 숨김 |
| END | 최종 결과 카드 | 표시 |

- 노드 속성에 **페이지 표시 옵션** 하나: `hidden | summary | full`. 내부 호출은 숨기고 사용자에게 의미 있는 것만 남긴다.
- 섹션 순서: graph 위상 정렬, 같은 깊이면 캔버스 y 좌표. 루프·합류는 처음엔 위상 정렬로 깔고 이상하면 y 로 조정.
- INPUT 이 중간에 있으면 위 카드는 결과가 채워진 채, 아래는 비활성 → "여기까지 확인하고 다음 입력".

## INPUT 필드(`WaitField`) 확장

| 속성 | 뜻 |
|---|---|
| `hidden` | 화면에 안 그림. 값은 `default` 로 채움 |
| `required` | 지금은 전부 필수 취급이라 선택 입력이 안 됨 |
| `default` | 기본값. 바인딩 허용(`{{ tenant@env }}`) |
| `type: 'select'` + `options: [{value,label}]` | 고정 선택지 |
| `optionsFrom` + `optionValue` / `optionLabel` | 동적 선택지: 앞 노드 출력 배열을 바인딩. 서버가 `PendingInputRequest` 만들 때 풀어서 내려줌(FORM 노드가 필드를 resolve 하는 자리와 같음) |

동적 선택지 예:

```
START → HTTP(고객 목록 조회) → INPUT(고객 선택: optionsFrom={{ items@고객목록 }}) → HTTP(주문 조회) → END
```

선택지 조회도 flow 의 일부다. 페이지에선 "불러오는 중" 카드가 잠깐 보였다가 셀렉트가 채워진다.

첫 화면부터 셀렉트가 필요하면 페이지를 열 때 **자동 실행**하면 된다(START → HTTP → INPUT 이니 첫 INPUT 에서 멈춤).
페이지 라우트에 "열면 자동 실행" 옵션 하나.

한계: 지역 → 도시 같은 **종속 셀렉트**는 한 INPUT 안에서 안 됨. INPUT 두 개로 나누면 되고, 페이지에선 두 섹션으로 보여 자연스럽다.

## 입력 수 줄이기 — 자동 분류

graph 를 스캔해 `{{ key@input }}` 참조를 뽑으면 "받을 수 있는 입력 전체"다.

- `run-input` 저장값 있는 key → 기본값 채워진 숨김 필드
- 저장값 없는 key → 필수 입력 박스

만든 사람이 스키마를 따로 안 써도 폼이 나오고, 기본값을 채울수록 폼이 짧아진다. 라벨·타입을 예쁘게 하고 싶을 때만 INPUT 노드로 옮긴다.
열 개 넘게 받는 flow 는 폼 문제가 아니라 flow 가 너무 많은 일을 하는 것 → INPUT 노드로 단계마다 나눠 받는다.

## 단계

1. **MVP (프론트 위주, 하루 이틀)**
   - `WaitField` 에 `hidden / required / default / select+options` (백엔드는 필드 추가 + `PendingInputRequest` 에 그대로 실어 보내기)
   - 노드 속성 `pageDisplay: hidden|summary|full`
   - 라우트 `/flows/:id/page` + `FlowPage` 렌더러. `Editor.tsx onRun` 의 폴링·resume 루프를 훅(`useFlowRun`)으로 빼서 에디터와 공유
   - 실행 상세에서도 같은 렌더러로 "사용자가 본 화면" 재생
2. **동적 선택지**: `optionsFrom` 바인딩을 서버에서 resolve
3. **공유 링크** (`/run/{token}`, 비로그인): 웹훅 토큰 방식. `SecurityConfig` · `SpaStaticConfig` 경로 추가, `requireWrite` 우회, 익명 실행 한도. 보안 판단이 들어가므로 별도 작업

## 열린 질문

- 결과 카드에 **무엇을** 보여줄지: END 노드에 "화면에 보여줄 값" 매핑을 둘지, 마지막 노드 출력을 JSON 트리로 보여주는 기본값으로 갈지
- 페이지 표시 옵션의 기본값(요약)이 실제 flow 에서 너무 시끄러운지 — 실제 flow 몇 개에 렌더러를 대 보고 결정
- 여러 사용자가 같은 실행 페이지를 보는 것: presence WS 가 있어 확장 여지는 있으나 당장은 아님
