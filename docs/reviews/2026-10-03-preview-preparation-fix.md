# 미리보기 환경 준비 수정 기록 (2026-10-03)

독립 QA에서 확인한 환경 preview P2를 root 요청에 따라 두 파일만 수정했다.

- TransformPreview: 현재 공간 환경 prepareForRun 성공을 기다린다. 실행 위치가 다르거나 명시 환경을 선택하면 해당 API의 환경 목록/권한 확인을 기다리며 누락 환경은 차단한다. 공간·노드·변환·환경·설정·입력 snapshot이 달라지거나 컴포넌트가 닫히면 늦은 요청/응답을 반영하지 않는다. 환경 준비 실패는 preview 요청 없이 오류로 표시한다.
- ProtocolEditor의 PreviewSection: prepareForRun 성공 이후만 API를 호출한다. scope/spec/message/input/environment snapshot이 변경되면 준비 중인 요청을 중단하고 늦은 응답을 버린다. 이전 선택의 결과도 signature가 맞을 때만 표시한다.

검증: frontend tsc -b 및 두 파일 oxlint 성공. `node docs/reviews/preview-preparation-regression.cjs`의 환경 실패/prepare 중 대상 변경/정상 준비 3개 검증 성공. 이 harness는 실제 TransformPreview 소스를 transpile하여 hook/API stub으로 async 로직을 검증한다; 브라우저 React 렌더링 검증을 대신하지 않는다.

브라우저 확인은 root 담당: 환경 PUT 실패 중 미리보기 요청 없음; 응답 지연 중 환경/노드/공간 변경 시 결과 미노출; 저장 성공 후 새 환경값으로 preview.
