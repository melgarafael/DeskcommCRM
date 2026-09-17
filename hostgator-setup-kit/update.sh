#!/usr/bin/env bash
# Atualiza o DeskcommCRM na VPS: código novo + banco + app — com BACKUP antes e
# CHECAGEM DE SAÚDE depois. Um comando só, pensado pra quem não é técnico:
#
#   bash hostgator-setup-kit/update.sh
#
# Flags:
#   --force        instala a versão pedida mesmo que ela seja igual ou ANTERIOR
#                  à que já está aqui (é o jeito explícito de voltar no tempo)
#   --skip-backup  pula o backup automático (não recomendado)
#   --to <tag>     instala essa tag em vez da mais recente publicada
# Absoluto e resolvido ANTES do `enter_project`, que faz `cd`: depois dele um
# `dirname "$0"` relativo apontaria para o lugar errado, e o único sintoma seria
# um script do kit "não encontrado" no meio da atualização.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$KIT_DIR/_common.sh"
enter_project

FORCE=""; SKIP_BACKUP=""; TARGET_TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --to) shift; TARGET_TAG="$1" ;;
  esac
  shift
done

# ── 0-. Esta cópia do repo é a dona dos contêineres? ─────────────────────────
# Antes do cron e antes do git: uma segunda cópia que atualiza por cima recria o
# parque com o .env DELA. Foi o que deixou o WhatsApp de uma VPS real três dias
# em 401. Ver `recusar_projeto_de_outra_arvore` em _common.sh.
recusar_projeto_de_outra_arvore || die "Atualização interrompida para não quebrar a instalação que está no ar."

# ── 0. Liga o agente da tela ANTES de qualquer decisão de versão ─────────────
# Instalar o cron aqui, e não no fim, é o que faz o bootstrap ter fim: os
# caminhos "já está na versão mais recente" e "essa versão é anterior à sua"
# saem do script mais abaixo, e se o cron dependesse deles a atualização pela
# tela nunca ligaria justamente em quem já está em dia. É idempotente.
setup_update_agent_cron

# ── 1. Tem atualização mesmo? ────────────────────────────────────────────────
step "Procurando atualizações"
git fetch --tags --quiet origin 2>/dev/null || c_ylw "⚠ não consegui falar com o GitHub — sigo com o código que já está aqui."
[ -n "$TARGET_TAG" ] || TARGET_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
[ -n "$TARGET_TAG" ] || die "Não encontrei nenhuma versão publicada para instalar."
git rev-parse --verify --quiet "${TARGET_TAG}^{commit}" >/dev/null \
  || die "Não conheço a versão $TARGET_TAG aqui. Confira o nome (ex.: v1.1.0) ou tente de novo quando o servidor conseguir falar com o GitHub."
CURRENT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"

# O código estar em dia NÃO significa que o app está: quem roda é a imagem.
# Uma atualização interrompida depois do checkout (queda de rede, falta de
# memória no meio do docker pull) deixa o repositório novo e a imagem velha — e
# a partir dali TODO update.sh respondia "já está na versão mais recente",
# prendendo o CRM na versão antiga sem nenhuma saída visível para o dono.
# Também cobre imagem republicada sem commit novo (rebuild de segurança).
# (Veio da `main`; a versão por tag cai exatamente na mesma armadilha, porque a
# comparação de tags também fica satisfeita com a imagem velha no lugar.)
image_desatualizada() {
  # O fallback vem de `IMG_APP` (_common.sh, sourceado no topo deste arquivo) e não de
  # um literal: num fork com namespace próprio, o literal apontava para a
  # imagem do UPSTREAM, e um `.env` sem APP_IMAGE comparava o digest local
  # contra um registry que não é o dele.
  local img="${APP_IMAGE:-${IMG_APP}:latest}" local_d remote_d
  local_d="$(docker image inspect "$img" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null | sed 's/.*@//')"
  [ -z "$local_d" ] && return 0                 # nem baixada ainda → atualizar
  remote_d="$(docker buildx imagetools inspect "$img" 2>/dev/null | awk '/^Digest:/{print $2; exit}')"
  [ -z "$remote_d" ] && return 1                # sem como consultar → não forçar
  [ "$local_d" != "$remote_d" ]
}

