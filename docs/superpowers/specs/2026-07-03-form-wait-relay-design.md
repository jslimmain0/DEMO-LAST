# form/wait 노드 분리 + relay.js — 설계 (2026-07-03, 사용자 승인)

> **status: as-built** — form/wait/input 노드·relay.js 는 현행. 현행 진실원은 [CLAUDE.md](../../../CLAUDE.md).

## 배경 · 결정

- origin/main 에서 WAIT 노드가 "폼 전송"으로 재용도되면서 사용자입력대기 노드가 사라짐 → **둘을 분리해 복원**한다.
- 사용자가 제시한 스펙(브라우저 엔진 executor.ts + relay.js 기준)을 **기존 Spring 백엔드 엔진에 각색**하기로 선택
  (AskUserQuestion: "백엔드 엔진에 각색"). 엔진은 Spring 유지, 콜백 수신은 relay.js → SSE → 브라우저 → resume API.
- 기존 `{{ __callbackUrl }}`/`{{ __notiUrl }}`/`{{ __corrId }}` 특수 토큰과 백엔드 콜백 엔드포인트
  (`/api/v1/executions/callback/{token}`, `/api/v1/callbacks`)는 relay 방식으로 **대체·제거**(콜백 경로 단일화).
- 추가 요청: 에디터 패널 크기조절 편의성 — origin/main 에 이미 구현됨(ResizeHandle) → 동작 확인 + 필요 시 폴리시(더블클릭 리셋 등)만 보강.

## 1. 노드 모델

| 타입 | 팔레트 라벨 | 역할 |
|---|---|---|
| `form` (신설) | 폼 전송(팝업) | 팝업 열고 hidden form 자동 submit → **기다리지 않고 즉시 다음 노드** |
| `wait` (재정의) | 콜백 대기 | relay 수신 URL 로 콜백/노티가 올 때까지 대기 (타임아웃 기본 120초) |
| `input` (추가 요청, 2026-07-03) | 사용자 입력 | 모달 input box 에 값 입력·confirm → 값이 노드 출력(다음 노드 바인딩). 필드 타입 string/number/boolean/json, 취소=중단(CANCELLED). `waitMsg`/`waitFields` 재사용, 구 `wait`+waitFields 그래프 자동 승격 |

- `form` 설정: `formAction`(팝업 URL, 바인딩 가능) · `formMethod`(POST/GET) · Hidden 필드(`fields.body`, 값마다 바인딩, [필드↔Raw] 유지)
- `wait` 설정(신규 필드): `waitTimeoutSec`(기본 120) · `callbackRespType`(text/html/json) · `callbackRespBody`(콜백에 줄 응답 본문) · `outputs`(콜백 본문 키 선언 — 바인딩 피커 칩용)
- 하위호환: 저장된 그래프의 `type==='wait' && formAction` 노드는 프론트 로드(toRF)·백엔드 실행(effective type) 양쪽에서 `form` 으로 간주.
- `waitMsg`/`waitFields`(구 OTP 모달)는 타입 정의만 유지(dead), 신규 UI 없음.

## 2. 실행 프로토콜 (백엔드 각색)

```
[프론트 onRun]
  waitNodes 있으면: relayRunId = crypto 영숫자 16자 생성
    → POST {relay}/exec/{relayRunId}/register  (wait 노드별 {contentType, body} — {{ url@id }} 토큰은 프론트에서 치환)
    → EventSource {relay}/events/{relayRunId} 연결 (노드ID별 버퍼 큐)
    → 실패는 기억만 해두고 진행 (form/http/set 만 있으면 relay 없이 동작)
  POST /flows/{id}/runs { relayRunId, relayBase }    ← RunRequest 확장
[백엔드 run]
  relayRunId 있으면 모든 wait 노드에 ctx.putOutput(waitId, {url: {relayBase}/cb/{relayRunId}/{waitId}}) 시드
    → {{ url@waitId }} 가 wait 보다 앞 노드에서도 해석됨 (TokenResolver 무변경)
  drive():
    form 도달 → action/필드 바인딩 해석(URL 비면 즉시 실패 "팝업 URL이 비어 있습니다") → pendingForm 으로 중단
    wait 도달 → pendingWait {nodeId, timeoutSec, receiveUrl} 로 중단
[프론트 루프]
  pendingForm → window.open('', 'flowlink_pay_{노드ID}', 'width=480,height=720') (창 이름 고정 → 재실행 시 재사용)
      팝업에 "이동 중…" + hidden form DOM 조립 → 자동 submit → resume {nodeId, popupOpened:true}  (fire-and-forget)
      차단 시 resume {nodeId, error:"팝업 차단됨 — 브라우저의 팝업 허용이 필요합니다"} → 노드 실패
  pendingWait → 버퍼에 콜백 있으면 즉시 소비, 없으면 Promise.race(SSE수신, 타임아웃, ⏹중단)
      콜백    → resume {nodeId, callback:{method,url,headers,body}}
      타임아웃 → resume {nodeId, error:"타임아웃 — n초 동안 콜백이 오지 않았습니다"}
      ⏹ 중단  → resume {nodeId, error:"실행이 중단되었습니다", aborted:true} + 대기 즉시 해제
[백엔드 resume]
  FORM: 성공 시 requestText=method·URL·hidden 필드 전체(줄 단위), responseText="팝업을 열고 form을 submit 했습니다"
  WAIT: 본문 tryParse(JSON→urlencoded→원문) → 출력 맵(비맵이면 {body:...}) + url 병합 → 다운스트림 바인딩/조건에 사용
        requestText=콜백 method·URL·헤더, responseText=본문 전문
```

