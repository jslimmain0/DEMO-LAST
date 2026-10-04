# D-01 구현 — 목록 탐색 맥락 유지

후속 실제 배포·브라우저 검증은 [D-01~03 수정 검증](2026-10-03-discovery-fixes-validation.md)에 완료 범위와 한계를 기록했다. 제품 담당의 IAB 접근 제한으로 주 담당이 실제 조작을 수행하고 제품 담당은 캡처를 독립 검토했다.

기존 독립 탐색 D-01의 채택 결정을 본개발 턴에서 구현했다. **소스와 focused 검증 완료, 통합 배포 뒤 실제 브라우저 검증은 별도다.** 원래 발견 기록의 `수정 미착수`는 발견 당시 상태이며 이 문서가 후속 상태다.

## 토론과 범위

제품 담당과 같은 계정·서버·공간에서 출발한 목록의 검색·정렬·페이지·폴더를 유지하는 데 합의했다. Mock에서도 같은 사용자 목적을 적용하되 검색·상태/종류 필터·정렬·페이지 크기만 보존하고 체크 선택과 팝업은 보존하지 않는다. 전역 store·새 의존성·localStorage 지속은 추가하지 않았다.

목록은 자신의 브라우저 history entry에 식별 범위와 탐색 상태를 보관한다. 상세 진입은 space를 명시한 URL과 내부 출발 목록을 전달한다. 상세의 목록 버튼 및 브라우저 뒤로가기는 그 맥락을 다시 읽는다. 출발 맥락 없는 직접 진입은 워크플로 소속 폴더, Mock은 현재 공간 목록으로 돌아간다.

- 다른 계정·서버·공간의 상태는 적용하지 않는다.
- 복귀 URL은 해당 내부 목록 경로이며 현재 space가 정확히 한 번 들어 있어야 한다.
- 주 담당의 반론을 반영해 연결 여부 true/false 자체는 계정 식별에서 제외했다. 같은 계정의 일시 연결 변화는 개인 목록 맥락을 버리지 않는다.
- 공간 선택에 따른 새 이동은 상태를 전달하지 않는다. 같은 공간 URL 정규화는 기존 state를 유지한다.
- 삭제 등으로 페이지가 줄어들면 기존 `catalogPage`가 표시 페이지를 유효 범위로 제한한다.

## 변경 파일

- `frontend/src/lib/catalogNavigation.ts`: 검증·식별·직접 진입 fallback·상세/목록 URL의 순수 함수.
- `frontend/src/lib/useCatalogNavigation.ts`: 현재 history entry 상태 갱신과 복귀 hook. 검색 입력은 replace, 폴더 이동은 push다.
- `Dashboard.tsx` / `Editor.tsx`: 목록·최근 작업·카드·새 워크플로 진입 및 목록 복귀.
- `MockServers.tsx` / `MockServerEditor.tsx`: 같은 목록 복귀 계약 적용.
- `MockInventory.tsx`: 현재 공간의 한 그룹 페이지를 부모 목록 상태로 제어. 선택 체크와 메뉴는 계속 transient다.
- `WorkspaceContext.tsx`: 같은 공간 URL 보충·정규화에서 location.state 보존.

기존 미커밋 변경을 보존했으며 git diff 전체를 이번 수정량으로 주장하지 않는다.

## 검증

`frontend`에서 `tsc -b --pretty false` 통과. 대상 파일 oxlint는 오류 0이며 기존 파일의 Fast Refresh export 경고 3개가 남는다.

`node frontend/scripts/test-catalog-navigation.cjs`는 실제 순수 함수와 실제 hook을 history harness에 연결해 다음을 검증했다.

- 홈 검색에서 폴더 소속 흐름을 열어도 원래 홈 결과로 복귀.
- 출발 폴더 유지, 직접 진입 소속 폴더 fallback.
- 다른 계정·서버·공간 state 거부와 같은 계정 연결 변화 보존.
- 외부 URL·다른 section·다른 space·중복 space 거부.
- 하나의 이벤트에서 여러 필터 갱신을 병합, 입력마다 history 항목을 만들지 않음.
- 상세의 목록 복귀와 브라우저 Back에 해당하는 history 재방문에서 상태 유지.
- Mock 필터·정렬·페이지 왕복, 필터 초기화, 줄어든 목록의 페이지 제한.

프론트 담당은 구현 계약을 독립 검토했고 연결 상태 접미사 외 추가 실질 결함을 찾지 못했다. 제품 담당에게 완료 조건과 변경 파일을 전달했다. 실제 사용자 브라우저는 작업 중이므로 구현 담당은 조작하지 않았다. 통합 배포 이후 제품 담당의 전용 탭 검증 결과와 이 harness 검증을 구분한다. MCP 테스트는 수행하지 않았다.
