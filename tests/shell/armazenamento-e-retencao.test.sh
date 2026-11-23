#!/usr/bin/env bash
# Espaço antes do pull, retenção de backup e poda conservadora de imagens (#4837).
#
#   bash tests/shell/armazenamento-e-retencao.test.sh
#
# NADA aqui toca no Docker de verdade, em backup real ou no backup de quem roda:
# `docker` e `df` são dublês no PATH e as pastas de backup são temporárias. Isso
# não é zelo de teste — o dublê é o único jeito de provar o comportamento sem
# arriscar 57 GB de imagens numa VPS de produção.
#
# O que é medido, comportamento por comportamento:
#   1. espaço insuficiente RECUSA antes de qualquer pull, com código próprio de
#      "a atualização nunca começou" (RC 3) e mensagem que diz o número, o
#      motivo e o que fazer;
#   2. espaço suficiente segue — a guarda não vira parada;
#   3. retenção: 7 arquivos com BACKUP_KEEP=5 apagam os DOIS mais antigos e
#      preservam o mais novo; com um arquivo só, nada é apagado; BACKUP_KEEP
#      zero ou lixo não apaga o único backup;
#   4. poda: uma chamada de `docker image prune` SEM `-a`, com filtro
#      conservador, e as versões antigas só das NOSSAS imagens — nunca a versão
#      atual, a da volta, a que um contêiner usa ou os canais móveis;
#   5. falha da poda NÃO aborta a atualização (o podar devolve 0 e avisa).
#
# O caso 1 roda as mesmas três linhas que o update.sh executa e, logo depois,
# confere por NÚMERO DE LINHA que elas estão antes do backup e do `dc pull` no
# script real — sem essa segunda metade, alguém poderia mover a guarda para
# depois do pull e este teste continuaria verde.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT_DIR="$ROOT/hostgator-setup-kit"
# O namespace das imagens vem da FONTE (`_common.sh`), como no resto da suíte:
# escrever `ghcr.io/...` à mão aqui reprova a catraca de
# `tests/unit/namespace-das-imagens.test.ts`, e um publicador diferente do nosso
# (fork) ficaria com o teste reprovando sem ter quebrado nada.
NS="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$KIT_DIR/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
nota() { printf '    %s\n' "$*"; }
tem() { grep -qF -- "$2" "$1"; }
nao_tem() { ! grep -qF -- "$2" "$1"; }

# ── Dublês de docker e df ────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
export DOCKER_LOG="$WORK/docker.log"
: > "$DOCKER_LOG"

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "${1:-}" in
  image)
    case "${2:-}" in
      inspect) printf '%s\n' "${FAKE_IMAGE_SIZE:-536870912}" ;;
      prune)
        if [ "${FAKE_PRUNE_FAIL:-0}" = "1" ]; then
          printf 'erro simulado da poda\n' >&2
          exit 1
        fi
        printf 'Total reclaimed space: 0B\n' ;;
      ls)
        ref="${!#}"
        [ -f "${FAKE_IMAGE_LIST:-/dev/null}" ] \
          && awk -v r="$ref" 'index($0, r ":") == 1' "$FAKE_IMAGE_LIST"
        ;;
      rm) : ;;
    esac ;;
  ps)
    [ -n "${FAKE_IMAGE_USED:-}" ] && printf '%s\n' "$FAKE_IMAGE_USED" ;;
esac
exit 0
STUB

cat > "$WORK/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf 'overlay 100000000 1 %s 1%% /\n' "${FAKE_DF_KB:-100000000}"
exit 0
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/df"
PATH="$WORK/bin:$PATH"
export PATH

