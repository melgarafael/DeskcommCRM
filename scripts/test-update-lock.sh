#!/bin/bash
# test-update-lock.sh — as duas falhas do kit de atualização da issue #5116,
# medidas num sandbox descartável: docker/dc de mentira no PATH registrando a
# decisão de cada pull, e um git de fixture com duas tags.
#
#   bash scripts/test-update-lock.sh                 # prova completa (+ sabotagens)
#   KIT_DIR=/tmp/kit-da-main bash scripts/test-update-lock.sh   # red-before
#   SABOTAGEM=0 bash scripts/test-update-lock.sh     # só os casos de aceite
#
# ── O que está sob prova ─────────────────────────────────────────────────────
#
# A1. `APP_PULL_POLICY=never` no `.env` (o que o `load_env` exporta) e uma
#     atualização de verdade: o pull do APP tem de acontecer na versão alvo, e
#     o `.env` tem de ficar coerente com o que foi puxado. É a falha medida na
#     VPS: `dc pull` dizia `Skipped` no app, `up -d` morria em "No such image",
#     e o script culpava a arquitetura.
# A2. O MESMO `never`, sem atualização pedida (a tag instalada é a alvo): nada é
#     puxado e o `never` do operador continua no `.env`. Sem este caso, "puxar
#     sempre" passaria em A1 e ninguém notaria.
# A3. Dois `update.sh` ao mesmo tempo, com o app fora do ar: o segundo sai sem
#     tocar em imagem, `.env` nem baseline, e o `agent.sh` (a vigília que volta
#     a versão) não reinicia nada no meio.
# A4. Sabotagem por item: tirar a releitura dos `*_PULL_POLICY` derruba A1 (e
#     só A1); tirar o `flock` derruba A3 (e só A3). O `cmp`/`diff` do fim prova
#     que a cópia sabotada difere da original em UM arquivo, e que o resto
#     continua byte a byte igual.
#
# ── Como o dublê mede (e por que ele mede o defeito de verdade) ──────────────
#
# O `dc` é uma FUNÇÃO do `_common.sh` que chama `docker compose` — então quem
# está no PATH é o `docker`. O dublê resolve o `pull_policy` de cada serviço com
# a MESMA precedência do Compose (o AMBIENTE vence o `.env`) e registra a
# decisão: `→ BAIXADA` ou `→ SKIPPED`. Um dublê que só contasse chamadas ficaria
# verde com o defeito no lugar, porque o `dc pull` É chamado nos dois mundos.
#
# Nada aqui toca a máquina de quem roda: nenhum contêiner sobe, nenhum crontab
# real é escrito, nenhum `git` de verdade é afetado (repositórios em mktemp) e o
# `flock` é o de verdade — é ele que está sob prova.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
KIT="${KIT_DIR:-$RAIZ/hostgator-setup-kit}"
SABOTAGEM="${SABOTAGEM:-1}"
command -v flock >/dev/null 2>&1 || { echo "FATAL: 'flock' não está no PATH — sem ele o kit não tem cadeado e este teste não mede nada" >&2; exit 1; }
[ -f "$KIT/update.sh" ] || { echo "FATAL: $KIT não parece o kit de atualização" >&2; exit 1; }

# Isolamento do git: um GIT_DIR herdado (suíte rodando de dentro de hook ou de
# `rebase --exec`) manda por cima de todo `cd`/`git init` daqui e escreveria no
# repositório de quem roda.
unset $(git rev-parse --local-env-vars) 2>/dev/null || true
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

TMP="$(mktemp -d "${TMPDIR:-/tmp}/teste-5116.XXXXXX")"
if [ -z "$TMP" ] || [ ! -d "$TMP" ] || [ "$TMP" = / ]; then
  echo "abortado: mktemp -d não devolveu sandbox (TMP='$TMP')" >&2
  exit 1
fi
BLOQUEIO_DIR=""
limpar() {
  # Solta um `update.sh` que ficou esperando o pull (o caso A3 falhou no meio?
  # o `wait` do filho não pode virar o teste travado para sempre).
  [ -n "$BLOQUEIO_DIR" ] && : > "$BLOQUEIO_DIR/blq.liberar" 2>/dev/null || true
  rm -rf "$TMP"
}
trap limpar EXIT

