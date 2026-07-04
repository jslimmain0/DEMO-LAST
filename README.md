# FlowLink

REST API 워크플로 오케스트레이션 플랫폼. HTTP·폼·콜백·변환·TCP 노드로 워크플로를 그려 실행하고,
미완성 API 는 내장 **Mock 서버**로 세워 전체 흐름을 먼저 테스트한다. UI 는 전부 한국어.

## 빠른 시작 (Windows / PowerShell)

전체 스택(backend + relay + mock + 프론트 dev)을 한 번에:

```powershell
# 기동 — 4개 서비스가 각자 창으로 뜬다
powershell -ExecutionPolicy Bypass -File scripts\dev-all.ps1

# 종료
powershell -ExecutionPolicy Bypass -File scripts\dev-stop.ps1
```

준비되면 **http://localhost:5173** 를 연다.

| 서비스 | 주소 | 역할 |
|---|---|---|
| backend | http://localhost:18080 | API + 실행 엔진 (H2 파일 DB — Postgres/Docker 불필요) |
| relay | http://localhost:8787 | wait(콜백 대기) 노드의 콜백 수신 + SSE |
| mock | http://localhost:9090 · :9091(TCP) | 데모용 가짜 대상 시스템 |
| vite | http://localhost:5173 | 프론트 개발 서버 (`/api` → :18080 프록시) |

> 서비스를 개별로 띄우거나 세부 옵션이 필요하면 [`backend/README.md`](backend/README.md) 참고.
> 데모 워크플로는 [`demos/README.md`](demos/README.md)(가져오기로 로드).

## 더 보기

- **[CLAUDE.md](CLAUDE.md)** — 아키텍처·구조·최근 변경 상세 (유지보수 진실원)
- **[backend/README.md](backend/README.md)** — 백엔드 구현 범위·API·실행
- **[demos/README.md](demos/README.md)** — 데모 워크플로 · [demos/pay-mock](demos/pay-mock/README.md)(내장 Mock + 검증 노드)
- **[docs/](docs/)** — 설계 문서·토론 로그 · `legacy/` — 동결된 원본 프로토타입
