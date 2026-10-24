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

# Antes de qualquer outra coisa: esta cópia do repo manda neste projeto Docker?
#
# Cedo de propósito — antes até de ANUNCIAR a versão. Uma cópia que não é a dona
# anunciaria a versão da árvore dela, e o app ofereceria "Atualizar agora" com
# base num número que não descreve o que está no ar.
recusar_projeto_de_outra_arvore log_err || exit 0

# A senha das rotinas que o log do sistema guardou (#1054) é trocada AQUI quando
# a atualização veio do botão da tela: o `update.sh` dirigido por um agent.sh
# não pode trocá-la (o agente que o dirige fala com a senha velha até o fim).
# Esta execução já é a do kit novo — o cron relê o arquivo a cada 5 minutos — e
# ainda não segura nenhuma atualização. Uma vez só: a marca em disco encerra.
# Depois da troca, `setup_event_log_drain_cron` reescreve a linha do crontab
# (numa instalação que atualizou por um update.sh antigo, ela ainda carrega a
# senha escrita) e o SECRET desta execução passa a ser o novo.
if [ ! -e "${PROJECT_DIR}/${MARCA_SEGREDO_DO_CRON_NOME}" ]; then
  if trocar_segredo_do_cron_vazado >/dev/null 2>&1; then
    if [ -n "${SEGREDO_DO_CRON_TROCADO:-}" ]; then
      setup_event_log_drain_cron >/dev/null 2>&1 || true
      log_err "troquei a senha interna das rotinas (a antiga ficou no log do sistema por versões anteriores do instalador). Recomendado: apagar os logs antigos — sudo truncate -s 0 /var/log/syslog && sudo rm -f /var/log/syslog.* && sudo journalctl --rotate && sudo journalctl --vacuum-time=1s"
    fi
  else
    log_err "não consegui trocar a senha interna das rotinas nesta execução — tento de novo na próxima"
  fi
  SECRET="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
fi

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