PROVAS=0
FALHAS=0
ok()      { PROVAS=$((PROVAS + 1)); printf '  ✓ %s\n' "$1"; }
nao()     { PROVAS=$((PROVAS + 1)); FALHAS=$((FALHAS + 1)); printf '  ✗ %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; return 0; }
# afirmar <descrição> <comando...> — verde só se o comando sai 0.
afirmar() {
  local desc="$1"; shift
  if "$@"; then ok "$desc"; else nao "$desc"; fi
}
# negar <descrição> <comando...> — verde só se o comando sai ≠ 0.
negar() {
  local desc="$1"; shift
  if "$@"; then nao "$desc"; else ok "$desc"; fi
}
# contem <descrição> <texto> <arquivo>
contem() {
  local desc="$1" texto="$2" arq="$3"
  if grep -qF -- "$texto" "$arq" 2>/dev/null; then ok "$desc"; else nao "$desc" "não achei \"$texto\" em $(basename "$arq")"; fi
}
nao_contem() {
  local desc="$1" texto="$2" arq="$3"
  if grep -qF -- "$texto" "$arq" 2>/dev/null; then nao "$desc" "achei \"$texto\" em $(basename "$arq")"; else ok "$desc"; fi
}
# hash_de <arquivo> — sha256 curto, para comparar antes/depois.
hash_de() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
mtime_de() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
# igual <descrição> <valor esperado> <valor obtido>
igual() {
  local desc="$1" esperado="$2" obtido="$3"
  if [ "$esperado" = "$obtido" ]; then ok "$desc"; else nao "$desc" "esperado '$esperado', obtido '$obtido'"; fi
}

# ── Dublês ───────────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Registra TODA chamada e, no `pull`, decide como o Compose decide: a variável
# do AMBIENTE vence a do `.env`. É essa precedência que produz o `Skipped` do
# app no defeito da #5116.
printf '%s\n' "$*" >> "$DOCKER_LOG"

do_env() {  # do_env <CHAVE> → ambiente, senão .env do diretório corrente
  local v="${!1:-}"
  [ -n "$v" ] || v="$(sed -n "s/^$1=//p" .env 2>/dev/null | tail -1 | tr -d "\"'")"
  printf '%s' "$v"
}

case " $* " in
  *" exec "*) printf 'healthy\n{"data":{"status":"healthy","version":"0.1.0","checks":{}}}\n'; exit 0 ;;
  *" imagetools inspect --raw "*) printf '%s' '{"schemaVersion":2,"manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}'; exit 0 ;;
  *" imagetools inspect --format "*) printf 'linux/amd64\n'; exit 0 ;;
  *" image inspect "*)
    # `image_desatualizada` compara o digest local com o remoto. Local presente e
    # remoto ausente (o `imagetools inspect` sem flag não imprime nada) = "não dá
    # para comparar", que é o que mantém A2 no caminho de "nada a atualizar".
    case " $* " in *RepoDigests*) printf '%s@sha256:0000000000000000\n' "$(do_env APP_IMAGE)" ;; esac
    exit 0 ;;
esac