MESMA_TAG=""
[ "$CURRENT_TAG" = "$TARGET_TAG" ] && MESMA_TAG=1

if [ -n "$MESMA_TAG" ] && [ -z "$FORCE" ] && ! image_desatualizada; then
  c_grn "✓ Você já está na versão mais recente ($TARGET_TAG). Nada a atualizar."
  exit 0
fi

# Alvo que JÁ está contido no que roda aqui = andar pra trás, não pra frente.
# Numa instalação que segue a `main`, `git describe --exact-match` é vazio: a
# comparação de tags acima passa batido e, sem esta guarda, o script instalaria
# alegremente uma versão MAIS VELHA que a instalada — desligando o que o dono
# já tem (foi assim que este próprio botão se autodestruiria, voltando pra uma
# imagem que não conhece o agente de atualização). Recusar é o padrão; voltar
# no tempo continua possível, mas só quando alguém pede de propósito.
# Quando o alvo é a MESMA tag já instalada, a guarda não se aplica: não há para
# onde voltar no tempo — só a imagem é que ficou para trás.
if [ -z "$FORCE" ] && [ -z "$MESMA_TAG" ]; then
  is_already_in_head "$TARGET_TAG" && CONTIDA=0 || CONTIDA=$?
  case "$CONTIDA" in
    0) refuse "A versão $TARGET_TAG é ANTERIOR à que já está instalada neste servidor.
     Instalar ela seria voltar no tempo e desligar coisas que você já tem.
     Não mexi em nada: nem no banco, nem no app — está tudo como estava.
     Se você REALMENTE quer voltar para a $TARGET_TAG, rode:
       bash hostgator-setup-kit/update.sh --to $TARGET_TAG --force" ;;
    2) refuse "Não consegui ter CERTEZA de que a versão $TARGET_TAG é mais nova que a instalada
     aqui — a cópia do código neste servidor veio abreviada e eu não consegui completá-la
     (o servidor precisa conseguir falar com o GitHub para isso).
     Prefiro não mexer a arriscar te levar para uma versão anterior sem querer.
     Não mexi em nada. Tente de novo em alguns minutos; se insistir, confira a internet do
     servidor. Para instalar assim mesmo, por sua conta:
       bash hostgator-setup-kit/update.sh --to $TARGET_TAG --force" ;;
  esac
fi
if [ -n "$MESMA_TAG" ] && [ -n "$FORCE" ]; then
  # Com --force na mesma tag ninguém conferiu a imagem: quem chega aqui pediu
  # para refazer (é a saída que a própria atualização ensina quando o banco não
  # termina limpo). Dizer "o app está rodando uma imagem antiga" seria inventar.
  if [ -n "$SKIP_BACKUP" ]; then
    c_ylw "Refazendo a versão $TARGET_TAG, como pedido (--force): banco de novo, e confere o app."
  else
    c_ylw "Refazendo a versão $TARGET_TAG, como pedido (--force): backup e banco de novo, e confere o app."
  fi
elif [ -n "$MESMA_TAG" ]; then
  c_ylw "O código já está na $TARGET_TAG, mas o app está rodando uma imagem antiga. Vou atualizar a imagem."
else
  c_ylw "Vou atualizar para a versão $TARGET_TAG com segurança."
fi

# ── 2. Backup de segurança ANTES de tocar no banco ───────────────────────────
if [ -z "$SKIP_BACKUP" ]; then
  step "Backup de segurança (antes de mexer no banco)"
  if bash "$(dirname "$0")/backup.sh"; then
    c_grn "✓ backup feito — se algo der errado, dá pra restaurar (restore.sh)."
  else
    if [ -n "${DESKCOMM_AGENT_REPORT:-}" ] || [ ! -t 0 ]; then
      die "O backup preventivo falhou. Atualização automática interrompida para proteger os dados."
    fi
    c_ylw "⚠ o backup falhou. A atualização NÃO apaga dados (só reorganiza os contatos),"
    c_ylw "  mas o ideal é ter backup."
    read -r -p "Deseja continuar MESMO SEM BACKUP? Digite 'CONTINUAR': " conf
    [ "$conf" = "CONTINUAR" ] || die "Atualização cancelada pelo operador para investigar a falha do backup."
  fi
