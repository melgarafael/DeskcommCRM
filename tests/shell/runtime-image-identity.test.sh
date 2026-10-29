#!/usr/bin/env bash
set -euo pipefail
# A hook may export GIT_DIR/GIT_INDEX_FILE: the fixture must own its Git state.
unset $(git rev-parse --local-env-vars)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q
git -c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -qm base
BASE="$(git rev-parse HEAD)"
git tag v1.2.0
git -c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -qm customized
CUSTOM="$(git rev-parse HEAD)"
git -c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -qm other
OTHER="$(git rev-parse HEAD)"
# The checkout deliberately differs from the image. No registry/network.
PROJECT_DIR="$TMP"
nome_do_projeto_atual() { printf 'example-crm'; }
esc() { printf '%s' "$1"; }
git() {
  if [ "${1:-}" = fetch ]; then
    command git update-ref refs/deskcomm-runtime-tags/v1.2.0 "$BASE"
  else command git "$@"; fi
}
dc() {
  local role="${*: -1}" digit
  case "$role" in app) digit=1;; worker) digit=2;; scheduler) digit=3;; *) return 0;; esac
  printf '%064d\n' "$digit"
}
docker() {
  local format="${*: -2:1}" id="${*: -1}" role
  case "$id" in *1|*4) role=app;; *2|*5) role=worker;; *) role=scheduler;; esac
  case "$format" in
    *com.docker.compose.project.working_dir*) printf '%s\n' "$PROJECT_DIR";;
    *com.docker.compose.project*) if [ "$MODE" = foreign ] && [ "$role" = worker ]; then printf 'foreign\n'; else printf 'example-crm\n'; fi;;
    *com.docker.compose.service*) printf '%s\n' "$role";;
    '{{.Image}}') case "$role" in app) printf 'sha256:%064d\n' 4;; worker) printf 'sha256:%064d\n' 5;; *) printf 'sha256:%064d\n' 6;; esac;;
    *State.Running*) printf 'true\n';;
    *State.Health*) if [ "$MODE" = unhealthy ] && [ "$role" = worker ]; then printf 'unhealthy\n'; else printf 'healthy\n'; fi;;
    *org.opencontainers.image.revision*)
      if [ "$MODE" = official ]; then printf '%s\n' "$BASE"
      elif [ "$MODE" = missing ]; then printf '<no value>\n'
      elif [ "$MODE" = divergent ] && [ "$role" = worker ]; then printf '%s\n' "$OTHER"
      else printf '%s\n' "$CUSTOM"; fi;;
    *Config.Env*) printf 'APP_VERSION=1.2.0\n';;
    *) printf 'unexpected docker format: %s\n' "$format" >&2; return 1;;
  esac
}
source "$ROOT/hostgator-setup-kit/_runtime.sh"
for MODE in official customized unhealthy missing divergent foreign; do
  collect_runtime_confirmation
  case "$MODE" in
    official|customized) [ "$RUNTIME_CONFIRMED" = true ];;
    *) [ "$RUNTIME_CONFIRMED" = false ];;
  esac
  if [ "$MODE" = official ]; then [ "$RUNTIME_REVISION" = "$BASE" ]; fi
  if [ "$MODE" = customized ]; then [ "$RUNTIME_REVISION" = "$CUSTOM" ] && [ "$RUNTIME_REVISION" != "$(command git rev-parse HEAD)" ]; fi
  if [ "$MODE" = official ]; then runtime_can_install_release; else ! runtime_can_install_release; fi
  printf '%s\n' "$RUNTIME_CONFIRMATION" > "$TMP/$MODE.json"
done
printf 'runtime collector: official/customized/health/missing/divergent/project isolation passed\n'