- 토큰 문법 각색: 스펙의 `{{node.<id>.url}}` → `{{ url@<노드ID> }}`, `{{node.<id>.body.경로}}` → `{{ 키@<노드ID> }}`
  (이 엔진은 출력 맵 최상위 키만 해석 — HTTP 노드와 동일한 평면 규약).
- 바인딩 피커: 조상 소스에 더해 **그래프 내 모든 wait 노드의 수신 URL(`url`)** 을 별도 그룹으로 노출(앞 노드에서 returnUrl/notiUrl 에 꽂는 표준 패턴).
- 버퍼링 2중: relay 가 SSE 연결 전 수신분 보관·재생(중복 이벤트 무해) + 프론트 실행 루프가 노드ID별 큐로 wait 도달 전 도착분 보관.
- 콜백 도착 전 wait 도달 전에 실행이 실패/완료되면 relay 이벤트는 큐에 남을 뿐 소비되지 않음(무해).

## 3. relay.js (리포 루트, node:http, 의존성 0, 기본 8787)

| 엔드포인트 | 동작 |
|---|---|
| `POST /exec/{실행ID}/register` | wait 노드별 `{contentType, body}` 응답 설정 저장 |
| `GET /events/{실행ID}` | SSE. 연결 즉시 기수신분 재생, 25초 ping, 종료 시 정리 |
| `ANY /cb/{실행ID}/{노드ID}` | 보관 + SSE 전원 전달 + 등록 응답 반환(미등록 "OK"). GET 은 쿼리스트링을 본문으로 |
| `GET /health` | `{ok, execs}` |
| 그 외 | `frontend/dist` 정적 서빙(없는 경로는 index.html) |

- 모든 응답 CORS 오픈, OPTIONS 204. 상태 전부 메모리 — 실행ID별 마지막 접근 2시간 후 정리(SSE 종료), 재시작 시 소멸.
- 실행: `node relay.js [port]` 또는 `PORT`. relay 주소는 프론트 localStorage(`fl:relayBase`, 기본 `http://localhost:8787`).

## 4. UI

- RunPanel: 대기 중 카운트다운 "대기 중 (n초 남음)" 0.3초 갱신 · 수신 URL 표시(클릭 전체선택+복사) · ⏹ 실행 중단 버튼 · 콜백 스텝 카드(method/URL/헤더/본문/파싱 출력).
- 캔버스: 대기 중 wait 노드 청록 펄스 + 유입 엣지 애니메이션.
- PropertyPanel: form 섹션(팝업 URL·method·Hidden 필드·returnUrl 안내), wait 섹션(타임아웃·응답 형식/본문·수신 URL 패턴 표시·"바인딩 토큰 복사"·출력 규격·relay 주소 설정).
- 실행 중 beforeunload 이탈 경고(기존 dirty 경고에 running 조건 추가).

## 5. 한계 (스펙 §4 그대로 감수)

- 실행 중 탭 닫힘 = 실행 끊김(경고만). 팝업 차단 가능(차단 시 실패 메시지, 허용 후 재실행).
- form 노드는 인증 여부를 모름 — 판정은 다음 wait 의 콜백 수신.
- 콜백 발신자 인증/검증 없음(사내 테스트망 전제) — relayRunId 가 비밀값 역할.
- 백엔드 suspensions 인메모리(기존 한계 상속). API 직접 실행(브라우저 없이)은 wait 에서 WAITING 으로 남음.
