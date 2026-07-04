# 그래프 구조 · 엣지 · 토큰 문법

## 그래프 JSON 최상위

```json
{ "name": "워크플로 이름", "nodes": [ ...노드... ], "edges": [ ...엣지... ] }
```

- `nodes`: 노드 객체 배열 (각 노드는 `nodes.md` 참조)
- `edges`: 엣지 배열
- 백엔드는 그래프를 raw(text)로 저장 — 정의되지 않은 필드도 라운드트립 보존되지만, 위 3개만 쓰면 된다.

## 엣지

```json
{ "id": "e1", "from": "소스노드id", "to": "타깃노드id", "fromPort": "out" }
```

- `from`/`to`: **`node.id`** (이름 아님)
- `fromPort`: 소스 출력 핸들. **일반 노드는 생략**(기본 `"out"`).
- **IF 노드만** 분기별로 명시: 참 분기 `"fromPort":"true"`, 거짓 분기 `"fromPort":"false"`.
- 실행은 Kahn 위상정렬 순서. 엣지 나열 순서는 무관하지만, 관례상 `start→…→end` 흐름 순으로 쓰고 IF 뒤에 true/false 두 엣지를 연속 배치.
- 사이클 금지, 노드 수 상한 200.

예 — IF 분기:
```json
"edges":[
  {"id":"e1","from":"start001","to":"if000001"},
  {"id":"e2","from":"if000001","to":"httpstat","fromPort":"true"},
  {"id":"e3","from":"if000001","to":"setfail1","fromPort":"false"},
  {"id":"e4","from":"httpstat","to":"end00001"},
  {"id":"e5","from":"setfail1","to":"end00001"}
]
```

## 토큰 / 바인딩 문법

정규식: `{{ key[@[req:]sourceId] }}` — `key`는 `[\w.-]+`, `sourceId`는 `[A-Za-z0-9]+`.

3가지 형태:
- `{{ key }}` — **bare**: 가장 가까운 상위 노드부터 그 key를 출력에 가진 첫 노드 값.
- `{{ key@nodeId }}` — **명시 소스**: `nodeId` 노드 출력에서 key 추출.
- `{{ key@req:nodeId }}` — **요청 스코프**: 그 노드의 요청값에서 추출.

★ **핵심: `@` 뒤는 노드 이름이 아니라 `node.id`.** 예) 이름이 "로그인"이어도 id가 `httplogn`이면 `{{ token@httplogn }}`.

특수:
- `{{ url@wait노드id }}` — wait 노드의 콜백 **수신 URL**. 실행 시작 시 ctx에 시드되어 **wait 노드보다 앞선 노드**(form의 returnUrl 등)에서도 해석된다. → form→wait 콜백 패턴의 핵심.
- 문자열 안에 리터럴+토큰 혼용 가능: `"Bearer {{ token@httplogn }}"`, `"/api/orders/{{ orderId@httpordr }}"`.
- 필드에서 구조적 바인딩(`bound:{key,sourceId,scope?}`)을 쓰면 value 대신 그 값이 쓰인다. 대부분은 value 문자열에 `{{토큰}}`을 넣는 방식으로 충분하다.

## cat 색 카테고리

`cat`은 노드 카드 색. 보통 `type`과 같은 값을 쓰되 **http만 `"generic"`**.

| cat | 의미 |
|---|---|
| start / end | 시작 / 끝 |
| set | 변수 |
| if | 조건 분기(T/F 핸들) |
| assert | 검증(거짓이면 FAILED) |
| generic | HTTP 노드 |
| form | 폼/결제창 |
| input | 사용자 입력 |
| wait | 콜백 대기 |
| transform | 변환 |
| tcp | TCP 전문 |

## 대표 패턴 (데모에서 추출)

**결제창 → 콜백 → 검증** (`demos/pay-mock/01-결제창-콜백.json`)
`start → set(orderId/amount) → form(결제창, returnUrl={{ url@wait0001 }}) → wait(콜백, outputs resultCode/tid) → assert({{ resultCode@wait0001 }} == '0000') → end`. 엣지 전부 일반(assert는 분기 아님).

**결제 + 분기** (`demos/demo-01-결제게이트웨이.json`)
`… → wait → if({{ resultCode@wait0001 }} == '0000')` → true→`http(상태조회)`→end, false→`set(실패)`→end.

**로그인 토큰 → 인증 헤더 → 경로 바인딩 → 변환** (`demos/demo-03-주문API.json`)
`start → http(로그인, outputs token) → http(주문, 헤더 Bearer {{ token@httplogn }}, body qty type:number) → http(조회, path=/api/orders/{{ orderId@httpordr }}) → transform(concat) → end`.

**OTP 사용자 입력 → 검증 → 분기** (`demos/demo-02-OTP인증.json`)
`start → http(OTP 발송, outputs hint) → input(waitMsg에 {{ hint@httpsend }}, waitFields otp) → http(검증, body otp={{ otp@input001 }}, outputs verified:boolean) → if({{ verified@httpverf }} == true)` → 성공/실패 set → end.
