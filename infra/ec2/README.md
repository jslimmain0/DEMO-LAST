# Docker 가상 EC2와 GitHub Actions 배포

`ec2` 컨테이너는 SSH와 자체 Docker daemon이 있는 Linux 서버다. 호스트의 Docker socket을 공유하지 않는다. 서버의 `/opt/flowlink`와 내부 Docker 데이터는 named volume으로 보존한다. PC의 Windows 앱 설치에는 Docker가 필요하지 않다.

배포 경로: GitHub Actions의 Linux 서버 빌드 + Windows MSI 빌드 → artifacts → 같은 Docker 네트워크의 self-hosted runner → SSH `ec2:22` → 컨테이너 안에서 Docker 앱 배포. GitHub hosted runner는 PC localhost에 접근하지 못하므로 마지막 배포 job만 self-hosted로 실행한다.

## 1. 가상 서버 실행

Docker Desktop Linux 엔진과 PowerShell 7에서 리포 루트 기준:

```powershell
pwsh -File scripts/start-ec2-lab.ps1
```

SSH: `127.0.0.1:2222`. 앱 배포 후 화면: `http://127.0.0.1:18088`. 서버 정보 및 다운로드: `/api/v1/distribution`, `/downloads/FlowLink.msi`. 기본 브라우저 UI와 `/mcp`는 같은 공개 주소를 쓴다.

`.run/ec2/keys/id_ed25519`는 배포 private key, `id_ed25519.pub`는 서버 public key, `known_hosts`는 서버에서 직접 얻은 host key다. `.run/ec2/app.env`는 테스트 서버 전용 H2·인증·영속 암호화 키 설정이며 최초 한 번 생성된다. 서버 `/opt/flowlink/.env`는 이후 시작 시 덮어쓰지 않는다. 테스트 H2는 EC2 검증용이며 사용자 PC의 개인 H2와 별개다.

이 서버는 DinD를 위해 privileged로 실행한다. SSH·앱 포트는 호스트 loopback에만 공개한다. 이 lab 컨테이너를 실제 운영 EC2에 배포하지 않는다.

## 2. GitHub runner 연결

GitHub 저장소 Settings → Actions → Runners → New self-hosted runner에서 Linux 등록 토큰을 얻는다. 다음 환경변수는 현재 PowerShell 세션에만 설정한다(토큰을 커밋하지 않는다).

```powershell
$env:GITHUB_REPOSITORY = 'jslimmain0/DEMO-LAST'
$env:RUNNER_TOKEN = '<단기 runner 등록 토큰>'
pwsh -File scripts/start-ec2-lab.ps1 -WithRunner
Remove-Item Env:RUNNER_TOKEN
```

runner label은 `flowlink-deploy`다. 등록 토큰은 런타임 시작 시 필요하므로 만료 후 컨테이너를 recreate할 때 새 토큰을 발급한다. 저장소에서 제거하지 않고 기존 이름을 강제로 대체하지 않는다. 기존 runner 등록이 있으면 Settings에서 확인 후 정리한다. 이 runner는 배포 job만 실행하며 untrusted PR을 실행하는 CI workflow에 사용하지 않는다.

## 3. GitHub 배포 환경

Settings → Environments에 `ec2-lab` 생성:

| 종류 | 이름 | Docker lab 값 |
|---|---|---|
| Variable | `EC2_HOST` | `ec2` |
| Variable | `EC2_SSH_PORT` | `22` |
| Variable | `EC2_SSH_USER` | `flowlink` |
| Secret | `EC2_SSH_PRIVATE_KEY` | `.run/ec2/keys/id_ed25519` 파일 내용 |
| Secret | `EC2_SSH_KNOWN_HOSTS` | `.run/ec2/keys/known_hosts` 파일 내용 |

워크플로 파일을 저장소의 기본 브랜치에 반영한 뒤 Actions → **FlowLink 빌드 및 EC2 배포** → Run workflow → `ec2-lab`, 서버 주소 `http://127.0.0.1:18088`. MSI에 이 주소가 포함되며 배포 대상의 설정과 다르면 배포를 실패시킨다. `VERSION`을 바꾸지 않고 다른 MSI를 같은 버전으로 덮어쓰는 것은 거부한다. self-hosted runner의 다운로드 폴더는 매번 새로 만들어 이전 실행의 MSI가 섞이지 않는다.

