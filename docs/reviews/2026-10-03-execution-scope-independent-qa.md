# 독립 QA — 실행·환경·공간 경계 (2026-10-03)

검토자는 해당 UI를 작성하지 않았다. 소스 및 실제 createEnvironment 함수의 지연 응답 재현을 확인했다. 브라우저 교차검증은 root 담당이다. root 소유 제품 파일은 수정하지 않았다.

## [P1] 이전 Editor 저장/실행 Promise가 새 공간의 전역 그래프를 사용한다

근거: `frontend/src/routes/Editor.tsx:304`의 mutationFn은 호출 시 전역 `getGraph()`를 읽고, onSuccess는 snapshot 확인 없이 `markSaved()`를 호출한다. `executeRun`의 환경 준비/저장 await 이후에는 detached/abort/flow ID 검사가 없다. `WorkspaceContext.tsx:90` 이후 scope별 Provider remount는 async Promise를 취소하지 않는다.

재현 A: A 공간 실행을 누르고 환경 목록/저장 응답을 지연한다. B 공간의 편집기로 이동하여 그래프를 수정한다. A 환경 응답을 해제한다. 이전 executeRun이 B의 전역 dirty/graph를 읽어 A flow에 저장할 수 있고, 이전 공간의 실행도 요청한다.

재현 B: A에서 저장 요청을 지연한다. B를 열어 수정한 뒤 A의 성공 응답을 해제한다. A onSuccess가 전역 dirty를 false로 만들어 B의 미저장 표시가 사라진다. 동일 공간에서 저장 중 추가 편집도 같은 문제가 있다.

최소 수정: 저장 mutation에 flow ID/graph/scope snapshot을 명시 전달하고 성공 시 현재 flow/scope/graph가 모두 같은 경우만 markSaved. prepare/save 및 실행 API 호출 사이에 unmount/abort/current flow+scope guard를 적용한다. 실행은 확인한 graph의 저장 versionNo로 고정한다. root가 수정 중이다.

집중 브라우저 회귀: 초기 GET 환경 응답을 지연→공간 변경→새 노드 편집→응답 해제 후 옛 flow version POST와 runs POST가 없어야 한다. 다음으로 version POST 성공만 지연→새 공간 수정→해제 후 새 공간 dirty가 true여야 한다. 동일 flow 저장 중 편집도 dirty=true 유지 및 새 실행이 확인된 버전만 실행하는지 확인한다.

## [P2] 초기 환경 GET이 진행 중인 사용자 초안을 덮어쓴다

근거: `frontend/src/lib/environments.ts:32`~41에서 list가 완료되면 cache를 서버 응답으로 통째 교체한다. `EnvManagerDialog.tsx:48`/151은 환경 로드가 끝나지 않아도 '+ 환경'을 허용하며 읽기 실패도 별도 loading/error 상태로 표시하지 않는다.

실제 재현: createEnvironment의 list Promise를 보류하고 setEnvStore로 draft 환경을 추가한다. list를 prod 환경 응답으로 완료하면 draft가 없어지고 다음 flush는 서버 목록 기준으로 'saved'가 된다. `.run/oracle-vault/qa-env.cjs`에서 현재 함수의 TS transpilation으로 확인했다.

최소 수정: store에 loading/error 상태를 노출하고 환경 편집을 successful initial load 전에는 막는다. 또는 응답 시 revision을 확인하여 미저장 초안을 보존/병합하고 서버 snapshot만 갱신한다. 실패 시 빈 목록을 정상 목록처럼 편집/저장해서는 안 된다. 별도 회귀 harness는 `docs/reviews/env-load-regression.cjs`이며 수정 전에는 의도대로 실패한다.

## [P2] 변환/전문 미리보기는 환경 준비 실패 및 pending save를 건너뛴다

근거: `frontend/src/panels/TransformPreview.tsx:22`~24, `frontend/src/components/ProtocolEditor.tsx:331`은 activeEnvName만 읽고 즉시 preview API를 호출한다. backend TransformController/ProtocolService는 전달된 환경 이름으로 DB 환경을 읽으므로 환경 편집 후 400ms 디바운스 이전 또는 저장 실패 시 이전 서버 변수로 플러그인/전문을 계산한다. 환경 초기 GET 실패 시 activeEnvName은 null이 되어 환경 전용 값 대신 공통 시크릿을 사용할 수 있다.

최소 수정: 같은 scope preview는 prepareForRun 성공 후에만 실행한다. 다른 실행 위치/명시 node 환경은 해당 target 환경의 조회/권한 성공을 확인하고 오류 시 preview를 중단한다. 환경/target 선택 변경 시 이전 result를 지우고 늦은 응답을 revision으로 거부한다.

검증: prod 환경 URL/secret 바인딩 변수를 변경하고 environment PUT 실패를 유도한 다음 변환 및 전문 조립을 누른다. preview 요청은 없어야 하고 환경 준비 실패가 표시되어야 한다. 정상 저장 후에는 새 값으로 계산해야 한다.

## 확인한 안전 경계

- 환경 API 및 QueryClient는 workspace scope에 분리되며 이름만으로 다른 공간 데이터를 합치지 않는다.
- ExecutionPlanDialog의 prepare 오류 또는 inspection 오류는 실행 버튼을 차단한다. 실제 실행은 다시 prepare한다.
- AgentSettings가 공간/agent를 바꾸면 명시 환경/Mock을 제거하고 선택 대상을 다시 조회한다.
- VIEWER에게 UI 단일 실행/저장을 제공하지 않으며 backend preview는 ResourceWorkspace.write 게이트로 권한을 검사한다. preview UI가 VIEWER에게 보여도 API는 403으로 차단하므로 권한 우회로 판단하지 않았다.
- root의 브라우저 오프라인 검증은 별도 필요하다. PC local 상태에서도 serverUrl/login 변경을 useApi memo dependency로 사용해 API 객체가 바뀌면 WeakMap 환경 store가 새로 생기는 가능성은 발견했으나 아직 사용자 재현 없이 확정 이슈로 올리지 않았다.

## 수정 후 독립 재검토

root의 Editor 가드는 actual callback AST harness 4개를 통과했다: 준비 중 공간 전환, 늦은 저장 성공, 저장 중 추가 편집, 저장 버전 pin. PropertyPanel callback harness 3개도 통과했다: 준비 중 unmount, 저장 중 노드 선택 변경, 정상 저장 버전 pin. 실행 명령은 각각 `node docs/reviews/editor-scope-regression.cjs`, `node docs/reviews/single-node-scope-regression.cjs`다. 실제 callback source를 추출하여 API/hook dependency stub으로 실행한다. 브라우저 렌더링 검증을 대신하지 않는다.

초기 환경 GET 문제는 store와 UI 양쪽에서 loadStatus ready 전 편집을 막는 방식으로 해결했다. env-load-regression의 기대도 '미준비 편집 거절 + 서버 목록 보존'으로 맞추었고 통과했다. Transform/Protocol 미리보기는 별도 수정 기록에 정리했다.
