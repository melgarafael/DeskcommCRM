#!/usr/bin/env bash
# Prova de `volume_waha_data` e `tar_tem_sessao` (_common.sh) — o volume que
# backup.sh e restore.sh montam para salvar e restaurar as sessões do WhatsApp —
# e da ponta que decide se o snapshot presta (backup.sh).
#
#   bash tests/shell/waha-backup-volume.test.sh
#
# Duas regressões, medidas na issue #1438:
#
#  1. `docker compose config --volumes` devolve o nome LÓGICO (`waha-data`) e o
#     volume real tem o prefixo do projeto (`deskcommcrm_waha-data`). Montar o
#     lógico cria um volume global VAZIO: o .tgz sai com ~87 bytes.
#  2. `.Name` só responde por volume NOMEADO. Num bind de pasta do host ele vem
#     vazio — e aí o nome lógico volta pela porta dos fundos. E, mesmo com o
#     volume certo, um .tgz vazio passa no `tar tzf` (código 0): o passo
#     anunciava "✓ sessões WhatsApp salvas" sobre um arquivo sem nada dentro.
#
# A ponta roda o backup.sh inteiro num projeto de mentira, com um dublê de
# docker que reproduz a semântica que importa: volume nomeado que não existe é
# criado VAZIO e bind monta a pasta do host. Nada aqui toca a máquina de quem
# roda — nem o stack do CRM.
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
igual() { [ "$1" = "$2" ] || { printf '    esperado %s, veio %s\n' "$2" "$1"; return 1; }; }
contem() { grep -qF -- "$2" "$1" || { printf '    não achei %s em %s\n' "$2" "$1"; return 1; }; }
nao_contem() { grep -qF -- "$2" "$1" && { printf '    %s apareceu em %s\n' "$2" "$1"; return 1; }; return 0; }
snapshot_tem() { tar tzf "$1" 2>/dev/null | grep -qxF "./noweb/waha.sqlite3"; }

# ── Dublê de docker ──────────────────────────────────────────────────────────
# Responde o que o kit pergunta (contêiner do waha e a montagem /app/.sessions,
# no formato TIPO|NOME|ORIGEM) e, no `docker run` do snapshot, monta a mesma
# coisa que o docker real montaria: bind → a pasta do host; volume nomeado →
# $VOLSTORE/<nome>, criado vazio quando não existe (o defeito da issue nasce
# aqui). $WAHA_ID e $WAHA_MONTAGEM entram por ambiente em cada cenário.
export VOLSTORE="$WORK/volumes" DUBLE_LOG="$WORK/docker.log"
mkdir -p "$WORK/bin" "$VOLSTORE" "$WORK/sessoes/noweb" "$VOLSTORE/deskcommcrm_waha-data/noweb"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "$DUBLE_LOG"
case " $* " in
  *" ps -a -q waha "*) printf '%s\n' "${WAHA_ID:-}"; exit 0 ;;
  *" inspect "*)
    [ -n "${WAHA_MONTAGEM:-}" ] || exit 0
    # Honra o formato pedido, como o docker: o template que só pede `.Name`
    # devolve VAZIO num bind — é justamente onde o defeito da issue mora.
    case " $* " in
      *"{{.Type}}"*) printf '%s\n' "$WAHA_MONTAGEM" ;;
      *) nome="${WAHA_MONTAGEM#*|}"; printf '%s\n' "${nome%%|*}" ;;
    esac
    exit 0 ;;
esac
case " $* " in *" run "*) ;; *) exit 0 ;; esac
origem=""; destino=""
anterior=""
for arg in "$@"; do
  if [ "$anterior" = "-v" ]; then
    sem_opcao="${arg%:ro}"; sem_opcao="${sem_opcao%:rw}"
    case "${sem_opcao##*:}" in
      /data) origem="${sem_opcao%:*}" ;;
      /out) destino="${sem_opcao%:*}" ;;
    esac
  fi
  anterior="$arg"