# A volta sozinha contada ao painel (#2757).
#
# O agente já fala com o app por esta rota (heartbeat e run_result); este é o
# terceiro recado, e existe porque a volta automática era invisível para quem
# usa a tela: o registro ficava só no `.update-agent.log` da VPS, e quem abria
# o painel via a versão mudar sem explicação. O corpo não leva comando nenhum —
# só o fato (de qual versão para qual, por quê) —, pela mesma regra do resto da
# rota: o que atravessa a fronteira é informação, nunca instrução.
#
# O recado leva o DESFECHO da volta (#3271), num campo próprio (`ok`). Sem ele
# o painel tratava igual a volta que terminou bem e a que falhou: a tela
# afirmava "está no ar agora" nos dois casos e ainda oferecia o botão de voltar
# apontando para a versão que já estava rodando. O motivo continua no `reason`
# (é o texto que quem lê entende), mas quem decide o desfecho é o campo: código
# 0 = a volta terminou; qualquer outro = não terminou.
#
# Falha aqui NÃO derruba nada: a volta já aconteceu, e o pior desfecho de um
# aviso que não passa é o `.update-agent.log` de sempre.
avisar_volta_no_painel() {  # avisar_volta_no_painel <para onde voltou> <versão que não respondeu> <falhas> <rc da volta>
  local para="${1:-}" falhou="${2:-}" falhas="${3:-}" rc="${4:-0}" ok motivo corpo
  [ -n "$para" ] || return 0
  motivo="o site não respondeu em ${falhas:-2} healthchecks seguidos logo depois da atualização"
  if [ "${rc:-0}" = "0" ]; then
    ok="true"
  else
    ok="false"
    motivo="$motivo (a volta terminou com código $rc)"
  fi
  corpo="{\"kind\":\"rollback\",\"returned_to\":\"$(esc "$para")\",\"failed_version\":\"$(esc "$falhou")\",\"ok\":$ok,\"reason\":\"$(esc "$motivo")\"}"
  post "$corpo" >/dev/null 2>&1 || true
  return 0
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
# A AUTORIDADE é a release publicada, NUNCA a maior tag. Ver
# `ultima_release_estavel` em _common.sh para o caso real que obrigou a troca
# (v1.20.0 existia como tag manual, sem release — e a pergunta antiga mandava
# instalá-la). O `git fetch --tags` acima continua necessário: a API decide
# QUAL tag, o git fornece o CONTEÚDO dela (changelog, ancestralidade).
LATEST_TAG="$(ultima_release_estavel)" || true
# "A API não respondeu" é diferente de "não há release". Sem esta distinção o
# app leria o silêncio como boa notícia e diria "você está em dia" a uma
# instalação atrasada — o mesmo defeito que COMPARE_FAILED já evita do outro
# lado.
if [ -n "$LATEST_TAG" ]; then RELEASE_OK=1; else RELEASE_OK=0; fi

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
# Idem quando quem não respondeu foi a API de releases: não sabemos se existe
# versão nova, e dizer que não existe seria mentir com cara de boa notícia.
[ -z "$LATEST_TAG" ] && [ "$RELEASE_OK" = 0 ] && COMPARE_FAILED=true

# ── A ETIQUETA PODE SAIR NA FRENTE DA IMAGEM ─────────────────────────────────
#
# MEDIDO em 2026-09-13: a tela ofereceu a "Nova versão · 1.17.16" enquanto a
# imagem dela ainda estava sendo construída — porque este agente decidia olhando
# SÓ a etiqueta no Git. São uns seis minutos entre uma coisa e outra.
#
# Antes da pausa dos serviços, clicar naquela janela era um susto: a atualização
# avisava "a versão ainda está publicando" e o sistema seguia no ar com a versão
# antiga. Agora o app é PARADO antes do banco e a volta usa o endereço da imagem
# NOVA. Sem imagem, ele não volta.
#
# ⚠️ E aqui o silêncio é ESCOLHIDO, ao contrário de todo o resto deste arquivo.
# Este bloco não acende `COMPARE_FAILED`: seria inventar um sinal falso, porque
# a comparação funcionou — o que falta é a imagem, não a resposta. E não há
# campo no batimento para "existe versão nova, mas ainda não dá para instalar".
# Ficar calado por alguns minutos é a escolha certa aqui e só aqui, por três
# razões: o estado é transitório, ele se cura sozinho na passada seguinte (5
# min), e a alternativa é um botão que derruba o sistema.
VEREDITO_IMAGEM=""
if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "$CURRENT" ]; then
  VEREDITO_IMAGEM="$(veredito_da_imagem_do_app "${LATEST_TAG#v}" "${CURRENT_TAG#v}")" || VEREDITO_IMAGEM=""
  # Só `ausente` cala. `indisponivel` é "não consegui perguntar ao registro", e
  # nesse caso anunciar é o que preserva o comportamento de sempre — uma VPS com
  # saída de rede ruim não pode ficar sem atualização para sempre, em silêncio.
  [ "$VEREDITO_IMAGEM" = "ausente" ] && LATEST_TAG=""
  # ── E a release tem as QUATRO imagens? (#1955, critério 1) ──────────────
  # O veredito de cima olha SÓ a imagem do app. Um run de publicação que morre
  # no meio deixa a ETIQUETA publicada com o worker (ou o scheduler, ou a voz)
  # inexistente — e quem clica em "Atualizar" descobre no `up -d`, com o CRM
  # parado e o build local queimando a memória da VPS. Uma release sem todas
  # as imagens prontas não é oferecida: o silêncio aqui é transitório (a
  # próxima passada, 5 min, reavalia) e a alternativa é um botão que derruba
  # o sistema.
  # Só `incompleta` cala, pelo MESMO motivo do `ausente`: `indisponivel` é o
  # registro fora do ar, e uma VPS com rede ruim não pode ficar sem
  # atualização para sempre, em silêncio.
  if [ -n "$LATEST_TAG" ] && [ "$(veredito_das_imagens_da_release "${LATEST_TAG#v}")" = "incompleta" ]; then
    LATEST_TAG=""
  fi
fi

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
  # O corte deixou de ser cego. O `awk` para de imprimir AO IMPRIMIR o cabeçalho
  # da versão instalada — e o cabeçalho entra de propósito: é ele que prova ao
  # app que a faixa está completa. Isso encolhe o payload no caso comum (uma ou
  # duas versões de salto) em vez de subir o teto, que mataria o heartbeat
  # inteiro com 422, calado. O `head -c 30000` continua depois, como teto para o
  # salto grande. `index()` e não regex: o rótulo tem `[` e `]`, e escapar isso
  # em awk é onde se erra. Instalação fora de release (CURRENT é um SHA) nunca
  # casa, cai no arquivo inteiro cortado, e o app declara que não alcançou.
  # MANTENHA numa linha física só: `lib/release/cabe-na-tela.ts` lê o teto E o
  # `-v cur=` daqui por regex de linha única e EXPLODE se ela for quebrada. São
  # dois os leitores, com atores diferentes — o teste que cobra o AUTOR DO PR
  # (tests/unit/changelog-cabe-na-tela-da-vps.test.ts) e o que cobra a CASA
  # (pnpm release:acervo-cabe, fora de pull_request) —, mas a régua é uma só:
  # duas cópias do número seriam duas fontes da verdade, e a que envelhece é
  # sempre a cópia.
  CHANGELOG="$(git show "${LATEST_TAG}:CHANGELOG.md" 2>/dev/null | awk -v cur="## [${CURRENT#v}]" 'index($0, cur) == 1 { print; exit } { print }' | head -c 30000 || true)"
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

# ── 2. Uma atualização por vez — e o cadeado cobre o agente INTEIRO (#2757) ─
# O `flock` protegia só o caminho de quem executa o pedido. A vigília do app
# logo abaixo TAMBÉM dispara uma atualização (a volta sozinha), então o
# cadeado passa a valer desde aqui: um segundo cron que suba enquanto este
# segura um update — ou uma volta — não sonda o app no meio da troca nem
# encosta nas marcas da vigília. `flock -n`: quem não pegou sai em silêncio,
# e o próximo ciclo (5 minutos) pega.
exec 9>"$LOCK"
flock -n 9 || exit 0

# ── 3. O app caiu logo após uma atualização? (#2757) ───────────────────────
#
# O `update.sh` devolve os serviços em qualquer saída e o bloco lá embaixo
# devolve a IMAGEM quando o run termina com erro — mas os dois dependem de
# alguém ver a falha acontecer. Quando o app cai DEPOIS disso, quem mais
# precisa de saída é o dono com o painel em 502: o botão de voltar mora
# dentro do app que parou.
#
# Esta seção é a resposta, e ela roda ANTES do heartbeat de propósito: com o
# app fora do ar o POST não tem resposta, e o `|| exit 0` logo abaixo encerraria
# o agente — o cenário inteiro desta vigília. A marca que a autoriza nasce no
# `update.sh` (passo 1.6), e quem a desarma é a própria vigília: app
# respondendo, janela vencida ou volta já disparada.
DE_VOLTA="$(vigia_ler)" || DE_VOLTA=""
if [ -n "$DE_VOLTA" ]; then
  if app_esta_no_ar; then
    # Respondeu: a contagem recomeça. A marca segue de pé — é a janela de
    # validade (duas horas) que encerra a vigília, não um healthcheck bom.
    vigia_zerar
  else
    FALHAS="$(vigia_falhou)" || FALHAS=0
    log_err "o app não respondeu em $FALHAS de $VIGIA_FALHAS_SEGUIDAS healthchecks seguidos logo após a atualização — se continuar assim, volto para a $DE_VOLTA sozinho"
    if [ "${FALHAS:-0}" -ge "$VIGIA_FALHAS_SEGUIDAS" ]; then
      # A marca sai ANTES de rodar: UMA tentativa por vigília, sempre. Se a
      # volta falhar, o motivo fica no log para alguém ler — repetir sozinha
      # a cada 5 minutos viraria laço de atualização num app que não sobe
      # nem na versão anterior.
      vigia_encerrar
      # A versão que NÃO respondeu, lida ANTES da volta: depois do
      # `update.sh --to`, o código em disco já é o da versão anterior, e o
      # aviso do painel diria que a volta foi para ela mesma.
      VERSAO_QUE_FALHOU="$CURRENT"
      log_err "voltando sozinho para a $DE_VOLTA: o app ficou fora do ar em $FALHAS healthchecks seguidos logo após a atualização"
      set +e
      bash "$(dirname "$0")/update.sh" --to "$DE_VOLTA" --force >>"$LOG" 2>&1
      RC_VOLTA=$?
      set -e
      log_err "volta para a $DE_VOLTA terminou com código $RC_VOLTA — a saída completa está em .update.log"
      # A volta sozinha é a única troca de versão que ninguém pediu pela tela:
      # sem este aviso, quem abre o painel vê a versão mudar sem explicação (o
      # registro ficava só no `.update-agent.log` da VPS). O canal é o mesmo
      # que o agente já usa — ver `avisar_volta_no_painel`.
      avisar_volta_no_painel "$DE_VOLTA" "$VERSAO_QUE_FALHOU" "$FALHAS" "$RC_VOLTA"
      # O fim desta passada: seguir para um pedido de atualização (ou sondar
      # de novo) com o app no meio da troca só mistura as duas histórias. O
      # próximo ciclo volta a contar com tudo.
      exit 0
    fi
  fi
fi

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

# ── 4. Alguém pediu. Uma atualização por vez. ───────────────────────────────
# (o cadeado já está na mão desde a seção 2 — a vigência também dispara
# atualização, e as duas não podem correr ao mesmo tempo.)
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
# O alvo vem do RUN, e não da última release: a tela pode ter pedido um
# VOLTAR (#2757) — e aí instalar a última publicada seria reinstalar
# exatamente a versão que acabou de quebrar. Rota anterior a #2757 não manda
# `to_version`; run sem ele cai no de sempre, que é a última release
# publicada (e, sem tag anunciada, o update.sh resolve o alvo sozinho e
# recusa em português o que não for atualização de verdade — o motivo chega
# à tela pelo log_tail, em vez de o run sumir sem explicação).
ALVO="$(json_field "$RESP" to_version)" || ALVO=""
[ -n "$ALVO" ] || ALVO="$LATEST_TAG"
UPDATE_ARGS=()
[ -n "$ALVO" ] && UPDATE_ARGS=(--to "$ALVO")
# A MESMA guarda do update.sh contra "versão ANTERIOR à já instalada"
# (o bloco que recusa sem --force), decidida AQUI, onde o git está: alvo
# contido no que roda aqui é voltar no tempo. Sem esta linha o pedido de volta
# morreria na recusa do próprio update.sh — o run fecharia "failed" mandando
# quem clicou rodar, no terminal, o comando que este agente tinha em mãos.
VOLTA_NO_TEMPO=""
if [ -n "$ALVO" ] && [ "$ALVO" != "$CURRENT_TAG" ]; then
  is_already_in_head "$ALVO" && CONTIDA=0 || CONTIDA=$?
  [ "$CONTIDA" = 0 ] && VOLTA_NO_TEMPO=1
fi
[ -n "$VOLTA_NO_TEMPO" ] && UPDATE_ARGS+=(--force)

# Cada execução do agente começa sem medição nenhuma do banco: o arquivo da
# rodada é desta rodada, e resíduo da execução anterior não pode virar história
# desta (a tela conta o que aconteceu AGORA). Quem grava é o reaplicar_baseline,
# no _common.sh.
export RODADA_DO_BANCO_ARQUIVO="${TMPDIR:-/tmp}/deskcomm-rodada-do-banco.$$"
rm -f "$RODADA_DO_BANCO_ARQUIVO" 2>/dev/null || true
set +e
DESKCOMM_AGENT_REPORT=1 \
DESKCOMM_AGENT_PREV_IMAGE="$PREV_IMAGE" \
DESKCOMM_AGENT_REPORT_CMD="$(declare -f post report log_err); report" \
  bash "$(dirname "$0")/update.sh" "${UPDATE_ARGS[@]+"${UPDATE_ARGS[@]}"}" >"$LOG" 2>&1
RC=$?
set -e

# ── 5. O app voltou? Se não, volta a imagem anterior. ───────────────────────
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

# O que a rodada do banco contou de si mesma — três campos PLANOS, com os nomes
# que a rota lê (`disputa_de_banco`, `retentativas_do_banco`, `passada_do_banco`).
# Vazio = não medido: os três chegam ausentes e a tela se cala, em vez de afirmar
# zero. O corpo é montado em pedaços porque campo ausente não vira `null` nem
# vírgula solta no fim.
RODADA_DO_BANCO="$(ler_rodada_do_banco 2>/dev/null || true)"
BODY="{\"kind\":\"run_result\",\"run_id\":\"${RUN_ID}\",\"status\":\"${STATUS}\",\"log_tail\":\"${TAIL}\""
[ -z "$RODADA_DO_BANCO" ] || BODY="${BODY},${RODADA_DO_BANCO}"
BODY="${BODY}}"

# O app acabou de reiniciar: insiste por ~2 min antes de desistir.
for _ in $(seq 1 12); do
  OUT="$(post "$BODY")"
  [ -n "$OUT" ] && break
  sleep 10
done
