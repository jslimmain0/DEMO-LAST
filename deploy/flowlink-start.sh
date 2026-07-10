#!/usr/bin/env bash
set -Eeuo pipefail

readonly app_home="${FLOWLINK_HOME:-${HOME}/flowlink}"
readonly jar_file="${app_home}/flowlink.jar"
readonly data_directory="${app_home}/data"
readonly plugin_directory="${app_home}/plugins"
readonly log_file="${app_home}/flowlink.log"
readonly pid_file="${app_home}/flowlink.pid"

if [[ ! -f "${jar_file}" ]]; then
    echo "FlowLink JAR not found: ${jar_file}" >&2
    exit 1
fi

mkdir -p "${data_directory}" "${plugin_directory}"

if [[ -s "${pid_file}" ]]; then
    pid="$(cat "${pid_file}")"
    if [[ -r "/proc/${pid}/cmdline" ]] \
        && tr '\0' ' ' < "/proc/${pid}/cmdline" | grep -Fq "${jar_file}"; then
        echo "FlowLink is already running (PID ${pid})."
        exit 0
    fi
    rm -f "${pid_file}"
fi

nohup env \
    SERVER_ADDRESS=127.0.0.1 \
    SPRING_PROFILES_ACTIVE=h2 \
    FLOWLINK_PORT=18080 \
    FLOWLINK_H2_FILE="${data_directory}/flowlink" \
    FLOWLINK_PLUGINS_DIR="${plugin_directory}" \
    FLOWLINK_EXECUTION_RELAY_BASEURL=http://localhost:18080 \
    java -jar "${jar_file}" >> "${log_file}" 2>&1 < /dev/null &

pid=$!
printf '%s\n' "${pid}" > "${pid_file}"

for _ in $(seq 1 60); do
    if curl --fail --silent http://127.0.0.1:18080/actuator/health \
        | grep -q '"status":"UP"'; then
        echo "FlowLink is ready (PID ${pid})."
        exit 0
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
        echo "FlowLink stopped during startup. See ${log_file}." >&2
        tail -n 50 "${log_file}" >&2 || true
        rm -f "${pid_file}"
        exit 1
    fi
    sleep 1
done

echo "FlowLink did not become healthy within 60 seconds. See ${log_file}." >&2
exit 1
