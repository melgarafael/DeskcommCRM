#!/usr/bin/env bash
# Agente de atualização: roda por cron a cada 5 minutos no HOST.
#
# Ele NÃO recebe comandos do app — recebe um booleano. Anuncia a versão
# instalada, lê na resposta se alguém clicou em "Atualizar agora" na tela e, se
# sim, roda o update.sh da tag publicada. É o que mantém o CRM em container sem
# nenhum acesso ao Docker do host.
source "$(dirname "$0")/_common.sh"
enter_project

SECRET="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
[ -n "$SECRET" ] || exit 0
[ -n "${NEXT_PUBLIC_APP_URL:-}" ] || exit 0

API="${NEXT_PUBLIC_APP_URL}/api/v1/system/agent"
LOCK="${PROJECT_DIR}/.update.lock"
LOG="${PROJECT_DIR}/.update.log"
# Log PERSISTENTE (append) de falha de comunicação/execução — distinto do
# .update.log acima, que é sobrescrito a cada corrida do update.sh. Um POST que
# falha em silêncio é o pior modo de falha desta feature (o sintoma vira "o
# botão não aparece" e ninguém sabe por quê); tudo que não for 2xx (ou uma
# falha de comando que a gente escolheu não deixar matar o script) cai aqui.
ERRLOG="${PROJECT_DIR}/.update-agent.log"

# _common.sh liga `set -e -o pipefail`. Com pipefail, QUALQUER substituição de
# comando/pipe cujo status não seja explicitamente neutralizado mata o script
# ali mesmo, sem imprimir nada — pior ainda depois de responder ao app que vai
# executar (run "dispatched"): o agente morre, nunca reporta, e o run fica
# travado pra sempre (o índice único da migration 0090 recusa qualquer novo
# pedido). Regra seguida abaixo: NENHUMA substituição pode derrubar o script —
# ou o comando dentro dela já tem seu próprio "|| true"/"|| echo" (git
# describe/rev-parse), ou a atribuição inteira termina em "|| true" — e valor
# vazio resultante é sempre tratado explicitamente, nunca deixado para o `-e`
# decidir por nós.
log_err() {  # log_err <mensagem> — grava com timestamp, corta pra ~200 linhas
  printf '%s [agent] %s\n' "$(date -u +%FT%TZ)" "$1" >> "$ERRLOG" || true
  { tail -n 200 "$ERRLOG" > "${ERRLOG}.tmp" && mv "${ERRLOG}.tmp" "$ERRLOG"; } 2>/dev/null || true
}

post() {  # post <json> → corpo da resposta em 2xx; VAZIO em qualquer falha
  # (quem chama, ex. o laço de retry do run_result, usa "saiu vazio" como sinal
  # de falha — por isso o corpo só é impresso no ramo de sucesso).
  local out http_code body
  out="$(curl -sS -X POST "$API" \
    -H "Authorization: Bearer ${SECRET}" \
    -H 'Content-Type: application/json' \
    --max-time 20 -d "$1" \
    -w $'\n%{http_code}' 2>&1)" || true
  http_code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  case "$http_code" in
    2[0-9][0-9])
      printf '%s' "$body"
      ;;
    *)
      log_err "POST ${API} -> ${out}"
      ;;
  esac
}

json_field() {  # json_field <corpo> <campo> — sem jq, que pode não existir no VPS
  printf '%s' "$1" | tr ',' '\n' | grep -o "\"$2\":[^,}]*" | head -1 | cut -d: -f2- | tr -d '" '
}