if [ "${1:-}" = compose ]; then
  sub=""; achou=""; alvos=()
  for a in "$@"; do
    if [ -n "$achou" ]; then alvos+=("$a"); continue; fi
    case "$a" in pull|up|ps|images|build|logs|exec) sub="$a"; achou=1 ;; esac
  done
  if [ "$sub" = pull ]; then
    [ "${#alvos[@]}" -gt 0 ] || alvos=(app worker scheduler voice-agent)
    for svc in app worker scheduler voice-agent; do
      case " ${alvos[*]:-} " in *" $svc "*) ;; *) continue ;; esac
      case "$svc" in
        app)            img="$(do_env APP_IMAGE)";            pol="$(do_env APP_PULL_POLICY)" ;;
        worker)         img="$(do_env WORKER_IMAGE)";         pol="$(do_env WORKER_PULL_POLICY)" ;;
        scheduler)      img="$(do_env SCHEDULER_IMAGE)";      pol="$(do_env SCHEDULER_PULL_POLICY)" ;;
        voice-agent)    img="$(do_env VOICE_AGENT_IMAGE)";    pol="$(do_env VOICE_AGENT_PULL_POLICY)" ;;
      esac
      [ -n "$img" ] || continue
      case "$pol" in
        never)
          printf 'pull  %-12s %-50s policy=%-7s → SKIPPED\n' "$svc" "$img" "$pol" >> "$DOCKER_LOG" ;;
        missing)
          if grep -qxF "$img" "$FAKE_STORE" 2>/dev/null; then
            printf 'pull  %-12s %-50s policy=%-7s → SKIPPED (já no disco)\n' "$svc" "$img" "$pol" >> "$DOCKER_LOG"
          else
            printf 'pull  %-12s %-50s policy=%-7s → BAIXADA\n' "$svc" "$img" "$pol" >> "$DOCKER_LOG"
            printf '%s\n' "$img" >> "$FAKE_STORE"
          fi ;;
        *)
          printf 'pull  %-12s %-50s policy=%-7s → BAIXADA\n' "$svc" "$img" "$pol" >> "$DOCKER_LOG"
          printf '%s\n' "$img" >> "$FAKE_STORE" ;;
      esac
    done
    # A3: o primeiro pull de UMA execução fica parado aqui até o teste liberar.
    # Sem isso, "dois update.sh simultâneos" seria uma corrida de milissegundos
    # que passa por sorte — e teste que passa por sorte não prova nada.
    if [ -n "${FAKE_DOCKER_BLOQUEIO:-}" ] && [ ! -e "${FAKE_DOCKER_BLOQUEIO}.pronto" ]; then
      : > "${FAKE_DOCKER_BLOQUEIO}.pronto"
      n=0
      while [ ! -e "${FAKE_DOCKER_BLOQUEIO}.liberar" ] && [ "$n" -lt 1200 ]; do sleep 0.2; n=$((n + 1)); done
    fi
  fi
fi
exit 0
STUB
# `crontab` guarda a tabela num arquivo: o kit instala a linha do agente, e o
# crontab de quem roda a suíte não é lugar para isso.
cat > "$TMP/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
# Nenhuma saída daqui toca a rede. O corpo sem "status" é de propósito: é o app
# FORA DO AR para a vigília (A3), e é o que faz o `agent.sh` agir quando o
# cadeado não está lá.
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *ghcr.io/token*) printf '%s' '{"token":"teste"}' ;;
  *ghcr.io/v2/*)   printf 200 ;;
  */api/v1/health*) printf '{"data":{}}' ;;
  *)               printf '{"data":{}}\n200' ;;
esac
STUB
chmod +x "$TMP/bin/docker" "$TMP/bin/crontab" "$TMP/bin/curl"
export PATH="$TMP/bin:$PATH"
unset DOCKER_LOG FAKE_STORE FAKE_CRONTAB FAKE_DOCKER_BLOQUEIO 2>/dev/null || true

# ── Fixture ──────────────────────────────────────────────────────────────────
# montar_fixture <raiz> <kit> <versão instalada> <versão alvo> <pull_policy>
# Uma instalação de mentira: projeto com `.env`, compose, e um git descartável
# com a versão instalada (HEAD) e a alvo (tag à frente). O `.env` fica FORA do
# git (`.gitignore`) para o `checkout` do passo 3 não desfazer o que o passo 5
# acabou de gravar — o defeito medido é justamente entre esses dois.
montar_fixture() {
  local raiz="$1" kit="$2" atual="$3" alvo="$4" policy="$5"
  local proj="$raiz/inst" ns
  ns="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$kit/_common.sh" | head -1)"
  [ -n "$ns" ] || { echo "FATAL: não li IMG_NS de $kit/_common.sh" >&2; exit 1; }
  mkdir -p "$proj/supabase"
  cp -RL "$kit" "$proj/hostgator-setup-kit"
  printf 'services:\n  app:\n    image: ${APP_IMAGE:-x}\n' > "$proj/docker-compose.prod.yml"
  # Baseline de mentira: existe para o passo 4 do update.sh RODAR (o `docker
  # run ... psql -f /b.sql` do dublê aparece no log) — sem ele "não tocou no
  # baseline" seria verdade por vacuidade, e o A3 não mediria nada.
  printf 'select 1;\n' > "$proj/supabase/baseline.sql"
  cat > "$proj/.env" <<ENV