fi
# Avisa o agente do host (se for ele quem está dirigindo) — é o que faz a tela
# de atualização avançar passo a passo enquanto o app ainda está de pé.
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" backup

# ── 3. Código novo ───────────────────────────────────────────────────────────
step "Baixando o código novo"
if ! git checkout --quiet "$TARGET_TAG" 2>&1; then
  die "Não consegui trocar para a versão $TARGET_TAG (parece haver mudanças locais que divergem).
     Rode 'git status' pra ver, ou peça ajuda. NÃO mexi no banco — está tudo como estava."
fi
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" codigo

# ── 4. Banco: schema + correções de dados (schema ANTES do app) ──────────────
# O baseline é idempotente e auto-curativo. Re-aplicar numa base que JÁ existe
# gera erros do tipo "já existe" / "multiple primary keys" — isso é ESPERADO e
# inofensivo (são objetos que já estavam lá). Filtramos esse ruído e só
# mostramos problemas de verdade. Erro de disputa com o app no ar (deadlock)
# faz o arquivo ser aplicado de novo: ver `reaplicar_baseline` em _common.sh.
# Re-aplicar o baseline é DDL, então vai por `url_do_schema` (_common.sh) e não
# pela string do app: numa instalação em Supabase próprio, com a role menor no
# `.env` como recomendamos, este passo passava a falhar em silêncio a cada
# atualização — e é o update.sh que entrega migration nova ao clone (issue #192).
step "Atualizando o banco de dados"
# O que sobrou de errado no banco, para ser repetido no FIM da execução.
# Vazio = o banco terminou limpo (ou não havia baseline para aplicar).
BANCO_INCOMPLETO=""
# As linhas que repetir NÃO cura: as que não são de disputa nem de conexão
# (permissão, dado). Vazio com BANCO_INCOMPLETO cheio = só o banco ocupado.
BANCO_RESTANTE=""
# O que fazer, dito por causa, no passo 4 e de novo no fim. Rodar o update.sh sem
# --force responderia "já está na versão mais recente" e não tocaria no banco.
# O restore vem por ÚLTIMO: ele desfaz também o que o CRM gravou desde o backup.
orientar_banco_incompleto() {
  # As duas metades SOMAM: uma lista pode ter disputa (que repetir cura) e erro de
  # permissão ou de dado (que não). Escolher uma só escondia a ação possível.
  if [ "$BANCO_RESTANTE" != "$BANCO_INCOMPLETO" ]; then
    c_ylw "  Parte não aplicou porque o banco seguiu ocupado ou fora de alcance nas $BASELINE_PASSADAS passadas."
    c_ylw "  Confira se o banco está no ar e repita a atualização, de preferência num horário de pouco"
    c_ylw "  movimento (reaplica o banco; o site pode piscar por alguns segundos):"
    c_ylw "    bash hostgator-setup-kit/update.sh --to $TARGET_TAG --force"
  fi
  case "$BANCO_RESTANTE" in
    "") ;;
    *permission\ denied*|*must\ be\ owner*|*permissão\ negada*)
      c_ylw "  Há erros de PERMISSÃO, e esses repetir não cura: a conexão do .env não é o dono do banco."
      c_ylw "  Num Supabase próprio, declare SUPABASE_DB_ADMIN_URL no .env — é ela que roda o schema — e"
      c_ylw "  repita a atualização:"
      c_ylw "    bash hostgator-setup-kit/update.sh --to $TARGET_TAG --force" ;;
    *)
      c_ylw "  O resto dos erros acima repetir não cura: guarde a mensagem e peça ajuda." ;;
  esac
  c_ylw "  Só em último caso, volte ao backup feito antes desta atualização (restore.sh)."
}
if [ -f supabase/baseline.sql ]; then
  # Extensões que o schema exige (idempotente; iguais ao install.sh).
  docker run --rm postgres:17-alpine psql "$(url_do_schema)" -c \
    "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;" \
    >/dev/null 2>&1 || true

  if reaplicar_baseline "$PROJECT_DIR/supabase/baseline.sql"; then
    if [ "$BASELINE_PASSADAS" -gt 1 ]; then
      c_grn "✓ banco atualizado na passada $BASELINE_PASSADAS — as anteriores não aplicaram tudo (banco ocupado ou conexão instável; o que faltou está listado acima)."
    else
      c_grn "✓ banco atualizado (e conversas reorganizadas, se havia bagunça)."
    fi
  else
    BANCO_INCOMPLETO="$BASELINE_INESPERADO"
    BANCO_RESTANTE="$(printf '%s\n' "$BANCO_INCOMPLETO" | grep -viE "$BASELINE_ERROS_DE_DISPUTA" || true)"
    c_ylw "⚠ Apareceram avisos no banco que NÃO são os esperados:"
    # Sem `| head`: com pipefail, o head que fecha cedo mata o printf com SIGPIPE
    # numa lista grande — e o set -e derrubava o script aqui, antes do aviso de
    # PERMISSÃO, que foi escrito justamente para ela.
    listar_erros_do_banco "$BANCO_INCOMPLETO" 20
    c_ylw "  O app pode ainda funcionar."
    orientar_banco_incompleto
  fi