# Escapa texto pra caber dentro de uma string JSON, sem depender de jq:
# 1) remove controle C0 cru (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F) e DEL — cobre
#    inclusive sequências ANSI (ESC=0x1B), que o PRÓPRIO update.sh emite via
#    c_grn/c_ylw/c_red e que por isso aparecem de verdade em log_tail, não só
#    em teoria; \t e \n ficam de fora do -d porque viram placeholder abaixo.
# 2) troca tab/newline reais por bytes-placeholder (0x02/0x01 — já removidos
#    do texto pelo passo 1, então não colidem com conteúdo real).
# 3) escapa barra invertida e aspas do conteúdo ORIGINAL (antes de reintroduzir
#    qualquer barra invertida nova).
# 4) troca os placeholders pelas sequências JSON de verdade (\t, \n) — via
#    tr/sed sobre o STREAM inteiro, nunca por registro (awk 'ORS=...' junta
#    quebras de linha com um separador acrescentado SEMPRE, inclusive depois
#    do último registro — isso inventava um "\n" a mais quando o texto não
#    termina em quebra de linha real, ex.: truncamento no meio de uma linha).
#
# `LC_ALL=C` em CADA estágio: sob locale UTF-8 (o padrão em Debian/Ubuntu,
# inclusive via cron), `tr`/`sed` validam a entrada como texto multibyte e
# ABORTAM com "Illegal byte sequence" ao encontrar um byte inválido — e byte
# inválido é exatamente o que sobra quando `head -c` corta no meio de um
# caractere UTF-8 (achado reproduzindo de propósito: o mesmo bug do item 1a,
# por uma porta que só aparece sob locale UTF-8 — funciona na máquina de quem
# testa em LC_ALL=C e morre na VPS do cliente, que roda UTF-8 por padrão). Com
# `LC_ALL=C`, essas ferramentas tratam a entrada como bytes crus: nunca
# validam multibyte, então nunca têm como abortar por sequência ilegal, em
# nenhum host.
esc() {
  printf '%s' "$1" \
    | LC_ALL=C tr -d '\000-\010\013\014\015\016-\037\177' \
    | LC_ALL=C tr '\t\n' '\002\001' \
    | LC_ALL=C sed 's/\\/\\\\/g; s/"/\\"/g' \
    | LC_ALL=C sed $'s/\002/\\\\t/g; s/\001/\\\\n/g'
}

# ── 1. Que versão está instalada e qual é a última publicada? ────────────────
FETCH_OK=1
git fetch --tags --quiet origin 2>/dev/null || FETCH_OK=0

CURRENT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
CURRENT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
LATEST_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)" || true

# Guardado ANTES de qualquer zeragem abaixo: "vi uma tag" e "não anunciei"
# são coisas diferentes. Sem isto, um fork sem NENHUMA tag `v*` chega ao app
# com a mesma combinação de uma instalação que já contém a última publicada
# (LATEST_TAG zerado, compare_failed=false) — e a tela não tem como saber se
# está à frente de uma release real ou se nunca houve release nenhuma.
if [ -n "$LATEST_TAG" ]; then HAS_KNOWN_RELEASE=true; else HAS_KNOWN_RELEASE=false; fi

if [ -n "$CURRENT_TAG" ]; then
  CURRENT="$CURRENT_TAG"; OFF_RELEASE=false
else
  CURRENT="$CURRENT_SHA";  OFF_RELEASE=true
fi

# Tag que já está CONTIDA no que roda aqui não é atualização — é retrocesso, e
# o update.sh recusa instalar (sem --force). Anunciá-la mesmo assim acenderia
# na tela um botão que o agente é obrigado a recusar depois: o mesmo teste de
# ancestralidade nas duas pontas é o que impede o app de prometer o que o host
# não vai cumprir. Sem tag anunciada, a tela diz que a instalação está à frente
# da versão publicada.
#
# Na dúvida (repositório raso que não deu pra completar), também NÃO anuncia:
# oferecer o botão seria oferecer o que o update.sh vai recusar do outro lado.
#
# Mas "não anunciei" e "não existe versão nova" são coisas DIFERENTES, e o app
# não tem como distinguir uma da outra olhando um campo vazio — ele leria o
# silêncio como boa notícia e diria "você está em dia" a uma instalação
# atrasada. Por isso o "não sei" viaja explícito no heartbeat.
COMPARE_FAILED=false
if [ -n "$LATEST_TAG" ]; then
  is_already_in_head "$LATEST_TAG" && CONTIDA=0 || CONTIDA=$?
  [ "$CONTIDA" = 2 ] && COMPARE_FAILED=true
  [ "$CONTIDA" = 1 ] || LATEST_TAG=""   # 0 = retrocesso, 2 = não sei: nos dois, não anuncia
fi
# Sem nenhuma tag conhecida E sem ter conseguido buscar: também não dá para
# afirmar que não há versão nova — nem sabemos se existe alguma publicada.
[ -z "$LATEST_TAG" ] && [ "$FETCH_OK" = 0 ] && COMPARE_FAILED=true

