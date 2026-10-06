#!/usr/bin/env bash
# Same script runs over SSH in Docker EC2 and on an actual Linux EC2 host.
set -euo pipefail
root=${FLOWLINK_DEPLOY_ROOT:-/opt/flowlink}
release=$(realpath "${1:?Pass the uploaded release directory}")
root=$(realpath "$root")
[[ "$release" == "$root/releases/"* && -d "$release" ]] || { echo 'Release must be inside deploy root/releases.' >&2; exit 1; }
[[ -f "$root/.env" ]] || { echo 'Create deploy root/.env first.' >&2; exit 1; }
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
cd "$release"
sha256sum --check --quiet SHA256SUMS
# Validate all release data before loading an image or modifying downloads.
python3 - <<'PY'
import hashlib, json, pathlib, re
p = pathlib.Path('.')
v = (p / 'VERSION').read_text().strip()
assert re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', v), 'Invalid version'
image = (p / 'image.env').read_text().strip()
assert re.fullmatch(r'FLOWLINK_IMAGE=flowlink/server:' + re.escape(v) + r'-[0-9a-f]{40}', image), 'Invalid image identity'
m = json.loads((p / 'downloads/release-manifest.json').read_text())
assert m['version'] == v and v in m['compatibleServerVersions'], 'MSI/server version mismatch'
name = f'FlowLink-{v}-windows-x64.msi'
assert [f.name for f in (p / 'downloads').glob('*.msi') if f.is_file()] == [name], 'Exactly one versioned MSI is required'
assert m['downloadPath'] == '/downloads/' + name and m['platform'] == 'windows' and m['arch'] == 'x64'
f = p / 'downloads' / name
digest = hashlib.sha256()
with f.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
assert f.stat().st_size == m['size'] and digest.hexdigest() == m['sha256'], 'Invalid MSI checksum'
PY
docker load --input server-image.tar.gz > /dev/null
mkdir -p "$root/downloads"
installer="FlowLink-$(cat VERSION)-windows-x64.msi"
if [[ -f "$root/downloads/$installer" ]]; then
    cmp --silent "downloads/$installer" "$root/downloads/$installer" || { echo 'Published MSI versions are immutable. Increment VERSION.' >&2; exit 1; }
else
    cp "downloads/$installer" "$root/downloads/.$installer.tmp"
    mv "$root/downloads/.$installer.tmp" "$root/downloads/$installer"
fi
previous=$(readlink -f "$root/current" 2>/dev/null || true)
export FLOWLINK_CONFIG_FILE="$root/.env" FLOWLINK_DOWNLOAD_DIR="$root/downloads"
compose() { docker compose -p flowlink-runtime --env-file "$root/.env" --env-file "$1/image.env" -f "$1/app.compose.yml" "${@:2}"; }
had_manifest=false
if [[ -f "$root/downloads/release-manifest.json" ]]; then
    cp "$root/downloads/release-manifest.json" "$release/previous-manifest.json"
    had_manifest=true
fi
rollback() {
    trap - ERR
    if $had_manifest; then
        cp "$release/previous-manifest.json" "$root/downloads/.rollback-manifest"
        mv "$root/downloads/.rollback-manifest" "$root/downloads/release-manifest.json"
    else
        rm -f "$root/downloads/release-manifest.json"
    fi
    if [[ -n "$previous" && "$previous" != "$release" && -f "$previous/image.env" ]]; then
        compose "$previous" up -d --wait --wait-timeout 180 || echo 'Previous deployment needs operator attention.' >&2
    elif [[ -z "$previous" ]]; then
        compose "$release" down || echo 'Failed first deployment needs operator attention.' >&2
    fi
    echo 'Deployment failed; previous manifest and available previous containers restored. DB was not rolled back.' >&2
}
trap rollback ERR
cp downloads/release-manifest.json "$root/downloads/.release-manifest.tmp"
mv "$root/downloads/.release-manifest.tmp" "$root/downloads/release-manifest.json"
compose "$release" up -d --wait --wait-timeout 180
# Checks management metadata only. Never invokes MCP, OAuth, or IDE registration.
# Check the proxy listener with its configured Host/TLS name, even in the lab's port mapping.
proxy_url=$(compose "$release" config --format json | python3 -c '
import json, pathlib, urllib.parse
site = json.load(__import__("sys").stdin)["services"]["proxy"]["environment"]["FLOWLINK_SITE_ADDRESS"]
u = urllib.parse.urlsplit(site if "://" in site else "https://" + site)
public = urllib.parse.urlsplit(pathlib.Path("server-url.txt").read_text().strip())
host = u.hostname or "localhost"
port = u.port or (443 if u.scheme == "https" else 80)
print(f"{u.scheme}://{host}:{port}{public.path.rstrip(chr(47))}")')
proxy_host=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).hostname)' "$proxy_url")
proxy_port=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).port)' "$proxy_url")
curl_proxy() { curl --fail --silent --show-error --connect-timeout 5 --max-time 20 --retry 3 --retry-all-errors --retry-delay 2 --resolve "$proxy_host:$proxy_port:127.0.0.1" "$@"; }
curl_proxy "$proxy_url/api/v1/auth/config" > "$release/auth-check.json"
curl_proxy "$proxy_url/api/v1/distribution" > "$release/distribution-check.json"
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('.')
d = json.loads((p / 'distribution-check.json').read_text())
assert d['available'] and d['automaticUpdateAllowed'], d.get('releaseStatus')
assert d['serverVersion'] == (p / 'VERSION').read_text().strip() == d['version']
assert d['serverUrl'].rstrip('/') == (p / 'server-url.txt').read_text().strip().rstrip('/'), 'MSI server URL differs from deployment'
assert json.loads((p / 'auth-check.json').read_text())['runtime']['kind'] == 'server'
PY
curl_proxy --head "$proxy_url/downloads/$installer" > "$release/installer-head.txt"
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('.')
headers = dict(line.lower().split(':', 1) for line in (p / 'installer-head.txt').read_text().splitlines() if ':' in line)
assert int(headers['content-length'].strip()) == json.loads((p / 'downloads/release-manifest.json').read_text())['size'], 'Proxy installer size mismatch'
PY
ln -sfn "$release" "$root/current"
trap - ERR
echo "Deployed FlowLink $(cat VERSION)"