# ── Instalação falsa: o mínimo que o `enter_project` exige ───────────────────
PROJ="$WORK/proj"
mkdir -p "$PROJ/backups"
: > "$PROJ/docker-compose.prod.yml"
cat > "$PROJ/.env" <<ENV
APP_IMAGE="$NS/deskcommcrm:1.115.0"
WORKER_IMAGE="$NS/deskcomm-worker:1.115.0"
SCHEDULER_IMAGE="$NS/deskcomm-scheduler:1.115.0"
VOICE_AGENT_IMAGE="$NS/deskcomm-voice-agent:1.115.0"
ENV

# A "volta": a versão que o update anterior deixou no snapshot. É ela que a
# poda tem de preservar junto com a atual.
cat > "$PROJ/.deskcomm-env-antes-do-update" <<ENV
APP_IMAGE="$NS/deskcommcrm:1.114.0"
ENV

runner() {  # runner <arquivo> : fonte das funções, com o projeto como cwd
  local arq="$1"
  cat > "$arq" <<SH
#!/usr/bin/env bash
cd "$PROJ" || exit 9
. "$KIT_DIR/_common.sh"
enter_project
SH
  chmod +x "$arq"
}

# ── 1. Espaço insuficiente: recusa antes do pull, RC próprio ────────────────
printf '\n▶ 1. Espaço insuficiente recusa antes do pull\n'
recusa="$WORK/recusa.sh"
runner "$recusa"
cat >> "$recusa" <<'SH'
if ! checar_espaco_para_atualizacao; then
  refuse "$(mensagem_de_espaco_curto)"
fi
printf 'SEGUIU\n'
SH

saida="$(FAKE_DF_KB=1000 bash "$recusa" 2>&1)"; rc=$?
check "RC 3 (a atualização nunca começou), não 1" [ "$rc" -eq 3 ]
check "a mensagem diz que nada foi parado nem baixado" tem <(printf '%s' "$saida") "nada foi parado"
check "a mensagem traz o número que falta" tem <(printf '%s' "$saida") "precisa de"
check "a mensagem ensina o que libera espaço" tem <(printf '%s' "$saida") "backup.sh --podar"
check "a mensagem proíbe o prune com volumes" tem <(printf '%s' "$saida") "system prune --volumes"
check "não seguiu adiante" nao_tem <(printf '%s' "$saida") "SEGUIU"
check "nenhum docker pull foi chamado" nao_tem "$DOCKER_LOG" "pull"

# A guarda tem de estar ANTES do backup e do pull no script que o operador roda:
# guarda depois do pull não evita o disco cheio, que é o defeito da issue.
linha_espaco="$(grep -n 'checar_espaco_para_atualizacao' "$KIT_DIR/update.sh" | head -n 1 | cut -d: -f1)"
linha_backup="$(grep -n 'bash "\$KIT_DIR/backup.sh"' "$KIT_DIR/update.sh" | head -n 1 | cut -d: -f1)"
linha_pull="$(grep -n '^if ! dc pull; then' "$KIT_DIR/update.sh" | head -n 1 | cut -d: -f1)"
check "a checagem de espaço vem antes do backup" [ "${linha_espaco:-0}" -lt "${linha_backup:-0}" ]
check "a checagem de espaço vem antes do pull" [ "${linha_espaco:-0}" -lt "${linha_pull:-0}" ]

# ── 2. Espaço suficiente: segue ─────────────────────────────────────────────
printf '\n▶ 2. Espaço suficiente segue\n'
saida="$(FAKE_DF_KB=100000000 bash "$recusa" 2>&1)"; rc=$?
check "RC 0" [ "$rc" -eq 0 ]
check "avisa que seguiu" tem <(printf '%s' "$saida") "SEGUIU"