else
  c_ylw "⚠ supabase/baseline.sql não encontrado — pulei a parte do banco."
fi
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" banco

# ── 4.5 E-mails de acesso, para quem já estava instalado ────────────────────
# Só COM o token no ambiente, e por isso duas coisas:
#
#  - é assim que um clone ANTIGO recebe os e-mails com a marca dele. O
#    `install.sh` dele nunca chamou este passo (ele não existia), e nenhuma
#    atualização toca em config de auth por conta própria;
#  - sem o token, o script imprimiria o passo manual — útil UMA vez, na
#    instalação, e ruído em toda atualização a partir daí. Atualização que
#    resmunga toda vez ensina a ignorar a saída dela.
#
# E sem o token, UMA vez na vida: quem instalou antes de a entrevista pedir o
# token tem o Site URL do projeto em `localhost:3000` — o link de "esqueci minha
# senha" leva a uma máquina que não existe fora do laptop de quem desenvolve.
# Esse parque não é alcançado por nada: o `install.sh` dele não perguntou o
# token, e o bloco acima só roda com token. Sem esta linha, a população
# REALMENTE quebrada hoje nunca fica sabendo.
#
# Uma vez, e nunca mais — o marcador em disco garante isso, que é o que separa
# um recado de um resmungo mensal. E o texto CONFERE, não acusa: quem já
# configurou à mão está certo, e ler "seus e-mails estão quebrados" numa
# atualização que correu bem seria alarme falso na cara de quem fez tudo certo.
AVISO_SITE_URL=""
MARCA_AVISO_SITE_URL="$PROJECT_DIR/.deskcomm-site-url-avisado"
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  bash "$KIT_DIR/marca-emails.sh" --projeto "$PROJECT_DIR" || true
  : > "$MARCA_AVISO_SITE_URL" 2>/dev/null || true   # o passo automático rodou
elif [ ! -e "$MARCA_AVISO_SITE_URL" ]; then
  AVISO_SITE_URL=1
fi

# ── 5. App novo ──────────────────────────────────────────────────────────────
step "Baixando a versão nova do app e reiniciando"
# Imagem da TAG publicada (não "latest" solto): garante que o código (checkout
# acima) e a imagem do container sejam sempre da mesma versão. Gravada no .env,
# não só exportada: o compose lê a imagem de lá, e um `up -d` rodado à mão
# depois voltaria pro ":latest" do install — desfazendo a atualização.
#
# As TRÊS imagens são gravadas juntas, na mesma versão. O worker e o scheduler
# passaram a ter imagem publicada porque, antes, eram `build:`-only no compose:
# `dc pull` os PULAVA ("Skipped - No image to be pulled") e o `dc up -d` abaixo
# recriava o contêiner sobre a imagem velha, sem `--build`. Resultado: o worker
# — que é o runtime do agente de IA — ficava congelado no código do dia da
# instalação e atravessava todas as atualizações. Esta é a linha que conserta
# isso para o parque já instalado, sem que ninguém precise editar arquivo.
#
# `gravar_imagens` também resolve o pull_policy pela mutabilidade da tag: como
# aqui o alvo é sempre uma tag de versão (imutável), sai `missing`. Isso além de
# tudo desfaz o "missing" que um rollback anterior deixava para trás — antes ele
# ficava no .env para sempre, e o `up -d` manual do dono nunca mais puxava nada.
# Lido ANTES de `gravar_imagens` corrigir — senão a informação some. Este é o
# estado que a execução ANTERIOR deixou, e o dono nunca soube: o `update.sh`
# antigo grava só `APP_IMAGE`, e o worker fica seguindo um canal móvel.
PIN_FALTANDO_ANTES="$(pin_incompleto .env)"