CHANGELOG=""
if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "$CURRENT" ]; then
  # Corta em 30000 bytes CRUS, não 60000: o teto do Zod (CHANGELOG_MAX_BYTES,
  # lib/system/changelog.ts) é 64000 e vale sobre a string JÁ ESCAPADA — cada
  # aspas/barra/tab/quebra de linha dobra de tamanho no esc() acima. Cortar
  # cru em 60000 dava só 6,7% de folga: um changelog técnico (trechos de
  # código, regex) passaria de 64000 escapado sem nunca bater 60000 cru, e o
  # HEARTBEAT INTEIRO morreria com 422 — sem short-circuit, isso morre calado.
  # 30000 cru garante ≤60000 escapado mesmo no pior caso (100% do texto
  # escapando 2x), com folga sobre o teto de 64000.
  CHANGELOG="$(git show "${LATEST_TAG}:CHANGELOG.md" 2>/dev/null | head -c 30000 || true)"
  # `head -c` corta em byte fixo, e o CHANGELOG tem emoji/acento multi-byte
  # (UTF-8) — um corte no meio de um caractere quebraria o JSON de um jeito
  # difícil de rastrear. `iconv -c` descarta o byte incompleto do final sem
  # depender do corte cair "certo". Guardado por `command -v`: se faltar no
  # host, pulamos a limpeza (o changelog fica como está, cru) em vez de o
  # changelog inteiro sumir em silêncio por causa de uma dependência ausente.
  if command -v iconv >/dev/null 2>&1; then
    CHANGELOG="$(printf '%s' "$CHANGELOG" | iconv -f UTF-8 -t UTF-8 -c 2>/dev/null || true)"
  fi
fi

# Cinto e suspensório: o "LC_ALL=C" acima já torna esc() incapaz de abortar
# por sequência inválida, mas a morte do agente é grave o bastante (run
# travado pra sempre) pra justificar a redundância explícita do "|| true".
# Pin pela metade: o app fixado numa versão e o worker/scheduler seguindo canal
# móvel. É o estado que a PRIMEIRA atualização de uma instalação legada deixa —
# medido em ensaio e na produção —, e o `update.sh` que o produz é o antigo, que
# não sabe avisar. Este agente é o único que roda DEPOIS dele já com o kit novo
# em disco (cron de 5 min, lido a cada execução), então é por aqui que a
# informação alcança quem parou na primeira e não voltou.
#
# Ele AVISA, não corrige. Gravar no `.env` de uma instalação alheia é mudança de
# comportamento e precisa de decisão de quem opera — não de um cron.
# Preenche a lacuna sozinho, e só a lacuna. O estado dura no máximo um ciclo de
# cron (5 min) em vez de durar até alguém rodar o update de novo — que era o que
# acontecia, porque a tela dizia "concluída" e ninguém volta.
PIN_CORRIGIDO="$(completar_pin_ausente .env)" || PIN_CORRIGIDO=""
[ -n "$PIN_CORRIGIDO" ] && log_err "fixei a versão de $PIN_CORRIGIDO no .env (estava sem versão fixa; usei a que já estava rodando)"

# O que sobra depois de corrigir: valor explícito em canal móvel, que é decisão
# do operador e não se toca. Aqui só se avisa.
PIN_FALTANDO="$(pin_incompleto .env)" || PIN_FALTANDO=""

BODY="{\"kind\":\"heartbeat\",\"current_version\":\"${CURRENT}\",\"current_sha\":\"${CURRENT_SHA}\",\"off_release\":${OFF_RELEASE},\"latest_version\":\"${LATEST_TAG}\",\"compare_failed\":${COMPARE_FAILED},\"has_known_release\":${HAS_KNOWN_RELEASE},\"changelog\":\"$(esc "$CHANGELOG")\"}" || true

