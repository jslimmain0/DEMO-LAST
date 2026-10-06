#!/bin/bash
set -euo pipefail

if [[ ! -s /bootstrap/authorized_keys ]]; then
    echo >&2 'FLOWLINK_DEPLOY_PUBLIC_KEY must point to a non-empty SSH public key file.'
    exit 1
fi
ssh-keygen -l -f /bootstrap/authorized_keys >/dev/null
install -d -m 700 -o flowlink -g flowlink /home/flowlink/.ssh
tr -d '\r' </bootstrap/authorized_keys >/home/flowlink/.ssh/authorized_keys
chown flowlink:flowlink /home/flowlink/.ssh/authorized_keys
chmod 600 /home/flowlink/.ssh/authorized_keys
mkdir -p /home/flowlink/deploy /etc/ssh/keys /run/sshd
chown flowlink:flowlink /home/flowlink /home/flowlink/deploy
if [[ ! -s /etc/ssh/keys/ssh_host_ed25519_key ]]; then
    ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/keys/ssh_host_ed25519_key
fi
chmod 600 /etc/ssh/keys/ssh_host_ed25519_key
cat >/etc/ssh/sshd_config <<'CONFIG'
Port 22
HostKey /etc/ssh/keys/ssh_host_ed25519_key
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
AllowUsers flowlink
AuthorizedKeysFile .ssh/authorized_keys
StrictModes yes
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
UseDNS no
Subsystem sftp internal-sftp
CONFIG
/usr/sbin/sshd -t

# Explicit dockerd command preserves official DinD setup without adding TCP listeners.
dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --group=docker &
docker_pid=$!
ssh_pid=''
cleanup() {
    trap - TERM INT EXIT
    [[ -z "$ssh_pid" ]] || kill -TERM "$ssh_pid" 2>/dev/null || true
    kill -TERM "$docker_pid" 2>/dev/null || true
    wait "$docker_pid" 2>/dev/null || true
    [[ -z "$ssh_pid" ]] || wait "$ssh_pid" 2>/dev/null || true
}
trap cleanup TERM INT EXIT
for attempt in {1..60}; do
    if docker info >/dev/null 2>&1; then break; fi
    if ! kill -0 "$docker_pid" 2>/dev/null; then
        echo >&2 'The isolated Docker daemon exited before becoming ready.'
        exit 1
    fi
    sleep 1
done
docker info >/dev/null
/usr/sbin/sshd -D -e &
ssh_pid=$!
echo 'Virtual EC2 ready: flowlink SSH user; Docker Unix socket only.'
# Stop both services if either service exits, and forward container stop signals.
set +e
wait -n "$docker_pid" "$ssh_pid"
status=$?
exit "$status"
