#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
doc="$root/docs/runbooks/oracle-arm64.md"
test -f "$doc"
for item in \
  'VM.Standard.A1.Flex' '2 OCPU' '12 GB' 'linux/arm64' \
  '80/TCP' '443/TCP' '7881/UDP' '5060/UDP' '10000–10200/UDP' \
  'VCN' 'Ubuntu' 'vX.Y.Z' 'preflight-upgrade.sh' \
  'ubuntu-production-installer.sh' \
  'backup.sh' 'restore.sh' 'não executado' \
  'RLS' 'WhatsApp' 'WaCalls' 'UI' 'ferramenta direta' \
  'não é deploy automático'; do
  grep -Fq "$item" "$doc" || { printf 'Runbook sem %s\n' "$item" >&2; exit 1; }
done
for path in ubuntu-production-installer.sh hostgator-setup-kit/preflight-upgrade.sh \
  hostgator-setup-kit/backup.sh \
  hostgator-setup-kit/restore.sh; do
  test -f "$root/$path" || { printf 'Comando documentado inexistente: %s\n' "$path" >&2; exit 1; }
done
printf '✓ runbook ARM64 cobre instalação, rede, rollback e limites da prova\n'
