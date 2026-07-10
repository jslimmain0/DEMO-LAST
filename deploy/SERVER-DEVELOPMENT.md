# Server-side development

The editable source tree lives at `~/apps/DEMO-LAST`. Runtime files and the H2
database stay separately under `~/flowlink`, so rebuilding the source does not
delete application data.

```bash
# Connect from Windows
ssh -i "C:\Users\jslim\Documents\docker\keys\local-ec2" -p 2222 ubuntu@localhost

# Edit
cd ~/apps/DEMO-LAST
nano backend/src/main/resources/application-h2.yml

# Build frontend, run all backend tests, install the JAR, and restart
flowlink-rebuild

# Process controls
flowlink-stop
flowlink-start

# Logs
tail -f ~/flowlink/flowlink.log
```

Open the SSH tunnel from Windows before using the browser:

```powershell
.\DEMO-LAST\deploy\connect-local.ps1
```

Then open <http://localhost:18080>.