MSI는 GitHub Windows runner에서 JDK21·Node24·WiX3.14.1을 준비해 만든다. 서버 이미지 및 MSI는 같은 커밋에서 만들어지고 SHA-256 검증 후 배포된다. Windows 코드는 서버 컨테이너에서 실행하지 않는다. GitHub Actions의 실제 실행은 파일을 push하고 runner·환경 secrets를 등록한 뒤 가능하다.

## 4. 실제 EC2 전환

Ubuntu EC2에 Docker Engine + Compose v2, SSH, bash/curl/python3/flock를 준비한다. 배포 사용자에게 Docker 실행 권한과 `/opt/flowlink` 쓰기 권한을 주고 SSH 공개키를 등록한다. GitHub `production` 환경에서 host/port/user 및 실제 서버의 검증된 host key를 설정한다. `flowlink-deploy` runner가 이 EC2로 SSH 연결할 수 있어야 한다.

`infra/ec2/.env.example`을 `/opt/flowlink/.env`로 복사해 Oracle·Vault·GitHub 인증·암호화 키·도메인을 채우고 파일 권한을 600으로 제한한다. Oracle 스키마 초기화는 `backend/flow-server/src/main/resources/db/init.sql`을 DBA가 수행한다. workflow에 DB/Vault 비밀번호를 넣거나 DB를 자동 초기화하지 않는다. Docker lab만 테스트 H2를 사용한다.

공개 DNS와 80/443 접근이 있으면 Caddy가 HTTPS를 제공한다. 기존 사내 TLS 프록시를 사용할 때는 `FLOWLINK_SITE_ADDRESS=http://:80`으로 바꾸고 외부 HTTPS 주소를 `FLOWLINK_PUBLIC_URL`/`FLOWLINK_PUBLIC_MCP_URL`에 유지한다. Actions의 `server_url`도 같은 외부 주소로 지정한다. Mock TCP를 외부에 공개해야 하면 필요한 포트만 `app.compose.yml`과 EC2 Security Group에 추가한다(기본 배포는 HTTP 프록시만 공개).

실패 시 이전 manifest와 이전 컨테이너 구성으로 복귀를 시도한다. DB schema/data는 되돌리지 않으며 기존 MSI 버전 파일·서버 영속 볼륨을 삭제하지 않는다. MCP 프로토콜·도구·IDE 테스트는 이 workflow에서 실행하지 않는다.

## 0.3.8 실제 배포 확인 (2026-10-07)

GitHub가 실행할 동일한 `deploy.sh`를 SSH로 Docker 가상 EC2에서 실행했다. server·Caddy가 healthy이며 `http://127.0.0.1:18088`의 SPA와 두 정적 자원, 인증 설정·배포 metadata가 응답한다. `/downloads/FlowLink-0.3.8-windows-x64.msi`를 실제 다운로드해 149,370,597 bytes와 manifest SHA-256 일치를 확인했다. metadata는 서버/앱 0.3.8, 중앙 `/mcp`, `AVAILABLE` 및 자동 업데이트 허용을 반환한다. 기존 설치 앱에서 MSI를 설치하는 작업은 하지 않았다.

격리 lab에서 잘못된 checksum의 배포가 컨테이너 변경 전에 거부되는 것, 서버 URL 불일치로 실패한 배포 뒤 이전 프록시·manifest가 복원되는 것, 같은 불변 release를 재배포할 수 있는 것을 확인했다. GitHub runner 이미지는 공식 다운로드 checksum·실행 파일을 확인했고 workflow는 actionlint를 통과했다. GitHub runner 등록·환경 secrets 설정 및 GitHub의 실제 workflow 실행은 아직 수행하지 않았다. EC2 lab만 테스트 H2를 사용하며 Oracle/Vault의 실제 연결은 위 production 설정으로 전환한다.

근거: [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments), [공식 runner 및 checksum](https://github.com/actions/runner/releases/tag/v2.337.0), [Docker daemon 접근 보호](https://docs.docker.com/engine/security/protect-access/).
