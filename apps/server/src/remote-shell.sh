#!/usr/bin/env bash
set -euo pipefail

LOCAL_SHELL="${T3_LOCAL_SHELL:-/bin/bash}"
REMOTE_HOST="${T3_REMOTE_HOST:-}"
REMOTE_PATH="${T3_REMOTE_PATH:-}"
LOCAL_PATH="${T3_LOCAL_PATH:-}"
REMOTE_USER="${T3_REMOTE_USER:-}"
REMOTE_PORT="${T3_REMOTE_PORT:-}"
MUTAGEN_LABEL_SELECTOR="${T3_MUTAGEN_LABEL_SELECTOR:-}"
MUTAGEN_BIN="${T3_MUTAGEN_BIN:-mutagen}"
STATE_DIR="${T3_REMOTE_STATE_DIR:-${HOME}/.t3code/remote-execution}"
MARKER="__T3_REMOTE_CWD__"

SSH_CONTROL_DIR="${STATE_DIR}/ssh"
SSH_CONTROL_PATH="${SSH_CONTROL_DIR}/control-%h-%p-%r"

mkdir -p "${STATE_DIR}" "${SSH_CONTROL_DIR}"

REMOTE_TARGET="${REMOTE_HOST}"
if [[ -n "${REMOTE_USER}" ]]; then
  REMOTE_TARGET="${REMOTE_USER}@${REMOTE_TARGET}"
fi

SSH_OPTS=(
  -o "BatchMode=yes"
  -o "ConnectTimeout=5"
  -o "ControlMaster=auto"
  -o "ControlPath=${SSH_CONTROL_PATH}"
  -o "ControlPersist=600"
  -o "ServerAliveInterval=30"
)

if [[ -n "${REMOTE_PORT}" ]]; then
  SSH_OPTS+=(-p "${REMOTE_PORT}")
fi

replace_paths_to_remote() {
  local value="$1"
  echo "${value//$LOCAL_PATH/$REMOTE_PATH}"
}

replace_paths_to_local() {
  local value="$1"
  echo "${value//$REMOTE_PATH/$LOCAL_PATH}"
}

flush_mutagen() {
  if [[ -z "${MUTAGEN_LABEL_SELECTOR}" ]]; then
    return 0
  fi
  if ! command -v "${MUTAGEN_BIN}" >/dev/null 2>&1; then
    return 0
  fi
  "${MUTAGEN_BIN}" sync flush --label-selector "${MUTAGEN_LABEL_SELECTOR}" >/dev/null 2>&1 || true
}

check_remote() {
  if [[ -z "${REMOTE_HOST}" || -z "${REMOTE_PATH}" || -z "${LOCAL_PATH}" ]]; then
    return 1
  fi
  ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" "exit 0" >/dev/null 2>&1
}

fail_remote_execution() {
  local detail="${1:-Remote execution target is unavailable.}"
  printf '[t3] %s\n' "${detail}" >&2
  exit 1
}

run_remote_command() {
  local command="$1"
  local remote_command
  remote_command="$(replace_paths_to_remote "${command}")"
  local remote_cwd
  remote_cwd="$(replace_paths_to_remote "$(pwd -P)")"

  flush_mutagen

  local output
  output="$(
    ssh "${SSH_OPTS[@]}" "${REMOTE_TARGET}" \
      "cd '${remote_cwd}' 2>/dev/null || cd '${REMOTE_PATH}'; ${LOCAL_SHELL} -lc $(printf '%q' "${remote_command}"); printf '\n${MARKER}%s\n' \"\$(pwd -P)\"" \
      2>&1
  )"
  local exit_code=$?

  flush_mutagen

  local new_cwd=""
  if [[ "${output}" == *"${MARKER}"* ]]; then
    new_cwd="${output##*${MARKER}}"
    output="${output%${MARKER}*}"
    new_cwd="$(replace_paths_to_local "${new_cwd}")"
    printf '%s\n' "${new_cwd}" > "${STATE_DIR}/cwd"
  fi

  printf '%s' "$(replace_paths_to_local "${output}")"
  return "${exit_code}"
}

run_interactive() {
  if ! check_remote; then
    fail_remote_execution "SSH target ${REMOTE_TARGET} is unreachable."
  fi

  flush_mutagen

  local remote_cwd
  remote_cwd="$(replace_paths_to_remote "$(pwd -P)")"
  exec ssh "${SSH_OPTS[@]}" -t "${REMOTE_TARGET}" \
    "cd '${remote_cwd}' 2>/dev/null || cd '${REMOTE_PATH}'; exec ${LOCAL_SHELL} -l"
}

main() {
  if [[ "$#" -eq 0 ]]; then
    run_interactive
  fi

  if [[ "$1" == "-c" && "$#" -ge 2 ]]; then
    shift
    if ! check_remote; then
      fail_remote_execution "SSH target ${REMOTE_TARGET} is unreachable."
    fi
    run_remote_command "$*"
    exit $?
  fi

  if [[ "$1" == "-l" || "$1" == "--login" || "$1" == "-i" ]]; then
    shift || true
    run_interactive "$@"
  fi

  fail_remote_execution "SSH target ${REMOTE_TARGET} is unavailable for local shell execution."
}

main "$@"