VERSAO_ALVO="${TARGET_TAG#v}"
export APP_IMAGE="${IMG_APP}:${VERSAO_ALVO}"
export WORKER_IMAGE="${IMG_WORKER}:${VERSAO_ALVO}"
export SCHEDULER_IMAGE="${IMG_SCHEDULER}:${VERSAO_ALVO}"
gravar_imagens .env "$VERSAO_ALVO"

# Os segredos da chamada de voz (spec 18), para quem instalou antes dela existir.
# LACUNA apenas — chave presente, mesmo vazia, é decisão de quem opera. Isto NÃO
# liga a feature: sem `voz` em COMPOSE_PROFILES o serviço nem é criado. O que
# isto compra é o dia em que o dono QUISER ligar não começar por inventar dois
# segredos num editor dentro da VPS, que é o passo manual que a doutrina de
# packaging proíbe.
VOZ_CRIADA="$(completar_segredos_da_voz .env)" || VOZ_CRIADA=""
[ -n "$VOZ_CRIADA" ] && c_ylw "  (preparei as credenciais da chamada de voz no .env — ela segue DESLIGADA)"

# `dc pull` falha se alguma das três imagens ainda não existir no registro — o
# que acontece numa instalação atualizando para a primeira versão publicada
# depois desta mudança, ou se um run de publicação quebrou. Nesse caso o compose
# ainda tem `build:` ao lado do `image:` do worker e do scheduler, então o
# `up -d` os constrói localmente: pior que puxar, melhor que não atualizar.
if ! dc pull; then
  # A mensagem distingue os dois casos porque a consequência é oposta, e uma
  # frase tranquilizadora sobre o caso errado é o pior desfecho possível: o
  # `worker` e o `scheduler` têm `build:` ao lado do `image:` e o `up -d` os
  # constrói; o `app` NÃO tem, então se for a imagem dele que falta, o `up -d`
  # morre logo abaixo — e dizer "sigo assim mesmo" teria sido mentira.
  if dc pull app >/dev/null 2>&1; then
    c_ylw "⚠ Não consegui puxar todas as imagens da versão ${VERSAO_ALVO}."
    c_ylw "  A do app veio; o que faltar é construído aqui (mais lento, mesmo resultado)."
  else
    c_ylw "⚠ Não consegui puxar a imagem do APP na versão ${VERSAO_ALVO}."
    c_ylw "  Causas comuns: a versão ainda está publicando, ou o pacote está privado no GHCR."
    c_ylw "  Vou tentar subir mesmo assim — se falhar, rode de novo em alguns minutos."
  fi
fi
# A rede do proxy externo é declarada como EXTERNA no compose: se ela sumiu
# (um `docker network prune`, ou o `down -v` que o próprio kit ensina como
# caminho de recomeço), o `up -d` abaixo morre em "network X declared as
# external, but could not be found" — e este script roda sozinho pelo agent.sh,
# então ninguém está lendo a tela para decifrar isso. Mesma função do install.sh.
garantir_rede_do_proxy
dc up -d

# O Caddyfile entra no container por bind mount de UM ARQUIVO, e bind mount de
# arquivo fica preso ao inode. O `git pull` não edita o arquivo: escreve outro e
# renomeia, gerando inode novo — o container continua lendo o antigo, para
# sempre. Medido nesta VPS: host inode 3283869, container 3271833, com o
# conteúdo velho lá dentro.
#
# Sem este force-recreate, TODA mudança de proxy enviada numa atualização
# (inclusive correção de segurança na borda) some em silêncio: o update diz
# "concluída" e a configuração antiga segue valendo.
#
# Com proxy externo não há Caddy para recriar — e não basta o profile inativo
# do override: nomear o serviço explicitamente (`up -d ... caddy`) ATIVA o
# profile dele no Compose e sobe o contêiner assim mesmo, indo bater de frente
# com o Traefik nas portas 80/443. O resultado era um "⚠ não consegui recriar o
# proxy" em TODA atualização de quem usa proxy externo: alarme falso, num
# momento em que o dono precisa confiar no que está lendo.
case "${REVERSE_PROXY:-caddy}" in
traefik|npm)
  c_grn "✓ proxy externo (${REVERSE_PROXY}): o Caddy não é usado aqui — nada a recarregar"
  ;;
