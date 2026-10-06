#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/hostgator-setup-kit/_common.sh"
IMG_NS=ghcr.io/exemplo
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ghcr_status() {
  [ "${TEST_OFFLINE:-0}" = 1 ] && { printf 000; return; }
  [ "${TEST_MISSING:-}" = "$1" ] && { printf 404; return; }
  printf 200
}
manifesto_tem_plataforma() {
  printf '%s %s\n' "$1" "$2" >> "$TMP/probes"
  [ "${TEST_BAD_IMAGE:-}" != "$1" ]
}
ok() { local name="$1"; shift; "$@" >"$TMP/out" 2>&1 || { echo "✗ $name: $(<"$TMP/out")"; exit 1; }; echo "✓ $name"; }
reject() { local name="$1"; shift; if "$@" >"$TMP/out" 2>&1; then echo "✗ $name aceito"; exit 1; fi; echo "✓ $name"; }

WAHA_IMAGE=devlikeapro/waha:latest-2026.7.2
ok 'release completa em AMD64' preflight_plataforma_atualizacao v1.66.1 linux/amd64
grep -q 'deskcomm-voice-agent:1.66.1 linux/amd64' "$TMP/probes"
TEST_MISSING=deskcomm-voice-agent
reject 'a quarta imagem ausente recusa update' preflight_plataforma_atualizacao v1.66.2 linux/arm64
unset TEST_MISSING
TEST_OFFLINE=1
reject 'registry indisponível recusa update' preflight_plataforma_atualizacao v1.66.1 linux/arm64
unset TEST_OFFLINE
TEST_BAD_IMAGE=registry.exemplo/waha-plus:custom
WAHA_IMAGE="$TEST_BAD_IMAGE"
reject 'WAHA customizada incompatível é preservada e recusada' preflight_plataforma_atualizacao v1.66.1 linux/arm64
test "$WAHA_IMAGE" = "$TEST_BAD_IMAGE"
unset TEST_BAD_IMAGE
ok 'WAHA Plus customizada compatível passa' preflight_plataforma_atualizacao v1.66.1 linux/arm64
grep -q 'registry.exemplo/waha-plus:custom linux/arm64' "$TMP/probes"
WAHA_IMAGE=devlikeapro/waha:latest-2026.7.2
ok 'WAHA padrão antiga migra só na sonda ARM64' preflight_plataforma_atualizacao v1.66.1 linux/arm64
grep -q 'devlikeapro/waha:noweb-arm-2026.7.2 linux/arm64' "$TMP/probes"
test "$WAHA_IMAGE" = devlikeapro/waha:latest-2026.7.2
reject 'canal móvel não é update versionado' preflight_plataforma_atualizacao stable linux/arm64

# O updater decide no-op/downgrade antes do preflight. Uma atualização real
# recusada em ARM64 não pode ter feito backup, checkout ou tocado no banco. O
# cron do agente e o GoTrue (signup/SMTP) ficam no passo 0, antes da decisão de
# versão, de propósito: o "só convite" tem de chegar mesmo quando o update recusa.
updater="$(<"$ROOT/hostgator-setup-kit/update.sh")"
before="${updater%%if \[ \"\$PLATAFORMA_HOST\" = linux/arm64 \] && *! preflight_plataforma_atualizacao *}"
test "$before" != "$updater" || { echo '✗ update.sh não chama preflight_plataforma_atualizacao só no ARM64'; exit 1; }
after="${updater#*! preflight_plataforma_atualizacao *}"
case "$before" in
  *'bash "$KIT_DIR/backup.sh"'*|*'git checkout --quiet'*|*'atualizar_supabase_single_server ||'*)
    echo '✗ atualização altera estado antes do preflight'; exit 1 ;;
esac
case "$before" in
  *'sincronizar_signup_mode_do_gotrue'*'setup_update_agent_cron'*'Procurando atualizações'*) : ;;
  *) echo '✗ GoTrue/cron saíram do passo 0'; exit 1 ;;
esac
case "$after" in
  *'bash "$KIT_DIR/backup.sh"'*'git checkout --quiet'*) : ;;
  *) echo '✗ ordem de backup/checkout incorreta'; exit 1 ;;
