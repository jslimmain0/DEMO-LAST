# Server-side development (EC2)

The editable source tree lives at `~/apps/DEMO-LAST`. Runtime files (PID/log) go
under `.run/`, and the H2 database defaults to `~/flowlink-h2db/` (or set
`FLOWLINK_H2_FILE`), so rebuilding the source does not delete application data.

```bash
# Connect from Windows
ssh -i "C:\Users\jslim\Documents\docker\keys\local-ec2" -p 2222 ubuntu@localhost

# Edit
cd ~/apps/DEMO-LAST
nano backend/src/main/resources/application.yml

# Rebuild (frontend + jar) and restart in one go
bash scripts/start.sh --build

# Process controls
bash scripts/stop.sh
bash scripts/start.sh
bash scripts/status.sh

# Logs
tail -f .run/flowlink.log
```

To turn on GitHub login / Vault / Oracle on the server, export the env vars
before `scripts/start.sh` — see [README.md](README.md) §2.

Open the SSH tunnel from Windows before using the browser:

```powershell
.\DEMO-LAST\infra\connect-local.ps1
```

Then open <http://localhost:18080>.
