#!/usr/bin/env bash
set -Eeuo pipefail

readonly app_home="${FLOWLINK_HOME:-${HOME}/flowlink}"
readonly pid_file="${app_home}/flowlink.pid"

if [[ ! -s "${pid_file}" ]]; then
    echo "FlowLink is not running."
    exit 0
fi

pid="$(cat "${pid_file}")"
if [[ ! -r "/proc/${pid}/cmdline" ]] \
    || ! tr '\0' ' ' < "/proc/${pid}/cmdline" | grep -Fq "${app_home}/flowlink.jar"; then
    rm -f "${pid_file}"
    echo "FlowLink is not running."
    exit 0
fi

kill "${pid}"
for _ in $(seq 1 30); do
    if ! kill -0 "${pid}" 2>/dev/null; then
        rm -f "${pid_file}"
        echo "FlowLink stopped."
        exit 0
    fi
    sleep 1
done

echo "FlowLink did not stop within 30 seconds." >&2
exit 1
