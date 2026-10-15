#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# Only the registry boundary is replaced; the production helper parses its JSON.
cat > "$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
if [ "${MOCK_DOCKER_FAIL:-0}" = 1 ]; then exit 1; fi
if [ "${4:-}" = --raw ]; then
  printf '%s' "${MOCK_RAW:-}"
else
  printf '%s' "${MOCK_FORMAT:-}"
fi
SH
cat > "$TMP/bin/jq" <<'SH'
#!/usr/bin/env bash
exit 127
SH
chmod +x "$TMP/bin/docker" "$TMP/bin/jq"
export PATH="$TMP/bin:$PATH"
source "$ROOT/hostgator-setup-kit/_common.sh"

ghcr_status() {
  if [ "${MOCK_MISSING_IMAGE:-}" = "$1" ]; then printf '%s' 404
  else printf '%s' "${MOCK_STATUS:-200}"; fi
}

both='{"schemaVersion":2,"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}},{"platform":{"os":"unknown","architecture":"unknown"}}]}'
amd='{"schemaVersion":2,"manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}'
arm='{"schemaVersion":2,"manifests":[{"platform":{"os":"linux","architecture":"arm64"}}]}'
single='{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"digest":"sha256:abc"}}'

expect_ok() {
  local label="$1"; shift
  if "$@" >"$TMP/out" 2>&1; then printf '✓ %s\n' "$label"
  else printf '✗ %s: %s\n' "$label" "$(<"$TMP/out")"; exit 1; fi
}
expect_fail() {
  local label="$1" reason="$2"; shift 2
  if "$@" >"$TMP/out" 2>&1; then printf '✗ %s: accepted\n' "$label"; exit 1; fi
  if ! grep -q "$reason" "$TMP/out"; then
    printf '✗ %s: missing reason %s: %s\n' "$label" "$reason" "$(<"$TMP/out")"; exit 1
  fi
  printf '✓ %s\n' "$label"
}

expect_ok 'host amd64' test "$(plataforma_oci_do_host x86_64)" = linux/amd64
expect_ok 'host arm64' test "$(plataforma_oci_do_host aarch64)" = linux/arm64
expect_fail 'unknown host' riscv64 plataforma_oci_do_host riscv64

export MOCK_RAW="$both" MOCK_FORMAT=$'linux/amd64\nlinux/arm64\nunknown/unknown'
expect_ok 'index amd64' manifesto_tem_plataforma example/app:1 linux/amd64
expect_ok 'index arm64' manifesto_tem_plataforma example/app:1 linux/arm64
export MOCK_RAW="$amd" MOCK_FORMAT='linux/amd64'
expect_fail 'amd-only image on ARM' linux/arm64 manifesto_tem_plataforma example/app:1 linux/arm64
export MOCK_RAW="$arm" MOCK_FORMAT='linux/arm64'
expect_fail 'arm-only image on AMD' linux/amd64 manifesto_tem_plataforma example/app:1 linux/amd64

export MOCK_RAW="$single" MOCK_FORMAT='linux/arm64'
expect_ok 'single manifest ARM' manifesto_tem_plataforma example/app:1 linux/arm64
expect_fail 'single manifest wrong arch' linux/amd64 manifesto_tem_plataforma example/app:1 linux/amd64

export MOCK_RAW='not-json'
expect_fail 'malformed manifest' OCI manifesto_tem_plataforma example/app:1 linux/arm64
export MOCK_RAW=''
expect_fail 'empty manifest' OCI manifesto_tem_plataforma example/app:1 linux/arm64
export MOCK_RAW="$both" MOCK_FORMAT=$'linux/amd64\nlinux/arm64' MOCK_DOCKER_FAIL=1
expect_fail 'unreachable registry' inacessível manifesto_tem_plataforma example/app:1 linux/arm64
unset MOCK_DOCKER_FAIL

export MOCK_STATUS=403
expect_fail 'private GHCR package' 403 preflight_imagens_crm 1.66.1 linux/arm64
export MOCK_STATUS=000
expect_fail 'GHCR offline' 000 preflight_imagens_crm 1.66.1 linux/arm64
export MOCK_STATUS=200 MOCK_MISSING_IMAGE=deskcomm-voice-agent
expect_fail 'one of four missing' deskcomm-voice-agent preflight_imagens_crm 1.66.1 linux/arm64
unset MOCK_MISSING_IMAGE
expect_ok 'all four match' preflight_imagens_crm 1.66.1 linux/arm64
expect_ok 'legacy name checks platform' trio_publicado 1.66.1