# Só no log do host, de propósito. Mandar isto no heartbeat seria inútil: o
# schema da rota é `z.object` sem `.strict()`, então o Zod DESCARTA chave
# desconhecida em silêncio — o campo viajaria e não chegaria a lugar nenhum,
# que é a definição de controle decorativo. Quando o app aprender o campo, aí
# ele entra no BODY junto.
if [ -n "$PIN_FALTANDO" ]; then
  log_err "a versão de $PIN_FALTANDO está solta (seguindo um canal, não uma versão fixa) — rode 'bash hostgator-setup-kit/update.sh' mais uma vez para fixar"
fi
RESP="$(post "$BODY")"

[ "$(json_field "$RESP" update_requested)" = "true" ] || exit 0
RUN_ID="$(json_field "$RESP" run_id)" || true
[ -n "$RUN_ID" ] || exit 0

# ── 2. Alguém pediu. Uma atualização por vez. ────────────────────────────────
exec 9>"$LOCK"
flock -n 9 || exit 0

report() { post "{\"kind\":\"run_progress\",\"run_id\":\"${RUN_ID}\",\"step\":\"$1\"}" >/dev/null; }

# Guarda a imagem em execução ANTES de puxar a nova: é por onde a gente volta
# se o app novo não subir. `docker compose images -q` pode sair != 0 sempre
# que o daemon soluça, o app não estiver de pé, ou houver problema de
# permissão — coisas normais numa VPS rodando isso a cada 5 minutos, pra
# sempre; sem o "|| true" isso já derrubava o agente ANTES de sequer chamar o
# update.sh (achado só rodando de propósito com o comando falhando).
PREV_IMAGE="$(dc images -q app 2>/dev/null | head -1)" || true
# O worker e o scheduler passaram a ser imagens publicadas e pinadas na mesma
# versão do app (antes eram `build:`-only e nenhum update os alcançava). Isso
# tem um custo aqui: um rollback que voltasse SÓ o app deixaria o parque com
# app na versão antiga e worker/scheduler na nova — mistura de versões que a
# doutrina de packaging existe para impedir. Então os três voltam juntos.
#
# SÓ numa instalação que já passou pelo update.sh novo — isto é, cujo .env já
# tem WORKER_IMAGE/SCHEDULER_IMAGE. Numa instalação LEGADA o `images -q` devolve
# o ID da imagem antiga, e gravá-lo no .env seria pior que não voltar nada: o
# scheduler legado era `alpine:3.20` com o crontab montado por um `command:`
# inline que este compose não tem mais. Pinar aquele ID deixaria o contêiner
# rodando o CMD do alpine puro — ele sai na hora, e `restart: unless-stopped` o
# recoloca em crashloop. Os 16 crons parariam, em silêncio, gravado no .env.
if grep -qE '^WORKER_IMAGE=' .env 2>/dev/null; then
  PREV_WORKER_IMAGE="$(dc images -q worker 2>/dev/null | head -1)" || true
fi
if grep -qE '^SCHEDULER_IMAGE=' .env 2>/dev/null; then
  PREV_SCHEDULER_IMAGE="$(dc images -q scheduler 2>/dev/null | head -1)" || true
fi
PREV_WORKER_IMAGE="${PREV_WORKER_IMAGE:-}"
PREV_SCHEDULER_IMAGE="${PREV_SCHEDULER_IMAGE:-}"
if [ -z "$PREV_IMAGE" ]; then
  # Registrado, não ignorado: sem imagem anterior conhecida, se o update.sh
  # falhar mais adiante NÃO HÁ como voltar — o status vai sair "failed", nunca
  # "failed_rolled_back", e é importante um humano conseguir saber o porquê
  # (docker fora do ar? primeira execução, sem stack de pé ainda? etc.)
  # olhando o log em vez de adivinhar.
  log_err "PREV_IMAGE vazio (docker compose images -q app não devolveu nada) — rollback não será possível se a atualização falhar"
fi

