#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_REPOSITORY:?Set owner/repository}"

[[ "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 1
if [[ ! -f .runner ]]; then
: "${RUNNER_TOKEN:?Set a short-lived GitHub runner registration token}"
./config.sh --unattended --url "https://github.com/$GITHUB_REPOSITORY" --token "$RUNNER_TOKEN" \
    --name "${RUNNER_NAME:-flowlink-ec2-deploy}" --labels "${RUNNER_LABELS:-flowlink-deploy}" --work _work
fi
unset RUNNER_TOKEN
exec ./run.sh