# O mínimo é CALCULADO, não um número solto: sem imagem no Docker (inspect
# falhando) e sem backup, o piso de 1024 MB decide.
printf '\n▶ 2b. O mínimo é o maior entre piso e medição\n'
mede="$WORK/mede.sh"
runner "$mede"
cat >> "$mede" <<'SH'
printf 'NECESSARIO=%s\n' "$(espaco_necessario_kb)"
SH
necessario="$(FAKE_IMAGE_SIZE=0 bash "$mede" 2>/dev/null | sed -n 's/^NECESSARIO=//p')"
check "sem medição, o piso de 1024 MB vale" [ "${necessario:-0}" -eq $((1024 * 1024)) ]
head -c 20971520 /dev/zero > "$PROJ/backups/db-20260101-000000.sql.gz"
necessario="$(FAKE_IMAGE_SIZE=$((8589934592)) bash "$mede" 2>/dev/null | sed -n 's/^NECESSARIO=//p')"
check "com 8 GB por imagem e 20 MB de backup, o mínimo passa do piso" [ "${necessario:-0}" -gt $((1024 * 1024)) ]
check "o mínimo soma o último backup com 20% de folga" [ "${necessario:-0}" -ge $(( (8589934592 / 1024 + 20480) * 12 / 10 )) ]
rm -f "$PROJ/backups/db-20260101-000000.sql.gz"

# ── 3. Retenção ─────────────────────────────────────────────────────────────
printf '\n▶ 3. Retenção de backup\n'
BK="$WORK/backups-retencao"
mkdir -p "$BK"
# Sete dumps, do mais antigo ao mais novo. O mtime é o critério do `ls -1t`.
i=0
for dia in 01 02 03 04 05 06 07; do
  i=$((i + 1))
  arq="$BK/db-202601$dia-030000.sql.gz"
  printf 'dump %s\n' "$dia" > "$arq"
  touch -d "2026-01-$dia 03:00:00" "$arq"
done
retem="$WORK/retem.sh"
runner "$retem"
cat >> "$retem" <<SH
podar_backups "$BK" 5
SH
saida="$(bash "$retem" 2>&1)"; rc=$?
check "podar com retenção 5 devolve 0" [ "$rc" -eq 0 ]
check "sobram 5 arquivos" [ "$(ls -1 "$BK"/db-*.sql.gz | wc -l)" -eq 5 ]
check "o MAIS NOVO continua lá" [ -f "$BK/db-20260107-030000.sql.gz" ]
check "o mais antigo saiu" [ ! -f "$BK/db-20260101-030000.sql.gz" ]
check "o segundo mais antigo saiu" [ ! -f "$BK/db-20260102-030000.sql.gz" ]
check "o terceiro mais antigo ficou (só dois saem)" [ -f "$BK/db-20260103-030000.sql.gz" ]
check "a saída conta o que apagou" tem <(printf '%s' "$saida") "2 apagado"

# Um arquivo só, retenção 1: o único backup NUNCA sai — apagar a última cópia
# é o desfecho que a issue pede explicitamente para evitar.
printf '\n▶ 3b. O último backup nunca sai\n'
UM="$WORK/backups-um"
mkdir -p "$UM"
printf 'unico\n' > "$UM/db-20260107-030000.sql.gz"
retem_um="$WORK/retem-um.sh"
runner "$retem_um"
cat >> "$retem_um" <<SH
podar_backups "$UM" 1
podar_backups "$UM" 0        # política inválida: o piso é 1
podar_backups "$UM" abc      # lixo no .env: cai no padrão 14
SH
bash "$retem_um" >/dev/null 2>&1
check "com retenção 1 sobrou o arquivo" [ -f "$UM/db-20260107-030000.sql.gz" ]
UM2="$WORK/backups-um2"
mkdir -p "$UM2"
printf 'unico\n' > "$UM2/storage-20260107-030000.tgz"
retem_zero="$WORK/retem-zero.sh"
runner "$retem_zero"
cat >> "$retem_zero" <<SH
podar_backups "$UM2" 0
SH
bash "$retem_zero" >/dev/null 2>&1
check "retenção ZERO não apaga o único backup" [ -f "$UM2/storage-20260107-030000.tgz" ]

