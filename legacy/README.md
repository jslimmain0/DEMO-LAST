# legacy — 동결된 설계 기준선

`FlowBuilder.dc.html` + `support.js`(dc-runtime 생성물)는 FlowLink 의 **원본 클라이언트 전용 프로토타입**이다.
현재 제품(`backend/`·`frontend/`)은 이 프로토타입을 엔터프라이즈 플랫폼으로 고도화한 것으로,
설계 기준선으로서 참고 가치가 있어 보존한다.

- **실행·빌드·임포트에 사용되지 않는다** — 실행 코드(백엔드·프론트)가 참조하지 않는다.
- 참고용으로 **동결**(freeze)된 상태이며 유지보수 대상이 아니다.
- `FlowBuilder.dc.html` 을 브라우저로 직접 열면 옛 프로토타입이 그대로 동작한다(`support.js` 상대참조).