APP_IMAGE=$ns/deskcommcrm:$atual
APP_PULL_POLICY=$policy
WORKER_IMAGE=$ns/deskcomm-worker:$atual
WORKER_PULL_POLICY=$policy
SCHEDULER_IMAGE=$ns/deskcomm-scheduler:$atual
SCHEDULER_PULL_POLICY=$policy
VOICE_AGENT_IMAGE=$ns/deskcomm-voice-agent:$atual
VOICE_AGENT_PULL_POLICY=$policy
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
VAPID_PUBLIC_KEY=pub
VAPID_PRIVATE_KEY=priv
ENV
  chmod 600 "$proj/.env"
  printf '.env\n' > "$proj/.gitignore"
  (
    cd "$proj" || exit 1
    git init --quiet
    git add -A
    git commit --quiet -m "$atual"
    git tag "v$atual"
    printf 'topo\n' > topo.txt
    git add -A
    git commit --quiet -m "topo"
    git tag "v$alvo"
    git checkout --quiet "v$atual"
  ) >/dev/null 2>&1
}

# rodar_kit <proj> <saida> <log do docker> <comando do kit> [args...]
# O `< /dev/null` não é decoração: sem terminal no stdin o `die` do kit fala em
# vez de abrir o `read -p` de quem digita "sim" — é assim que o CI roda.
rodar_kit() {
  local proj="$1" saida="$2" log="$3" script="$4"; shift 4
  RC=0
  ( cd "$proj" && DOCKER_LOG="$log" FAKE_STORE="$proj/../imagens.txt" FAKE_CRONTAB="$proj/../crontab.txt" \
      bash "$script" "$@" ) >"$saida" 2>&1 </dev/null || RC=$?
}

mostrar_decisoes() {  # a ordem de chamadas que o sandbox viu
  printf '      decisões de pull registradas:\n'
  grep -E '→ (BAIXADA|SKIPPED)' "$1" 2>/dev/null | sed 's/^/        /' || printf '        (nenhuma)\n'
}

# ── A1 ───────────────────────────────────────────────────────────────────────
# `never` no .env + atualização de verdade: o pull do APP tem de acontecer.
caso_a1() {  # caso_a1 <kit> <raiz> → as provas são contadas nos contadores globais
  local kit="$1" raiz="$2"
  local proj="$raiz/inst" log="$raiz/docker.log"
  local inicio="$PROVAS" inicio_falhas="$FALHAS"
  montar_fixture "$raiz" "$kit" 1.113.0 1.122.0 never
  rodar_kit "$proj" "$raiz/update.log" "$log" hostgator-setup-kit/update.sh --to v1.122.0 --force
  mostrar_decisoes "$log"
  printf '      rc do update.sh: %s\n' "$RC"

  igual "A1 · update.sh terminou com rc=0" 0 "$RC"
  contem "A1 · o pull do APP foi feito na versão alvo (1.122.0)" "app" "$log"
  afirmar "A1 · o app foi BAIXADO com policy=missing" \
    grep -qE 'pull  app +[^ ]*deskcommcrm:1\.122\.0 +policy=missing +→ BAIXADA' "$log"
  negar "A1 · o app NÃO foi pulado (Skipped)" \
    grep -qE 'pull  app .*→ SKIPPED' "$log"
  afirmar "A1 · o .env ficou coerente com o que foi puxado (APP_IMAGE=1.122.0)" \
    grep -qxE "APP_IMAGE=[^=]*deskcommcrm:1\.122\.0" "$proj/.env"
  afirmar "A1 · o .env ficou coerente com o pull (APP_PULL_POLICY=missing)" \
    grep -qx "APP_PULL_POLICY=missing" "$proj/.env"
  afirmar "A1 · worker e scheduler também vieram (o sandbox mede o todo)" \
    grep -qE 'pull  worker .*:1\.122\.0 +policy=missing +→ BAIXADA' "$log"
  afirmar "A1 · e o scheduler" \
    grep -qE 'pull  scheduler .*:1\.122\.0 +policy=missing +→ BAIXADA' "$log"
  # O .env que ficou no disco, para quem lê o log não precisar abrir o sandbox:
  # é ele que o Compose usaria na PRÓXIMA execução.
  printf '      .env depois da atualização:\n'
  grep -E '^(APP|WORKER|SCHEDULER|VOICE_AGENT)_(IMAGE|PULL_POLICY)=' "$proj/.env" | sed 's/^/        /'

  [ "$PROVAS" -gt "$inicio" ] && [ "$FALHAS" -eq "$inicio_falhas" ]
}

