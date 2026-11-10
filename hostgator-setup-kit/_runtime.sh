#!/usr/bin/env bash
# Loaded by agent.sh after _common.sh and esc(). No Docker access is granted
# to the app. Only the existing host agent reads immutable image metadata.

runtime_service() { # role; all strings emitted below are validated or escaped
  local role="$1" ids id image revision version base running healthy owner service folder verified=false
  ids="$(dc ps -a -q "$role" 2>/dev/null)" || ids=""
  id=""; image=""; revision=""; version=""; base=""; running=false; healthy=false
  if [[ "$ids" =~ ^[a-f0-9]{64}$ ]]; then
    id="$ids"
    owner="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null)" || owner=""
    service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null)" || service=""
    folder="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$id" 2>/dev/null)" || folder=""
    if [ "$owner" = "$(nome_do_projeto_atual)" ] && [ "$service" = "$role" ] && [ "$folder" = "$PROJECT_DIR" ]; then
      image="$(docker inspect --format '{{.Image}}' "$id" 2>/dev/null)" || image=""
      running="$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null)" || running=false
      # Missing healthcheck is not a successful healthcheck.
      [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)" = healthy ] && healthy=true
      if [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]; then
        revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null)" || revision=""
        version="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" 2>/dev/null | sed -n 's/^APP_VERSION=//p')" || version=""
        # APP_VERSION only locates a release. The tag must come from origin,
        # and its commit must really be an ancestor of the image's revision.
        if [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "$revision" =~ ^[a-f0-9]{40,64}$ ]] && [ "$RUNTIME_TAGS_OK" = true ]; then
          base="$(git rev-parse --verify "refs/deskcomm-runtime-tags/v${version#v}^{commit}" 2>/dev/null)" || base=""
          if [[ "$base" =~ ^[a-f0-9]{40,64}$ ]] && git merge-base --is-ancestor "$base" "$revision" 2>/dev/null; then verified=true; fi
        fi
      fi
    fi
  fi
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || id=""
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || image=""
  [[ "$revision" =~ ^[a-f0-9]{40,64}$ ]] || revision=""
  [[ "$base" =~ ^[a-f0-9]{40,64}$ ]] || base=""
  [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || version=""
  [ "$running" = true ] || running=false
  if [ "$verified" != true ] || [ "$running" != true ] || [ "$healthy" != true ]; then RUNTIME_CONFIRMED=false; fi
  RUNTIME_SELECTIONS="${RUNTIME_SELECTIONS}${role}:${ids}"$'\n'
  if [ "$role" = app ]; then
    RUNTIME_REVISION="$revision"; RUNTIME_VERSION="${version#v}"; RUNTIME_BASE="$base"
  elif [ "$revision" != "$RUNTIME_REVISION" ] || [ "${version#v}" != "$RUNTIME_VERSION" ] || [ "$base" != "$RUNTIME_BASE" ]; then
    RUNTIME_CONFIRMED=false
  fi
  # Re-read the selection at the end; never publish a snapshot of a container
  # that compose replaced while metadata was being collected.
  [ "$ids" = "$(dc ps -a -q "$role" 2>/dev/null || true)" ] || RUNTIME_CHANGED=true
  # Build nullable fields explicitly (no unvalidated Docker text in JSON).
  RUNTIME_SERVICE="{\"role\":\"$role\",\"container_id\":$(runtime_nullable "$id"),\"image_id\":$(runtime_nullable "$image"),\"revision\":$(runtime_nullable "$revision"),\"base_version\":$(runtime_nullable "${version#v}"),\"base_revision\":$(runtime_nullable "$base"),\"source_verified\":$verified,\"running\":$running,\"healthy\":$healthy}"
}

runtime_nullable() { if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }

collect_runtime_confirmation() {
  RUNTIME_TAGS_OK=false; RUNTIME_CONFIRMED=true; RUNTIME_CHANGED=false
  RUNTIME_REVISION=""; RUNTIME_VERSION=""; RUNTIME_BASE=""; RUNTIME_SELECTIONS=""
  # An isolated ref namespace: no checkout, existing tags or branches change.
  git fetch --quiet origin '+refs/tags/v*:refs/deskcomm-runtime-tags/v*' 2>/dev/null && RUNTIME_TAGS_OK=true
  local role services="" issues="" voice_ids published="${LATEST_TAG:-}"
  [[ "$published" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || published=""
  for role in app worker scheduler; do
    runtime_service "$role"
    services="${services}${services:+,}${RUNTIME_SERVICE}"
  done
  # Voice is optional. An existing stopped container is still applicable and
  # cannot disappear from the health/identity verdict merely by stopping it.
  voice_ids="$(dc ps -a -q voice-agent 2>/dev/null)" || voice_ids=""
  if [ -n "$voice_ids" ]; then runtime_service voice-agent; services="$services,$RUNTIME_SERVICE"; fi
  while IFS=: read -r role ids; do
    [ -z "$role" ] && continue
    [ "$ids" = "$(dc ps -a -q "$role" 2>/dev/null || true)" ] || RUNTIME_CHANGED=true
  done <<< "$RUNTIME_SELECTIONS"
  [ "$RUNTIME_TAGS_OK" = true ] || issues='"release_refs_unavailable"'
  if [ "$RUNTIME_CHANGED" = true ]; then issues="${issues}${issues:+,}\"changed_during_collection\""; RUNTIME_CONFIRMED=false; fi
  RUNTIME_CONFIRMATION="{\"schema\":1,\"collected_at\":\"$(date -u +%FT%TZ)\",\"project\":\"$(esc "$(nome_do_projeto_atual)")\",\"published_release\":$(runtime_nullable "$published"),\"services\":[$services],\"issues\":[$issues]}"
}

# The native updater installs public release images. A custom revision needs
# reconciliation; a partial observation cannot authorize replacement either.
runtime_can_install_release() {
  [ "$RUNTIME_CONFIRMED" = true ] && [ -n "$RUNTIME_BASE" ] && [ "$RUNTIME_REVISION" = "$RUNTIME_BASE" ]
}
