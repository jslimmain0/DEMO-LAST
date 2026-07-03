# PG 결제 시나리오 데모 (내장 Mock 서버 대상)

FlowLink 의 **Mock 서버 기능**으로 만든 "가짜 결제 게이트웨이(PG)"를 대상으로,
승인·취소·빌키·가상계좌·노티·규격/인코딩·서명까지 실제 결제 테스트 흐름을 워크플로로 재현한다.
각 플로우는 **검증(assert) 노드**로 결과를 판정한다(거짓이면 실행 FAILED = 빨간불).

## 준비 (터미널 3개 + 브라우저)

```powershell
# ① 백엔드 (H2)
powershell -ExecutionPolicy Bypass -File backend\scripts\start.ps1 -H2
# ② relay (wait 콜백/노티 수신 — pg-01·06·07·08 에 필요)
node relay.js
# ③ 프론트
cd frontend; npm run dev
```

1. 상단 내비 **Mock 서버** → slug `pg-demo`, 종류 **프리셋: 가짜 결제 게이트웨이**로 생성
   (이미 있으면 생략). base URL 은 `http://localhost:18080/mock/pg-demo`.
2. 대시보드에서 새 워크플로 → 탑바 **[가져오기]** → `demos/pg/pg-XX-….json` 선택 → 저장 → ▶ 실행.

> 데모 JSON 의 HTTP/폼 노드 baseUrl 은 `…/mock/pg-demo` 로 박혀 있다. 다른 slug 를 쓰면 노드 baseUrl 을 바꾸면 된다.

## 시나리오

| 파일 | 쓰는 기능 | 판정(assert) |
|---|---|---|
| `pg-01-결제풀코스.json` | SET·**FORM(팝업)**·**WAIT(인증콜백)**·HTTP(승인)·**WAIT(승인노티)** | 인증 resultCode 0000 → 승인 0000 → **승인노티 tid == 승인 tid**(노티 대사) |
| `pg-02-전체취소.json` | HTTP(keyin)·취소 | cancelAmt==금액 && remainAmt=='0' |
| `pg-03-부분취소대사.json` | 취소(부분)·거래조회 | 잔액 7000 && 조회 status=PARTIAL |
| `pg-04-부분취소소진.json` | 취소 2회 체인 | 2차 후 잔액 0 && CANCELLED |
| `pg-05-빌키3단.json` | 빌키 발급→승인→취소 | billKey!=null → 승인 0000 → 취소 잔액 0 |
| `pg-06-가상계좌.json` | HTTP(채번)·**WAIT(입금노티)**·조회 | 노티 금액==채번 금액 && 조회 deposited==true |
| `pg-07-승인노티대사.json` | keyin(notiUrl)·**WAIT**·거래조회 | 노티 tid 로 조회한 금액 == 승인 금액 |
| `pg-08-취소노티.json` | 취소(notiUrl)·**WAIT** | 취소노티 cancelTid == 취소 응답 cancelTid |
| `pg-09-euckr왕복.json` | **charset EUC-KR**·urlencoded | custName=='홍길동' && 0000 |
| `pg-10-ms949.json` | **charset MS949** | 수신 charset == 'windows-949'(IANA명 부착 확인) |
| `pg-11-규격3종.json` | respType **xml**·**urlencoded**·**raw** 고정전문 | xml 0000 → urlenc tid!=null → raw 응답 == `OK\|{tid}\|CANCELLED` |
| `pg-12-해시서명.json` | SET·**TRANSFORM(concat×2·sha256)** | sha256(mid+amount+secret) 서명 승인 0000 |
| `pg-13-basic인증.json` | **TRANSFORM(base64)**·헤더 바인딩 | Basic 인증 통과 0000 && grade VIP |
| `pg-14-텍스트추출.json` | respType **text**·**TRANSFORM(regex-extract)** | 텍스트에서 승인번호 추출→재사용, 에코 일치 |

## 두 가지 관찰 포인트

- **노티 대사(11번 표준 패턴)**: wait 노드 자체는 assert 가 없다. 대신 노티 본문의 `tid` 를
  뒤 HTTP(거래조회)에 바인딩해 **금액/상태 일치를 assert** 한다 — 노티 내용 검증의 표준.
- **mock 이 진짜로 노티를 쏜다**: PG 프리셋은 요청의 `notiUrl`(= `{{ url@wait노드 }}`)로
  승인/취소/입금 노티를 **서버에서 발사**하고, "OK" 응답이 아니면 2초 간격 3회 재발송한다.
  그래서 pg-01/06/07/08 은 relay(:8787)가 떠 있어야 wait 이 깨어난다.

## 검증

라이브 스택에서 브라우저 실행 루프를 시뮬레이션해 전 시나리오를 확인했다(모두 export 전 PASS):
- server 체인 10종(pg-02~05·09~14): 23 단언 PASS
- 브라우저 루프 4종(pg-01·06·07·08, form 팝업·wait·노티): 20 단언 PASS

## 참고 — 검증(assert) 노드 조건 문법

IF 노드와 같은 **SpEL 안전 평가**(읽기전용)라 비교(`== != < >`)·논리(`and or not`)·산술·문자열 연결(`+`)만 된다.
`.contains()`·`.startsWith()` 같은 **메서드 호출은 차단**된다. 두 토큰 비교가 필요하면
`{{ a@n1 }} == {{ b@n2 }}` 처럼 쓰고, 부분일치가 필요하면 mock 이 값을 분리해 주도록 설계한다
(pg-10 이 `recvContentType` 대신 `recvCharset` 를 반환하는 이유).
