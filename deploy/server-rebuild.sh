#!/usr/bin/env bash
set -Eeuo pipefail

readonly repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly runtime_home="${FLOWLINK_HOME:-${HOME}/flowlink}"
readonly runtime_jar="${runtime_home}/flowlink.jar"
readonly previous_jar="${runtime_home}/flowlink.jar.previous"
readonly start_script="${runtime_home}/bin/flowlink-start.sh"
readonly stop_script="${runtime_home}/bin/flowlink-stop.sh"
readonly built_jar="${repo_root}/backend/build/libs/flowlink.jar"
readonly built_plugin="${repo_root}/backend/plugin-sample/build/libs/flowlink-plugin-sample.jar"

for command_name in java javac node npm; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
        echo "Required build command is missing: ${command_name}" >&2
        exit 1
    fi
done

echo "[1/3] Building the frontend"
cd "${repo_root}/frontend"
npm ci
npm run lint
npm run build

echo "[2/3] Testing and building the application JAR"
cd "${repo_root}/backend"
java -classpath gradle/wrapper/gradle-wrapper.jar \
    org.gradle.wrapper.GradleWrapperMain \
    --no-daemon clean test :plugin-sample:test bootJar :plugin-sample:jar

if ! jar tf "${built_jar}" | grep 'BOOT-INF/classes/static/index.html' >/dev/null; then
    echo "The built JAR does not contain the frontend." >&2
    exit 1
fi

echo "[3/3] Installing and restarting FlowLink"
if [[ -f "${runtime_jar}" ]]; then
    cp -f "${runtime_jar}" "${previous_jar}"
fi

"${stop_script}"
install -m 0644 "${built_jar}" "${runtime_jar}"
install -m 0644 "${built_plugin}" "${runtime_home}/plugins/flowlink-plugin-sample.jar"

if ! "${start_script}"; then
    echo "The new build failed to start; restoring the previous JAR." >&2
    "${stop_script}" || true
    if [[ -f "${previous_jar}" ]]; then
        install -m 0644 "${previous_jar}" "${runtime_jar}"
        "${start_script}" || true
    fi
    exit 1
fi

sha256sum "${runtime_jar}"
echo "FlowLink rebuild completed."