# ── A2 ───────────────────────────────────────────────────────────────────────
# `never` sem atualização pedida: nada é puxado e o never continua no .env.
caso_a2() {
  local kit="$1" raiz="$2"
  local proj="$raiz/inst" log="$raiz/docker.log"
  local inicio="$PROVAS" inicio_falhas="$FALHAS"
  montar_fixture "$raiz" "$kit" 1.122.0 1.122.0 never
  local policy_antes
  policy_antes="$(grep -c '^APP_PULL_POLICY=never$' "$proj/.env" || true)"
  igual "A2 · o operador começa com APP_PULL_POLICY=never" 1 "$policy_antes"

  # --to da versão instalada, SEM --force: é o "nada a atualizar" de verdade.
  rodar_kit "$proj" "$raiz/update.log" "$log" hostgator-setup-kit/update.sh --to v1.122.0
  mostrar_decisoes "$log"
  printf '      rc do update.sh: %s\n' "$RC"

  igual "A2 · update.sh terminou com rc=0" 0 "$RC"
  contem "A2 · a saída é a de 'nada a atualizar'" "já está na versão mais recente" "$raiz/update.log"
  negar "A2 · nenhum pull foi pedido" grep -qE '→ (BAIXADA|SKIPPED)' "$log"
  afirmar "A2 · o never do operador continua no .env" \
    grep -qx "APP_PULL_POLICY=never" "$proj/.env"
  afirmar "A2 · e a imagem do operador não foi trocada" \
    grep -qxE "APP_IMAGE=[^=]*deskcommcrm:1\.122\.0" "$proj/.env"

  [ "$PROVAS" -gt "$inicio" ] && [ "$FALHAS" -eq "$inicio_falhas" ]
}