esac
echo '✓ update real em ARM64 consulta plataformas antes de efeitos'

# O escape da #1955 (DESKCOMM_BUILD_LOCAL) não pode sumir no ARM64: com o
# registro fora, é justamente ele que deixa atualizar. Roda o `if` REAL do
# update.sh, com `refuse` trocado por uma saída que o teste enxerga.
guarda="$(sed -n '/^if \[ "\$PLATAFORMA_HOST" = linux\/arm64 \]/,/^fi$/p' "$ROOT/hostgator-setup-kit/update.sh")"
[ -n "$guarda" ] || { echo '✗ não achei a guarda de plataforma no update.sh'; exit 1; }
roda_guarda() ( refuse() { exit 3; }; PLATAFORMA_HOST=linux/arm64 TARGET_TAG=v1.66.1; eval "$guarda" )
TEST_OFFLINE=1
reject 'ARM64 com registro fora e sem construção local recusa' roda_guarda
DESKCOMM_BUILD_LOCAL=1 ok 'ARM64 com registro fora e DESKCOMM_BUILD_LOCAL=1 não recusa' roda_guarda
unset TEST_OFFLINE

test -f "$ROOT/hostgator-setup-kit/preflight-upgrade.sh" || { echo '✗ falta bootstrap legado'; exit 1; }
echo '✓ bootstrap legado presente'

mkdir -p "$TMP/instalacao" "$TMP/bin"
printf 'services: {}\n' > "$TMP/instalacao/docker-compose.prod.yml"
printf 'WAHA_IMAGE=registry.exemplo/plus:arm\nTEST_SECRET=segredo-que-nao-pode-sair\n' > "$TMP/instalacao/.env"
cp "$TMP/instalacao/.env" "$TMP/env-antes"
cat > "$TMP/bin/uname" <<'STUB'
#!/usr/bin/env bash
[ "$*" = -m ] && { printf 'aarch64\n'; exit 0; }
exec /usr/bin/uname "$@"
STUB
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *ghcr.io/token*) printf '%s' '{"token":"teste"}' ;;
  *ghcr.io/v2/*) printf 200 ;;
esac
STUB
cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
if [ "$1 $2 $3" = 'buildx imagetools inspect' ]; then
  case " $* " in
    *' --raw '*) printf '%s' '{"schemaVersion":2,"manifests":[{"platform":{"os":"linux","architecture":"arm64"}}]';;
    *) printf 'linux/arm64\n';;
  esac
  exit 0
fi
printf 'docker mutante chamado: %s\n' "$*" >&2
exit 91
STUB
chmod +x "$TMP/bin/uname" "$TMP/bin/curl" "$TMP/bin/docker"
PATH="$TMP/bin:$PATH" bash "$ROOT/hostgator-setup-kit/preflight-upgrade.sh" \
  --installation "$TMP/instalacao" --to v1.66.1 >"$TMP/cli-out" 2>&1 || {
    echo "✗ bootstrap legado falhou: $(<"$TMP/cli-out")"; exit 1;
  }
cmp -s "$TMP/instalacao/.env" "$TMP/env-antes" || { echo '✗ bootstrap escreveu no .env'; exit 1; }
! grep -q segredo-que-nao-pode-sair "$TMP/cli-out" || { echo '✗ segredo apareceu na saída'; exit 1; }
echo '✓ bootstrap legado só lê e não divulga segredo'

# O update.sh carrega estes arquivos juntos, e em bash a ÚLTIMA definição de um
# nome vence sem aviso. O merge com a #1955 produziu exatamente isso: dois
# `preflight_atualizacao` no _common.sh, e o do ARM64 (2 argumentos, motivo no
# stderr) calou o preflight geral que o update.sh chama com 1 argumento.
dup="$(cat "$ROOT"/hostgator-setup-kit/{_i18n,_manifestos,_common,_supabase-images,manutencao}.sh \
  | grep -oE '^[A-Za-z_][A-Za-z0-9_]*\(\)' | sort | uniq -d)"
[ -z "$dup" ] || { echo "✗ função definida duas vezes no kit: $dup"; exit 1; }
echo '✓ nenhuma função do kit é definida duas vezes'