# ── 4. Poda conservadora ────────────────────────────────────────────────────
printf '\n▶ 4. Poda conservadora de imagens\n'
: > "$DOCKER_LOG"
export FAKE_IMAGE_LIST="$WORK/imagens.txt"
cat > "$FAKE_IMAGE_LIST" <<LIST
$NS/deskcommcrm:1.108.0
$NS/deskcommcrm:1.110.0
$NS/deskcommcrm:1.114.0
$NS/deskcommcrm:1.115.0
$NS/deskcommcrm:stable
$NS/deskcomm-worker:1.108.0
$NS/deskcomm-worker:1.115.0
LIST
export FAKE_IMAGE_USED="$NS/deskcomm-worker:1.108.0"

poda="$WORK/poda.sh"
runner "$poda"
cat >> "$poda" <<'SH'
podar_imagens_nao_usadas
printf 'PODA_RC=%s\n' "$?"
SH
saida="$(bash "$poda" 2>&1)"; rc=$?
check "a poda devolve 0" tem <(printf '%s' "$saida") "PODA_RC=0"
check "chamou docker image prune" tem "$DOCKER_LOG" "image prune"
check "com filtro conservador dangling=true" tem "$DOCKER_LOG" '--filter dangling=true'
check "com filtro de idade (until=168h)" tem "$DOCKER_LOG" 'until=168h'
check "NUNCA com -a" nao_tem "$DOCKER_LOG" "prune -f -a"
check "NUNCA com --all" nao_tem "$DOCKER_LOG" "--all"
check "nunca docker system prune" nao_tem "$DOCKER_LOG" "system prune"
check "uma chamada só de prune (sem laço)" [ "$(grep -c 'image prune' "$DOCKER_LOG")" -eq 1 ]

check "removeu a versão antiga do app" tem "$DOCKER_LOG" "image rm $NS/deskcommcrm:1.108.0"
check "removeu a outra versão antiga" tem "$DOCKER_LOG" "image rm $NS/deskcommcrm:1.110.0"
check "preservou a versão ATUAL" nao_tem "$DOCKER_LOG" "rm $NS/deskcommcrm:1.115.0"
check "preservou a versão da VOLTA" nao_tem "$DOCKER_LOG" "rm $NS/deskcommcrm:1.114.0"
check "preservou o canal móvel stable" nao_tem "$DOCKER_LOG" "rm $NS/deskcommcrm:stable"
check "preservou imagem usada por contêiner parado" nao_tem "$DOCKER_LOG" "rm $NS/deskcomm-worker:1.108.0"
check "não tocou em imagem de terceiros" nao_tem "$DOCKER_LOG" "image rm devlikeapro"
check "a saída diz o que foi removido" tem <(printf '%s' "$saida") "imagem antiga removida"

printf '\n▶ 4b. Falha da poda não aborta\n'
: > "$DOCKER_LOG"
saida="$(FAKE_PRUNE_FAIL=1 bash "$poda" 2>&1)"; rc=$?
check "RC 0 mesmo com a poda falhando" [ "$rc" -eq 0 ]
check "o aviso aparece para o operador" tem <(printf '%s' "$saida") "poda de camadas soltas não rodou"
check "e a poda das nossas imagens segue" tem "$DOCKER_LOG" "image rm $NS/deskcommcrm:1.108.0"

printf '\n▶ 4c. Poda desligável pelo .env\n'
: > "$DOCKER_LOG"
saida="$(DESKCOMM_PODA_IMAGENS=0 bash "$poda" 2>&1)"; rc=$?
check "com DESKCOMM_PODA_IMAGENS=0 devolve 0" [ "$rc" -eq 0 ]
check "e não chama docker image prune" nao_tem "$DOCKER_LOG" "image prune"
check "e diz que está desligada" tem <(printf '%s' "$saida") "desligada"

printf '\n'
if [ "$FAILS" -ne 0 ]; then
  printf '✖ %s caso(s) reprovado(s)\n' "$FAILS"
  exit 1
fi
printf '✓ armazenamento, retenção e poda: todos os casos passaram\n'