# update.sh roda num processo bash SEPARADO (via `bash arquivo`, não `source`).
# report() chama post(), que por sua vez lê $API/$SECRET/$ERRLOG, e o próprio
# corpo de report() referencia $RUN_ID — nada disso atravessa pro processo
# filho sem export explícito: sem isto, o report() "funciona" (não quebra a
# atualização) mas todo run_progress falha calado (achado rodando de verdade:
# 1ª tentativa deu "post: comando não encontrado"; corrigido isso, a 2ª deu
# 422 "Invalid UUID" — RUN_ID chegava vazio no filho). `declare -f` também
# precisa incluir post, não só report.
export API SECRET ERRLOG RUN_ID
# Sem tag anunciada (instalação à frente da última publicada, ou sem tags),
# roda sem --to: o update.sh resolve o alvo sozinho e recusa em português o
# que não for atualização de verdade — o motivo chega à tela pelo log_tail,
# em vez de o run sumir sem explicação.
UPDATE_ARGS=()
[ -n "$LATEST_TAG" ] && UPDATE_ARGS=(--to "$LATEST_TAG")
set +e
DESKCOMM_AGENT_REPORT=1 \
DESKCOMM_AGENT_PREV_IMAGE="$PREV_IMAGE" \
DESKCOMM_AGENT_REPORT_CMD="$(declare -f post report log_err); report" \
  bash "$(dirname "$0")/update.sh" "${UPDATE_ARGS[@]+"${UPDATE_ARGS[@]}"}" >"$LOG" 2>&1
RC=$?
set -e

# ── 3. O app voltou? Se não, volta a imagem anterior. ───────────────────────
STATUS="success"
if [ $RC -eq "$REFUSED_RC" ]; then
  # O update.sh recusou ANTES de tocar em qualquer coisa (alvo anterior ao
  # instalado, ou impossível ter certeza). Não há nada a desfazer: reiniciar o
  # container e reescrever o .env aqui seria inventar um estrago — e reportar
  # "voltei para a versão anterior" seria a mentira que esta feature passou uma
  # onda inteira consertando. O motivo em português já está no log.
  STATUS="failed"
elif [ $RC -ne 0 ]; then
  STATUS="failed"
  if [ -n "$PREV_IMAGE" ]; then
    # Os serviços que temos como voltar. Worker e scheduler entram só se o
    # `images -q` deles respondeu: numa instalação que ainda não tinha as
    # imagens novas, voltar o app sozinho continua sendo o comportamento certo,
    # e é melhor que não voltar nada.
    ROLLBACK_ARGS=(app)
    [ -n "$PREV_WORKER_IMAGE" ] && ROLLBACK_ARGS+=(worker)
    [ -n "$PREV_SCHEDULER_IMAGE" ] && ROLLBACK_ARGS+=(scheduler)

    if APP_IMAGE="$PREV_IMAGE" APP_PULL_POLICY=missing \
       WORKER_IMAGE="${PREV_WORKER_IMAGE:-}" WORKER_PULL_POLICY=missing \
       SCHEDULER_IMAGE="${PREV_SCHEDULER_IMAGE:-}" SCHEDULER_PULL_POLICY=missing \
         dc up -d "${ROLLBACK_ARGS[@]}" >>"$LOG" 2>&1; then
      STATUS="failed_rolled_back"
      # Persiste a volta: o update.sh já gravou as imagens NOVAS (quebradas) no
      # .env antes do pull. Sem reescrever aqui, o próximo `up -d` — o do
      # cliente, semanas depois — traria o app quebrado de volta e desfaria o
      # rollback em silêncio. Os IDs guardados são LOCAIS (não tags do
      # registro), então a política de pull precisa ir junto.
      set_env_var .env APP_IMAGE "$PREV_IMAGE"
      set_env_var .env APP_PULL_POLICY missing
      if [ -n "$PREV_WORKER_IMAGE" ]; then
        set_env_var .env WORKER_IMAGE "$PREV_WORKER_IMAGE"
        set_env_var .env WORKER_PULL_POLICY missing
      fi
      if [ -n "$PREV_SCHEDULER_IMAGE" ]; then
        set_env_var .env SCHEDULER_IMAGE "$PREV_SCHEDULER_IMAGE"
        set_env_var .env SCHEDULER_PULL_POLICY missing
      fi
    fi
  fi
fi

TAIL="$(esc "$(tail -40 "$LOG" || true)")" || true

# O app acabou de reiniciar: insiste por ~2 min antes de desistir.
for _ in $(seq 1 12); do
  OUT="$(post "{\"kind\":\"run_result\",\"run_id\":\"${RUN_ID}\",\"status\":\"${STATUS}\",\"log_tail\":\"${TAIL}\"}")"
  [ -n "$OUT" ] && break
  sleep 10
done
