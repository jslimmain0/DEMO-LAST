# 결제창 + 콜백 데모 (커스텀 Mock 서버)

"결제창 같은 웹페이지가 뜨고 → 콜백이 돌아오는" 흐름을 **커스텀 Mock 서버**로 흉내 낸다.
상태(잔액·원장) 없이, 응답 템플릿(HTML)과 콜백 발사만으로 만든다 — Mock 서버 기능의 본래 용도.

## 1. 기동 (터미널 3개 + 브라우저)

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\start.ps1 -H2   # 백엔드
node relay.js                                                             # relay :8787 (콜백 수신)
cd frontend; npm run dev                                                  # 프론트 :5173
```

## 2. Mock 서버 만들기

1. 상단 **Mock 서버** → 이름 아무거나, slug `pay-mock` → **+ 만들기**
2. 편집기에서 라우트를 [mock-spec.json](mock-spec.json) 내용으로 채운다.
   - 손으로: [+ 라우트 추가]로 아래 두 경로를 만든다.
   - 또는 API 한 방:
     ```
     PUT http://localhost:18080/api/v1/mock-servers/{id}/spec
     { "spec": <mock-spec.json 내용> }
     ```
3. **보내보기**로 `POST /checkout`(본문 `orderId=1&amount=1000&returnUrl=x`)을 눌러 HTML 결제창이 나오는지 확인.

### mock-spec.json 이 정의하는 것

| 라우트 | 동작 |
|---|---|
| `POST /checkout` | **HTML 결제창** 응답 — [결제 승인]/[취소] 버튼이 `{{body.returnUrl}}` 로 결과를 POST. 승인은 `resultCode=0000`·`tid=PAYMOCK-{{seq}}` |
| `POST /order` | JSON `{accepted:true}` 응답 + **콜백 자동 발사**(1.2초 뒤 `{{body.notiUrl}}` 로 `resultCode=0000&tid=NOTI-{{seq}}`, "OK" 못 받으면 재발송) |

## 3. 워크플로 가져오기 · 실행

에디터 탑바 **[가져오기]** → 파일 선택:

| 파일 | 흐름 | 보는 것 |
|---|---|---|
| `01-결제창-콜백.json` | SET → **FORM(팝업)** → **WAIT(콜백)** → 검증 | 결제창 팝업이 뜬다 → **[결제 승인]** 클릭 → returnUrl(= wait 수신 URL)로 결과 POST → wait 이 받아 재개 → 검증 `resultCode=='0000'` |
| `02-무인노티.json` | HTTP(주문) → **WAIT(노티)** → 검증 | 사용자 상호작용 없이, mock 이 주문 응답 후 **자동으로 노티를 발사** → wait 이 받아 재개 |

두 데모 모두 마지막 **검증(assert) 노드**로 `resultCode=='0000'` 을 판정한다(거짓이면 실행 실패).

## 4. 이게 보여주는 것

- **웹페이지가 뜬다**: 커스텀 라우트가 `contentType: html` 로 결제창을 응답. `{{body.returnUrl}}` 템플릿으로 콜백 주소를 폼 action 에 심는다.
- **콜백이 온다**: (a) 사용자가 결제창 버튼을 눌러 returnUrl 로 보내거나(01), (b) mock 규칙의 `callback` 이 응답 후 자동 발사(02). 둘 다 wait 노드가 relay 로 받는다.
- 상태 관리·서명 검증 같은 건 없다 — 필요했던 건 "창 뜨고 콜백"이지 결제 시뮬레이터가 아니었으므로.

> 참고: 상태가 필요한 시나리오(부분취소 잔액 등)는 이 도구의 범위가 아니다. 그런 게 필요하면 별도 시뮬레이터(리포 루트 `mock-server.js` 같은)를 쓰면 된다.
