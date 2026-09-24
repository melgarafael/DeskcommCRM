#!/usr/bin/env bash
# Prova de `volume_waha_data` (_common.sh): o volume que backup.sh e restore.sh
# montam para salvar e restaurar as sessões do WhatsApp.
#
#   bash tests/shell/waha-backup-volume.test.sh
#
# Regressão: `docker compose config --volumes` devolve `waha-data`, mas o volume
# real tem o prefixo do projeto (ex.: `deskcommcrm_waha-data`). O backup antigo
# montava um volume global vazio e gerava um .tgz de ~87 bytes que passava no
# `tar tzf`. A fonte da verdade é a montagem `/app/.sessions` do contêiner; sem
# contêiner, o nome sai de `nome_do_projeto_atual`, o mesmo que o compose usa.
#
# Nada aqui toca a máquina de quem roda: `docker` é um dublê.
set -uo pipefail
unset COMPOSE_PROJECT_NAME

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublê de docker ──────────────────────────────────────────────────────────
# `compose ... ps -a -q waha` devolve $WAHA_ID; `inspect` devolve $WAHA_VOL, o
# que o --format da montagem /app/.sessions imprimiria.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
case " $* " in
  *" ps -a -q waha "*) printf '%s\n' "${WAHA_ID:-}" ;;
  *" inspect "*) printf '%s\n' "${WAHA_VOL:-}" ;;
  *) : ;;
esac
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

volume_de() {  # volume_de <PROJECT_DIR> → o volume que backup/restore montariam
  ( PROJECT_DIR="$1"; source "$KIT_DIR/_common.sh"; volume_waha_data )
}
igual() { [ "$1" = "$2" ] || { printf '    esperado %s, veio %s\n' "$2" "$1"; return 1; }; }

echo "volume_waha_data:"
check "com contêiner, vale a montagem real, não o nome da pasta" \
  igual "$(WAHA_ID=abc123 WAHA_VOL=deskcommcrm_waha-data volume_de /root/deskcomm-crm)" deskcommcrm_waha-data
check "sem contêiner, pasta /root/DeskcommCRM dá deskcommcrm_waha-data" \
  igual "$(volume_de /root/DeskcommCRM)" deskcommcrm_waha-data
check "sem contêiner, pasta com hífen mantém o hífen, como o compose" \
  igual "$(volume_de /root/deskcomm-crm)" deskcomm-crm_waha-data
check "sem contêiner, COMPOSE_PROJECT_NAME vence o nome da pasta" \
  igual "$(COMPOSE_PROJECT_NAME=deskcomm-prod volume_de /root/DeskcommCRM)" deskcomm-prod_waha-data

echo "backup.sh e restore.sh:"
for f in backup.sh restore.sh; do
  check "$f monta o volume de volume_waha_data" grep -q 'vol="$(volume_waha_data)"' "$KIT_DIR/$f"
  check "$f não confia mais no nome lógico" \
    bash -c '! grep -q "dc config --volumes.*waha-data" "$1"' _ "$KIT_DIR/$f"
done

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: backup e restore resolvem o volume físico das sessões WAHA'