# ── A3 ───────────────────────────────────────────────────────────────────────
# Dois update.sh simultâneos + um ciclo da vigília no meio.
caso_a3() {
  local kit="$1" raiz="$2"
  local proj="$raiz/inst" log="$raiz/docker.log"
  local inicio="$PROVAS" inicio_falhas="$FALHAS" pid n
  montar_fixture "$raiz" "$kit" 1.113.0 1.122.0 never
  # O estado que o cron encontra ~10 min depois de a atualização começar: marca
  # da vigília armada e UMA falha já contada (a segunda dispara a volta).
  printf '%s\n%s\n' "$(date -u +%s)" "v1.113.0" > "$proj/.update-vigia"
  printf '1\n' > "$proj/.update-vigia-falhas"

  # O update "do terminal", parado dentro do `dc pull` — que é depois de ele já
  # ter gravado o .env e antes de recriar os contêineres.
  BLOQUEIO_DIR="$raiz"
  ( cd "$proj" && DOCKER_LOG="$log" FAKE_STORE="$raiz/imagens.txt" FAKE_CRONTAB="$raiz/crontab.txt" \
      FAKE_DOCKER_BLOQUEIO="$raiz/blq" bash hostgator-setup-kit/update.sh --to v1.122.0 --force ) \
      >"$raiz/update-1.log" 2>&1 </dev/null &
  pid=$!
  n=0
  while [ ! -e "$raiz/blq.pronto" ] && [ "$n" -lt 600 ]; do sleep 0.2; n=$((n + 1)); done
  if [ ! -e "$raiz/blq.pronto" ]; then
    nao "A3 · o update.sh nº1 chegou ao pull (é a premissa do caso)" "ver $(basename "$raiz")/update-1.log"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    BLOQUEIO_DIR=""
    return 1
  fi
  ok "A3 · o update.sh nº1 está no meio do pull (o app está fora do ar agora)"

  # ── o segundo update.sh, com o primeiro ainda trabalhando ──
  #
  # O que se mede é o EFEITO, não a chamada: o segundo pode rodar o diagnóstico
  # de saída (um `compose ps`), mas não pode tocar em imagem, `.env` nem
  # baseline. Então cada prova olha a fatia do log que nasceu na janela dele.
  local linhas_antes sha_antes mtime_antes linhas_depois sha_depois mtime_depois
  local baseline_antes baseline_depois
  linhas_antes="$(wc -l < "$log")"
  sha_antes="$(hash_de "$proj/.env")"
  mtime_antes="$(mtime_de "$proj/.env")"
  baseline_antes="$(grep -cE 'psql .*-f /b\.sql' "$log" || true)"

  rodar_kit "$proj" "$raiz/update-2.log" "$log" hostgator-setup-kit/update.sh --to v1.122.0 --force
  local rc_dois="$RC"
  linhas_depois="$(wc -l < "$log")"
  sha_depois="$(hash_de "$proj/.env")"
  mtime_depois="$(mtime_de "$proj/.env")"
  baseline_depois="$(grep -cE 'psql .*-f /b\.sql' "$log" || true)"
  sed -n "$((linhas_antes + 1)),\$p" "$log" > "$raiz/slice-2.log"

  igual "A3 · o segundo update.sh sai com rc=0 (não é erro, é recusa)" 0 "$rc_dois"
  contem "A3 · e diz que já existe uma atualização em andamento" "Já existe uma atualização em andamento" "$raiz/update-2.log"
  afirmar "A3 · o diagnóstico dele diz 'recusada', não 'concluído'" \
    grep -q "recusada: outra atualização em andamento" "$proj/.deskcomm-update-diagnostico.log"
  negar "A3 · o segundo não puxou nem recriou nada (imagem intocada)" \
    grep -qE 'compose .* (up|pull|stop|restart) ' "$raiz/slice-2.log"
  negar "A3 · e não construiu imagem" grep -qE 'compose .* build ' "$raiz/slice-2.log"
  igual "A3 · o .env ficou byte a byte igual (env intocada)" "$sha_antes" "$sha_depois"
  igual "A3 · e nem o mtime do .env mudou" "$mtime_antes" "$mtime_depois"
  igual "A3 · o segundo não reaplicou o baseline (contagem de psql idêntica)" \
    "$baseline_antes" "$baseline_depois"

  # ── a vigília do agent.sh no mesmo instante ──
  #
  # A marca é REARMADA aqui, com uma falha já contada: é o estado exato em que
  # o cron encontra a instalação ~10 min depois de a atualização ter começado
  # (foi assim que ele agiu na VPS). Sem o cadeado, o próximo healthcheck é a
  # segunda falha e ele volta a versão; com o cadeado, ele nem lê a marca.
  printf '%s\n%s\n' "$(date -u +%s)" "v1.113.0" > "$proj/.update-vigia"
  printf '1\n' > "$proj/.update-vigia-falhas"
  local rc_agente
  linhas_antes="$(wc -l < "$log")"
  rodar_kit "$proj" "$raiz/agent.log" "$log" hostgator-setup-kit/agent.sh
  rc_agente="$RC"
  sed -n "$((linhas_antes + 1)),\$p" "$log" > "$raiz/slice-agente.log"
  igual "A3 · o agent.sh saiu com rc=0 (não é falha, é o cadeado)" 0 "$rc_agente"
  printf '      o que o watchdog registrou:\n'
  if [ -s "$proj/.update-agent.log" ]; then
    grep -E 'healthchecks|voltando|volta para' "$proj/.update-agent.log" | tail -3 | sed 's/^/        /'
  else
    printf '        (nada: saiu no flock, antes da primeira sonda)\n'
  fi
  # O agente não imprime nada no caminho do cadeado: o rastro dele é o
  # .update-agent.log, e é ali que "voltando sozinho" apareceria.
  negar "A3 · o watchdog NÃO voltou a versão no meio da atualização" \
    grep -qs "voltando sozinho" "$proj/.update-agent.log"
  negar "A3 · o agent.sh não recriou nem puxou nada (não reiniciou o container)" \
    grep -qE 'compose .* (up|pull|stop|restart) ' "$raiz/slice-agente.log"
  afirmar "A3 · a marca da vigília continua de pé (a decisão nem foi tomada)" \
    test -f "$proj/.update-vigia"
  afirmar "A3 · e o código em disco continua o da ida (não voltou)" \
    test "$(git -C "$proj" describe --tags --exact-match 2>/dev/null || true)" = "v1.122.0"

  # ── libera o primeiro e confere que ELE terminou o serviço ──
  : > "$raiz/blq.liberar"
  BLOQUEIO_DIR=""
  local rc_um=0
  wait "$pid" || rc_um=$?
  igual "A3 · o update.sh nº1 (o que segurava o cadeado) terminou com rc=0" 0 "$rc_um"
  afirmar "A3 · e o .env final é o da versão alvo, coerente com o pull" \
    grep -qxE "APP_IMAGE=[^=]*deskcommcrm:1\.122\.0" "$proj/.env"

  [ "$PROVAS" -gt "$inicio" ] && [ "$FALHAS" -eq "$inicio_falhas" ]
}

