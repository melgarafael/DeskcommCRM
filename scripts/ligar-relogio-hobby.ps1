# Liga o relógio de quem não tem agendador: imprime os comandos
# (não grava secrets sozinho).
# Uso: .\scripts\ligar-relogio-hobby.ps1 -AppUrl https://SEU-DOMINIO [-Repo owner/repo]
param(
  [Parameter(Mandatory = $true)][string]$AppUrl,
  [string]$Repo = ""
)

# Mesmo fallback do irmão `ligar-relogio-hobby.sh`: sem -Repo, o repositório sai
# do `gh`, e o placeholder só entra quando não vier nada. Um literal como default
# seria um valor que nunca funciona para quem rodar sem passar o parâmetro.
if (-not $Repo -and (Get-Command gh -ErrorAction SilentlyContinue)) {
  $Repo = gh repo view --json nameWithOwner -q .nameWithOwner 2>$null
}
if (-not $Repo) { $Repo = "SEU_USER/DeskcommCRM" }

$AppUrl = $AppUrl.TrimEnd("/")
$Tick = "$AppUrl/api/v1/system/relogio/tick"

Write-Host @"
=== Relógio sem agendador ===

1) GitHub Actions (grátis, a cada ~5 min) — o workflow PRECISA estar na main:

   gh variable set RELOGIO_LIGADO -R $Repo -b 1
   gh secret set RELOGIO_APP_URL -R $Repo -b "$AppUrl"
   gh secret set RELOGIO_SECRET -R $Repo
   # (cole o INTERNAL_SECRET do seu .env quando pedir)

   Depois: Actions → relogio → Run workflow

2) cron-job.org (grátis, a cada 1 min) — cole isto no painel:

   URL:    $Tick
   Method: POST
   Header: Authorization = Bearer <INTERNAL_SECRET>

3) Teste agora:

   curl -fsS -X POST -H "Authorization: Bearer `$INTERNAL_SECRET" "$Tick"

Runbook: docs/runbooks/vercel-hobby-relogio.md
"@
