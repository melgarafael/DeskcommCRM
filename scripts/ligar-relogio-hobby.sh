#!/usr/bin/env bash
# Liga o relógio de quem não tem agendador: imprime os comandos
# (não grava secrets sozinho).
# Uso: ./scripts/ligar-relogio-hobby.sh https://SEU-DOMINIO
set -eu
APP_URL="${1:-}"
REPO="${2:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"

if [ -z "$APP_URL" ]; then
  echo "Uso: $0 <APP_URL> [owner/repo]"
  echo "Ex.: $0 https://SEU-DOMINIO SEU_USER/DeskcommCRM"
  exit 1
fi

APP_URL="${APP_URL%/}"
TICK="${APP_URL}/api/v1/system/relogio/tick"

cat <<EOF
=== Relógio sem agendador ===

1) GitHub Actions (grátis, a cada ~5 min) — o workflow PRECISA estar na main:

   gh variable set RELOGIO_LIGADO -R ${REPO:-SEU_USER/DeskcommCRM} -b 1
   gh secret set RELOGIO_APP_URL -R ${REPO:-SEU_USER/DeskcommCRM} -b "${APP_URL}"
   gh secret set RELOGIO_SECRET -R ${REPO:-SEU_USER/DeskcommCRM}
   # (cole o INTERNAL_SECRET do seu .env quando pedir)

   Depois: Actions → relogio → Run workflow

2) cron-job.org (grátis, a cada 1 min) — cole isto no painel:

   URL:    ${TICK}
   Method: POST
   Header: Authorization = Bearer <INTERNAL_SECRET>

3) Teste agora (PowerShell / bash):

   curl -fsS -X POST -H "Authorization: Bearer \$INTERNAL_SECRET" "${TICK}"

Runbook: docs/runbooks/relogio-http.md
EOF