# ── A3b · o caminho do BOTÃO: update.sh filho do agent.sh ───────────────────
# O `agent.sh` já segura o cadeado e ESPERA este processo; se o `update.sh`
# abrisse o arquivo de novo, o `flock -n` dele perderia para o próprio pai e a
# atualização pelo painel recusaria a si mesma. Aqui o pai é simulado com o
# mesmo fd 9 e o mesmo marcador que o `agent.sh` exporta.
caso_a3b() {
  local kit="$1" raiz="$2"
  local proj="$raiz/inst" log="$raiz/docker.log"
  local inicio="$PROVAS" inicio_falhas="$FALHAS"
  montar_fixture "$raiz" "$kit" 1.113.0 1.122.0 never
  RC=0
  (
    cd "$proj" || exit 1
    exec 9>"$proj/.update.lock"
    flock -n 9 || exit 1
    export DESKCOMM_UPDATE_LOCK_HELD=1
    DOCKER_LOG="$log" FAKE_STORE="$raiz/imagens.txt" FAKE_CRONTAB="$raiz/crontab.txt" \
      bash hostgator-setup-kit/update.sh --to v1.122.0 --force
  ) >"$raiz/update-pai.log" 2>&1 </dev/null || RC=$?

  mostrar_decisoes "$log"
  printf '      rc do update.sh (filho de quem segura o cadeado): %s\n' "$RC"
  igual "A3b · o update.sh filho do agent.sh NÃO recusa a si mesmo (rc=0)" 0 "$RC"
  nao_contem "A3b · e não imprime o aviso de 'já existe atualização'" \
    "Já existe uma atualização em andamento" "$raiz/update-pai.log"
  afirmar "A3b · o app foi puxado na versão alvo (o cadeado herdado não bloqueia)" \
    grep -qE 'pull  app +[^ ]*deskcommcrm:1\.122\.0 +policy=missing +→ BAIXADA' "$log"
  afirmar "A3b · e o .env ficou na versão alvo" \
    grep -qxE "APP_IMAGE=[^=]*deskcommcrm:1\.122\.0" "$proj/.env"

  [ "$PROVAS" -gt "$inicio" ] && [ "$FALHAS" -eq "$inicio_falhas" ]
}

# ── A4 · sabotagem por item ─────────────────────────────────────────────────
# Cada sabotagem é UMA linha, e a prova de que ela é a única diferença está no
# `diff -rq` logo depois. Sabotar a cópia (nunca a árvore de quem roda) é o que
# permite provar o vermelho sem risco de ficar com o defeito no checkout.
sabotar() {  # sabotar <kit novo> <original> <item>
  local novo="$1" original="$2" item="$3"
  cp -RL "$original" "$novo"
  case "$item" in
    reexportar)
      sed -i '/^  reexportar_pull_policies "\$envfile"$/d' "$novo/_common.sh"
      ;;
    flock)
      sed -i 's/^  if flock -n 9; then$/  if true; then/' "$novo/update.sh"
      ;;
    *) echo "FATAL: sabotagem desconhecida: $item" >&2; exit 1 ;;
  esac
  # A sabotagem tem de TER pego: `sed` que não casa não muda nada e o caso
  # "vermelho" viraria verde sem ninguém notar.
  local arquivo="$novo/_common.sh"
  [ "$item" = flock ] && arquivo="$novo/update.sh"
  [ "$(diff -rq "$original" "$novo" | wc -l)" = 1 ] \
    || { echo "FATAL: a sabotagem '$item' mexeu em mais de um arquivo: $(diff -rq "$original" "$novo")" >&2; exit 1; }
  case "$item" in
    reexportar)
      # A chamada TEM de ter saído — `sed` que não casa não muda nada, e o
      # "vermelho" seguinte seria o do kit consertado.
      if grep -q 'reexportar_pull_policies "\$envfile"' "$novo/_common.sh"; then
        echo "FATAL: a sabotagem '$item' não pegou (a chamada continua em _common.sh)" >&2
        exit 1
      fi ;;
    flock)
      if ! grep -q '^  if true; then$' "$novo/update.sh"; then
        echo "FATAL: a sabotagem '$item' não pegou (o flock continua no update.sh)" >&2
        exit 1
      fi ;;
  esac
  echo "  ($item: ${arquivo##*/} difere da original em exatamente 1 arquivo)"
}