*)
  dc up -d --force-recreate --no-deps caddy >/dev/null 2>&1 \
    && c_grn "✓ proxy recarregado com a configuração desta versão" \
    || c_ylw "⚠ não consegui recriar o proxy — rode: docker compose $(dc_files) up -d --force-recreate caddy"
  ;;
esac

# ── 6. O app voltou no ar? ───────────────────────────────────────────────────
step "Conferindo se o app voltou no ar"
ok=""
wait_app_healthy 20 3 >/dev/null && ok=1
if [ -n "$ok" ]; then
  if [ -n "$BANCO_INCOMPLETO" ]; then
    c_ylw "⚠ App no ar e saudável, mas o banco NÃO terminou limpo — o que fazer está no fim desta saída."
  else
    c_grn "✓ Atualização concluída — app no ar e saudável."
  fi
  # Dito no fim, e não no início, porque é aqui que o dono lê. Se a execução
  # anterior deixou o pin pela metade, ele nunca soube — a tela dizia "concluída"
  # e o worker seguia um canal móvel. Agora ele sabe que existiu e que acabou.
  if [ -n "$PIN_FALTANDO_ANTES" ]; then
    c_ylw "  (de quebra: a versão de $PIN_FALTANDO_ANTES estava solta e foi fixada agora)"
  fi
  # Dito aqui pelo mesmo motivo do pin: é no fim que o dono lê.
  if [ -n "$AVISO_SITE_URL" ]; then
    DOM_AVISO="$(printf '%s' "${NEXT_PUBLIC_APP_URL:-https://SEU_DOMINIO}")"
    cat <<AVISO

$(c_ylw "  ─── CONFIRA UMA COISA, UMA VEZ SÓ ─────────────────────")

  Os e-mails de acesso (esqueci minha senha, confirmação de cadastro,
  aceite de convite) levam para o endereço que estiver em Authentication
  → URL Configuration, no painel do Supabase. Instalações feitas antes de
  o instalador perguntar o token do Supabase ficaram com o padrão de
  projeto novo, \`http://localhost:3000\`, que só existe na máquina de
  quem desenvolve — e aí ninguém consegue redefinir a própria senha.

  Vale conferir. Se já estiver com os valores abaixo, não há nada a fazer:

       Site URL:       ${DOM_AVISO}
       Redirect URLs:  ${DOM_AVISO%/}/auth/confirm

  Este aviso não se repete — para o instalador cuidar disso sozinho, rode
  o update com \`export SUPABASE_ACCESS_TOKEN=sbp_...\` no ambiente.
AVISO
    : > "$MARCA_AVISO_SITE_URL" 2>/dev/null || true
  fi
else
  c_ylw "⚠ Atualizei, mas o app não respondeu 'ok'. Veja os logs:"
  c_ylw "  docker compose $(dc_files) logs --tail=50 app"
  # Código de saída != 0: é o que o agent.sh usa pra saber que precisa voltar
  # pra imagem anterior (guardada por ele ANTES do pull). Sem isso, não existe
  # rede de proteção — o app novo, quebrado, ficaria no ar sem ninguém saber.
  exit 1
fi

# ── 7. Automações (cron do drain de eventos; o da tela já subiu no bloco 0) ──
step "Conferindo as automações"
ensure_encryption_key .env
setup_event_log_drain_cron

# ── Fim: o banco que não terminou limpo é a ÚLTIMA coisa na tela ─────────────
# Na v1.27.3 de uma VPS real o aviso do passo 4 ficou soterrado por centenas de
# linhas do docker pull, e as últimas linhas da tela eram ✓ verdes. É aqui,
# depois de tudo, que o dono lê.
if [ -n "$BANCO_INCOMPLETO" ]; then
  step "Atenção: o banco NÃO terminou limpo nesta atualização"
  c_ylw "  Os avisos completos estão no passo \"Atualizando o banco de dados\", acima."
  orientar_banco_incompleto
fi