done
[ -n "$destino" ] || exit 0   # não é o snapshot (ex.: o pg_dump do banco)
case "$origem" in
  /*) pasta="$origem" ;;                                             # bind: o host manda
  *) pasta="$VOLSTORE/${origem:-sem-origem}"; mkdir -p "$pasta" ;;    # volume nomeado: docker cria vazio
esac
alvo="$(printf '%s\n' "$*" | grep -oE '/out/[^ ]+' | head -1 || true)"
if [ -n "$alvo" ]; then tar czf "$destino/${alvo#/out/}" -C "$pasta" .; fi
exit 0
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

volume_de() {  # volume_de <PROJECT_DIR> → o volume que backup/restore montariam
  ( PROJECT_DIR="$1"; source "$KIT_DIR/_common.sh"; volume_waha_data )
}
tem_sessao() { ( source "$KIT_DIR/_common.sh"; tar_tem_sessao "$1" ); }
reprova() { ! ( source "$KIT_DIR/_common.sh"; tar_tem_sessao "$1" ); }

echo "volume_waha_data:"
check "volume nomeado: vale o nome físico da montagem, não o da pasta" \
  igual "$(WAHA_ID=abc123 WAHA_MONTAGEM='volume|deskcommcrm_waha-data|' volume_de /root/deskcomm-crm)" deskcommcrm_waha-data
check "bind: vale a pasta do host, onde o .Name vem vazio" \
  igual "$(WAHA_ID=abc123 WAHA_MONTAGEM='bind||/srv/waha-sessoes' volume_de /root/deskcomm-crm)" /srv/waha-sessoes
check "contêiner sem a montagem /app/.sessions cai no nome do projeto" \
  igual "$(WAHA_ID=abc123 WAHA_MONTAGEM='' volume_de /root/DeskcommCRM)" deskcommcrm_waha-data
check "sem contêiner, pasta /root/DeskcommCRM dá deskcommcrm_waha-data" \
  igual "$(volume_de /root/DeskcommCRM)" deskcommcrm_waha-data
check "sem contêiner, pasta com hífen mantém o hífen, como o compose" \
  igual "$(volume_de /root/deskcomm-crm)" deskcomm-crm_waha-data
check "sem contêiner, COMPOSE_PROJECT_NAME vence o nome da pasta" \
  igual "$(COMPOSE_PROJECT_NAME=deskcomm-prod volume_de /root/DeskcommCRM)" deskcomm-prod_waha-data

echo "tar_tem_sessao:"
mkdir -p "$WORK/vazio" "$WORK/cheio/noweb"
: > "$WORK/cheio/noweb/waha.sqlite3"
tar czf "$WORK/vazio.tgz" -C "$WORK/vazio" . 2>/dev/null
tar czf "$WORK/cheio.tgz" -C "$WORK/cheio" . 2>/dev/null
check "reprova o .tgz de um volume vazio (é o tar que sai com código 0)" reprova "$WORK/vazio.tgz"
check "aprova o .tgz que traz arquivo de sessão" tem_sessao "$WORK/cheio.tgz"

echo "backup.sh ponta a ponta (dublê de docker):"
PROJ="$WORK/projeto"
mkdir -p "$PROJ/backups"
: > "$PROJ/docker-compose.prod.yml"
printf '%s\n' 'SUPABASE_DB_URL="postgresql://postgres:senha@db.exemplo.supabase.co:5432/postgres"' > "$PROJ/.env"
head -c 4096 /dev/urandom > "$WORK/sessoes/noweb/waha.sqlite3"
head -c 4096 /dev/urandom > "$VOLSTORE/deskcommcrm_waha-data/noweb/waha.sqlite3"

backup() {  # backup <arquivo-de-saída> [WAHA_ID] [WAHA_MONTAGEM]
  rm -f "$PROJ"/backups/waha-*.tgz
  ( cd "$PROJ" && WAHA_ID="${2:-}" WAHA_MONTAGEM="${3:-}" bash "$KIT_DIR/backup.sh" ) > "$1" 2>&1
}
snapshot() { ls "$PROJ"/backups/waha-*.tgz 2>/dev/null | head -1 || true; }

# Bind de pasta do host: o volume do .Name não existe, o que existe é a pasta.
: > "$DUBLE_LOG"
backup "$WORK/saida-bind.txt" abc123 "bind||$WORK/sessoes"
check "bind: o snapshot sai com o arquivo de sessão que está no host" \
  snapshot_tem "$(snapshot)"
check "bind: não é o tar de um diretório vazio" \
  bash -c '[ -n "$1" ] && [ "$(wc -c < "$1")" -gt 1000 ]' _ "$(snapshot)"
check "bind: o passo não anunciou vazio" nao_contem "$WORK/saida-bind.txt" "saiu VAZIO"
check "bind: a pasta do host foi a montagem levada ao docker" contem "$DUBLE_LOG" "$WORK/sessoes:/data:ro"

# Volume nomeado com o prefixo do projeto: é o defeito original da issue.
: > "$DUBLE_LOG"
backup "$WORK/saida-volume.txt" abc123 'volume|deskcommcrm_waha-data|'
check "volume nomeado: monta o nome com o prefixo, não o waha-data do compose" \
  contem "$DUBLE_LOG" "deskcommcrm_waha-data:/data:ro"
check "volume nomeado: o snapshot sai com o arquivo de sessão real" snapshot_tem "$(snapshot)"

# Contêiner fora do ar e nenhum volume físico com esse nome: o docker criaria um
# vazio e o tar arquivaria o vazio — o defeito de hoje. Aqui o vazio é RECUSADO.
backup "$WORK/saida-vazio.txt"
check "volume fantasma: o vazio não entra como waha-*.tgz" \
  bash -c '! ls "$1"/backups/waha-*.tgz >/dev/null 2>&1' _ "$PROJ"
check "volume fantasma: o aviso diz que o pareamento do WhatsApp não foi salvo" \
  contem "$WORK/saida-vazio.txt" "saiu VAZIO"
check "volume fantasma: o .parcial não fica para trás" \
  bash -c '! ls "$1"/backups/.waha-*.parcial >/dev/null 2>&1' _ "$PROJ"
check "volume fantasma: o backup do banco segue e o passo termina bem" \
  contem "$WORK/saida-vazio.txt" "✓ banco:"

echo "backup.sh e restore.sh:"
for f in backup.sh restore.sh; do
  check "$f monta o volume de volume_waha_data" grep -q 'vol="$(volume_waha_data)"' "$KIT_DIR/$f"
  check "$f não confia mais no nome lógico" \
    bash -c '! grep -q "dc config --volumes.*waha-data" "$1"' _ "$KIT_DIR/$f"
done
check "backup.sh só anuncia as sessões depois de provar que têm conteúdo" \
  grep -q 'tar_tem_sessao' "$KIT_DIR/backup.sh"

[ "$FAILS" -eq 0 ] || { echo "✖ $FAILS falha(s)" >&2; exit 1; }
echo 'ok: backup e restore resolvem o volume físico das sessões WAHA e o vazio não passa por backup'