# ── Execução ────────────────────────────────────────────────────────────────
echo "kit sob prova: $KIT"
echo

echo "── A1 · APP_PULL_POLICY=never no .env + atualização de verdade"
if caso_a1 "$KIT" "$TMP/a1"; then echo "   A1: OK"; else echo "   A1: FALHOU"; fi
echo
echo "── A2 · o mesmo never, sem atualização pedida"
if caso_a2 "$KIT" "$TMP/a2"; then echo "   A2: OK"; else echo "   A2: FALHOU"; fi
echo
echo "── A3 · dois update.sh simultâneos + a vigília do agent.sh no meio"
if caso_a3 "$KIT" "$TMP/a3"; then echo "   A3: OK"; else echo "   A3: FALHOU"; fi
echo

echo "── A3b · o caminho do botão (update.sh filho do agent.sh, cadeado herdado)"
if caso_a3b "$KIT" "$TMP/a3b"; then echo "   A3b: OK"; else echo "   A3b: FALHOU"; fi
echo

if [ "$SABOTAGEM" != "0" ]; then
  echo "── A4 · sabotagem por item (cada uma numa cópia do kit)"
  for item in reexportar flock; do
    sabotar "$TMP/kit-$item" "$KIT" "$item"
  done
  # Cada rodada de sabotagem vai num SUBSHELL: as provas dela aparecem na tela
  # (é o vermelho que se quer ver), mas o veredito da sabotagem é o dela — o
  # contador do arquivo conta só as provas do kit consertado.
  echo "   1) sem a releitura dos *_PULL_POLICY → A1 tem de cair, e só A1"
  if ( caso_a1 "$TMP/kit-reexportar" "$TMP/s1a1" ); then
    nao "A4 · A1 caiu sem a releitura" "A1 passou — a cerca de A1 não mede o conserto"
  else
    ok "A4 · A1 caiu sem a releitura (o teste mede o conserto)"
  fi
  if ( caso_a2 "$TMP/kit-reexportar" "$TMP/s1a2" ); then
    ok "A4 · A2 continua passando sem a releitura (a sabotagem não virou 'sempre puxa')"
  else
    nao "A4 · A2 continua passando sem a releitura" "A2 caiu também — a sabotagem derrubou mais que A1"
  fi
  if ( caso_a3 "$TMP/kit-reexportar" "$TMP/s1a3" ); then
    ok "A4 · A3 continua passando sem a releitura (só A1 depende dela)"
  else
    nao "A4 · A3 continua passando sem a releitura" "A3 caiu também — a sabotagem derrubou mais que A1"
  fi
  echo
  echo "   2) sem o flock do update.sh → A3 tem de cair, e só A3"
  if ( caso_a3 "$TMP/kit-flock" "$TMP/s2a3" ); then
    nao "A4 · A3 caiu sem o flock" "A3 passou — a cerca de A3 não mede o cadeado"
  else
    ok "A4 · A3 caiu sem o flock (o teste mede o cadeado)"
  fi
  if ( caso_a1 "$TMP/kit-flock" "$TMP/s2a1" ); then
    ok "A4 · A1 continua passando sem o flock (só A3 depende dele)"
  else
    nao "A4 · A1 continua passando sem o flock" "A1 caiu também — a sabotagem derrubou mais que A3"
  fi
  echo
  echo "   restore: as cópias sabotadas nunca foram a árvore de trabalho. A"
  echo "   original e cada cópia, arquivo a arquivo (só UM tem de diferir):"
  for item in reexportar flock; do
    printf '     kit-%s difere em: ' "$item"
    { diff -rq "$KIT" "$TMP/kit-$item" 2>/dev/null || true; } | awk '{print $2}' | tr '\n' ' '
    printf '\n'
  done
  echo "   sha256 da árvore de trabalho (a que vai no PR):"
  ( cd "$KIT" && sha256sum update.sh _common.sh agent.sh | sed 's/^/     /' )
  echo
fi

printf 'provas executadas: %s\n' "$PROVAS"
printf 'provas falhas:     %s\n' "$FALHAS"
if [ "$PROVAS" -eq 0 ]; then
  echo "FALHOU — zero provas executadas: nada aqui mediu nada."
  exit 1
fi
if [ "$FALHAS" -eq 0 ]; then
  echo "OK — todas as provas passaram."
  exit 0
fi
echo "FALHOU — $FALHAS prova(s) de $PROVAS."
exit 1