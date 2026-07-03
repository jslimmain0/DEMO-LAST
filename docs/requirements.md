# FlowLink 기능 요건 정의서 (SRS)

> REST API 워크플로 오케스트레이션 플랫폼 FlowLink의 전 기능을 요건 단위로 정리한 문서.
> 현재 코드베이스(구현 완료분)를 기준으로 작성하며, 각 요건에 구현 상태를 표기한다.

| 항목 | 내용 |
|---|---|
| 문서 버전 | v1.1 (SRS-2026-07) — 폼/콜백 개편(form·wait·input 3분리) 반영 |
| 작성일 | 2026-07-03 |
| 대상 시스템 | FlowLink (Frontend 5173 · Backend 18080) |
| 기준 소스 | main — Phase 1 + 2026-07-03 변경 반영 |

**상태 표기**: ✅ 구현(동작 검증됨) · 🔶 부분(일부만 동작/제약 있음) · ❌ 미구현(스키마·enum·유틸만 존재 또는 부재)

## 목차

1. [개요 (목적·범위·용어)](#1-개요)
2. [시스템 구성](#2-시스템-구성)
3. [기능 요건 (FR)](#3-기능-요건-fr)
4. [API 요건](#4-api-요건)
5. [비기능 요건 (NFR)](#5-비기능-요건-nfr)
6. [제약사항 · 미구현 (개선 후보)](#6-제약사항--미구현-개선-후보)
7. [부록 — 토큰 문법 · 설정 키 · 상태 코드](#7-부록)

---

## 1. 개요

### 1.1 목적

여러 REST API·TCP 전문·결제/인증 게이트웨이 호출을 시각적 워크플로(노드 그래프)로 구성하고, 저장·버전관리·실행·이력조회할 수 있는 플랫폼을 제공한다. 클라이언트 전용 프로토타입(`FlowBuilder.dc.html`)을 엔터프라이즈 구조(멀티테넌시·보안 가드·플러그인)로 고도화한 결과물이다.

### 1.2 범위

본 문서는 프론트엔드(에디터·대시보드·실행 이력)와 백엔드(정의·실행·폴더·변환·보안 모듈)의 전체 기능 요건과 비기능 요건을 다룬다. UI 텍스트는 전부 한국어로 제공한다.

### 1.3 용어

| 용어 | 정의 |
|---|---|
| **워크플로(Flow)** | 노드와 엣지로 구성된 실행 단위의 논리 컨테이너. 버전(FlowVersion)의 부모 |
| **노드 / 엣지** | 그래프의 실행 단계(START·HTTP·IF·FORM·WAIT·INPUT 등 10종) / 노드 간 연결(분기 포트 포함) |
| **바인딩 / 토큰** | 상위 노드 출력값 참조. `{{ key }}` 문법(3형식 + 특수 토큰 3종) |
| **실행(Execution)** | 워크플로 1회 실행 인스턴스. 노드별 결과(NodeExecution)를 가짐 |
| **재개(resume)** | WAITING으로 중단된 실행을 브라우저 결과·폼 값·콜백으로 이어가는 동작 |
| **팔레트** | 에디터 좌측의 노드 공급원. 기본 노드 그룹 + OpenAPI 임포트 그룹 |
| **테넌트** | 데이터 격리 단위. JWT claim → `tenant_id` 컬럼 필터 |
| **reqMode / respType** | HTTP 노드의 호출 주체(server/client) / 응답 파싱 방식(6종) |

## 2. 시스템 구성

### 2.1 기술 스택

| 구분 | 스택 | 포트 |
|---|---|---|
| **Backend** | Spring Boot 3.3.5 · Java 21 · JPA + Flyway · PostgreSQL(운영) / H2 파일(개발) · SpEL | 18080 |
| **Frontend** | React 19 · Vite 8 · @xyflow/react · Zustand(캔버스 상태) · React Query(서버 상태) · axios | 5173 (`/api` → 18080 프록시) |

### 2.2 아키텍처

백엔드·프론트 모두 **모듈러 모놀리스**. 백엔드 패키지는 `core`(도메인·그래프) / `definition`(CRUD·버전) / `execution`(엔진·API) / `folder` / `security` / `transform` / `common`으로 분리되어 향후 워커 분리에 대비한다. 프론트는 Zustand(캔버스 클라이언트 상태)와 React Query(서버 데이터)를 명확히 분리한다.

### 2.3 화면 구성

| 화면 | 경로 | 역할 |
|---|---|---|
| **대시보드** | `/flows` | 워크플로 목록·검색·정렬·폴더 관리·생성·복제·삭제 |
| **에디터** | `/flows/:id` | 캔버스 편집·팔레트·속성 패널·실행 로그·저장·실행·JSON/API 입출력 |
| **실행 이력** | `/executions` | 테넌트 전체 최근 실행 목록 |
| 공통 셸 | — | 상단 내비(활성 표시)·테마 토글·스킵 링크. `/`·404는 `/flows`로 리다이렉트 |

## 3. 기능 요건 (FR)

요건 ID는 `FR-영역-순번`. 상태는 코드 기준(검증 이력 포함).

### 3.1 워크플로 관리 (FR-FLW)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-FLW-01 | **목록 조회** | 테넌트의 비보관(non-archived) 워크플로를 최신 수정순으로 조회 | ✅ |
| FR-FLW-02 | **생성** | 이름(필수·≤255)·설명(≤2000)·폴더 지정. 생성 시 빈 그래프 v1 자동 생성, 프론트는 생성 즉시 에디터로 이동 | ✅ |
| FR-FLW-03 | **메타 수정** | PATCH 부분 수정(이름/설명). 동시 편집 충돌 시 낙관적 락으로 409 반환 | ✅ |
| FR-FLW-04 | **삭제(소프트)** | `archived=true` 소프트 삭제. 프론트는 confirm 후 수행<br>_하드 삭제·휴지통 복원 없음_ | ✅ |
| FR-FLW-05 | **복제** | 상세 조회 후 노드·엣지를 복사해 새 워크플로 생성(이름 " 복사" 접미) | ✅ |
| FR-FLW-06 | **버전 관리** | 저장 시마다 불변 스냅샷(FlowVersion) 생성·`currentVersion` 증가. 버전 목록·특정 버전 그래프 조회 API 제공<br>_버전 목록·복원·비교 **UI 없음**(API만 존재)_ | 🔶 |
| FR-FLW-07 | **서버 import/export** | 프로토타입 호환 JSON(`{version,name,nodes,edges}`) 가져오기(검증 포함)/내보내기 | ✅ |
| FR-FLW-08 | **폴더 이동** | 워크플로를 폴더(또는 미분류)로 이동. 대시보드 카드에서 select로 즉시 이동 | ✅ |
| FR-FLW-09 | **검색·정렬** | 이름+설명 부분일치 검색, 최근 수정순/이름순 정렬 토글 | ✅ |

### 3.2 폴더 관리 (FR-FLD)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-FLD-01 | **폴더 CRUD** | 생성(≤255)·이름변경·삭제. 삭제 시 소속 워크플로는 미분류로 이동(안내 후 confirm) | ✅ |
| FR-FLD-02 | **사이드바 분류** | 전체/미분류/폴더별 목록 + 실시간 개수 뱃지, 활성 폴더 하이라이트<br>_평면 구조(중첩 폴더 없음)_ | ✅ |

### 3.3 에디터 · 캔버스 (FR-EDT)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-EDT-01 | **노드 배치** | 팔레트에서 드래그&드롭(커서 좌표에 배치) 또는 클릭/Enter(화면 중앙 배치). 잘못된 드래그 페이로드는 무시(크래시 방지) | ✅ |
| FR-EDT-02 | **노드 연결** | 핸들 드래그·클릭 연결. 자석 스냅(`connectionRadius=45`), 연결 중 전체 핸들 확대(12→18px)+후광, 창 포커스 상실 시 상태 리셋 | ✅ |
| FR-EDT-03 | **삭제** | 엣지 중앙 × 버튼, Delete/Backspace 키. 노드 삭제 시 연결 엣지 자동 정리<br>_삭제 확인 대화상자 없음(즉시 삭제)_ | ✅ |
| FR-EDT-04 | **IF 분기 연결** | IF 노드는 T(초록)/F(빨강) 2개 소스 핸들로 분기별 연결 | ✅ |
| FR-EDT-05 | **탐색 보조** | 미니맵(카테고리 색, 팬/줌)·줌 컨트롤·자동 fitView·점 그리드 | ✅ |
| FR-EDT-06 | **노드 카드 정보** | 타입 아이콘+카테고리 색, HTTP 메서드 뱃지·경로, 요청 방식 뱃지(S→S/C→S, 툴팁), IF 조건 미리보기, 선택 강조, 말줄임 처리 | ✅ |
| FR-EDT-07 | **3패널 리사이즈** | 팔레트/속성/로그 패널을 드래그(포인터 캡처, 창 밖·취소 안전)·키보드(화살표 8px, Shift 32px)로 조절. min/max·뷰포트 동적 상한·창 리사이즈 재클램프 | ✅ |
| FR-EDT-08 | **레이아웃 유지** | 패널 크기를 localStorage(`fl:editor:*`)에 드래그 종료 시 1회 저장, 로드 시 클램프. 프라이빗 모드 예외 무시<br>_서버·플로우 단위 저장은 아님(브라우저별)_ | ✅ |
| FR-EDT-09 | **미저장 관리** | 정교한 dirty 추적(드래그 종료 시점·선택 제외) → "● 미저장/저장됨" 표시, 저장 버튼 자동 비활성, `beforeunload` 이탈 경고<br>_SPA 내부 이동(라우터) 가드는 없음_ | 🔶 |
| FR-EDT-10 | **이름 인라인 편집** | 상단바에서 워크플로 이름 즉시 편집(dirty 연동) | ✅ |
| FR-EDT-11 | **Undo/Redo · 복붙 · 노드 검색** | 실행취소/재실행, 노드 복사·붙여넣기, 캔버스/팔레트 검색<br>_붙여넣기용 id 리매핑 유틸(`tokenGrammar`)만 선반영됨_ | ❌ |

### 3.4 팔레트 · OpenAPI 임포트 (FR-PAL)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-PAL-01 | **기본 노드 그룹** | 8종 노드(시작/HTTP/IF/변수/변환/TCP/폼 전송/끝) 아이콘·카테고리 색과 함께 제공 | ✅ |
| FR-PAL-02 | **OpenAPI/Swagger 임포트** | OpenAPI 3·Swagger 2 JSON을 파일 업로드 또는 붙여넣기로 분석 → 오퍼레이션 체크박스 선택(전체선택/해제) → 팔레트 그룹으로 적재(캔버스 미오염) | ✅ |
| FR-PAL-03 | **스키마 자동 추출** | 쿼리/헤더 파라미터, 요청 바디 필드+타입, 응답 outputs+타입 자동 채움. 중첩 `$ref`(6단계)·`allOf` 병합·배열 응답 items 언랩·200→201→2xx→default 폴백·`*+json` 미디어타입 지원<br>_YAML·`oneOf/anyOf`·path/cookie 파라미터·multipart 미지원_ | 🔶 |
| FR-PAL-04 | **그룹 관리** | 그룹 전체 ×·항목별 개별 × 제거(마지막 항목 제거 시 그룹 자동 삭제), 메서드 뱃지, 말줄임+툴팁 | ✅ |
| FR-PAL-05 | **팔레트 영속** | 임포트 그룹이 그래프 JSON에 포함 저장되어 저장/리로드 후 유지(백엔드는 raw 저장 — 스키마 무변경)<br>_서버 export/import 포맷에는 미포함_ | ✅ |

### 3.5 노드 타입 (FR-NOD)

실행 스케줄링: Kahn 위상정렬 → 활성 노드만 순차 실행. 미선택 분기의 노드는 **SKIPPED**로 기록, 첫 노드 실패 시 전체 **FAILED**. 알 수 없는 타입은 명시적 실패 처리.

| ID | 노드 | 실행 시맨틱 | 상태 |
|---|---|---|:---:|
| FR-NOD-01 | **START / END** | 플로우 시작/종료 마커. 출력 없음 | ✅ |
| FR-NOD-02 | **SET (변수)** | 변수 목록을 바인딩 또는 리터럴로 구성해 출력. 시크릿 변수는 저장·로그에 `••••••` 마스킹(컨텍스트 값은 원본)<br>_KMS/볼트 연동 없음 — UI 마스킹만_ | ✅ |
| FR-NOD-03 | **IF (조건 분기)** | SpEL 조건식을 읽기전용 샌드박스에서 평가, `true`/`false` 포트 중 **단일 분기**만 활성화. 평가 오류는 false 처리 | ✅ |
| FR-NOD-04 | **HTTP 요청** | §3.6 참조 (server/client 이원 실행) | ✅ |
| FR-NOD-05 | **TRANSFORM (변환)** | 레지스트리의 변환(빌트인 15종 + JAR 플러그인)을 선언된 입출력 포트로 적용. 미등록 id는 실패 | ✅ |
| FR-NOD-06 | **TCP (고정길이 전문)** | 필드별 고정 바이트 길이·패딩(방향/문자/인코딩, 기본 EUC-KR)·초과분 절단으로 전문 조립, 길이 프리픽스(자기포함 옵션) 부착. 응답은 프리픽스 해석 후 필드별 바이트 슬라이싱→이름별 출력. SSRF 가드 적용 | ✅ |
| FR-NOD-07 | **FORM (폼 전송)** | 브라우저가 팝업(`flowlink_pay_{노드ID}` 창 재사용)에 "이동 중…"+hidden form(HTML 이스케이프)을 써넣고 자동 submit → **기다리지 않고 즉시 다음 노드로**(fire-and-forget). 팝업 차단·URL 공백=노드 실패. 로그에 method·URL·필드 전체 | ✅ |
| FR-NOD-08 | **WAIT (콜백 대기)** | 실행별 수신 URL(`/api/v1/cb/{실행ID}/{노드ID}`)로 콜백이 올 때까지 대기. 타임아웃(기본 120초) 시 노드 FAILED, 이른 콜백은 버퍼에서 즉시 소비, "콜백에 줄 응답"(text/html/json+본문) 등록·반환<br>_인메모리(재시작 시 대기 실행 소실)_ | ✅ |
| FR-NOD-09 | **INPUT (사용자 입력 대기)** | 실행 중 입력 창(안내 문구 waitMsg + 입력 필드 waitFields)을 띄우고, 입력 값이 각 키로 노드 출력이 됨(프로토타입 복원). 취소 시 WAITING 유지 | ✅ |

### 3.6 HTTP 노드 상세 (FR-HTT)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-HTT-01 | **요청 방식(reqMode)** | **server**(기본): 백엔드 엔진이 호출(SSRF 가드·동기). **client**: 실행이 WAITING으로 중단되고 조립된 요청(`pendingClient`)을 브라우저가 fetch → `resume`으로 결과 전송 → 재개. 노드 카드에 S→S/C→S 뱃지 | ✅ |
| FR-HTT-02 | **요청 구성** | 메서드(기본 GET)·Base URL(바인딩 가능)+경로(토큰)·Params·Headers·Body 탭. 각 탭에 설명 힌트 제공 | ✅ |
| FR-HTT-03 | **바디 타입** | `json / urlencoded / form / raw / xml`. GET·HEAD는 바디 생략. json은 필드 모드에서 값 타입 코어션(number/boolean/json/array/null, 정수-실수 구분 보존)<br>_multipart는 urlencoded로 폴백(미구현)_ | 🔶 |
| FR-HTT-04 | **[필드 ↔ Raw] 전환** | Body·Params(urlencoded 원문)·Headers(`Key: Value` 줄, curl 붙여넣기형)에서 내용을 실제 변환하는 비파괴 토글. 파싱 실패 시 원문 보존+경고. bodyType 변경 시 내용 재직렬화("보이는 것=보내는 것") | ✅ |
| FR-HTT-05 | **응답 타입(respType)** | 6종 파싱: `json`(스칼라는 `body`로 정규화) / `xml`(루트 자식 재귀 맵·중복=리스트·스칼라 루트는 요소명 키) / `urlencoded·form`(키-값 맵, 중복=리스트) / `text`(`{body:원문}`) / `binary`(`{body:"(binary · N bytes)"}` 실제 수신 바이트). 모든 타입 파싱 실패 시 `body` 키로 원문 보존. UI는 키형/통짜형에 따라 예상 키 입력을 노출/숨김, 전환 시 끊길 바인딩 경고 | ✅ |
| FR-HTT-06 | **문자셋(charset)** | UTF-8(기본)/EUC-KR/MS949/US-ASCII. server 모드에서 요청 인코딩·응답 디코딩에 완전 적용, 비UTF-8이면 Content-Type에 charset 부착(MS949는 IANA명 `windows-949`)<br>_client 모드는 브라우저 제약으로 비UTF-8 본문 미보장(경고 표시)_ | 🔶 |
| FR-HTT-07 | **요청 안전 가드** | 헤더명 RFC 7230 토큰 검증(위반 시 skip 보고), 헤더 값 CR/LF 제거(인젝션 방지), URL 파싱 실패 즉시 실패, 응답 5MB 초과 절단 | ✅ |

### 3.7 바인딩 · 토큰 (FR-BND)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-BND-01 | **토큰 문법 3형식** | `{{ key }}`(최근 상위 출력) · `{{ key@nodeId }}`(명시 노드) · `{{ key@req:nodeId }}`(요청 스코프). 실행 input은 `input` 키로 시드. 배열은 첫 요소, 미해석 토큰은 빈 문자열. 프론트 `tokenGrammar`가 동일 문법 미러 | ✅ |
| FR-BND-02 | **바인딩 픽커** | 선택 노드의 조상을 역방향 BFS로 수집, 노드별 그룹·응답/요청 태그·타입 뱃지·키 검색(autoFocus) 제공. respType 반영(text/binary는 `body`만). 연결 없으면 안내 문구 | ✅ |
| FR-BND-03 | **바인딩 칩·토큰 삽입** | 내부 id·문법을 숨긴 칩(노드명·키·카테고리 색·hover 전체 토큰·×제거·클릭 재선택). 조건식·raw 본문·formAction 등 텍스트 필드에 `{ }` 버튼으로 토큰 삽입 | ✅ |
| FR-BND-04 | **수신 URL 바인딩** | wait(콜백 대기) 노드의 수신 URL이 실행 시작 시점에 `{url}` 출력으로 시드되어 `{{ url@노드ID }}`로 바인딩 — **뒤쪽 wait 노드를 앞쪽 노드에서도** 픽커로 선택 가능(결제요청 returnUrl/notiUrl 패턴) | ✅ |

### 3.8 실행 엔진 · 재개 · 콜백 (FR-EXE)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-EXE-01 | **수동 실행(동기)** | 현재 또는 지정 버전 그래프를 호출 스레드에서 동기 실행. 상태: RUNNING → SUCCEEDED/FAILED/WAITING. 트리거는 MANUAL만<br>_비동기 큐/워커 미구현(최대 아키텍처 부채) · CRON/WEBHOOK/EVENT enum만 존재_ | 🔶 |
| FR-EXE-02 | **노드별 기록** | NodeExecution(seq·상태·httpStatus·소요시간·요청/응답 텍스트·출력 JSON) 기록. capture 비활성 시 HTTP 본문은 "(redacted)" 처리, 시크릿 마스킹 | ✅ |
| FR-EXE-03 | **실행 전 자동 저장** | 프론트가 미저장 변경이 있으면 저장 후 실행 | ✅ |
| FR-EXE-04 | **클라이언트 모드 루프** | WAITING마다 브라우저가 직접 fetch(소요시간 측정, 실패도 status 0+에러로 재개) → `resume` 반복. 무한루프 가드(<100). 진행 상황을 로그 패널에 실시간 표시 | ✅ |
| FR-EXE-05 | **콜백 수신 relay** | `ANY /api/v1/cb/{실행ID}/{노드ID}`(permitAll) — GET은 쿼리스트링=본문, urlencoded POST는 서블릿 파라미터 병합, 그 외 본문은 JSON→`a=1&b=2`→`{body:원문}` 순 파싱. 수신 즉시 **서버가 직접 재개**(브라우저 불필요), 응답은 그 wait 노드에 등록된 것(미등록 `OK`)을 그대로 반환. 선언하지 않은 파라미터도 전부 노드 출력(중복 키=리스트) | ✅ |
| FR-EXE-06 | **이른 콜백 버퍼링** | wait 도달 전에 도착한 콜백은 (실행ID,노드ID) 버퍼(FIFO, 노드당 20)에 보관 → 도달/서스펜션 등록 직후 소비. 여러 건이면 첫 건만 소비(나머지 무해). 서스펜션 클레임(콜백/브라우저/타임아웃 경쟁)은 락으로 원자화 | ✅ |
| FR-EXE-07 | **타임아웃 · 실행 중단(⏹)** | wait 타임아웃(초, 기본 120) 초과 시 노드 FAILED("타임아웃 — n초…")+실행 FAILED. `POST /executions/{id}/cancel`로 대기 즉시 해제 → CANCELLED(멱등). 브라우저는 폴링(GET, 0.8s)으로 관전하며 카운트다운(0.3s 갱신)·수신 URL·⏹ 버튼 표시, 대기 노드 캔버스 펄스+유입 엣지 애니메이션 | ✅ |
| FR-EXE-08 | **재개 내구성** | 중단 상태·콜백 버퍼·응답 레지스트리가 인메모리(ConcurrentHashMap) — 단일 인스턴스·세션 한정, 재시작 시 소실 | ❌ |

### 3.9 실행 이력 · 로그 (FR-LOG)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-LOG-01 | **이력 목록** | 테넌트 최근 실행(기본 50, 1–200 클램프)·플로우별 이력 조회. 상태 뱃지(색+아이콘+텍스트 3중 부호화), flowId 클릭 → 에디터, 상대시간<br>_자동 갱신(폴링)·필터·페이지네이션·소요시간 표시 없음_ | 🔶 |
| FR-LOG-02 | **실행 로그 패널** | 노드별 접이식 로그(seq·상태·이름·httpStatus·소요시간), 펼치면 요청/응답/출력 pretty JSON. 실행 상태 실시간 안내(`aria-live`)<br>_메서드 태그가 GET으로 하드코딩된 표시 버그 존재_ | ✅ |

### 3.10 변환 · 플러그인 (FR-TRF)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-TRF-01 | **빌트인 변환 15종** | `split · substring · concat · pair-split · replace · regex-extract · upper · lower · trim · base64-encode/decode · url-encode/decode · sha256 · md5` — 전부 순수 문자열 변환, 실패 시 원본/빈값으로 완화 | ✅ |
| FR-TRF-02 | **변환 SPI · JAR 플러그인** | `FlowTransform` 인터페이스 + ServiceLoader. UI에서 `.jar` 업로드(확장자 검증·파일명 새니타이즈) → 레지스트리 리로드 → 변환 드롭다운 즉시 반영. 플러그인이 빌트인 오버라이드 가능<br>_샌드박스 없음(전체 권한) · 업로드 RBAC 게이트 없음(permitAll) · 업로드 실패 시 무피드백_ | 🔶 |
| FR-TRF-03 | **변환 노드 UI 연동** | 변환 선택 시 입력/출력 포트 자동 구성, 파라미터 기본값 프리필, 입력값 바인딩 지원 | ✅ |

### 3.11 워크플로 JSON 입출력 — 에디터 (FR-IOX)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-IOX-01 | **내보내기** | 현재 그래프 JSON을 클립보드 복사("복사됨 ✓" 피드백, 실패 시 수동 복사 안내 폴백) 또는 파일 다운로드(파일명 새니타이즈, 한글 유지) | ✅ |
| FR-IOX-02 | **가져오기** | 파일 선택/붙여넣기 → 단계별 사전 검증(JSON 파싱·nodes 배열·id 유무·중복 id 명시 등 구체적 오류 메시지) → 캔버스 대체(경고 표시, flowId 유지·dirty). 댕글링 엣지 자동 제거로 손편집 JSON도 안전 | ✅ |

### 3.12 UI 공통 · 편의 (FR-UIX)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| FR-UIX-01 | **테마** | 라이트/다크 토글(🌙/☀), localStorage(`flowlink-theme`) 영속, 최초 방문 시 OS 다크모드 자동 감지. 전 색상(메서드 6종·카테고리 9종·상태색)이 라이트/다크 CSS 변수로 토큰화 | ✅ |
| FR-UIX-02 | **상태 표면** | 로딩 스켈레톤(대시보드)·"불러오는 중…", 백엔드 연결 실패 안내(포트 명시), 빈 상태(검색 여부 문구 분기), 실행 상태 뱃지 7종 | ✅ |
| FR-UIX-03 | **다이얼로그 관례** | Esc 닫기 공용 훅·오버레이 클릭 닫기·autoFocus·`role="dialog" aria-modal`, readonly 필드 클릭 시 전체 선택 | ✅ |
| FR-UIX-04 | **접근성** | `:focus-visible` 아웃라인 · `prefers-reduced-motion` 존중 · 스킵 링크 · 캔버스 `role="application"` · 리사이즈 핸들 `role="separator"`+aria-value · 로그 `aria-live` · 색 단독 금지(아이콘+텍스트 동반) · ARIA 라벨 전반 | ✅ |
| FR-UIX-05 | **데이터 헬퍼** | 상대시간("방금/분 전")·소요시간(ms/s) 포맷, 이니셜 아바타, 토큰 파서 안전 id 생성(`crypto` 영숫자 8자) | ✅ |
| FR-UIX-06 | **알림 시스템** | 토스트/스낵바 부재 — 저장 실패(409 포함)·플러그인 업로드 실패가 사용자에게 표시되지 않음<br>_클라이언트 그래프 검증기(`validateGraph`: 사이클·중복 id·상한)도 UI 미연결(dead code)_ | ❌ |

## 4. API 요건

모든 API는 `/api/v1` 하위, 테넌트 스코프 적용. 오류는 `ApiError`(status·reason·message·path·details)로 통일 — 404(NotFound) / 400(BadRequest·검증) / 409(낙관적 락) / 500.

| 리소스 | 메서드 · 경로 | 기능 |
|---|---|---|
| 워크플로 | `GET /flows` | 목록(비보관·최신순) |
| | `POST /flows` | 생성(+빈 그래프 v1) — 201 |
| | `GET·PATCH·DELETE /flows/{id}` | 상세+현재 그래프 / 부분 수정(409 가능) / 소프트 삭제 — 204 |
| | `PUT /flows/{id}/folder` | 폴더 이동(null=미분류) — 204 |
| | `POST /flows/{id}/versions` | 버전 저장(그래프 검증) — 201 |
| | `GET /flows/{id}/versions` · `GET /flows/{id}/versions/{n}` | 버전 목록 / 특정 버전 그래프 JSON |
| | `POST /flows/import` · `GET /flows/{id}/export` | 프로토타입 JSON 가져오기 — 201 / 내보내기 |
| 실행 | `POST /flows/{flowId}/runs` | 동기 실행(input·versionNo 옵션) |
| | `GET /flows/{flowId}/runs?limit=` | 플로우 실행 이력(1–200 클램프) |
| | `POST /executions/{id}/resume` | 재개(form 팝업 결과 / input 값 / client HTTP 응답) — 멱등, wait는 브라우저 재개 불가 |
| | `POST /executions/{id}/cancel` | 실행 중단(⏹) — 대기 해제 + CANCELLED, 멱등 |
| | `GET /executions/{id}` · `GET /executions?limit=` | 실행 상세(+노드 로그, pending 정보 복원) / 테넌트 최근 실행 |
| | `ANY /cb/{실행ID}/{노드ID}` | wait(콜백 대기) 수신부 — **인증 예외(permitAll)**, 등록된 응답(text/html/json) 반환 |
| 폴더 | `GET·POST /folders` | 목록(flowCount 포함) / 생성 — 201 |
| | `PATCH·DELETE /folders/{id}` | 이름변경 / 삭제(소속 플로우 미분류화) — 204 |
| 변환·플러그인 | `GET /transforms` · `POST /transforms/reload` | 변환 목록(UI 구동) / 레지스트리 리로드 |
| | `GET /plugins` · `POST /plugins` (multipart) | JAR 목록 / 업로드(.jar 검증→리로드) |
| 인프라 | `/swagger-ui.html` · `/v3/api-docs` · `/actuator/health·info·prometheus·metrics` · `/h2-console`(h2) | API 문서 · 헬스/메트릭 · 개발 DB 콘솔 |

## 5. 비기능 요건 (NFR)

### 5.1 보안 (NFR-SEC)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| NFR-SEC-01 | **인증(OIDC)** | `issuer-uri` 설정 시 JWT 리소스서버 자동 활성(IdP 불문), 미설정 시 dev permitAll(경고 로그). 공개 경로: actuator health/info/prometheus·Swagger·콜백 2종 | ✅ |
| NFR-SEC-02 | **멀티테넌시** | JWT claim(기본 `tenant`) → ThreadLocal `TenantContext` → 전 쿼리 `tenant_id` 필터. 콜백은 토큰/상관키 역인덱스로 테넌트 복원(try-finally)<br>_RLS·RBAC 미구현 — 컬럼 필터링만_ | 🔶 |
| NFR-SEC-03 | **SSRF 가드** | HTTP·TCP 공통 — 스킴 allowlist(http/https), 루프백(옵션)·`0.0.0.0`·링크로컬·RFC1918·멀티캐스트·CGNAT(100.64/10)·IPv6 ULA(fc00::/7)·메타데이터 호스트(169.254.169.254 등) 차단. h2 프로파일은 loopback 허용<br>_DNS 리바인딩 미대응(check-time 해석만, connect-time 핀닝 없음)_ | 🔶 |
| NFR-SEC-04 | **표현식 샌드박스** | IF 조건은 SpEL `SimpleEvaluationContext`(읽기전용 — 타입참조·생성자·빈참조 불가), 토큰은 객체 변수로 바인딩(문자열 삽입 없음 → 인젝션 차단), 길이 2000자·토큰 50개 DoS 가드, 오류는 false | ✅ |
| NFR-SEC-05 | **민감정보 보호** | HTTP 요청/응답 본문 저장은 deny-by-default(`capture` 옵트인, h2는 디버그용 true), SET 시크릿 마스킹, 콜백 URL은 추측 불가 토큰·실행마다 재발급<br>_시크릿 볼트(KMS)·서명 위변조 검증·리플레이 방지 미구현_ | 🔶 |
| NFR-SEC-06 | **웹 보안 설정** | CORS(localhost 5173/3000/18080, `/api/**`), CSRF 비활성(무상태 토큰), 헤더 인젝션 가드(FR-HTT-07), XML 외부 엔티티(XXE) 비활성, 브리지 HTML 유니코드 이스케이프 | ✅ |

### 5.2 성능 · 제한 (NFR-LIM)

| 항목 | 설정 키 (`flowlink.execution.*`) | 기본값 |
|---|---|---|
| HTTP 연결/읽기 타임아웃 | `http.connect-timeout-ms` / `http.read-timeout-ms` | 5,000 / 30,000 ms |
| HTTP 응답 크기 상한(초과 절단) | `http.max-response-bytes` | 5 MB |
| 실행당 노드 수 상한(저장·실행 시 검증) | `max-nodes-per-run` | 200 |
| IF 조건식 가드 | (코드 상수) | 2,000자 · 토큰 50개 |
| TCP 타임아웃 / 기본 인코딩 | (노드 설정) | 5,000 ms · EUC-KR |
| 플러그인 업로드 크기 | (multipart 설정) | 20 MB |
| 콜백 base URL | `callback.base-url` | `http://localhost:18080` (외부 게이트웨이는 터널 override) |

### 5.3 데이터 · 영속성 (NFR-DAT)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| NFR-DAT-01 | **도메인 모델** | Flow(1:N)FlowVersion(불변 스냅샷) · Flow(M:1)Folder · Execution(1:N)NodeExecution. 전 엔티티 UUID + tenant_id | ✅ |
| NFR-DAT-02 | **스키마 관리** | 운영: Flyway V1(핵심 4테이블)·V2(낙관적 락)·V3(폴더) + `ddl-auto: validate`. 개발: H2 파일 영속(`~/flowlink-h2db`, `ddl-auto: update`, Flyway off) | ✅ |
| NFR-DAT-03 | **동시성 제어** | Flow `@Version` 낙관적 락 → 409. 콜백/재개 스레드 간 `synchronized` happens-before 보장<br>_graph_json은 text 저장(JSONB는 Phase 2)_ | ✅ |

### 5.4 관측성 · 운영 (NFR-OPS)

| ID | 요건 | 설명 | 상태 |
|---|---|---|:---:|
| NFR-OPS-01 | **모니터링** | actuator health(probe)·info·metrics + Prometheus 레지스트리(공통 태그 `application=flowlink`) | ✅ |
| NFR-OPS-02 | **API 문서** | springdoc OpenAPI + Swagger UI 자동 생성 | ✅ |
| NFR-OPS-03 | **기동 스크립트** | `start`(H2/Postgres 선택, Docker compose·pg_isready 대기, 백그라운드 PID/로그 `.run/`, 헬스 폴링) / `stop`(DB 보존·삭제 옵션), graceful shutdown | ✅ |
| NFR-OPS-04 | **테스트** | 백엔드 단위 3종(ExpressionEvaluator·SsrfGuard·TokenResolver, DB 불필요) + 프론트 순수 함수(bodyConvert·schema) Node 단위테스트<br>_E2E·통합·프론트 컴포넌트 테스트 없음(수동 H2 e2e 검증 이력으로 보완)_ | 🔶 |

## 6. 제약사항 · 미구현 (개선 후보)

코드 주석·README에 명시된 Phase 2+ 부채와 이번 조사에서 확인된 갭. 유지보수·기능 추가 시 우선 검토 대상.

| 구분 | 항목 | 내용 |
|---|---|---|
| 백엔드 | 비동기 실행 | 완전 동기 실행(외부 HTTP에 스레드 블로킹). 큐/워커·내구성 실행 미구현 — 최대 아키텍처 부채 |
| | 재개 내구성 | 중단 실행·콜백 토큰이 인메모리 — 재시작 소실, 다중 인스턴스 불가 |
| | 트리거 | SCHEDULE/WEBHOOK/EVENT enum만 — MANUAL만 동작. `ExecutionStatus`의 PENDING/CANCELLED도 미사용 |
| | 보안 하드닝 | RBAC/RLS·시크릿 볼트·플러그인 샌드박스·DNS 리바인딩 핀닝·콜백 서명 검증/리플레이 방지 미구현 |
| | HTTP 커버리지 | multipart/form-data 미지원(urlencoded 폴백), 비UTF-8 POST 콜백은 서블릿 디코딩 모지바케 가능 |
| | 저장 포맷 | `graph_json` text → JSONB 마이그레이션 예정 |
| 프론트 | 에러 피드백 | 토스트 시스템 부재 — **저장 실패(409) 무표시**(save에 onError 없음), 플러그인 업로드 실패 silent, axios 인터셉터 없음 |
| | 편집 편의 | Undo/Redo·노드 복붙·노드/팔레트 검색·스냅 그리드·다중선택 편의·삭제 확인·전역 단축키(Ctrl+S) 없음 |
| | 이탈 가드 | beforeunload만 존재 — SPA 내부 이동 시 미저장 내용 경고 없이 유실 |
| | 미연결 코드 | `validateGraph`(사이클 검출) UI 미연결, 버전 이력 API 미사용, `ApiError` 타입 미사용, RunPanel 메서드 태그 GET 하드코딩 |
| | 이력 화면 | 자동 갱신/상태 필터/페이지네이션/소요시간 없음 |
| | 일반 | i18n(한국어 하드코딩)·모바일 반응형 없음, PropertyPanel 비대(노드별 컴포넌트 분리 권장) |

> ⚠️ **데모 범위 주의** — 결제/인증 콜백 기능은 데모 수준. 실제 결제망 연동 시 서명/해시 검증, EncodeData 복호화, 내구성 보관, 외부 도달성(base-url 터널) 하드닝이 선행되어야 한다.

## 7. 부록

### 7.1 토큰 문법 요약

| 형식 | 의미 | 비고 |
|---|---|---|
| `{{ key }}` | 가장 가까운 상위 노드 출력 | req 스코프 제외, 최근 우선 |
| `{{ key@nodeId }}` | 지정 노드의 출력 | `{{ key@input }}` = 실행 입력 |
| `{{ key@req:nodeId }}` | 지정 노드의 요청 값 | params/headers/body 필드 |
| `{{ url@노드ID }}` | wait(콜백 대기) 노드의 실행별 수신 URL | 실행 시작 시 시드 — 앞쪽 노드에서도 바인딩 가능 |

### 7.2 실행 상태 코드

| 구분 | 상태 |
|---|---|
| Execution | RUNNING / WAITING / SUCCEEDED / FAILED _(PENDING·CANCELLED 미사용)_ |
| NodeExecution | RUNNING / SUCCEEDED / FAILED / SKIPPED _(WAITING 미사용)_ |
| UI 뱃지 | ✓ 성공 · ✕ 실패 · ◴ 실행중 · ⏸ 대기 · ○ 대기열 · ⊘ 취소됨 · – 건너뜀 |

### 7.3 클라이언트 저장소 키

| 키 | 용도 |
|---|---|
| `flowlink-theme` | 라이트/다크 테마 선택 |
| `fl:editor:paletteW` · `fl:editor:propertyW` · `fl:editor:runH` | 에디터 3패널 크기 |

### 7.4 환경 변수 · 프로파일

| 항목 | 내용 |
|---|---|
| DB override | `FLOWLINK_DB_URL` · `FLOWLINK_DB_USER` · `FLOWLINK_DB_PASSWORD` · `FLOWLINK_H2_FILE` · `FLOWLINK_PORT` |
| h2 프로파일 특례 | SSRF loopback 허용 + 요청/응답 본문 캡처 on(디버그) + H2 콘솔 |
| 테넌트 claim | `flowlink.security.tenant-claim` (기본 `tenant`) |

---

_본 문서는 코드베이스 정적 분석(프론트 3영역 + 백엔드 전 모듈)과 CLAUDE.md 변경 이력을 기반으로 작성됨 · FlowLink SRS v1.0 · 2026-07-02_
