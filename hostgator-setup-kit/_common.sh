#!/usr/bin/env bash
# Helpers compartilhados pelos scripts do kit. Sourced, não executado direto.
set -euo pipefail

# Idioma da CLI (t(), IDIOMA_CLI) — ver o cabeçalho de _i18n.sh. Sourced aqui
# porque update.sh e os demais scripts do kit sourceiam _common.sh sem passar
# por install.sh; instalação já em andamento no mesmo processo (install.sh)
# mantém a escolha, já exportada em DESKCOMM_IDIOMA_CLI.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_i18n.sh"

COMPOSE="docker-compose.prod.yml"
COMPOSE_TRAEFIK="docker-compose.traefik.yml"
COMPOSE_NPM="docker-compose.npm.yml"
# Overlay que constrói as imagens no lugar de puxá-las. Existe no repo com
# `pull_policy: never` nas três imagens e sai do MESMO commit que o `git
# checkout` deixou no disco — é o caminho de quem não consegue usar as imagens
# publicadas (ver construir_aqui_e_subir, abaixo).
COMPOSE_BUILD="docker-compose.build.yml"

# ── Arquitetura das imagens publicadas ───────────────────────────────────────
# O CI publica app, worker, scheduler e agente de voz em linux/amd64 e
# linux/arm64. O instalador escolhe também a imagem oficial WAHA NOWEB ARM64;
# Redis, Caddy e SRH já publicam manifestos ARM64. Sem reconhecer a arquitetura
# aqui, uma VPS A1 seria recusada antes de chegar ao fluxo que já tem imagens
# nativas para ela.
#
# A decisão fica pura no argumento para os testes simularem a arquitetura sem
# depender do runner. A leitura de `uname -m` é o único ponto ligado ao host.
arquitetura_suportada_pelo_kit() {
  case "${1:-}" in
    x86_64|amd64|aarch64|arm64) return 0 ;;
    *) return 1 ;;
  esac
}

# WAHA publica NOWEB em tags distintas por arquitetura. O instalador grava
# essa referência no .env; `enter_project` também cobre um .env antigo sem a
# variável. A tag é fixa e corresponde à mesma versão funcional em ambas.
imagem_waha_padrao_para_host() {
  case "$(uname -m 2>/dev/null || true)" in
    aarch64|arm64) printf '%s' 'devlikeapro/waha:noweb-arm-2026.7.2' ;;
    *)             printf '%s' 'devlikeapro/waha:latest-2026.7.2' ;;
  esac
}

# Quem já roda em ARM (#1266) tem no .env o WAHA que o install.sh antigo
# gravava — `devlikeapro/waha` e, desde 13/08/2026, `latest-2026.7.2` —, e os
# dois índices só têm linux/amd64. Troca SÓ esses valores conhecidos (e o vazio,
# em que o default do compose seria o amd64); qualquer outra escolha do
# operador, WAHA Plus inclusive, fica intacta. Pura no argumento, como a de cima.
waha_amd64_conhecido_em_arm() {  # waha_amd64_conhecido_em_arm <arquitetura> <WAHA_IMAGE do .env> → 0 = trocar
  case "${1:-}" in aarch64|arm64) ;; *) return 1 ;; esac
  case "${2:-}" in
    ""|devlikeapro/waha|devlikeapro/waha:latest|devlikeapro/waha:latest-2026.7.2) return 0 ;;
  esac
  return 1
}

# ── JÁ EXISTE UMA INSTALAÇÃO REAL AQUI? (#1266, corrigido pelo #1778) ───────
#
# A guarda do #1042 vivia no TOPO dos dois scripts, e por isso matava antes de
# chegar ao `construir_aqui_e_subir` (#1060/#1143) — a recuperação por build
# local para uma arquitetura sem imagem publicada. As duas mudanças tinham
# teste verde isoladamente e ninguém rodou as duas juntas: o resultado foi um
# `exit 1` na PRIMEIRA linha, que deixava uma instalação existente nessa
# arquitetura sem poder rodar `update.sh` de novo, e sem bandeira nenhuma.
#
# O sinal NÃO pode ser o estado do DIRETÓRIO. "compose + `.env`" chega junto
# numa instalação NOVA: o `.env` pode ter sido copiado de outra máquina, gerado
# por automação, ou deixado por uma rodada anterior do `--yes` que parou no
# meio. Com esse critério, um `install.sh --yes` numa VPS de arquitetura sem
# imagem publicada e com o `.env` já preenchido passava pela guarda como se
# fosse instalação existente e ia construir as imagens na própria VPS (15–25
# min) — exatamente o que a guarda do #1042 existe para impedir. E o `.env` sozinho nunca provou nada: o
# `git clone` de uma instalação nova pode trazer um `.env` de exemplo.
#
# O sinal do DIRETÓRIO entra como CONDIÇÃO, nunca como prova: sem compose nem
# `.env` não há nem nome de projeto para procurar, e o marcador — que só o
# install.sh escreve, e sempre ao lado do `.env` — é o mesmo par sem prova.
#
# O que prova é o que a instalação DEIXOU no Docker, e a guarda pergunta ao
# Docker diretamente. `nome_do_projeto_compose` mora mais abaixo, no bloco de
# proxy/nome de projeto; por isso o cálculo do nome fica em uma função só, e o
# resto a chama por nome em tempo de execução (o shell resolve a chamada
# quando ela acontece, não quando o arquivo é lido) — o que deixa esta função
# aqui em cima, onde a guarda precisa dela, sem depender da ordem do arquivo.
#
# O volume do Postgres NÃO entra: ele só existe no modo single-server e some
# junto com o `down -v` que o próprio kit ensina como receita de "recomeçar" —
# quem o encontrasse seria uma instalação derrubada, não uma instalação real.
MARCA_INSTALACAO_NOME=".deskcomm-instalado"

# O nome do projeto Docker DESTA instalação, na ordem que importa. O
# COMPOSE_PROJECT_NAME do `.env` manda quando existe (é o nome que os
# contêineres carregam no label); o derivado do diretório é o que o Compose
# usaria sem ele, e as duas entradas são testadas. Errar o nome faria a guarda
# não achar o contêiner de quem JÁ TEM instalação — e a recusa voltaria a matar
# a recuperação do #1775, que é exatamente o que o sinal de contêiner
# existe para não fazer.
#
# O derivado do diretório é REPETIDO aqui, e não chamado de
# `nome_do_projeto_compose`: essa função mora ~500 linhas abaixo deste ponto, e
# a guarda roda no TOPO do arquivo, quando ela ainda não existe (chamar por nome
# aqui daria "command not found" e a recusa do #1042 viraria um erro de
# sintaxe). A fórmula é a de lá — minúsculo, só [a-z0-9_-], com os `_`/`-` do
# INÍCIO aparados — e `tests/shell/` mede as duas cópias iguais.
nomes_do_projeto_da_instalacao() {  # nomes_do_projeto_da_instalacao <diretório>
  local dir="$1" declarado derivado
  declarado="$(sed -n 's/^[[:space:]]*COMPOSE_PROJECT_NAME=//p' "$dir/.env" 2>/dev/null \
    | head -1 | tr -d '\r' | tr -d '"'"'" | tr -d '[:space:]')"
  derivado="$(basename "$dir" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  derivado="${derivado#"${derivado%%[!_-]*}"}"
  # Um valor fora do que o Compose aceita como nome é melhor ignorado do que
  # procurado: o `--filter` não valida, e o nome errado devolve vazio — que é a
  # mesma resposta de "não achei", e é a que manda recusar.
  case "$declarado" in
    ''|*[!a-z0-9_-]*) ;;
    *) printf '%s\n%s\n' "$declarado" "$derivado" ; return 0 ;;
  esac
  printf '%s\n' "$derivado"
}

# Há contêiner (rodando OU parado) do projeto compose informado? O `-a` conta o
# que está parado: quem instalou e parou o CRM tem instalação do mesmo jeito, e
# parar o stack é uma pausa, não um desinstalar. `docker` fora do PATH (ou sem
# permissão no socket) devolve 1, que é a resposta que manda RECUSAR — nunca
# adivinhar instalação a partir de um `docker` que não respondeu.
conteiner_do_projeto_existe() {  # conteiner_do_projeto_existe <projeto compose>
  [ -n "${1:-}" ] || return 1
  command -v docker >/dev/null 2>&1 || return 1
  [ -n "$(docker ps -a -q --filter "label=com.docker.compose.project=$1" 2>/dev/null)" ]
}

instalacao_real_do_kit_aqui() {
  local d nome
  for d in "$PWD" "$PWD/deskcommcrm"; do
    [ -f "$d/$COMPOSE" ] && [ -f "$d/.env" ] || continue
    [ -f "$d/$MARCA_INSTALACAO_NOME" ] && return 0
    while IFS= read -r nome; do
      [ -n "$nome" ] || continue
      conteiner_do_projeto_existe "$nome" && return 0
      conteiner_do_projeto_existe "$nome-supabase" && return 0
    done <<EOF
$(nomes_do_projeto_da_instalacao "$d")
EOF
  done
  return 1
}

# O install.sh grava este marcador com a stack no ar, para que a guarda de
# arquitetura reconheça a instalação pelo QUE ELA DEIXOU, e não pelo que veio
# pronto no diretório. `chmod 600` pelo mesmo rigor do `.env`: o arquivo não é
# segredo, mas também não é para vazar.
marcar_instalacao_feita() {  # marcar_instalacao_feita [versão]
  # `local` um por linha, e o segundo já com o valor montado: no mesmo `local`,
  # o nome da esquerda ainda não existe quando a direita é avaliada, e com
  # `set -u` o `local dir=… marca="$dir/…"` morre em "unbound variable" — o
  # arquivo nunca era gravado e a instalação que deu certo mesmo assim é que
  # escondia o defeito.
  local dir="${PROJECT_DIR:-$PWD}"
  local marca="$dir/$MARCA_INSTALACAO_NOME"
  { printf 'instalado_em=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo desconhecido)"
    printf 'versao=%s\n' "${1:-}"; } > "$marca" 2>/dev/null || return 1
  chmod 600 "$marca" 2>/dev/null || true
}

# Ecoa: amd64 | arm64 | recuperar | nova
#
# A decisão é PURA no que recebe: `uname` e a leitura do disco ficam fora, para
# o teste simular as três respostas sem depender do runner nem de um diretório
# de verdade. Quem traduz em mensagem é `verificar_arquitetura_do_kit`.
veredito_da_arquitetura() {  # veredito_da_arquitetura <arquitetura> [0=nova | 1=instalação existente]
  local arch="${1:-}" existe="${2:-0}"
  case "$arch" in
    x86_64|amd64) printf 'amd64'; return 0 ;;
    aarch64|arm64) printf 'arm64'; return 0 ;;
  esac
  [ "$existe" = 1 ] && { printf 'recuperar'; return 0; }
  printf 'nova'
}

verificar_arquitetura_do_kit() {
  local arch existe=0
  arch="$(uname -m 2>/dev/null || t "desconhecida")"
  # O sinal de "instalação real" SÓ é perguntado quando a arquitetura não é
  # suportada. Em amd64 ou arm64 o veredito já está definido e a guarda
  # atravessa, então perguntar seria trabalho inútil — e, com o critério do
  # #1778, trabalho que chama o `docker` no TOPO do install.sh, antes de
  # qualquer passo do instalador. A seção 4 do teste de #1778 mede isso em
  # x86_64.
  if ! arquitetura_suportada_pelo_kit "$arch"; then
    instalacao_real_do_kit_aqui && existe=1
  fi

  case "$(veredito_da_arquitetura "$arch" "$existe")" in
    amd64|arm64) return 0 ;;
    recuperar)
      # O update.sh relê este arquivo depois do checkout da versão nova, e a
      # guarda roda de novo no topo: sem esta trava o dono lia o mesmo aviso
      # duas vezes na mesma atualização. A variável não é exportada, então a
      # trava vale para ESTE processo e nenhum script filho herda o silêncio.
      [ -n "${_DESKCOMM_AVISO_ARQ_DADO:-}" ] && return 0
      _DESKCOMM_AVISO_ARQ_DADO=1
      # `printf` e não c_ylw: este ponto roda no TOPO do arquivo, e as cores só
      # são definidas algumas linhas abaixo (é a mesma razão do `printf` da
      # recusa logo abaixo). O aviso vai para o STDERR, como a recusa: o
      # agent.sh manda a saída do update.sh para arquivo e o dono lê o fim dela.
      printf '%s\n' \
        "⚠ $(t "Este servidor usa arquitetura '{1}', e as imagens publicadas do DeskcommCRM são linux/amd64 e linux/arm64." "$arch")" \
        "  $(t "Como esta instalação JÁ EXISTE, sigo em frente: as imagens da versão alvo serão construídas nesta própria VPS.")" \
        "  $(t "Leva de 15 a 25 minutos. Uma instalação NOVA exige x86_64/amd64 ou ARM64/aarch64 com imagens publicadas.")" >&2
      return 0 ;;
  esac

  printf '%s\n' \
    "✖ $(t "Este servidor usa arquitetura '{1}', mas o DeskcommCRM não publica imagens para ela (linux/amd64 e linux/arm64 estão disponíveis)." "$arch")" \
    "  $(t '  Use uma VPS x86_64/amd64 ou ARM64/aarch64. Repetir o download não resolve.' | sed 's/^  //')" >&2
  return 1
}

# Este arquivo é compartilhado por várias ferramentas. A limitação de imagem só
# deve bloquear os dois caminhos que realmente instalam/atualizam contêineres.
# update.sh sourceia aqui antes de qualquer trabalho; install.sh sourceia depois
# de localizar/clonar o repo, mas ainda antes de consultar ou baixar imagens do
# DeskcommCRM.
_deskcomm_chamador="${BASH_SOURCE[1]:-}"
_deskcomm_chamador="${_deskcomm_chamador##*/}"
case "$_deskcomm_chamador" in
  install.sh|update.sh) verificar_arquitetura_do_kit || exit 1 ;;
esac
unset _deskcomm_chamador

# Proxy reverso desta instalação. Vem do .env (load_env), com default 'caddy' —
# ou seja, toda instalação que já existe continua exatamente como está.
#
#   caddy   → o kit sobe o próprio Caddy nas portas 80/443 (VPS "cru")
#   traefik → a VPS JÁ tem um Traefik nessas portas (Hostinger, Coolify,
#             Dokploy...). Entra o override, que desliga o Caddy e publica o app
#             por labels. Ver o cabeçalho de docker-compose.traefik.yml.
#   npm     → a VPS JÁ tem um Nginx Proxy Manager nessas portas (não lê labels
#             Docker — o roteamento é manual, na UI dele). Entra o override, que
#             desliga o Caddy e garante o `app` na rede/IP que o Proxy Host
#             espera. Ver o cabeçalho de docker-compose.npm.yml.
#
# Todo `docker compose` do kit passa por aqui: com proxy externo, um comando sem
# o override subiria o Caddy e ele iria bater de frente com o proxy da hospedagem.
dc() {
  # Overlay da CA do Supabase (#829): só com a variável declarada, o arquivo da
  # CA existindo no disco (ca_do_supabase_ok) E o overlay no MESMO checkout — o
  # install.sh chama dc() antes do clone, e um -f apontando para arquivo que
  # não existe derruba o compose no meio da instalação. Entra por ÚLTIMO, depois
  # dos overlays de modo e de proxy, que é a ordem em que o compose aplica.
  local -a ca=()
  if ca_do_supabase_ok && [ -f docker-compose.supabase-ca.yml ]; then ca=(-f docker-compose.supabase-ca.yml); fi
  if [ "${SINGLE_SERVER:-0}" = "1" ]; then
    # #2099: o single-server também respeita o proxy da hospedagem. Os dois
    # ramos eram `if SINGLE_SERVER` → return ANTES do seletor, então o
    # docker-compose.traefik.yml (ou npm) nunca entrava aqui: o Caddy do
    # single-server subia e perdia o bind das 80/443 para o Traefik/NPM que já
    # estava lá. Junta os dois: o overlay do proxy vem DEPOIS do overlay do
    # single-server, e o padrão (sem a variável) continua só o single-server.
    case "${REVERSE_PROXY:-caddy}" in
    traefik) docker compose -f "$COMPOSE" -f docker-compose.single-server.yml -f "$COMPOSE_TRAEFIK" ${ca[@]+"${ca[@]}"} "$@" ;;
    npm)     docker compose -f "$COMPOSE" -f docker-compose.single-server.yml -f "$COMPOSE_NPM" ${ca[@]+"${ca[@]}"} "$@" ;;
    *)       docker compose -f "$COMPOSE" -f docker-compose.single-server.yml ${ca[@]+"${ca[@]}"} "$@" ;;
    esac
    return
  fi
  case "${REVERSE_PROXY:-caddy}" in
  traefik) docker compose -f "$COMPOSE" -f "$COMPOSE_TRAEFIK" ${ca[@]+"${ca[@]}"} "$@" ;;
  npm)     docker compose -f "$COMPOSE" -f "$COMPOSE_NPM" ${ca[@]+"${ca[@]}"} "$@" ;;
  *)       docker compose -f "$COMPOSE" ${ca[@]+"${ca[@]}"} "$@" ;;
  esac
}

# A mesma lista de -f, como texto, para as mensagens que ensinam o comando ao
# dono. Se a mensagem omitisse o override numa instalação com proxy externo, o
# próprio dono derrubaria o site seguindo a instrução do kit.
dc_files() {
  # Mesma condição do dc() (#829): a mensagem que ensina o comando tem de
  # carregar o overlay da CA quando o kit mesmo o usaria — sem isso o dono
  # refaz o `up -d` sem a CA e o app volta a sem-verificação.
  local sufixo=""
  if ca_do_supabase_ok && [ -f docker-compose.supabase-ca.yml ]; then
    sufixo=" -f docker-compose.supabase-ca.yml"
  fi
  if [ "${SINGLE_SERVER:-0}" = "1" ]; then
    # #2099: mesma junção de dc() — a lista de -f tem de bater com o que dc()
    # realmente roda, ou a mensagem ensinaria o dono a omitir o overlay do
    # proxy e o próprio dono derrubaria o site seguindo a instrução do kit.
    case "${REVERSE_PROXY:-caddy}" in
    traefik) printf -- '-f %s -f %s -f %s%s' "$COMPOSE" docker-compose.single-server.yml "$COMPOSE_TRAEFIK" "$sufixo" ;;
    npm)     printf -- '-f %s -f %s -f %s%s' "$COMPOSE" docker-compose.single-server.yml "$COMPOSE_NPM" "$sufixo" ;;
    *)       printf -- '-f %s -f %s%s' "$COMPOSE" docker-compose.single-server.yml "$sufixo" ;;
    esac
    return
  fi
  case "${REVERSE_PROXY:-caddy}" in
  traefik) printf -- '-f %s -f %s%s' "$COMPOSE" "$COMPOSE_TRAEFIK" "$sufixo" ;;
  npm)     printf -- '-f %s -f %s%s' "$COMPOSE" "$COMPOSE_NPM" "$sufixo" ;;
  *)       printf -- '-f %s%s' "$COMPOSE" "$sufixo" ;;
  esac
}

# ── A CA do Supabase, declarada UMA vez (#829) ────────────────────────────────
#
# O pooler da nuvem apresenta uma cadeia que a trust store padrão não conhece
# (SELF_SIGNED_CERT_IN_CHAIN quando o cliente exige verificação). Fornecer a CA
# oficial resolve — mas até aqui não existia caminho declarado: o runtime
# (app/worker/scheduler) e os clientes Postgres EFÊMEROS do kit
# (`docker run postgres:17-alpine psql`) moram em lugares diferentes e cada um
# precisava do arquivo por conta própria, com override de Compose só para o
# app/worker justamente não cobrindo os temporários.
#
# Daqui em diante é UMA chave no .env, lida pelos três consumidores:
#
#   SUPABASE_SSL_ROOT_CERT=/root/certs/prod-ca-2021.crt
#
# Caminho desta MÁQUINA (host), não do contêiner — o kit monta o arquivo
# somente-leitura no caminho fixo abaixo e traduz para cada cliente:
#   • psql/pg_dump efêmeros → -v ...:ro + PGSSLROOTCERT (libpq);
#   • app/worker/scheduler  → overlay docker-compose.supabase-ca.yml
#     (volume :ro + NODE_EXTRA_CA_CERTS), que dc() só acrescenta com a CA pronta;
#   • quem lê .env direto (node, cliente Node fora do compose) → a própria
#     chave, documentada em .env.example.
# A verificação NUNCA é desligada. No Node (NODE_EXTRA_CA_CERTS) a CA soma à
# trust store. Na libpq, o PGSSLROOTCERT apontando para um arquivo que existe
# faz `sslmode=require` se comportar como verify-ca (comportamento documentado
# da libpq): com a CA declarada, uma URL com require passa a verificar a cadeia
# nos psql do kit — e uma CA errada faz esses psql falharem fechado.
# Chave ausente = o kit faz o que sempre fez (o healthcheck só informa).
#
# O download oficial (a mesma CA da issue):
#   curl -fsSL -o /root/certs/prod-ca-2021.crt \
#     https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
CA_NO_CONTAINER="/etc/deskcomm/ca/supabase-ca.crt"

# stdout: o caminho ABSOLUTO do arquivo (o docker recusa bind relativo).
# stderr: o que falta, sempre com o nome da variável — é a frase que o
# diagnóstico mostra quando há falha de certificado, no lugar do
# `SELF_SIGNED_CERT_IN_CHAIN` cru que a issue reportou.
# Quem só quer saber se está pronta: ca_do_supabase_ok.
ca_do_supabase() {
  local p="${SUPABASE_SSL_ROOT_CERT:-}"
  if [ -z "$p" ]; then
    printf '%s' "SUPABASE_SSL_ROOT_CERT não está declarada no .env — sem ela o kit não recebe a CA do Supabase. Declare SUPABASE_SSL_ROOT_CERT=/caminho/do/prod-ca-2021.crt (baixe com: curl -fsSL -o /root/certs/prod-ca-2021.crt https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt)" >&2
    return 1
  fi
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  if [ ! -f "$p" ] || [ ! -r "$p" ]; then
    printf '%s' "SUPABASE_SSL_ROOT_CERT aponta para '$p', e este arquivo não existe (ou não é legível). Corrija o caminho no .env — a CA fica FORA do checkout, e o kit só monta arquivo que existe." >&2
    return 1
  fi
  printf '%s' "$p"
}

# Silenciosa, para as decisões de montagem (dc/pg_container): sem CA pronta o
# overlay de runtime NÃO entra — um bind para arquivo inexistente faria o
# compose criar um DIRETÓRIO no lugar da CA e subir o app sem ela.
ca_do_supabase_ok() { ca_do_supabase >/dev/null 2>&1; }

# psql/pg_dump efêmeros. No modo single-server o Postgres só é alcançável pela
# bridge privada (supabase-db), nunca por porta pública.
#
# Com a CA declarada, todo contêiner efêmero nasce com o arquivo montado
# somente-leitura e PGSSLROOTCERT apontando para ele: é o que faz uma connection
# string com `sslmode=verify-full` (ou um teste `PGSSLMODE=verify-full`)
# validar cadeia dentro do contêiner. Idempotente por construção — cada chamada
# monta de novo o MESMO caminho fixo, sem acumular flag nenhuma.
pg_container() {
  local -a rede=() ca=()
  local caminho=""
  [ -n "${PSQL_DOCKER_NETWORK:-}" ] && rede=(--network "$PSQL_DOCKER_NETWORK")
  # `local caminho` na linha de cima, não em `local caminho="$(...)"`: com a
  # atribuição junto, o status do comando substituído some dentro do `local` e
  # este `if` aceitaria uma CA quebrada como se estivesse pronta.
  if caminho="$(ca_do_supabase 2>/dev/null)"; then
    ca=(-v "$caminho:$CA_NO_CONTAINER:ro" -e "PGSSLROOTCERT=$CA_NO_CONTAINER")
  fi
  docker run --rm ${rede[@]+"${rede[@]}"} ${ca[@]+"${ca[@]}"} "$@"
}

# ── MODO SINGLE-SERVER: o Supabase que o kit instala e opera ─────────────────
#
# Só vale com SINGLE_SERVER=1 (install-single-server.sh). Nada aqui roda numa
# instalação comum: todo call site pergunta pelo modo antes.
#
# A versão do Supabase self-hosted é UMA, e mora aqui: o instalador a instala e
# o update.sh leva quem já instalou até ela (atualizar_supabase_single_server).
# Sem `readonly`: o update.sh relê este arquivo depois do checkout.
# Esta ref foi conferida em ARM64: todas as 11 imagens do compose oficial têm
# manifesto linux/arm64. Antes de atualizar a ref, confira as imagens novamente;
# o update automático também precisa continuar funcionando na VPS A1.
SUPABASE_REF="self-hosted/v0.8.1"

dir_do_supabase() { printf '%s/.runtime/supabase' "${PROJECT_DIR:-$PWD}"; }

# O compose oficial declara `name: supabase` e `container_name` fixos
# (supabase-db, supabase-envoy…). Dois Supabase na mesma VPS — o nosso e outro
# qualquer, ou o de uma segunda árvore do CRM — brigariam pelos mesmos nomes. O
# projeto leva o nome do projeto do CRM (o override tira os container_name), e
# a identidade continua sendo a árvore: ver recusar_supabase_de_outra_arvore.
projeto_do_supabase() { printf '%s-supabase' "$(nome_do_projeto_atual)"; }

# `docker compose` do Supabase, com o ambiente LIMPO. O load_env exporta o .env
# inteiro do CRM, e variável de ambiente vence o .env do projeto na
# interpolação: sem o `env -i`, o SMTP_HOST/SMTP_PORT do CRM entrariam no lugar
# dos do Supabase. O nome do projeto vai explícito pelo mesmo motivo.
dc_supabase() {
  (cd "$(dir_do_supabase)" && env -i PATH="$PATH" HOME="${HOME:-/root}" \
    ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
    ${DOCKER_CONTEXT:+DOCKER_CONTEXT="$DOCKER_CONTEXT"} \
    ${DOCKER_CONFIG:+DOCKER_CONFIG="$DOCKER_CONFIG"} \
    COMPOSE_PROJECT_NAME="$(projeto_do_supabase)" docker compose "$@")
}

# Invariante 8 (docs/doctrine/packaging.md) para o projeto do Supabase: o
# mesmo guarda do CRM, perguntando pelos contêineres do Supabase e pela pasta
# que os criou.
recusar_supabase_de_outra_arvore() {  # recusar_supabase_de_outra_arvore [como reportar]
  local projeto dir
  projeto="$(projeto_do_supabase)"; dir="$(dir_do_supabase)"
  COMPOSE_PROJECT_NAME="$projeto" PROJECT_DIR="$dir" COMPOSE=docker-compose.yml \
    recusar_projeto_de_outra_arvore "$@"
}

# Valor para o .env do Supabase, que só o dotenv do Compose lê: aspas duplas
# com `\`, `"` e `$` escapados (o Compose os desfaz; medido no install.sh, envq).
valor_compose() { printf '"%s"' "$(printf '%s' "${1-}" | sed 's/[\\"$]/\\&/g')"; }

# ── O GoTrue manda e-mail pelo SMTP do CRM ───────────────────────────────────
#
# O compose oficial aponta o GoTrue para `supabase-mail`, que não existe em
# produção: "esqueci a senha" e a confirmação de cadastro não chegariam. O SMTP
# do CRM (#1176) é a fonte, na MESMA precedência de lib/email/config.ts: a
# linha da tela /admin/email, se existe; senão o .env. Sai 1 (e não toca em
# nada) quando o CRM não tem SMTP — quem chama avisa o dono.
sincronizar_smtp_do_gotrue() {
  local env_sb sep=$'\x1f' linha="" host porta usuario senha remetente nome
  env_sb="$(dir_do_supabase)/.env"
  [ -f "$env_sb" ] || return 1
  linha="$(psql_run -tA -F "$sep" -c "select coalesce(smtp_host,''), smtp_port,
      coalesce(smtp_username,''),
      coalesce(case when smtp_password_encrypted is null then '' else public.fn_decrypt_oauth(smtp_password_encrypted) end,''),
      coalesce(from_email,''), coalesce(from_name,'')
    from public.platform_smtp_settings where id = 1" 2>/dev/null)" || linha=""
  if [ -n "$linha" ]; then
    IFS="$sep" read -r host porta usuario senha remetente nome <<<"$linha"
  else
    host="${SMTP_HOST:-}"; porta="${SMTP_PORT:-587}"; usuario="${SMTP_USERNAME:-}"
    senha="${SMTP_PASSWORD:-}"; remetente="${SMTP_FROM_EMAIL:-}"; nome="${SMTP_FROM_NAME:-}"
  fi
  [ -n "$host" ] && [ -n "$remetente" ] || return 1
  set_env_var "$env_sb" SMTP_HOST "$(valor_compose "$host")"
  set_env_var "$env_sb" SMTP_PORT "${porta:-587}"
  set_env_var "$env_sb" SMTP_USER "$(valor_compose "$usuario")"
  set_env_var "$env_sb" SMTP_PASS "$(valor_compose "$senha")"
  set_env_var "$env_sb" SMTP_ADMIN_EMAIL "$(valor_compose "$remetente")"
  set_env_var "$env_sb" SMTP_SENDER_NAME "$(valor_compose "${nome:-${APP_NAME:-DeskcommCRM}}")"
}

# ── `so_convite` fecha o caminho DIRETO do GoTrue (#1653) ────────────────────
#
# O CRM já recusava cadastro sem convite na tela, na server action e na volta do
# Google, mas o GoTrue continuava aceitando `POST /auth/v1/signup` — com a anon
# key que vai para o navegador. A instalação que escolheu "só convite" acumulava
# conta que ninguém autorizou, e o dono não tinha porta para fechar.
#
# A única trava que fecha esse caminho é o `disable_signup` do próprio GoTrue, e
# ele NÃO tem API de configuração no self-hosted: medido no fonte
# supabase/auth v2.196.0, as rotas `/admin` são audit, users, generate_link, sso
# e oauth — nenhuma de config. Então o valor mora no `.env` do Supabase, na
# chave OFICIAL `DISABLE_SIGNUP`: o compose do Supabase no ref pinado já a
# mapeia (`GOTRUE_DISABLE_SIGNUP: ${DISABLE_SIGNUP}`) e o `.env.example` dele a
# traz como `false`. Uma variável nossa ao lado seria sombra: o override passaria
# a ignorar a oficial, e quem fechou o cadastro pela receita do Supabase seria
# reaberto em silêncio.
#
# Quem manda é o modo que o APP enxerga, na mesma precedência de
# lib/auth/politica-de-cadastro.ts: a linha de `platform_settings` (a tela de
# `/admin/cadastro`); sem linha, o piso `SIGNUP_MODE` do `.env` do CRM; valor
# irreconhecível no piso vale `aberto`. `so_convite` → true, os outros → false.
# Usar `aberto` quando falta a linha deixaria justamente a instalação que
# declarou `SIGNUP_MODE=so_convite` com o CRM fechado e o GoTrue aberto.
#
# Idempotente, e quem chama só reinicia o `auth` quando o arquivo MUDOU. Devolve
# 1 (sem tocar em nada) quando o valor já é o do modo, quando o banco não
# respondeu ou quando a coluna ainda não existe (instalação anterior à 0253):
# reabrir ou fechar o cadastro de uma instalação por causa de um soluço do
# banco seria o mesmo defeito que o memo pegajoso de `modoDeCadastro()` existe
# para evitar. "Banco falhou" e "sem linha" são respostas diferentes: a primeira
# não mexe, a segunda cai no piso.
sincronizar_signup_mode_do_gotrue() {
  local env_sb modo alvo atual
  env_sb="$(dir_do_supabase)/.env"
  [ -f "$env_sb" ] || return 1
  modo="$(psql_run -tA -c "select signup_mode from public.platform_settings where id = 1" 2>/dev/null)" || return 1
  modo="$(printf '%s' "$modo" | tr -d '[:space:]')"
  if [ -z "$modo" ]; then
    modo="$(sed -n 's/^SIGNUP_MODE=//p' "${PROJECT_DIR:-$PWD}/.env" 2>/dev/null | tail -n 1 | tr -d "\"' \t\r")"
    case "$modo" in aberto|com_aprovacao|so_convite) ;; *) modo=aberto ;; esac
  fi
  case "$modo" in
    so_convite) alvo=true ;;
    aberto|com_aprovacao) alvo=false ;;
    *) return 1 ;;
  esac
  atual="$(sed -n 's/^DISABLE_SIGNUP=//p' "$env_sb" | tail -n 1 | tr -d "\"' \t\r")"
  [ "$atual" = "$alvo" ] && return 1
  set_env_var "$env_sb" DISABLE_SIGNUP "$alvo"
  if [ "$alvo" = true ]; then
    c_ylw "Cadastro direto no Supabase: FECHADO (a instalação está em 'só convite'; convites seguem funcionando)."
  else
    c_ylw "Cadastro direto no Supabase: ABERTO (acompanha o modo '$modo' da instalação)."
  fi
  return 0
}

# ── E-mails de acesso: o GoTrue busca o MOLDE no app (#2109) ────────────────
#
# O molde padrão do GoTrue linka para `/auth/v1/verify`, e o clique em "esqueci
# a senha" termina em `/login?error=link_invalido` (diagnóstico na #2109). As
# rotas `/email-templates/recovery` e `/email-templates/confirmation` do app
# emitem o link com `token_hash`, que `app/auth/confirm` sabe fechar.
#
# O compose oficial do Supabase não mapeia estas chaves para o serviço `auth`
# (só `GOTRUE_SMTP_*` e `GOTRUE_MAILER_URLPATHS_*`), então elas valem DUAS
# vezes: no .env do Supabase, que o compose interpola, e no
# `supabase-single-server.override.yml`, que as entrega ao contêiner.
#
# Chamada pelo install-single-server.sh (com o domínio que ele recebeu) e por
# atualizar_supabase_single_server (sem domínio: sai do SITE_URL que o
# instalador gravou como https://DOMINIO). Valor já presente — no .env do
# Supabase ou no ambiente — manda: nada sobrescreve um molde que o operador já
# apontou. Sem URL https para montar o caminho, não grava nada: um molde
# apontado para `localhost` seria pior que o padrão.
gravar_modelos_do_gotrue() {  # gravar_modelos_do_gotrue <.env do Supabase> [https://DOMINIO]
  local env_sb="$1" base="${2:-}" chave caminho valor
  [ -f "$env_sb" ] || return 0
  [ -n "$base" ] || base="$(valor_do_env "$env_sb" SITE_URL)"
  case "$base" in https://?*) base="${base%/}" ;; *) return 0 ;; esac
  for chave in GOTRUE_MAILER_TEMPLATES_CONFIRMATION GOTRUE_MAILER_TEMPLATES_RECOVERY; do
    [ -n "$(valor_do_env "$env_sb" "$chave")" ] && continue
    case "$chave" in
      *CONFIRMATION) caminho=/email-templates/confirmation ;;
      *) caminho=/email-templates/recovery ;;
    esac
    valor="${!chave:-}"
    [ -n "$valor" ] || valor="${base}${caminho}"
    set_env_var "$env_sb" "$chave" "$valor"
  done
  return 0
}

# ── O aviso do Site URL, UMA vez, no update.sh sem token ────────────────────
# Por topologia, na mesma ordem do marca-emails.sh. O texto da nuvem (painel do
# Supabase + `export SUPABASE_ACCESS_TOKEN=sbp_...`) saía em TODA instalação —
# e mandava quem tem o Supabase na própria VPS a outra conta, atrás de uma chave
# que ali não serve.
#  - single-server: nada a dizer. O Site URL é do kit: o install-single-server.sh
#    grava SITE_URL e ADDITIONAL_REDIRECT_URLS com o domínio desde o nascimento.
#  - Supabase próprio (URL que não é *.supabase.co): o padrão de um Supabase
#    novo também é localhost:3000, mas a conferência é no .env DELE.
#  - nuvem, e URL vazia (topologia desconhecida): o texto de sempre.
# Mora aqui, e não no update.sh, porque o update.sh relê este arquivo depois do
# checkout: daqui em diante, um texto corrigido chega na própria atualização que
# o traz. (A atualização que traz ESTA função ainda roda o update.sh anterior,
# com o texto antigo embutido — o bash segue lendo o arquivo que abriu. No
# single-server ele não chega a sair: atualizar_supabase_single_server grava o
# marcador antes. No Supabase próprio sai uma última vez.)
aviso_do_site_url() {  # aviso_do_site_url <URL do app>
  local dom="${1%/}"
  [ "${SINGLE_SERVER:-0}" = "1" ] && return 0
  printf '\n'
  c_ylw "  ─── CONFIRA UMA COISA, UMA VEZ SÓ ─────────────────────"
  case "${NEXT_PUBLIC_SUPABASE_URL:-}" in
    https://*.supabase.co*|"")
      cat <<AVISO

  Os e-mails de acesso (esqueci minha senha, confirmação de cadastro,
  aceite de convite) levam para o endereço que estiver em Authentication
  → URL Configuration, no painel do Supabase. Instalações feitas antes de
  o instalador perguntar o token do Supabase ficaram com o padrão de
  projeto novo, \`http://localhost:3000\`, que só existe na máquina de
  quem desenvolve — e aí ninguém consegue redefinir a própria senha.

  Vale conferir. Se já estiver com os valores abaixo, não há nada a fazer:

       Site URL:       ${dom}
       Redirect URLs:  ${dom}/auth/confirm

  Este aviso não se repete — para o instalador cuidar disso sozinho, rode
  o update com \`export SUPABASE_ACCESS_TOKEN=sbp_...\` no ambiente.
AVISO
      ;;
    *)
      cat <<AVISO

  Os e-mails de acesso (esqueci minha senha, confirmação de cadastro,
  aceite de convite) levam para o endereço que o seu Supabase tem em
  SITE_URL. O padrão de um Supabase novo é \`http://localhost:3000\`, que só
  existe na máquina de quem desenvolve — e aí ninguém consegue redefinir a
  própria senha.

  Vale conferir no .env do seu Supabase. Se já estiver assim, não há nada a
  fazer; se mudar, recrie o contêiner auth dele (docker compose up -d auth,
  na pasta do Supabase — um restart não relê o .env):

       SITE_URL=${dom}
       ADDITIONAL_REDIRECT_URLS=${dom}/auth/confirm

  Este aviso não se repete.
AVISO
      ;;
  esac
}

# ── O update.sh leva o Supabase até a versão pinada ──────────────────────────
#
# O `update.sh` oficial do Supabase faz o merge de três vias dos arquivos dele
# contra a versão de partida (.supabase-version), nunca toca em dado nem no
# .env (só acrescenta chave nova). Falhar aqui NÃO derruba a atualização do
# CRM: o Supabase segue na versão de antes e a próxima rodada tenta de novo.
atualizar_supabase_single_server() {
  local dir atual
  # O aviso do Site URL não tem o que dizer aqui: o Site URL é do kit (ver
  # aviso_do_site_url). O marcador nasce no corpo desta função, e não só no
  # update.sh, pelo motivo do #1653 lá embaixo: o update.sh ANTIGO, com o texto
  # da nuvem embutido, chama esta função antes de decidir o aviso pelo marcador.
  : > "${PROJECT_DIR:-$PWD}/.deskcomm-site-url-avisado" 2>/dev/null || true
  dir="$(dir_do_supabase)"
  [ -f "$dir/.env" ] || { c_red "⛔ $(t "Modo single-server sem {1}/.env — rode install-single-server.sh." "$dir")"; return 1; }
  cp "$KIT_DIR/supabase-single-server.override.yml" "$dir/docker-compose.deskcomm.yml" || return 1
  set_env_var "$dir/.env" COMPOSE_PROJECT_NAME "$(projeto_do_supabase)"
  atual="$(sed -n 's/^ref=//p' "$dir/.supabase-version" 2>/dev/null | tail -1)"
  if [ "$atual" != "$SUPABASE_REF" ]; then
    step "$(t "Atualizando o Supabase desta VPS ({1} → {2})" "${atual:-$(t "desconhecida")}" "$SUPABASE_REF")"
    if ! (cd "$dir" && env -i PATH="$PATH" HOME="${HOME:-/root}" sh update.sh --to "$SUPABASE_REF" --yes); then
      c_ylw "$(t "⚠ O Supabase não foi atualizado; segue na versão {1}. A próxima atualização tenta de novo." "${atual:-$(t "anterior")}")"
    fi
  fi
  # #2109 — no corpo desta função, e não numa linha do update.sh, pelo mesmo
  # motivo do #1653 logo abaixo. Antes do `up -d --wait`: o compose recria o
  # auth com o ambiente novo, sem reinício à parte.
  gravar_modelos_do_gotrue "$dir/.env"
  dc_supabase up -d --wait || return 1
  # #1653 — a sincronização do modo de cadastro mora AQUI, no corpo desta
  # função, e não numa linha do update.sh. Na atualização que traz este
  # conserto, quem executa é o update.sh ANTIGO: o bash segue lendo o arquivo
  # que abriu, e uma linha nova no texto do update.sh nunca roda (medido: o
  # `git checkout` troca o inode e o script antigo vai até o fim). O que o
  # update.sh antigo faz depois do checkout é reler este `_common.sh` e chamar
  # esta função — em toda versão com single-server (desde a v1.42.0) —, então
  # é o corpo NOVO dela que roda já na primeira atualização. Falha aqui é
  # aviso, não saída 1: o CRM segue atualizável.
  if sincronizar_signup_mode_do_gotrue; then
    dc_supabase up -d --no-deps auth >/dev/null 2>&1 || c_ylw "⚠ Não consegui reiniciar o auth do Supabase com o modo de cadastro (#1653)."
  fi
  return 0
}

# Nome FÍSICO do volume que guarda as sessões do WAHA. `docker compose config
# --volumes` devolve o nome LÓGICO (`waha-data`); passá-lo direto a `docker run
# -v` cria/abre outro volume global com esse nome e produz um backup vazio que
# parece válido. Perguntar ao contêiner pela montagem real mantém o prefixo do
# projeto Compose (ex.: `deskcommcrm_waha-data`).
#
# A montagem também diz de QUE ESPÉCIE ela é, e `.Name` só responde por uma: num
# bind de pasta do host (`- /srv/waha:/app/.sessions`) ele vem VAZIO, e ficar só
# com ele devolve exatamente o volume fantasma que esta função existe para não
# usar. Volume nomeado → `.Name`; bind → `.Source`.
#
# Sem contêiner não há montagem para ler, e o nome sai de
# nome_do_projeto_atual, o mesmo que o compose usa: respeita COMPOSE_PROJECT_NAME
# e mantém o `-` de uma pasta como `deskcomm-crm`.
volume_waha_data() {
  local container campos tipo nome origem
  container="$(dc ps -a -q waha 2>/dev/null || true)"
  campos=""
  if [ -n "$container" ]; then
    campos="$(docker inspect "$container" \
      --format '{{range .Mounts}}{{if eq .Destination "/app/.sessions"}}{{.Type}}|{{.Name}}|{{.Source}}{{end}}{{end}}' \
      2>/dev/null || true)"
  fi
  tipo="${campos%%|*}"
  nome="${campos#*|}"; nome="${nome%%|*}"
  origem="${campos##*|*|}"
  case "$tipo" in
    volume) if [ -n "$nome" ]; then printf '%s' "$nome"; return 0; fi ;;
    bind)   if [ -n "$origem" ]; then printf '%s' "$origem"; return 0; fi ;;
  esac
  printf '%s' "$(nome_do_projeto_atual)_waha-data"
}

# O `.tgz` de um volume VAZIO tem ~87 bytes, uma entrada só (`.`) e o `tar` SAI
# COM ZERO. Quem decide se o snapshot presta é o CONTEÚDO, não o código de saída
# dele: contar as entradas além da raiz é o que separa um backup de verdade do
# volume errado — a diferença que só aparecia no dia do restore.
tar_tem_sessao() {  # tar_tem_sessao <arquivo.tgz>
  local itens
  itens="$(tar tzf "$1" 2>/dev/null | grep -cvxE '\./?$' || true)"
  [ "${itens:-0}" -gt 0 ]
}

# ── QUEM FALA COM O BANCO E PODE SER PARADO ──────────────────────────────────
#
# O `update.sh` aplica o `baseline.sql`, que APAGA e RECRIA cada regra de
# isolamento — é o único jeito portável, porque o Postgres não tem
# `create or replace policy`. Com tráfego vivo isso vira disputa de trava, e
# quando o CRIAR trava o APAGAR já valeu: a regra some, o banco passa a negar a
# leitura em silêncio, e a tela fica VAZIA sem um erro sequer.
#
# Medido numa instalação real, no mesmo dia e com o mesmo arquivo:
#   tudo de pé ................................ 113 travamentos
#   CRM parado ................................  60 travamentos
#   CRM + rest + realtime + studio parados ....   0 travamentos
#
# ⚠️ O realtime NÃO se chama `supabase-realtime`. Na instalação real o nome é
# `realtime-dev.supabase-realtime`, e um padrão ancorado em `^supabase-` deixa
# de pé justamente quem mais reage a mudança de estrutura. O ponto é escapado
# porque em expressão regular ele casaria com qualquer caractere.
#
# ⚠️ O banco e o auth ficam DE PÉ de propósito: é no banco que o DDL roda, e
# derrubar o auth deslogaria quem está na tela sem necessidade.
#
# ⚠️ Nada de varredura larga. Uma VPS hospeda outros sistemas (medido numa real:
# um CRM imobiliário e dois WordPress). A lista é explícita, e é só a nossa.
#
# Vazio quando o Supabase é HOSPEDADO — lá não há o que parar, e é por isso que
# a conferência das regras, que não depende de parar nada, é a peça portável.
supabase_local_containers() {
  # No single-server os nomes são os do projeto (sem container_name fixo): as
  # mesmas três peças, achadas pelo projeto e pelo serviço — nunca as de outro
  # Supabase que more na VPS.
  if [ "${SINGLE_SERVER:-0}" = "1" ]; then
    docker ps --filter "label=com.docker.compose.project=$(projeto_do_supabase)" \
      --format '{{.Names}} {{.Label "com.docker.compose.service"}}' 2>/dev/null \
      | awk '$2 == "rest" || $2 == "studio" || $2 == "realtime" { print $1 }' || true
    return 0
  fi
  docker ps --format '{{.Names}}' 2>/dev/null | grep -E \
    '^(supabase-rest|supabase-studio|realtime-dev\.supabase-realtime)$' || true
}

# ── O CICLO: PAUSAR ANTES DO BANCO, VOLTAR DEPOIS DE CONFERIR ────────────────
#
# Estas duas vivem aqui, e não dentro do `update.sh`, por um motivo prático: é
# aqui que dá para carregá-las num teste e provar o ciclo com um `docker` dublê,
# sem parar nada de verdade. O `update.sh` fica com o que é dele — a ordem dos
# passos e o `trap`.
#
# `PARADOS` guarda o que esta rodada derrubou, para saber o que levantar.
# `REGRAS_FALTANDO` é preenchida pela conferência e decide se o CRM volta.
PARADOS="${PARADOS:-}"
REGRAS_FALTANDO="${REGRAS_FALTANDO:-}"

# ── A IMAGEM DAQUELA VERSÃO EXISTE MESMO? ────────────────────────────────────
#
# MEDIDO em 2026-09-13, e quem viu foi o dono da instalação: a tela ofereceu a
# "Nova versão · 1.17.16" enquanto a imagem dela ainda estava sendo construída.
# O agente decidia olhando SÓ a etiqueta no Git, e nunca perguntava se havia o
# que baixar. Entre publicar a etiqueta e a imagem ficar pronta passam-se uns
# seis minutos.
#
# Antes da pausa dos serviços isso era um susto: a atualização avisava "a versão
# ainda está publicando, rode de novo em alguns minutos" e o sistema seguia no
# ar com a versão antiga, porque nada tinha sido parado. Agora o app é PARADO
# antes do banco e a volta usa o endereço da imagem NOVA — gravado antes de
# tentar baixá-la. Sem imagem, ele não volta. O susto virou queda.
#
# ⚠️ SÓ A IMAGEM DO APP. O worker e o scheduler têm `build:` ao lado do `image:`
# no compose, então o `up -d` os constrói localmente quando falta imagem — mais
# lento, mesmo resultado. O app não tem essa rede de segurança, e essa
# assimetria já está escrita no update.sh, onde as duas mensagens são
# diferentes de propósito.
#
# Ecoa: publicada | ausente | indisponivel
veredito_da_imagem_do_app() {  # veredito_da_imagem_do_app <versão alvo> <versão instalada>
  local alvo="${1:-}" instalada="${2:-}"
  [ -n "$alvo" ] || { printf 'indisponivel'; return 0; }
  if docker buildx imagetools inspect "${IMG_APP}:${alvo}" >/dev/null 2>&1; then
    printf 'publicada'; return 0
  fi
  # ⛔ A SONDA DE CONTROLE, e é ela que impede o conserto de virar defeito pior.
  #
  # Sem ela, uma VPS sem saída para o registro pararia de oferecer atualização
  # PARA SEMPRE, em silêncio — e ninguém liga o silêncio de uma tela a um
  # problema de rede. A versão INSTALADA é a sonda certa porque ela existe com
  # certeza: está rodando aqui. Se nem ela responde, o que está fora é o
  # registro, não a imagem.
  #
  # Instalação fora de release não tem versão instalada para sondar. Sem sonda
  # não dá para separar as duas causas, e a resposta certa é a que não tira nada
  # de ninguém: segue anunciando, como sempre foi.
  [ -n "$instalada" ] || { printf 'indisponivel'; return 0; }
  if docker buildx imagetools inspect "${IMG_APP}:${instalada}" >/dev/null 2>&1; then
    printf 'ausente'
  else
    printf 'indisponivel'
  fi
}

pausar_o_que_fala_com_o_banco() {
  PARADOS="$(supabase_local_containers)"
  c_ylw "$(t "Pausando o sistema para mexer no banco com segurança.")"
  dc stop app worker scheduler >/dev/null 2>&1 || true
  if [ -n "$PARADOS" ]; then
    # shellcheck disable=SC2086
    docker stop $PARADOS >/dev/null 2>&1 || true
  fi
}

# ── O BANCO RELIGA ASSIM QUE O BANCO TERMINA ─────────────────────────────────
#
# MEDIDO na instalacao real em 2026-09-13: as pecas pararam as 03:10:18 e o
# script so terminou as 03:13:09. QUASE TRES MINUTOS sem o Supabase — e nao
# por falha: por desenho. A pausa acontecia na etapa do banco e a volta so no
# gatilho de saida, depois de baixar imagem, recriar conteiner e esperar o
# healthcheck do app.
#
# Esses tres minutos existiam mesmo quando tudo dava certo, e ninguem os tinha
# medido porque o alvo era outro. Religar aqui e o caminho; o gatilho de saida
# continua existindo, mas como rede de seguranca.
#
# IDEMPOTENTE de proposito: o gatilho vai chamar de novo, e uma segunda
# chamada que reclamasse faria TODA atualizacao bem-sucedida terminar com um
# alarme falso.
religar_o_supabase() {
  if [ -n "${PARADOS:-}" ]; then
    # ── A VOLTA DEIXA DE SER MUDA ────────────────────────────────────────────
    #
    # MEDIDO em 2026-09-13, numa atualização real: a pausa funcionou, a
    # conferência rodou com tudo parado (92 de 92) e as três peças do Supabase
    # NÃO VOLTARAM. Ficaram paradas até alguém perceber — e a atualização já
    # tinha dito "concluída com sucesso".
    #
    # A causa daquela falha NÃO FOI DETERMINADA, e isso fica escrito como está:
    # a cadeia inteira, reproduzida na mesma VPS com dublês, funciona; e a
    # evidência se perdeu ao subir as peças, que era o certo a fazer com o
    # sistema fora do ar. O que não pode se repetir é o SILÊNCIO — a versão
    # anterior desta linha era `docker start ... >/dev/null 2>&1 || true`, que
    # não deixa rastro nenhum quando falha.
    local ainda_fora="" c
    # shellcheck disable=SC2086
    docker start $PARADOS >/dev/null 2>&1 || true
    for c in $PARADOS; do
      docker ps --format '{{.Names}}' 2>/dev/null | grep -qxF "$c" || ainda_fora="${ainda_fora}${ainda_fora:+ }${c}"
    done
    if [ -n "$ainda_fora" ]; then
      # Uma segunda tentativa antes de gritar: subir contêiner logo depois de
      # uma enxurrada de operações do Docker às vezes precisa de um instante.
      # shellcheck disable=SC2086
      docker start $ainda_fora >/dev/null 2>&1 || true
      sleep 3
      local resta="" d
      for d in $ainda_fora; do
        docker ps --format '{{.Names}}' 2>/dev/null | grep -qxF "$d" || resta="${resta}${resta:+ }${d}"
      done
      ainda_fora="$resta"
    fi
    if [ -n "$ainda_fora" ]; then
      c_red "$(t "⛔ PEÇAS DO BANCO NÃO VOLTARAM depois da atualização:")"
      for c in $ainda_fora; do c_red "   • $c"; done
      c_red "$(t "   Enquanto elas estiverem paradas, o CRM não consegue ler nem gravar.")"
      c_ylw "$(t "   Para subir à mão:  docker start {1}" "$ainda_fora")"
    fi
    PARADOS=""
  fi
}

restaurar_servicos() {
  # O código de SAÍDA da execução que está terminando, capturado antes de
  # qualquer coisa: é ele que o diagnóstico (#1955) relata como desfecho. Este
  # é o gatilho `trap restaurar_servicos EXIT INT TERM HUP` do update.sh — e é
  # também por ele que TODO run termina com diagnóstico persistido.
  local rc_da_execucao=$?
  religar_o_supabase
  # O rollback dos pins ANTES de qualquer subida (#1955, critério 4). É esta
  # linha que faz o `dc up -d` lá embaixo trazer a versão de ANTES: sem ela, o
  # ambiente e o `.env` seguem apontando para a imagem que falhou, e a "volta"
  # deixa os serviços em `Created`/`Exited`. No-op quando a atualização não
  # passou da troca de versão (ou quando terminou bem e o rollback foi
  # desarmado) — e também é no-op em qualquer outro script do kit, que não
  # arma nada.
  restaurar_versao_anterior
  # ⛔ O CRM NÃO VOLTA AO AR COM REGRA DE ISOLAMENTO FALTANDO.
  #
  # Um CRM fora do ar é um problema visível que alguém resolve em minutos. Um
  # CRM no ar sem regra de isolamento mostra tela VAZIA para todo mundo, sem um
  # erro sequer, e é indistinguível de "não há nada aqui" — foi exatamente isso
  # que custou um dia inteiro nesta instalação, com o funil vazio e a
  # atualização dizendo "concluída com sucesso".
  if [ -n "${REGRAS_FALTANDO:-}" ]; then
    c_red "$(t "   O CRM segue PARADO de propósito. Resolva as regras antes de subir.")"
    # ⚠️ O aviso de manutenção NÃO desce aqui, de propósito. Com regra faltando o
    # CRM não volta, e a página é a única coisa que explica isso a quem tentar
    # abrir o sistema — melhor que um erro de conexão sem autor.
    diagnostico_de_atualizacao "$rc_da_execucao"
    return 0
  fi
  # O aviso desce ANTES de o CRM subir, e não depois. Com o Caddy do próprio kit
  # a página atende pelo apelido `app` na rede interna; com os dois de pé ao
  # mesmo tempo o Docker faria rodízio, e metade das pessoas veria "estamos
  # atualizando" com o CRM já no ar. A janela que isso abre dura o `docker rm`, e
  # nela aparece o mesmo erro que aparecia o tempo todo antes desta página.
  #
  # `declare -F` porque quem carrega o aviso é só o update.sh: install.sh e
  # agent.sh também sourceiam este arquivo e não têm o que derrubar.
  declare -F manutencao_desce >/dev/null 2>&1 && manutencao_desce
  dc up -d app worker scheduler >/dev/null 2>&1 || true
  # Por ÚLTIMO: assim o diagnóstico mostra o estado DEPOIS da volta, que é o
  # que interessa a quem for ler o arquivo depois (#1955, critério 5).
  diagnostico_de_atualizacao "$rc_da_execucao"
}

# ── Imagem pronta que não serve para esta VPS: constrói a versão aqui ────────
# Uma VPS cuja arquitetura não é a das imagens publicadas (Oracle Ampere, por
# exemplo) recebe "no matching manifest for linux/arm64/v8" ao puxá-las. O
# `up -d` seguinte morre junto: sem imagem no disco e sem `build:` ao lado do
# `image:` do app, o Compose não tem o que subir. O desfecho visível era o pior
# possível — a atualização não acontecia, o script terminava como se tivesse
# dado certo e o dono só descobria pelo CRM velho. Pelo botão "Atualizar" do
# site, nem isso: o agente roda sozinho no cron e não há ninguém lendo a tela.
#
# A saída já existe no repo e é o docker-compose.build.yml: `pull_policy: never`
# nas três imagens e o build saindo do MESMO commit que o `git checkout` deixou
# no disco. A imagem construída aqui é a versão alvo, não sobra de build antigo
# — e o `up` por este overlay também não volta ao registro para reclamar.
#
# O gatilho é o CÓDIGO DE SAÍDA de quem falhou, nunca o texto do erro:
# arquitetura da VPS, tag que ainda está publicando, pacote que nasceu privado
# no registro e registro fora do ar caem todos no mesmo caminho, sem depender de
# casar em inglês uma frase que o Docker escreve como quer.
construir_aqui_e_subir() {  # construir_aqui_e_subir [versão alvo] → 0 se subiu
  local versao="${1:-}"
  # A imagem construída aqui responde /api/v1/health com a versão de verdade —
  # o código no disco É a versão alvo. Sem isto ela responderia "local".
  [ -n "$versao" ] && export APP_VERSION="$versao"
  # O aviso vem ANTES da construção, e não depois: são 15 a 25 minutos de tela
  # parada, e sem ele o dono conclui que travou e mata o script no meio.
  c_ylw "$(t "⚠ As imagens prontas desta versão não servem para esta VPS.")"
  c_ylw "$(t "  O motivo mais comum é a arquitetura dela ser diferente da das imagens")"
  c_ylw "$(t "  publicadas: o registro responde que não tem manifest para a arquitetura")"
  c_ylw "$(t "  daqui. Não é problema da sua VPS nem do seu acesso.")"
  c_ylw "$(t "  Vou construir as três imagens aqui, do código desta versão.")"
  c_ylw "$(t "  Leva de 15 a 25 minutos e a tela fica sem novidade nesse tempo —")"
  c_ylw "$(t "  não é travamento, pode deixar rodando.")"
  if ! dc -f "$COMPOSE_BUILD" build; then
    c_red "$(t "✖ A construção das imagens aqui falhou (o erro está logo acima).")"
    return 1
  fi
  if ! dc -f "$COMPOSE_BUILD" up -d; then
    c_red "$(t "✖ As imagens foram construídas, mas os serviços não subiram.")"
    return 1
  fi
  return 0
}

# ── O que fazer quando o REGISTRO DE IMAGENS não responde (#1955) ───────────
#
# MEDIDO numa instalação real da HostGator, reproduzido duas vezes: durante um
# update pela tela o resolver do Docker saturou (`[resolver] more than 1024
# concurrent queries`, `dial udp 8.8.4.4:53: i/o timeout`), o `pull` e o
# `up -d` morreram, e o script caiu no fallback de CONSTRUÇÃO LOCAL — que
# gastou a memória inteira da VPS no `next-build` (OOM) e deixou app, worker,
# scheduler e proxy em `Created`/`Exited`. 502 para todo mundo até alguém
# reiniciar o Docker à mão.
#
# Três peças fecham a classe inteira, e elas são as que faltavam:
#
#   1. `preflight_atualizacao` — pergunta ao registro ANTES de parar qualquer
#      coisa. Falhou? `refuse` (RC 3): a versão atual segue no ar intocada.
#   2. `build_local_permitido` — construção local deixa de ser o que acontece
#      SOZINHO quando o registro não responde. Continua sendo o caminho de
#      quem quer de propósito (DESKCOMM_BUILD_LOCAL=1) e de quem tem registro
#      respondendo (a recuperação de arquitetura, #1060/#1143).
#   3. `restaurar_versao_anterior` + `diagnostico_de_atualizacao` — o rollback
#      dos pins de versão e o laço que garante diagnóstico no fim de TODO run.
#
# O prazo é a outra metade: sem ele o `docker ps` também trava (foi o que
# prendeu o healthcheck no passo "▶ Containers") e nenhum destes sinais chega
# a existir — o script simplesmente nunca termina.
com_prazo() {  # com_prazo <segundos> <comando...>
  local prazo="$1"; shift
  # `timeout` é do coreutils e está em todo Linux onde o kit roda; sem ele o
  # comportamento continua o antigo, não nasce um erro novo.
  if command -v timeout >/dev/null 2>&1; then
    timeout "$prazo" "$@"
  else
    "$@"
  fi
}

# As QUATRO imagens da release estão prontas no registro?
#
# O agente da tela anunciava "nova versão" olhando SÓ a etiqueta no Git e SÓ a
# imagem do app: um run de publicação que morresse no meio deixava a release
# anunciada com o worker (ou o scheduler, ou a voz) inexistente — e era o
# `up -d` de quem clicava em "Atualizar" que descobria.
#
# Ecoa: prontas | incompleta | indisponivel
#   prontas       → as quatro existem;
#   incompleta    → ALGUMA falta e o registro respondeu = publicação incompleta;
#   indisponivel  → NENHUMA respondeu = o registro/DNS está fora (ou a tag nem
#                   existe, o que para o chamador dá no mesmo: não se sabe).
veredito_das_imagens_da_release() {  # veredito_das_imagens_da_release <versão>
  local versao="${1:-}" img total=0 achadas=0
  versao="${versao#v}"
  [ -n "$versao" ] || { printf 'indisponivel'; return 0; }
  for img in "$IMG_APP" "$IMG_WORKER" "$IMG_SCHEDULER" "$IMG_VOICE_AGENT"; do
    total=$((total + 1))
    if com_prazo 20 docker buildx imagetools inspect "${img}:${versao}" >/dev/null 2>&1; then
      achadas=$((achadas + 1))
    fi
  done
  if [ "$achadas" -eq "$total" ]; then
    printf 'prontas'
  elif [ "$achadas" -eq 0 ]; then
    printf 'indisponivel'
  else
    printf 'incompleta'
  fi
}

# O preflight: dá para atualizar sem derrubar o que está no ar?
# → 0 = pode seguir; 1 = NÃO pode, com o motivo na stdout.
#
# Este é o critério 3 da issue: preflight falho mantém a versão ATUAL no ar.
# Por isso ele roda antes do backup, antes do `git checkout` e antes de
# qualquer `docker stop` — o `refuse` devolve RC 3, que o agent.sh lê como
# "esta atualização nunca começou" e não tenta desfazer nada.
preflight_atualizacao() {  # preflight_atualizacao <versão alvo>
  local versao="${1:-}" veredito
  versao="${versao#v}"
  if ! com_prazo 30 docker info >/dev/null 2>&1; then
    printf '%s' "o Docker não respondeu em 30s (daemon parado ou travado — veja 'systemctl status docker' e 'journalctl -u docker -n 100')."
    return 1
  fi
  # Quem pediu construção local de propósito não depende do registro: é a
  # saída de escape que o próprio portão do build ensina, e recusá-la aqui a
  # anularia justamente com o registro fora.
  build_local_pedido && return 0
  # Sem o plugin buildx a sonda abaixo falha nas quatro imagens, e o motivo
  # sairia como "registro fora (DNS/rede)" — diagnóstico errado, e o dono iria
  # mexer na rede de uma VPS cuja rede está boa.
  if ! com_prazo 20 docker buildx version >/dev/null 2>&1; then
    printf '%s' "o plugin buildx do Docker não está instalado nesta VPS, e é com ele que confiro se a versão $versao está publicada. Instale o pacote docker-buildx-plugin. Nada foi parado nem baixado."
    return 1
  fi
  veredito="$(veredito_das_imagens_da_release "$versao")"
  case "$veredito" in
    prontas) return 0 ;;
    incompleta)
      printf '%s' "a versão $versao está INCOMPLETA no registro: uma ou mais das quatro imagens (app, worker, scheduler, voz) ainda não existe — o run de publicação não terminou. Nada foi parado nem baixado."
      return 1 ;;
    *)
      printf '%s' "não consegui falar com o registro de imagens (DNS/rede) para a versão $versao. Nada foi parado nem baixado: a versão atual segue no ar."
      return 1 ;;
  esac
}

# A construção local continua sendo o caminho de quem TEM registro respondendo
# (é a recuperação de arquitetura, #1060/#1143 — ela não pode sumir) e de quem
# pede de propósito. O que ela deixou de ser é AUTOMÁTICA quando quem falhou é
# o registro: foi exatamente isso que transformou um apagão de DNS em OOM no
# `next-build` e a instalação em 502 (#1955, critério 2).
#
# → 0 = pode construir aqui.
build_local_pedido() {  # → 0 quando quem opera pediu construção local de propósito
  case "${DESKCOMM_BUILD_LOCAL:-}" in 1|sim|s|yes) return 0 ;; esac
  return 1
}

build_local_permitido() {  # build_local_permitido <versão alvo>
  build_local_pedido && return 0
  case "${DESKCOMM_BUILD_LOCAL:-}" in
    0|nao|não|no) return 1 ;;  # quem opera proibiu de propósito
  esac
  [ "$(veredito_das_imagens_da_release "${1:-}")" != "indisponivel" ]
}

# Os serviços que deveriam estar de pé depois do `up -d` (#1955, critério 6).
# Ecoa, um por linha, os que NÃO estão rodando. Vazio = "não sei".
#
# "Não sei" NUNCA vira rollback: derrubar uma instalação que está de pé por
# causa de um `ps` que falhou seria o defeito de antes, só que invertido. Só
# se devolve a versão anterior quando há UM SERVIÇO POSITIVAMENTE fora do ar.
servicos_fora_do_ar() {
  local esperados="app worker scheduler" saida svc estado conhecidos=0 rodando=" " fora=""
  case "${REVERSE_PROXY:-caddy}" in traefik|npm) ;; *) esperados="$esperados caddy" ;; esac
  # shellcheck disable=SC2046
  # Com prazo pelo mesmo motivo do healthcheck: um `ps` preso no resolver
  # saturado prenderia aqui o fim da atualização. Estourou = "não sei".
  saida="$(com_prazo 30 docker compose $(dc_files) ps -a --format '{{.Service}} {{.State}}' 2>/dev/null)" || return 0
  [ -n "$saida" ] || return 0
  while read -r svc estado; do
    [ -n "${svc:-}" ] || continue
    # CONHECER o estado e estar RODANDO são perguntas diferentes: `exited` e
    # `created` provam que o `ps` respondeu (então a lista vale), mas são
    # justamente o serviço fora do ar que esta conferência existe para pegar.
    case "$estado" in
      running|Up*)
        conhecidos=$((conhecidos + 1))
        rodando="${rodando}${svc} " ;;
      exited|created|paused|restarting|dead|removing|Exit*)
        conhecidos=$((conhecidos + 1)) ;;
    esac
  done <<EOF
$saida
EOF
  [ "$conhecidos" -gt 0 ] || return 0
  for svc in $esperados; do
    case "$rodando" in *" $svc "*) ;; *) fora="${fora}${fora:+ }${svc}" ;; esac
  done
  printf '%s' "$fora"
}

# ── O rollback dos pins de versão (#1955, critério 4) ───────────────────────
#
# `gravar_imagens` troca os OITO pins de versão do `.env` ANTES de baixar
# qualquer coisa, e o `update.sh` exporta as quatro imagens por cima. Daí em
# diante, TODO `docker compose up -d` usa o endereço da versão NOVA — inclusive
# o da volta, o do gatilho de saída e o do `up -d` manual que o dono roda
# depois. Se a nova imagem não existe (registro fora, publicação incompleta),
# a "volta" deixa os serviços em `Created`: era o desfecho da issue.
#
# O snapshot é a cópia fiel dos pins ANTES da troca; a restauração reescreve o
# arquivo E reexporta as variáveis, porque o compose prefere o ambiente ao
# `.env` — restaurar só o arquivo seria rollback no papel, com o ambiente ainda
# apontando para a versão que falhou.
CHAVES_DE_VERSAO="APP_IMAGE APP_PULL_POLICY WORKER_IMAGE WORKER_PULL_POLICY SCHEDULER_IMAGE SCHEDULER_PULL_POLICY VOICE_AGENT_IMAGE VOICE_AGENT_PULL_POLICY"
SNAPSHOT_DE_VERSAO=".deskcomm-env-antes-do-update"

armar_rollback_de_versao() {  # armar_rollback_de_versao <envfile>
  local envfile="${1:-}" snap tmp
  [ -f "$envfile" ] || return 0
  # `${envfile%/*}` não corta nada num caminho sem barra (`.env` relativo, que
  # é como o update.sh chama), e o snapshot caeria DENTRO de um arquivo.
  case "$envfile" in
    */*) snap="${envfile%/*}/${SNAPSHOT_DE_VERSAO}" ;;
    *)   snap="./${SNAPSHOT_DE_VERSAO}" ;;
  esac
  tmp="${snap}.tmp.$$"
  # Só as chaves que EXISTEM agora: uma chave ausente é omissão de uma
  # instalação antiga, e a restauração tem de voltar a deixá-la ausente.
  grep -E "^($(printf '%s' "$CHAVES_DE_VERSAO" | tr ' ' '|'))=" "$envfile" > "$tmp" 2>/dev/null || true
  mv "$tmp" "$snap" 2>/dev/null || return 0
  ROLLBACK_ENV_SNAPSHOT="$snap"
  ROLLBACK_ENV_ARQUIVO="$envfile"
  return 0
}

# Desarma sem apagar o arquivo: ele é a prova do estado anterior, e a próxima
# execução o sobrescreve. Chamado no único ponto em que a atualização PROVOU
# ter terminado (app saudável e serviços de pé).
desarmar_rollback_de_versao() {
  ROLLBACK_ENV_SNAPSHOT=""
  return 0
}

restaurar_versao_anterior() {  # → 0 sempre (rollback que falha não mata a volta)
  [ -n "${ROLLBACK_ENV_SNAPSHOT:-}" ] || return 0
  [ -f "${ROLLBACK_ENV_SNAPSHOT:-}" ] || { ROLLBACK_ENV_SNAPSHOT=""; return 0; }
  local envfile="${ROLLBACK_ENV_ARQUIVO:-}" tmp k v re
  [ -n "$envfile" ] && [ -f "$envfile" ] || return 0
  re="^($(printf '%s' "$CHAVES_DE_VERSAO" | tr ' ' '|'))="
  tmp="${envfile}.rollback.$$"
  grep -vE "$re" "$envfile" > "$tmp" 2>/dev/null || true
  cat "$ROLLBACK_ENV_SNAPSHOT" >> "$tmp" 2>/dev/null || true
  # O modo do `.env` (600) sobrevive ao `mv`: trocar de inode sem herdá-lo
  # deixaria os segredos legíveis por outro usuário da VPS.
  chmod --reference="$envfile" "$tmp" 2>/dev/null || chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$envfile" 2>/dev/null || return 0
  # E as variáveis EXPORTADAS voltam junto — sem isto o rollback é só papel.
  for k in $CHAVES_DE_VERSAO; do
    v="$(sed -n "s/^${k}=//p" "$envfile" 2>/dev/null | tail -1)"
    if [ -n "$v" ]; then
      export "$k=$v" 2>/dev/null || true
    else
      unset "$k" 2>/dev/null || true
    fi
  done
  ROLLBACK_ENV_SNAPSHOT=""
  UPDATE_ROLLBACK="pins restaurados para a versão anterior"
  return 0
}

# ── O diagnóstico que TODO run deixa para trás (#1955, critério 5) ──────────
#
# Escrito por um gatilho no TOPO do update.sh (cobre os caminhos que morrem
# antes do banco) e por `restaurar_servicos` daí para baixo — os dois escrevem
# no MESMO arquivo. Sem ele, a única evidência de um update que morreu era a
# cauda do log que o agente guarda, e o apagão de resolver descrito na issue
# não deixava rastro nenhum de POR QUÊ.
#
# Silencioso de propósito: sai no arquivo, nunca na stdout (um "✓" a mais na
# tela de quem está operando é ruído, e ruído ensina a ignorar a saída).
# Tudo com `|| true` — este código roda dentro de gatilho de saída, onde
# falhar é pior do que não dizer.
diagnostico_de_atualizacao() {
  local rc="${1:-$?}" arq="${DIAGNOSTICO_ARQUIVO:-}" status
  [ -n "$arq" ] || return 0
  status="${UPDATE_STATUS:-em andamento}"
  if [ "$rc" -ne 0 ] && [ "$status" = "em andamento" ]; then
    status="FALHA (a execução saiu pelo caminho de erro)"
  elif [ "$rc" -eq 0 ] && [ "$status" = "em andamento" ]; then
    status="concluído"
  fi
  {
    printf '══ diagnóstico da atualização do DeskcommCRM ══\n'
    printf 'quando:     %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null || date)"
    printf 'diretório:  %s\n' "${PROJECT_DIR:-$PWD}"
    printf 'status:     %s\n' "$status"
    printf 'código:     %s\n' "$rc"
    printf 'etapa:      %s\n' "${UPDATE_ETAPA:-desconhecida}"
    printf 'alvo:       %s\n' "${TARGET_TAG:-—}"
    printf 'instalada:  %s\n' "${CURRENT_TAG:-—}"
    printf 'rollback:   %s\n' "${UPDATE_ROLLBACK:-não precisou (a atualização não passou da troca de versão)}"
    printf 'containers:\n'
    # shellcheck disable=SC2046
    # Com prazo: este bloco roda no gatilho de SAÍDA, inclusive quando o
    # preflight recusou porque o Docker não respondeu — sem prazo, o `ps`
    # travaria ali e a atualização nunca terminaria.
    com_prazo 30 docker compose $(dc_files) ps -a 2>/dev/null || printf '  (o Docker não respondeu em 30s)\n'
    printf '\n'
  } >> "$arq" 2>/dev/null || true
  return 0
}

# ── A rede externa por onde o proxy de fora alcança o app ────────────────────
# O nome que o docker compose dá ao projeto quando ninguém passa -p: basename do
# diretório, minúsculo, só [a-z0-9_-] — E com os `_`/`-` do INÍCIO aparados
# (NormalizeProjectName faz TrimLeft). Sem essa aparada, uma pasta como
# `/root/_deskcomm` faz o kit calcular `_deskcomm` enquanto os contêineres
# carregam `deskcomm`: a instalação deixa de se reconhecer e passa a se tratar
# como intrusa. Medido contra o docker compose v2.38.2 em `_deskcomm`,
# `-deskcomm`, `_-_crm` e `_123` — todos divergiam.
nome_do_projeto_compose() {  # nome_do_projeto_compose <diretório>
  local n
  n="$(basename "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  printf '%s' "${n#"${n%%[!_-]*}"}"
}

nome_do_projeto_atual() {
  printf '%s' "${COMPOSE_PROJECT_NAME:-$(nome_do_projeto_compose "${PROJECT_DIR:-$PWD}")}"
}

# ── Quem é o DONO deste projeto Docker ───────────────────────────────────────
#
# Duas cópias do repo na mesma VPS — o clone de produção e um de teste ao lado —
# recebem o MESMO nome de projeto compose: o docker o deriva do basename do
# diretório, e `/root/DeskcommCRM` e `/root/apagar6/DeskcommCRM` dão os dois
# `deskcommcrm`. Os contêineres são UM conjunto só; os `.env` são dois. Cada
# `up -d` recria o parque com as credenciais da SUA árvore, e a outra fica
# falando com um transporte que não a reconhece mais.
#
# Não é hipótese. Numa VPS real o clone de teste recriou o contêiner do WhatsApp
# com a chave dele às 13:30; o app foi recriado da árvore de produção às 14:47,
# com outra chave; e por TRÊS DIAS toda chamada ao WAHA respondeu 401 — nenhum
# número conectava, nenhuma mensagem entrava, e o painel só dizia "não foi
# possível verificar a conexão".
#
# O `flock` do agent.sh não protege disso: ele é por DIRETÓRIO, então as duas
# árvores pegam locks diferentes enquanto disputam os mesmos contêineres. A
# trava tem de ser pelo que elas de fato compartilham — o projeto Docker.
#
# O sinal é o próprio Docker: todo contêiner criado pelo compose carrega o label
# `com.docker.compose.project.working_dir` com a árvore que o criou.
donos_do_projeto_em_execucao() {  # → um diretório por linha, sem repetir
  docker ps -a \
    --filter "label=com.docker.compose.project=$(nome_do_projeto_atual)" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null \
    | grep -v '^$' | sort -u
}

# Imprime as árvores ALHEIAS que ainda são instalações VIVAS; sai 0 quando existe
# ao menos uma. Sem contêiner no ar não há dono, e uma instalação nova assume
# legitimamente — por isso o silêncio aqui é "pode seguir", não "não sei".
#
# "Viva" é o filtro que impede este guarda de nascer vermelho em quem não fez
# nada de errado: quem MOVEU a instalação de pasta deixa contêineres apontando
# para um caminho que não existe mais. Esse não é um rival disputando o parque —
# é o endereço antigo desta mesma instalação, e recusar ali travaria as
# atualizações para sempre, num log que ninguém lê. Só conta como rival a árvore
# que ainda está no disco COM um compose: aquela de onde um segundo cron
# realmente consegue rodar `up -d`.
projeto_pertence_a_outra_arvore() {
  local dir vivas=""
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    [ "$dir" != "${PROJECT_DIR:-$PWD}" ] || continue
    [ -f "$dir/$COMPOSE" ] || continue
    vivas="${vivas}${vivas:+$'\n'}${dir}"
  done <<EOF
$(donos_do_projeto_em_execucao)
EOF
  [ -n "$vivas" ] || return 1
  printf '%s' "$vivas"
}

# O guarda que o agent.sh e o update.sh chamam antes de tocar em contêiner.
#
# Falha FECHADA na ação (não mexe em parque alheio) e ABERTA na informação: diz
# qual árvore é a dona e como assumir de propósito. Parar calado deixaria o dono
# da VPS achando que o agente atualiza, quando ele desiste a cada 5 minutos.
#
# `DESKCOMM_ASSUMIR_PROJETO=1` é a saída para o caso legítimo — a instalação
# mudou de pasta e os contêineres ainda apontam para a antiga. É explícita de
# propósito: assumir por engano é justamente o defeito que esta função existe
# para impedir.
recusar_projeto_de_outra_arvore() {  # recusar_projeto_de_outra_arvore <como reportar>
  local alheias reportar="${1:-}"
  alheias="$(projeto_pertence_a_outra_arvore)" || return 0
  [ "${DESKCOMM_ASSUMIR_PROJETO:-}" != "1" ] || return 0

  local recado
  recado="os contêineres do projeto '$(nome_do_projeto_atual)' foram criados por outra cópia do repo ($(printf '%s' "$alheias" | tr '\n' ' ')) — esta aqui é $(printf '%s' "${PROJECT_DIR:-$PWD}"). Duas cópias com o mesmo nome de projeto disputam os MESMOS contêineres e cada uma os recria com o .env dela, o que derruba as conexões de WhatsApp e quebra as credenciais. Deixe apenas UMA no cron (crontab -e) ou, se esta é mesmo a instalação boa, rode com DESKCOMM_ASSUMIR_PROJETO=1"
  if [ -n "$reportar" ] && command -v "$reportar" >/dev/null 2>&1; then
    "$reportar" "$recado"
  else
    printf '%s\n' "$recado" >&2
  fi
  return 1
}

# A bridge que ESTE projeto reserva para o proxy externo. Um `basename` cru
# diverge numa pasta com maiúscula, ponto ou underscore inicial — e aí o kit
# cria uma rede e o compose procura outra.
rede_reservada_do_proxy() { printf '%s_proxy' "$(nome_do_projeto_atual)"; }

# O compose declara TRAEFIK_NETWORK como rede EXTERNA, e rede externa que não
# existe é recusada ANTES de o compose criar qualquer coisa — medido com o
# compose v2.38.2: `up -d` morre em "network X declared as external, but could
# not be found", sem dizer de onde saiu o nome. Descobrir isso aqui, com o nome na
# mão, é dezenas de minutos de diferença para quem está instalando. Valor escrito
# à mão no .env passa pelo mesmo crivo: erra tão fácil quanto a detecção.
#
# A rede que o instalador reserva para si é o caso em que não existir é NORMAL —
# instalação nova, ou alguém que rodou `docker network prune`. Aí a resposta é
# criar, não morrer: o nome é nosso e sabemos a forma dele.
# Ecoa: ok | criar | inexistente | driver_errado
veredito_rede_do_proxy() {  # veredito_rede_do_proxy <driver encontrado> <rede> <bridge do projeto> [attachable]
  local drv="${1:-}" rede="${2:-}" nossa="${3:-}"
  if [ -z "$drv" ]; then
    [ -n "$nossa" ] && [ "$rede" = "$nossa" ] && { printf 'criar'; return 0; }
    printf 'inexistente'; return 0
  fi
  [ "$drv" = bridge ] && { printf 'ok'; return 0; }
  # $4 = "true" quando a rede é uma overlay attachable (Swarm). Contêiner de
  # compose comum entra numa dessas, então ela serve tão bem quanto uma bridge.
  # Sem o attachable a recusa continua: ali o `up` morreria em
  # "could not attach to network".
  [ "$drv" = overlay ] && [ "${4:-}" = true ] && { printf 'ok'; return 0; }
  printf 'driver_errado'
}

# Aplica o veredito acima: confere no Docker, cria a nossa quando falta, morre
# explicando quando é de outro. Mora aqui — e não no install.sh — porque o
# `dc up -d` do update.sh corre exatamente o mesmo risco: a bridge é um artefato
# como qualquer outro e some num `docker network prune`, ou no `down -v` que o
# próprio kit ensina como caminho de recomeço. Sem esta checagem a atualização
# morre com a mesma mensagem opaca do compose, e pior: o agent.sh roda o
# update.sh sozinho a cada 5 minutos, então ninguém está olhando a tela.
# Define TRAEFIK_NETWORK quando ela vem vazia — de propósito, é o mesmo default
# que o instalador grava no .env.
garantir_rede_do_proxy() {
  # NPM nunca é criado por nós: a rede é sempre do stack do Proxy Manager (ou de
  # quem hospeda), então não há "nossa" bridge para oferecer — só checar e, se
  # sumiu (prune, down -v), morrer explicando em vez do opaco erro do compose.
  if [ "${REVERSE_PROXY:-caddy}" = "npm" ]; then
    local rede
    rede="${PROXY_NETWORK_NAME:-proxy_network}"
    docker network inspect "$rede" >/dev/null 2>&1 && return 0
    die "$(t "A rede Docker '{1}' (a do Nginx Proxy Manager) não existe.
Rode 'docker network ls', identifique a rede do seu NPM (Settings > a que o
contêiner dele já está conectado) e ponha PROXY_NETWORK_NAME=<nome> no .env
antes de tentar de novo." "$rede")"
  fi
  [ "${REVERSE_PROXY:-caddy}" = "traefik" ] || return 0
  local nossa drv erro
  nossa="$(rede_reservada_do_proxy)"
  TRAEFIK_NETWORK="${TRAEFIK_NETWORK:-traefik}"
  drv="$(docker network inspect -f '{{.Driver}}' "$TRAEFIK_NETWORK" 2>/dev/null || true)"
  local att
  att="$(docker network inspect -f '{{.Attachable}}' "$TRAEFIK_NETWORK" 2>/dev/null || true)"
  case "$(veredito_rede_do_proxy "$drv" "$TRAEFIK_NETWORK" "$nossa" "$att")" in
  ok) : ;;
  criar)
    # O motivo vai junto porque aqui NÃO se sabe qual é: o comando está certo, e
    # quem recusou foi o Docker (falta de faixa de IP livre numa VPS com muitas
    # stacks é um caso conhecido). Sem repassar a resposta dele, a mensagem
    # mandaria repetir à mão o comando que acabou de falhar.
    if ! erro="$(docker network create "$TRAEFIK_NETWORK" 2>&1 >/dev/null)"; then
      die "$(t "Não consegui criar a rede Docker '{1}'. O Docker respondeu:
  {2}" "$TRAEFIK_NETWORK" "$erro")"
    fi
    c_dim "$(t '  (rede '"'"'{1}'"'"' criada — é por ela que o Traefik alcança o CRM)' "$TRAEFIK_NETWORK")"
    ;;
  inexistente)
    die "$(t "A rede Docker '{1}' não existe.
Rode 'docker network ls', identifique a rede do seu Traefik e ponha
TRAEFIK_NETWORK=<nome> no .env antes de tentar de novo." "$TRAEFIK_NETWORK")"
    ;;
  driver_errado)
    # Mandar quem está em modo host "procurar a rede do seu Traefik" é mandar
    # procurar o que não existe: em modo host ele não está em rede nenhuma do
    # Docker. Para esse caso a saída é apagar a linha e deixar o kit decidir —
    # ele cria a bridge do projeto sozinho.
    die "$(t "A rede '{1}' tem driver '{2}', e o app precisa
de uma bridge para o Traefik alcançar o contêiner. Se o seu Traefik roda em modo
host (é o caso quando 'docker ps' não mostra porta publicada nele), APAGUE a linha
TRAEFIK_NETWORK do .env: o kit cria e usa a rede '{3}'.
Senão, rode 'docker network ls' e ponha a bridge certa em TRAEFIK_NETWORK no .env.
Se for uma overlay do Swarm, ela precisa ter sido criada com --attachable —
sem isso um contêiner de compose comum não consegue entrar nela." "$TRAEFIK_NETWORK" "$drv" "$nossa")"
    ;;
  esac
}

# Cor só quando há terminal de verdade — mesma regra do install.sh (se mexer
# numa, mexa na outra). Aqui isso vale dobrado: o update.sh, que herda estas
# funções, é rodado pelo agent.sh com a saída redirecionada para arquivo
# (`> "$LOG"`) a cada 5 minutos, para sempre, em toda instalação. Era daí que
# vinha o escape ANSI que o esc() do agent.sh precisa varrer byte a byte antes
# de mandar o log no heartbeat; não emitir na origem é a correção de causa.
if   [ -n "${NO_COLOR:-}" ];    then COLOR=0
elif [ -n "${FORCE_COLOR:-}" ]; then COLOR=1
elif [ -t 1 ];                  then COLOR=1
else                                 COLOR=0
fi
paint() { local code="$1"; shift; if [ "$COLOR" = 1 ]; then printf '\033[%sm%s\033[0m\n' "$code" "$*"; else printf '%s\n' "$*"; fi; }
c_red() { paint 31 "$*"; }
c_grn() { paint 32 "$*"; }
c_ylw() { paint 33 "$*"; }
c_dim() { paint 2  "$*"; }
die()   { c_red "✖ $*"; exit 1; }
step()  { printf '\n'; paint 1 "▶ $*"; UPDATE_ETAPA="$*"; }

# Gêmea da de install.sh (se mexer numa, mexa na outra) — ver o comentário lá
# para o defeito que ela fecha. Coberta por test-validators.sh.
resposta_sim() {
  local r
  r="$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  case "$r" in s|sim|si|sí|sÍ|y|yes) return 0;; *) return 1;; esac
}

# Saúde do app pela rota que ele responde de verdade, não pela porta. A porta
# 3000 aceita conexão assim que o Node sobe — ANTES de o app saber se alcança
# banco, Redis e WhatsApp. Era exatamente a diferença entre o install.sh, que
# testava a porta e imprimia "Instalação concluída!" mesmo sem resposta, e o
# update.sh, que só declara sucesso com "status":"ok". Um critério, um lugar.
# Devolve DUAS linhas: o status GERAL na primeira, o corpo inteiro na segunda.
#
# A separação existe porque procurar '"status":"ok"' no JSON cru é errado, e
# erra em silêncio: `ok` é o vocabulário dos CHECKS individuais
# (ok|degraded|down), enquanto o status geral usa outro (healthy|degraded|
# unhealthy). Medido contra o app real: um `grep '"status":"ok"'` casa com o
# `checks.redis`, então um app com o BANCO FORA — status geral "unhealthy" —
# passava como saudável, desde que qualquer outro check estivesse de pé. Quem
# decide é o app, no Node que já está sendo invocado; o shell não repete a
# regra dele.
app_health_probe() {
  dc exec -T app node -e \
    "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.json()).then(j=>{console.log((j&&j.data&&j.data.status)||'sem_status');console.log(JSON.stringify(j))}).catch(()=>process.exit(1))" \
    2>/dev/null || echo ''
}

# wait_app_healthy [tentativas] [intervalo_s] — 0 quando o app se declara
# `healthy` ou `degraded`, 1 caso contrário. `degraded` entra de propósito:
# significa que algum serviço OPCIONAL ainda não foi configurado (o check
# devolve degraded/not_configured), e recusar a instalação por isso reprovaria
# um CRM que está de pé e atendendo. `unhealthy` é outra história — quer dizer
# check DOWN, e aí o app não serve. Ecoa o corpo lido, para quem chama poder
# mostrar o motivo em vez de só dizer que não deu.
wait_app_healthy() {
  local tentativas="${1:-20}" intervalo="${2:-3}" saida='' status='' corpo='' i=0
  while [ "$i" -lt "$tentativas" ]; do
    saida="$(app_health_probe)"
    status="$(printf '%s\n' "$saida" | head -1 | tr -d '\r')"
    corpo="$(printf '%s\n' "$saida" | tail -n +2)"
    case "$status" in
      healthy|degraded) printf '%s' "$corpo"; return 0;;
    esac
    i=$((i+1))
    [ "$i" -lt "$tentativas" ] && sleep "$intervalo"
  done
  printf '%s' "$corpo"
  return 1
}

# Código de saída de quem RECUSOU antes de tocar em qualquer coisa — distinto
# de "falhei no meio" (1). O agent.sh usa isso para não desfazer uma
# atualização que nunca começou: reiniciar o container e reescrever o .env
# "voltando" de uma mudança que não houve é estrago inventado do nada.
REFUSED_RC=3
refuse() { c_red "✖ $*"; exit "$REFUSED_RC"; }

# Instalar <ref> seria voltar no tempo? 0 = sim (já está contido no HEAD),
# 1 = não, 2 = NÃO SEI. "Não sei" nunca vira "pode".
#
# O install.sh clona com `--depth 1`, e num repositório raso o
# `merge-base --is-ancestor` responde 1 (não-ancestral) para QUALQUER coisa
# fora do único commit baixado — inclusive para uma tag velha que, na história
# real, está muito atrás. Ou seja: a resposta que libera é exatamente a que o
# raso dá de graça, e `git fetch --tags` não desfaz o raso (conferido: depois
# do fetch, is-shallow-repository continua true). Por isso completamos a
# história ANTES de perguntar, e, se não der, devolvemos 2 — o chamador
# recusa. Falhar fechado é o certo num script que roda como root na máquina de
# quem não sabe consertar.
is_already_in_head() {
  local ref="$1"
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" = "true" ]; then
    git fetch --unshallow --tags --quiet origin 2>/dev/null || true
  fi
  case "$(git rev-parse --is-shallow-repository 2>/dev/null || echo unknown)" in
    false) : ;;
    *) return 2 ;;   # ainda raso, ou nem é repositório git: não dá pra saber
  esac
  git merge-base --is-ancestor "$ref" HEAD 2>/dev/null && return 0
  return 1
}

# Carrega o .env lendo cada linha como DADO, sem `source`.
#
# O `. ./.env` interpretava o arquivo como script, e aí qualquer valor de texto
# livre virava código: `APP_NAME=Loja do João` fazia o shell tentar executar
# `do`; uma senha com `#` era truncada no que parecia comentário; uma com `$`
# era expandida e chegava corrompida. Como TODO script do kit passa por aqui,
# um nome de empresa com espaço — ou seja, quase todos — derrubava reset-mfa,
# reset-password, backup, restore e healthcheck. Justamente as ferramentas de
# emergência, que só são usadas quando já deu problema.
#
# Aceita valores com ou sem aspas: instalações antigas (sem aspas) passam a
# funcionar sem precisar reescrever o .env.
load_env() {
  local file="${1:-.env}" line key val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue;; esac
    case "$line" in *=*) ;; *) continue;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in ''|*[!A-Za-z0-9_]*) continue;; esac
    case "$val" in
      \"*\")
        val="${val:1:${#val}-2}"
        # Tirar as aspas não desfaz o escape que o envq pôs lá dentro. Sem estas
        # quatro trocas, `Loja P$ss` volta da releitura como `Loja P\$ss` — o
        # valor chega adulterado e o erro só aparece longe daqui (medido).
        #
        # O sentinela \001 existe pela ORDEM: um `\\` desfeito para `\` de cara
        # seria reprocessado pelas trocas seguintes, e `\\$` (barra literal
        # seguida de cifrão) viraria `$`. Guardando o par escapado num byte que
        # não ocorre em .env, as trocas de `\"`, `\$` e crase não o enxergam, e
        # ele só volta a ser barra no fim.
        val="${val//\\\\/$'\001'}"
        val="${val//\\\"/\"}"
        val="${val//\\\$/\$}"
        val="${val//\\\`/\`}"
        val="${val//$'\001'/\\}"
        ;;
      \'*\')
        # RETROCOMPATIBILIDADE — não remova. Até 2026-08 o envq gravava com
        # aspas simples, e atualizar NÃO reescreve o .env: o update.sh só troca
        # APP_IMAGE e APP_PULL_POLICY (:159 e :165, via set_env_var) e deixa as
        # outras chaves exatamente como o install antigo as escreveu. Quem
        # apagar este ramo devolve senha e connection string de toda instalação
        # velha com quatro caracteres a mais, já na primeira atualização.
        val="${val:1:${#val}-2}"
        # O envq daquela época escrevia a aspa simples do CONTEÚDO como '\''
        # (fecha o literal, escapa a aspa, reabre). Tirar as aspas de fora não
        # desfaz isso: sem esta troca, uma senha com aspa volta da releitura com
        # quatro caracteres a mais, e o erro só aparece longe daqui (o psql
        # recusa a conexão, o login não bate) sem nada apontando para o .env.
        # Achado pelo teste de round-trip.
        val="${val//"'\\''"/"'"}"
        ;;
    esac
    printf -v "$key" '%s' "$val"
    export "${key?}"
  done < "$file"
}

# Vai pro diretório do projeto (onde está o compose) e carrega o .env.
enter_project() {
  if [ -f "$COMPOSE" ]; then :;
  elif [ -f "deskcommcrm/$COMPOSE" ]; then cd deskcommcrm;
  else die "$(t "Não achei {1}. Rode a partir da pasta do projeto." "$COMPOSE")"; fi
  [ -f .env ] || die "$(t "Falta o .env (rode install.sh primeiro).")"
  load_env .env
  if [ -z "${WAHA_IMAGE:-}" ]; then
    WAHA_IMAGE="$(imagem_waha_padrao_para_host)"
    export WAHA_IMAGE
  fi
  PROJECT_DIR="$(pwd)"
}

# ── As DUAS conexões: a do app e a do schema ─────────────────────────────────
# `SUPABASE_DB_URL` tinha dois papéis numa string só: ela vai para o `.env` dos
# contêineres (o app fala com o banco por ela) E era a mesma que rodava
# `create extension`, o `baseline.sql` e a promoção do dono.
#
# Na nuvem isso não dói — a string do pooler já vem privilegiada. Num Supabase
# PRÓPRIO dói na primeira instalação: o baseline exige o dono do banco, o app
# quer a role menor (é o que `docs/deploy-selfhost/README.md` §2 recomenda), e a
# única saída era editar o `.env` na mão entre uma etapa e outra (issue #192).
#
# Daqui em diante: quem mexe no schema (e quem faz backup/restore, que precisam
# ler tudo) passa por esta função; o `.env` continua recebendo só a do app.
# `SUPABASE_DB_ADMIN_URL` ausente OU vazia cai na de sempre — quem já instalou
# não muda de comportamento.
#
# É FUNÇÃO, e não uma atribuição no topo deste arquivo, porque o `_common.sh` é
# *sourced* ANTES do `load_env` nos dois scripts (install.sh e update.sh), e ele
# abre com `set -euo pipefail`: uma linha `X="${SUPABASE_DB_ADMIN_URL:-$SUPABASE_DB_URL}"`
# aqui morre em "variável não associada" e leva o kit inteiro junto (medido: a
# suíte de shell inteira foi a EXIT=1 com 0 casos executados). E com guarda
# (`${SUPABASE_DB_URL:-}`) seria pior: o valor CONGELA vazio e todo sítio de DDL
# passa a rodar `psql ""`. A resolução tem de acontecer na hora do uso.
#
# `:?` e não `:-`: sem NENHUMA das duas, o certo é parar com uma frase que diz o
# que fazer, não seguir para um `psql ""` que erra longe da causa. O limite é
# honesto — isto roda em substituição de comando, e um subshell não derruba o
# pai; o que a mensagem garante é que a causa apareça na tela antes do erro de
# conexão que os chamadores já tratam.
url_do_schema() {
  printf '%s' "${SUPABASE_DB_ADMIN_URL:-${SUPABASE_DB_URL:?sem connection string de banco no .env — rode o install.sh}}"
}

# psql efêmero via container (não exige psql no host). Usa a conexão de schema:
# os chamadores mexem em `auth.mfa_factors` e `private.app_secrets`, fora do
# alcance de uma role de app com grants só em `public`.
psql_run() { pg_container -i postgres:17-alpine psql "$(url_do_schema)" -v ON_ERROR_STOP=1 "$@"; }

# ── O teste TLS do kit (#829) ────────────────────────────────────────────────
#
# A issue quer duas metades, e esta é a segunda: com a CA declarada o teste
# PASSA com verificação LIGADA; sem ela, o diagnóstico diz qual variável falta.
#
# `sslmode` no query string vence o ambiente (libpq), então dá para exigir
# `verify-full` reescrevendo a string SÓ no teste — a conexão normal do kit
# segue a string original, inalterada. `sslrootcert` precisa do caminho DENTRO
# do contêiner, que é o fixo do pg_container (CA_NO_CONTAINER).
url_tls_verificada() {  # url_tls_verificada <connection string> → string com verificação total
  local url="${1:?url_tls_verificada sem connection string}"
  case "$url" in
    *sslmode=*) url="$(printf '%s' "$url" | sed 's/sslmode=[A-Za-z0-9_-]*/sslmode=verify-full/g')" ;;
    *) case "$url" in *\?*) url="${url}&sslmode=verify-full" ;; *) url="${url}?sslmode=verify-full" ;; esac ;;
  esac
  case "$url" in
    *sslrootcert=*) url="$(printf '%s' "$url" | sed "s|sslrootcert=[^&]*|sslrootcert=${CA_NO_CONTAINER}|g")" ;;
    *) url="${url}&sslrootcert=${CA_NO_CONTAINER}" ;;
  esac
  printf '%s' "$url"
}

# Roda um `select 1` com verificação TOTAL de cadeia e hostname. Vazio no
# sucesso; ao falhar, explica — e quando a causa é a CA ausente, a frase vem
# com o nome da variável (ca_do_supabase), nunca só o erro cru do libpq.
tls_do_banco() {
  local caminho=""
  if [ -z "${SUPABASE_DB_ADMIN_URL:-}${SUPABASE_DB_URL:-}" ]; then
    printf '%s' "Sem SUPABASE_DB_URL no .env não há connection string para testar — rode o install.sh."
    return 1
  fi
  if ! caminho="$(ca_do_supabase 2>&1)"; then
    printf '%s' "$caminho"
    return 1
  fi
  pg_container postgres:17-alpine psql "$(url_tls_verificada "$(url_do_schema)")" -tAc 'select 1' >/dev/null
}

# ── Re-aplicar o baseline num banco que JÁ existe ────────────────────────────
# Chamado pelo `update.sh` e pelo `install.sh` re-executado. Sem `ON_ERROR_STOP`,
# de propósito: com a flag, o primeiro "já existe" de um clone antigo pararia o
# arquivo, e o apêndice com as migrations novas nunca chegaria.
#
# O preço é que o psql segue depois de QUALQUER erro, inclusive dos que não vêm
# do arquivo. Medido numa VPS real, na v1.27.3: com o app atendendo, dois
# comandos perderam um `deadlock detected`, e um deles era o `create policy` logo
# depois do `drop policy` da mesma policy — `ai_knowledge_sources` ficou sem a
# policy de leitura até alguém refazer o bloco à mão. O aviso saiu na tela, no
# meio das três linhas de ruído das atualizações daquela VPS (v1.27.2 e v1.27.3).
#
# O arquivo é idempotente (o job `invariants` o re-aplica com ON_ERROR_STOP=1),
# então a cura de uma disputa é aplicá-lo de novo, inteiro. O veredito é o da
# ÚLTIMA passada: o comando que perdeu na primeira rodou outra vez na seguinte,
# e é o estado dela que fica no banco. Só re-aplica por erro de disputa ou de
# conexão — a que cai no meio e a que nem chega a abrir. Erro de permissão ou de
# dado se repetiria igual, só mais tarde. Medido contra um Postgres 17 real:
# deadlock (psql sai 0), `pg_terminate_backend`, restart do servidor e
# "too many clients" (psql sai 2) — todos curados na 2ª passada.
#
# O limite da cura, e por que cada nova passada imprime o que não aplicou: um
# comando que COPIA dado guardado por uma checagem de catálogo, e que perde a
# disputa enquanto o comando seguinte (o que destrói a origem) passa, não tem o
# que copiar na passada seguinte — ela sai limpa e o dado não veio. O ✓ depois
# de uma disputa nunca é mudo: cada nova passada lista na tela as linhas que não
# aplicaram (as de disputa primeiro, até 10, dizendo quantas ficaram de fora) e,
# quando quem chama passa um log, a saída inteira de cada passada vai para ele.
#
# Nada de `| grep -q` nem `| head` aqui: com `pipefail`, o leitor que sai cedo
# mata o `printf` com SIGPIPE quando a saída passa do buffer do pipe (os milhares
# de "must be owner" de uma role sem dono passam), e o pipeline inteiro vira
# falha — medido: a disputa deixava de ser reconhecida. `grep` sem `-q`, `sed`
# e `awk` leem até o fim; o `grep -q` que sobra lê de here-string, e se ela
# falhar a função devolve 1 (aviso), nunca 0.
#
#   reaplicar_baseline <baseline.sql> [log]
#     0 → a última passada não teve erro fora dos benignos
#     1 → teve; as linhas ficam em BASELINE_INESPERADO
#   BASELINE_PASSADAS diz quantas passadas foram feitas.
#   O log, quando dado, recebe a saída de TODAS as passadas, cada uma com cabeçalho.
#   BASELINE_TENTATIVAS (padrão 3) e BASELINE_ESPERA_S (padrão 10, vezes o número
#   da passada) existem para a suíte de shell não esperar de verdade.
BASELINE_ERROS_BENIGNOS='already exists|multiple primary keys|multiple default values|is already a member|already a partition'
BASELINE_ERROS_DE_DISPUTA='deadlock detected|could not serialize access|lock timeout|could not obtain lock|terminating connection|server closed the connection|connection to server was lost|SSL connection has been closed unexpectedly|SSL SYSCALL error|remaining connection slots|too many clients|max client(s| connections) reached|the database system is (starting up|shutting down|in recovery mode|not yet accepting connections)|Temporary failure in name resolution|Connection refused|Connection timed out|timeout expired|Network (is )?unreachable'
# listar_erros_do_banco <linhas> <máximo> [recuo]: as de disputa ou conexão primeiro
# — são as que explicam uma nova passada, e numa lista de milhares de "must be
# owner" ficariam fora do corte —, depois o resto, dizendo quantas ficaram de fora.
listar_erros_do_banco() {
  local linhas="$1" maximo="$2" recuo="${3:-}" total
  total="$(printf '%s\n' "$linhas" | grep -c . || true)"
  # `awk` com -v, e não `sed "s/^/$recuo/"`: assim o recuo e o máximo entram como
  # DADO. Uma barra no recuo quebraria o programa do sed, e `maximo=0` viraria o
  # endereço inválido `1,0` — os dois derrubariam o script sob set -e.
  { printf '%s\n' "$linhas" | grep -iE "$BASELINE_ERROS_DE_DISPUTA" || true
    printf '%s\n' "$linhas" | grep -viE "$BASELINE_ERROS_DE_DISPUTA" || true
  } | awk -v r="$recuo" -v n="$maximo" 'NF && ++i <= n { print r $0 }'
  [ "${total:-0}" -le "$maximo" ] || printf '%s(e mais %s linhas)\n' "$recuo" "$((total - maximo))"
}

reaplicar_baseline() {
  local arquivo="$1" log="${2:-}" tentativas="${BASELINE_TENTATIVAS:-3}" espera="${BASELINE_ESPERA_S:-10}"
  local raw rc causa
  BASELINE_PASSADAS=1
  [ -z "$log" ] || : > "$log"
  while :; do
    rc=0
    raw="$(pg_container -i -v "$arquivo:/b.sql:ro" postgres:17-alpine \
          psql "$(url_do_schema)" -q -f /b.sql 2>&1)" || rc=$?
    [ -z "$log" ] || printf '── passada %s de %s (saída %s) ──\n%s\n' "$BASELINE_PASSADAS" "$tentativas" "$rc" "$raw" >> "$log"
    BASELINE_INESPERADO="$(printf '%s\n' "$raw" | grep -iE 'ERROR|FATAL' | grep -viE "$BASELINE_ERROS_BENIGNOS" || true)"
    # Sem ON_ERROR_STOP o psql sai 0 mesmo com erro de SQL: saída diferente de
    # zero é o psql (ou o docker) que NÃO chegou ao fim do arquivo. Sem isto, uma
    # conexão que cai no meio sem imprimir a palavra ERROR terminaria em
    # "✓ banco atualizado" com metade do arquivo aplicada. A causa citada é a
    # última linha que não é continuação indentada — a última de todas costuma ser
    # a dica "Is the server running…", e não o motivo.
    if [ "$rc" -ne 0 ]; then
      causa="$(printf '%s\n' "$raw" | awk 'NF && !/^[[:space:]]/ { l = $0 } END { print l }')"
      BASELINE_INESPERADO="$(printf '%s\n' "$BASELINE_INESPERADO" \
        "a aplicação não chegou ao fim do arquivo (o psql saiu com código $rc): $causa" | sed '/^$/d')"
    fi
    if [ -z "$BASELINE_INESPERADO" ]; then
      # Fechou: em qual passada, e quantas retentativas custou até aqui.
      registrar_rodada_do_banco "$([ "$BASELINE_PASSADAS" -gt 1 ] && printf 1 || printf 0)" \
        "$((BASELINE_PASSADAS - 1))" "$BASELINE_PASSADAS"
      return 0
    fi
    if [ "$BASELINE_PASSADAS" -ge "$tentativas" ]; then
      # Esgotou as passadas SEM fechar o banco. Não se registra nada: as frases
      # da tela são todas escritas como "…até a atualização do banco fechar", e
      # esta rodada não fechou — gravar aqui faria a tela afirmar um fechamento
      # que não houve, na rodada em que ela mais precisa calar. (Antes, este
      # ponto gravava os MESMOS três números do sucesso, e os dois desfechos
      # ficavam indistinguíveis no registro.) O desfecho da rodada vive no log
      # do kit e no `status` do run.
      return 1
    fi
    if ! grep -qiE "$BASELINE_ERROS_DE_DISPUTA" <<<"$BASELINE_INESPERADO"; then
      # Erro que retentativa não cura — e a rodada NÃO fechou. O `0 0 1` que
      # este ponto gravava era literal, não medido: se a passada 1 teve disputa
      # de lock e a passada 2 morreu num erro fatal, ele afirmava "primeira
      # passada, sem disputa" em cima de duas coisas que ninguém mediu. Silêncio.
      return 1
    fi
    c_ylw "$(t "• parte do banco não aplicou (disputa com o app no ar ou conexão instável) — aplicando de novo, é seguro (passada {1} de {2}). O que não aplicou:" "$((BASELINE_PASSADAS + 1))" "$tentativas")"
    listar_erros_do_banco "$BASELINE_INESPERADO" 10 "    "
    sleep "$((espera * BASELINE_PASSADAS))"
    BASELINE_PASSADAS=$((BASELINE_PASSADAS + 1))
  done
}

# ---------------------------------------------------------------------------
# O que a rodada do banco conta de si mesma.
#
# Achado do PR #997: o baseline reaplicado sobrevive a uma disputa com o sistema
# no ar — o kit tenta de novo e fecha. Até aqui essa parte da história morria no
# log do servidor: quem clicou via "terminou" sem saber que a base estava
# ocupada, nem quanto custou. Estas duas funções passam a rodada ADIANTE, por um
# arquivo simples, porque o kit e o reporte do agente são passos separados.
# ---------------------------------------------------------------------------
# O caminho pode vir do processo que chamou (agent.sh exporta antes de rodar o
# update.sh): o kit e o reporte são processos diferentes, e os dois precisam
# apontar para o MESMO arquivo — é ele que carrega a história da rodada.
RODADA_DO_BANCO_ARQUIVO="${RODADA_DO_BANCO_ARQUIVO:-${TMPDIR:-/tmp}/deskcomm-rodada-do-banco.$$}"

registrar_rodada_do_banco() {
  # $1 disputa (1|0), $2 retentativas, $3 passada em que fechou.
  printf 'disputa=%s\nretentativas=%s\npassada=%s\n' "$1" "$2" "$3" \
    >"$RODADA_DO_BANCO_ARQUIVO" 2>/dev/null || true
}

ler_rodada_do_banco() {
  # Sem medição, silêncio: nada é impresso e o campo chega ausente — a tela
  # ignora. Número impossível (negativo, fracionado, passada 0) também é
  # silêncio, nunca uma afirmação torta.
  [ -s "$RODADA_DO_BANCO_ARQUIVO" ] || return 0
  local disputa retentativas passada
  disputa="$(sed -n 's/^disputa=//p' "$RODADA_DO_BANCO_ARQUIVO" | tail -1)"
  retentativas="$(sed -n 's/^retentativas=//p' "$RODADA_DO_BANCO_ARQUIVO" | tail -1)"
  passada="$(sed -n 's/^passada=//p' "$RODADA_DO_BANCO_ARQUIVO" | tail -1)"
  case "$disputa" in 0|1) ;; *) return 0 ;; esac
  case "$retentativas" in ''|*[!0-9]*) return 0 ;; esac
  case "$passada" in ''|*[!0-9]*) return 0 ;; esac
  [ "$passada" -ge 1 ] || return 0
  # As três chaves saem PLANAS e com os nomes da rota (`disputa_de_banco`,
  # `retentativas_do_banco`, `passada_do_banco`), prontas para entrarem no corpo
  # do `run_result`: é o contrato de `app/api/v1/system/agent/route.ts`. O
  # arquivo desta função fala a língua do kit; a fronteira fala a da API — e
  # era aqui que as duas se confundiam, com o `z.object` da rota descartando em
  # SILÊNCIO o objeto aninhado e gravando as três colunas nulas em toda rodada.
  printf '"disputa_de_banco":%s,"retentativas_do_banco":%s,"passada_do_banco":%s\n' \
    "$([ "$disputa" = "1" ] && printf true || printf false)" "$retentativas" "$passada"
}

# ── As três imagens que NÓS publicamos ───────────────────────────────────────
# O namespace é constante e literal de propósito: ele está gravado no .env de
# toda instalação viva, e derivá-lo de variável faria o kit antigo (que já está
# no disco do cliente) e o novo montarem strings diferentes.
#
# Esta linha é a ÚNICA fonte do namespace para tudo que executa — os testes do
# kit a leem em vez de repetir a string. Quem a confere é
# `tests/unit/namespace-das-imagens.test.ts`, que assere este valor e cobra que
# `docker-compose.prod.yml`, `.env.hostgator.example` e a matriz de
# `publish-image.yml` digam o mesmo. Se você é um fork, é lá que está a lista do
# que trocar junto — e, desde 18/09/2026, o CI do SEU fork não cobra este valor:
# a asserção só vale quando o dono do runner é o dono deste repositório.
IMG_NS="ghcr.io/melgarafael"
IMG_APP="${IMG_NS}/deskcommcrm"
IMG_WORKER="${IMG_NS}/deskcomm-worker"
IMG_SCHEDULER="${IMG_NS}/deskcomm-scheduler"
# Telefonia por SIP (#677): só roda com `telefonia` em COMPOSE_PROFILES, mas é
# imagem NOSSA e segue a mesma versão das outras três (gravar_imagens).
IMG_VOICE_AGENT="${IMG_NS}/deskcomm-voice-agent"

# A última versão publicada (ex.: "1.2.1"), ou vazio se não deu para saber.
#
# Consulta o REMOTO, não o clone: o install.sh clona com `--depth 1`, que não
# traz tag nenhuma, então `git tag -l` local devolveria vazio e a instalação
# nasceria em `latest` sem ninguém perceber — que é justamente o defeito que
# esta função existe para consertar.
#
# Falha ABERTA de propósito: sem rede, sem git ou sem tag no remoto ela devolve
# vazio e quem chama cai no canal móvel, como era antes. Travar a instalação de
# alguém porque não deu para resolver um número de versão seria trocar um
# problema de previsibilidade por um de disponibilidade.
ultima_versao_publicada() {
  local url="${1:-https://github.com/melgarafael/DeskcommCRM.git}" ref
  command -v git >/dev/null 2>&1 || return 0
  # `grep -v -- -` descarta PRERELEASE (v1.11.0-rc1, v1.1.1-jmpo.1 — esta última
  # existe de verdade neste repo). O `--sort=-v:refname` do git põe o prerelease
  # ACIMA do release final quando `versionsort.suffix` não está configurado, e
  # uma instalação nova nasceria num release candidate sem ninguém pedir.
  ref="$(git ls-remote --tags --refs --sort=-v:refname "$url" 'v*' 2>/dev/null \
        | awk '{print $2}' | grep -v -- '-' | head -1)" || return 0
  [ -n "$ref" ] || return 0
  printf '%s' "${ref#refs/tags/v}"
}

# Código HTTP do manifest de uma referência nossa no GHCR, anonimamente.
#   200 = existe e é pública | 404 = não existe | 403 = pacote PRIVADO | 000 = sem rede
#
# 403 é o caso que mais engana: pacote recém-criado no GHCR nasce privado, e
# repositório público não muda isso. Enquanto ninguém trocar a visibilidade na
# mão, o `docker compose pull` de toda VPS é negado — e como `pull` de serviço
# com `image:` falha a operação inteira, a instalação morre no passo de subir.
#
# ⚠️ O DONO E O REGISTRO SAEM DO `IMG_NS`, NUNCA DE UM LITERAL. Achado por
# @galeonel no PR #605: as duas URLs abaixo tinham `melgarafael` cravado. Num
# fork que troca o `IMG_NS`, isso faz o pré-voo conferir os pacotes do UPSTREAM
# enquanto `gravar_imagens` escreve no `.env` do cliente as referências do FORK
# — a sonda mede um caminho e o usuário usa outro, que é a falha-em-verde do
# passe 5 da triagem.
#
# E o literal escapava da catraca por acidente: `namespace-das-imagens.test.ts`
# procura a string contígua `ghcr.io/melgarafael`, e a URL do token a parte em
# `ghcr.io/token?scope=repository:melgarafael/`.
ghcr_status() {
  local img="$1" tag="$2" tok registry owner
  registry="${IMG_NS%%/*}"
  owner="${IMG_NS#*/}"
  tok="$(curl -fsS --max-time 6 \
          "https://${registry}/token?scope=repository:${owner}/${img}:pull&service=${registry}" 2>/dev/null \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || true
  if [ -z "$tok" ]; then printf '000'; return 0; fi
  curl -s -o /dev/null --max-time 6 -w '%{http_code}' \
    -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
    "https://${registry}/v2/${owner}/${img}/manifests/${tag}" 2>/dev/null || printf '000'
}

# As TRÊS imagens existem e são públicas nesta referência?
#
# Perguntar pelas três juntas, e não só pela do app, é o ponto: `deskcomm-worker`
# e `deskcomm-scheduler` nasceram depois das releases que já existem, então
# `deskcomm-worker:1.2.1` nunca vai existir — a v1.2.1 é passado. Pinar as três
# numa versão sem conferir gravaria no .env do cliente duas referências
# impossíveis, e o kit as construiria na VPS **em silêncio**, do topo da main:
# app de uma release + worker/scheduler de outro código. Exatamente a mistura de
# versões que a doutrina existe para proibir, no caminho de primeira impressão.
# O nome ficou de quando eram três; hoje são quatro, e a lista acompanha a
# matriz de publish-image.yml — quem cobra é
# tests/unit/listas-de-imagens-seguem-matriz.test.ts. Renomear a função
# quebraria o leitor daquele teste sem ganhar nada: o que importa é a lista.
trio_publicado() {
  local tag="$1" i
  for i in deskcommcrm deskcomm-worker deskcomm-scheduler deskcomm-voice-agent; do
    [ "$(ghcr_status "$i" "$tag")" = "200" ] || return 1
  done
  return 0
}

# O .env está com pin PELA METADE? (app fixado numa versão, worker/scheduler não)
#
# Este é o estado que a transição produz e que nada denuncia. Medido em ensaio e
# depois na produção: quem executa a primeira atualização é o `update.sh` que já
# estava no disco — o antigo —, e ele só sabe gravar `APP_IMAGE`. O worker cai no
# default do compose (`:stable`, um canal MÓVEL) e o script termina dizendo
# "Atualização concluída — app no ar e saudável", sem uma palavra sobre isso.
#
# Por que importa: na release seguinte o `stable` se move, e um `up -d` qualquer
# — com `pull_policy: always`, que é o default de tag móvel — levaria o worker
# sozinho para a versão nova enquanto o app permanece na antiga. Mistura de
# versões que acontece sem ninguém pedir, e é o que o invariante 3 proíbe.
#
# Ecoa os serviços sem pin, separados por espaço. Vazio = está tudo certo.
valor_do_env() {  # valor_do_env <arquivo> <chave>   (sem aspas ao redor)
  # O `|| true` não é decorativo: o `_common.sh` roda sob `set -euo pipefail`, e
  # um `grep` que não casa sai 1 — o que, sem isto, mataria a função inteira
  # justamente no caso que interessa (a chave AUSENTE). Custou dois casos verdes
  # de mentira num teste antes de aparecer.
  { grep -E "^$2=" "$1" 2>/dev/null || true; } | head -1 | cut -d= -f2- | sed "s/^['\"]//; s/['\"]\$//"
}

tag_da_imagem() {  # tag_da_imagem <referência>  → a tag, ou vazio se não houver
  local ref="${1##*/}"
  case "$ref" in *:*) printf '%s' "${ref##*:}" ;; *) printf '' ;; esac
}

pin_incompleto() {  # pin_incompleto [caminho do .env]
  local envfile="${1:-.env}" app_ref app_tag faltando="" par chave svc img tag
  [ -f "$envfile" ] || return 0

  # Sem APP_IMAGE pinado não há "metade" nenhuma — é outra situação (instalação
  # que nunca rodou update, ou que escolheu um canal de propósito).
  app_ref="$(valor_do_env "$envfile" APP_IMAGE)"
  [ -n "$app_ref" ] || return 0
  app_tag="$(tag_da_imagem "$app_ref")"
  case "$app_tag" in latest|main|stable|"") return 0 ;; esac

  for par in "WORKER_IMAGE:worker" "SCHEDULER_IMAGE:scheduler"; do
    chave="${par%%:*}"; svc="${par##*:}"
    img="$(valor_do_env "$envfile" "$chave")"
    if [ -z "$img" ]; then
      faltando="$faltando $svc"                    # ausente: segue o default do compose
    else
      tag="$(tag_da_imagem "$img")"
      case "$tag" in latest|main|stable|"") faltando="$faltando $svc" ;; esac
    fi
  done
  printf '%s' "${faltando# }"
}

# Completa o pin AUSENTE no .env, com a versão que a imagem EM EXECUÇÃO declara.
#
# A regra que torna isto seguro: **só preenche lacuna, nunca sobrescreve valor
# explícito.** Chave ausente é omissão do `update.sh` antigo; chave presente é
# decisão de quem opera — inclusive a decisão de seguir um canal móvel de
# propósito. Um cron que corrigisse escolha alheia seria pior que o defeito.
#
# E a versão gravada é a que o contêiner JÁ está rodando (label
# `org.opencontainers.image.version` da imagem em uso), não a do app. A diferença
# importa: se o worker estiver numa versão diferente do app, gravar a do app
# MUDARIA o que roda no próximo `up -d` — possivelmente um downgrade. Gravando o
# que já está lá, a operação é congelamento puro: nada muda de comportamento
# agora, e o próximo `update.sh` alinha as três.
#
# Ecoa os serviços corrigidos, separados por espaço. Vazio = nada a fazer.
completar_pin_ausente() {  # completar_pin_ausente [envfile]
  local envfile="${1:-.env}" par chave svc repo img ver corrigidos=""
  [ -f "$envfile" ] || return 0
  # Esta guarda vale para execução não-root e não custa nada. NÃO é ela que
  # protege o caso real: o cron roda como root, e root ignora `chmod`. Quem
  # protege é a atomicidade do `set_env_var` (escreve num `.tmp` e faz `mv`) —
  # medido com `chattr +i`, que barra até root: a escrita falha, a função sai 0
  # e o `.env` original chega intacto do outro lado, com as customizações.
  [ -w "$envfile" ] || return 0

  for par in "WORKER_IMAGE:worker:deskcomm-worker" "SCHEDULER_IMAGE:scheduler:deskcomm-scheduler"; do
    chave="${par%%:*}"; svc="$(printf '%s' "$par" | cut -d: -f2)"; repo="${par##*:}"

    # LACUNA apenas. Valor explícito (mesmo em canal móvel) é intocável.
    if { grep -qE "^${chave}=" "$envfile" 2>/dev/null; }; then continue; fi

    img="$(docker inspect "$(nome_do_projeto_atual)-${svc}-1" --format '{{.Config.Image}}' 2>/dev/null)" || img=""
    [ -n "$img" ] || continue
    ver="$(docker image inspect "$img" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null)" || ver=""
    # `<no value>` = imagem sem o label (build local). Canal não é versão.
    case "$ver" in ""|"<no value>"|latest|main|stable) continue ;; esac

    set_env_var "$envfile" "$chave" "${IMG_NS}/${repo}:${ver}"
    set_env_var "$envfile" "${chave%_IMAGE}_PULL_POLICY" missing
    corrigidos="$corrigidos $svc"
  done
  printf '%s' "${corrigidos# }"
}

# Escreve no .env as três imagens da MESMA versão + o pull_policy que combina
# com a mutabilidade da tag.
#
# As três juntas porque elas sobem juntas: app numa versão e worker em `latest`
# é a matriz de compatibilidade que ninguém testou. E o pull_policy não é
# detalhe — foi medido que, com `always` e o registry sem responder para aquela
# referência, o `up -d` FALHA e o contêiner não sobe, mesmo com a imagem já no
# disco. Numa tag imutável isso não protege de nada e só amarra a subida do CRM
# do cliente à disponibilidade do GHCR.
#
#   gravar_imagens .env 1.2.1   → pinado,  pull_policy=missing
#   gravar_imagens .env latest  → canal,   pull_policy=always
gravar_imagens() {
  local envfile="$1" versao="$2" politica
  case "$versao" in
    latest|main|stable) politica="always" ;;
    *)                  politica="missing" ;;
  esac
  set_env_var "$envfile" APP_IMAGE             "${IMG_APP}:${versao}"
  set_env_var "$envfile" APP_PULL_POLICY       "$politica"
  set_env_var "$envfile" WORKER_IMAGE          "${IMG_WORKER}:${versao}"
  set_env_var "$envfile" WORKER_PULL_POLICY    "$politica"
  set_env_var "$envfile" SCHEDULER_IMAGE       "${IMG_SCHEDULER}:${versao}"
  set_env_var "$envfile" SCHEDULER_PULL_POLICY "$politica"
  # A quarta imagem só é puxada com o profile `telefonia` ligado — compose não
  # puxa serviço de profile inativo. Gravá-la sempre é o que garante que, no
  # dia em que o dono ligar a telefonia, ela suba na MESMA versão do resto, e
  # não no `stable` móvel do default do compose.
  set_env_var "$envfile" VOICE_AGENT_IMAGE       "${IMG_VOICE_AGENT}:${versao}"
  set_env_var "$envfile" VOICE_AGENT_PULL_POLICY "$politica"
  # O WAHA de quem já roda em ARM mora AQUI, e não numa linha do update.sh: é
  # esta função que o update.sh ANTIGO chama depois de reler o kit, então é
  # assim que a troca chega já na atualização que a traz. O export vale porque
  # o compose prefere a variável do ambiente (que o enter_project exportou com o
  # valor velho) à do .env.
  local waha_atual
  waha_atual="$(sed -n 's/^WAHA_IMAGE=//p' "$envfile" 2>/dev/null | tail -1 | tr -d "\"'")"
  if waha_amd64_conhecido_em_arm "$(uname -m 2>/dev/null || true)" "$waha_atual"; then
    WAHA_IMAGE="$(imagem_waha_padrao_para_host)"
    export WAHA_IMAGE
    set_env_var "$envfile" WAHA_IMAGE "$WAHA_IMAGE"
    c_ylw "$(t "  (WAHA trocado para a variante oficial ARM64: {1})" "$WAHA_IMAGE")"
  fi
}

# ── Os segredos da chamada de voz, no .env de quem já tinha instalado ────────
#
# A doutrina de packaging é literal: "bump de versão não pode exigir que o
# operador edite `.env`, compose ou qualquer arquivo à mão". A chamada de voz
# (spec 18) trouxe três chaves novas, e o serviço NÃO SOBE sem duas delas.
#
# Quem instalou antes desta versão não as tem. Sem esta função, o dia em que ele
# quisesse ligar a voz começaria por inventar dois segredos num editor de texto
# dentro de uma VPS — que é exatamente o passo que a doutrina proíbe.
#
# LACUNA APENAS, como `completar_pin_ausente`: chave já presente (mesmo vazia
# por escolha de quem operou) é intocável. Preencher só o que falta é a
# diferença entre curar e sobrescrever.
#
# ⚠️ ISTO NÃO LIGA A FEATURE. As chaves geradas ficam paradas até alguém pôr
# `voz` em COMPOSE_PROFILES: sem o profile, o compose nem cria o contêiner.
# Gerar credencial para um serviço desligado não é risco — é o que faz o
# desligado poder virar ligado sem passo manual.
completar_segredos_da_voz() {  # completar_segredos_da_voz [envfile]
  local envfile="${1:-.env}" criados="" chave
  [ -f "$envfile" ] || return 0
  # Somente-leitura (montagem read-only, permissão errada): não é erro daqui.
  [ -w "$envfile" ] || return 0

  for chave in WACALLS_ADMIN_USER WACALLS_ADMIN_PASSWORD WACALLS_API_TOKEN; do
    # `^CHAVE=` casa inclusive a linha com valor vazio — que é presença, não
    # lacuna. Só a AUSÊNCIA da linha é preenchida.
    grep -qE "^${chave}=" "$envfile" && continue
    if [ "$chave" = "WACALLS_ADMIN_USER" ]; then
      set_env_var "$envfile" "$chave" "deskcomm"
    else
      set_env_var "$envfile" "$chave" "$(openssl rand -hex 32)"
    fi
    criados="$criados $chave"
  done

  printf '%s' "${criados# }"
}

# Grava (ou reescreve) uma chave no .env — sem duplicar linha se ela já existe.
#   set_env_var .env APP_IMAGE ghcr.io/…:1.1.0
#
# É o que faz uma escolha SOBREVIVER ao processo que a fez. `export APP_IMAGE=…`
# vale só enquanto o script roda: o docker-compose.prod.yml lê a imagem do .env,
# então um `docker compose up -d` rodado à mão pelo dono semanas depois (comando
# documentado no README) voltaria pro APP_IMAGE gravado no install (":latest") e
# DESFARIA a atualização — app do topo da main sobre o banco da versão
# instalada, exatamente o modo de falha pelo qual o Watchtower foi descartado.
set_env_var() {
  local envfile="$1" key="$2" value="$3" tmp
  [ -f "$envfile" ] || return 0
  tmp="${envfile}.tmp.$$"
  # "|| true": com pipefail, grep -v que filtra TODAS as linhas (arquivo de uma
  # linha só) sai 1 e derrubaria o script por set -e antes do append.
  { grep -vE "^${key}=" "$envfile" || true; } > "$tmp"
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"   # o .env tem segredos: o tmp nasce com o mesmo rigor
  mv "$tmp" "$envfile"
}

# Resolve o UUID de um usuário pelo e-mail (admin API do Supabase).
#
# ── O `filter` do GoTrue é BUSCA POR SUBSTRING, não expressão ────────────────
# Esta função pedia `?filter=email.eq.<email>` — sintaxe do PostgREST, que o
# GoTrue não fala. Ele trata a string inteira como termo de busca, nenhum e-mail
# contém "email.eq.", e a resposta é SEMPRE vazia. Medido em 2026-08-31 contra o
# projeto de produção, com um e-mail que existe:
#
#   GET /auth/v1/admin/users?filter=email.eq.<existente>  → 200 {"users":[]}
#   GET /auth/v1/admin/users?filter=<existente>           → 200 {"users":[<ele>]}
#
# Consequência: `reset-password.sh` morria com "Usuário '<email>' não
# encontrado" para TODO e-mail — o único caminho de recuperação de senha de uma
# instalação sem SMTP, que é o estado normal de um self-host, e o mesmo comando
# que o CLAUDE.md do kit manda usar quando a pessoa se tranca fora.
#
# ── Por que o casamento tem de ser EXATO aqui ────────────────────────────────
# Justamente por ser substring, `ana@empresa.com` casa também
# `mariana@empresa.com`. Um `head -1` cego devolveria o UUID da outra pessoa
# numa função cujo único consumidor TROCA SENHA. O padrão abaixo ancora no
# prefixo do objeto de usuário (id→aud→role→email, nessa ordem), que nenhum
# objeto aninhado de `identities` tem — e exige o e-mail inteiro, com os pontos
# escapados (em BRE `.` casa qualquer caractere, e sem escapar
# `elias.gervanno@x` casaria `eliasXgervanno@x`).
#
# Falha FECHADA: se o GoTrue mudar a ordem dos campos, o padrão não casa e a
# função devolve vazio — quem chama morre com "não encontrado", que é ruim mas
# recuperável. Devolver o UUID errado, não.
#
# ── Por que o `|| return 0` do fim não é enfeite ────────────────────────────
# `_common.sh` roda sob `set -euo pipefail`, e o consumidor resolve o UUID numa
# ATRIBUIÇÃO: `uid="$(owner_id_by_email "$EMAIL")"`. O status da atribuição é o
# da substituição, então uma função que devolve não-zero mata o script ALI — na
# linha de cima do `[ -n "$uid" ] || die "$(t "Usuário não encontrado.")"`, que nunca
# chega a rodar. E o `grep` devolve 1 justamente quando não casa ninguém, que é
# o caso em que a mensagem existe para falar.
#
# Medido em 2026-09-03 contra o GoTrue local v2.188.1, e-mail inexistente, as
# duas linhas reais do reset-password.sh: rc=1 e NENHUMA saída — o operador que
# erra uma letra no endereço não vê aviso nenhum, só o prompt de volta. "Não
# encontrado" era uma mensagem inalcançável. O `|| return 0` põe a decisão onde
# ela pertence: a função devolve VAZIO, e quem chama decide o que dizer.
owner_id_by_email() {
  local email="$1" resp esc
  resp="$(curl -fsS "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users?filter=${email}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" 2>/dev/null)" || return 0
  esc="$(printf '%s' "$email" | sed 's/[.[\*^$]/\\&/g')"
  printf '%s' "$resp" \
    | grep -o "\"id\":\"[0-9a-f-]\{36\}\",\"aud\":\"[^\"]*\",\"role\":\"[^\"]*\",\"email\":\"${esc}\"" \
    | head -1 | sed 's/^"id":"//;s/".*//' || return 0
}

# Ativa (idempotente) o cron que dispara o drain de eventos a cada minuto. SEM
# isso, nenhuma automação/webhook roda num self-host: neste kit os workers são
# lidos por cron, não por trigger→HTTP nem fila gerenciada (doutrina do
# projeto: trigger Postgres nunca faz HTTP). Chamada por install.sh e
# update.sh — re-rodar não duplica a linha do crontab.
# ── Cron: uma instalação nunca mexe na linha de outra ────────────────────────
# O filtro era `crontab -l | grep -v 'event-log-drain' | crontab -`: casava com
# a linha de QUALQUER instalação do host. Instalar uma segunda instância na
# mesma VPS apagava as duas linhas da primeira — o drain de eventos e o agente
# de atualização — em silêncio, e o dono só descobriria pelo que parou de
# acontecer. Confirmado numa VPS com produção rodando: as linhas dela seriam
# levadas por uma instalação nova em outra pasta.
#
# Agora cada linha carrega um marcador com o diretório da instalação, e o
# filtro remove só as que são dela.
# O marcador identifica a instalação E O PAPEL da linha. O papel não é enfeite:
# com um marcador só por instalação, a segunda função a rodar apagava a linha da
# primeira (o filtro remove tudo que casa com o marcador, e as duas linhas
# casavam). Medido na VPS: depois de instalar, sobrava só o agente e o CRM ficava
# SEM o drain de eventos — a automação inteira parada, em silêncio.
cron_tag() { printf '# deskcomm:%s:%s' "${PROJECT_DIR:-$PWD}" "${1:?papel da linha (drain|agent)}"; }

# Puro (testável sem tocar no crontab real): lê o crontab atual em stdin e
# imprime o novo. Tira as linhas DESTA instalação — pelo marcador, e também
# pela `assinatura` para as linhas legadas, escritas antes de o marcador
# existir, que sem isso ficariam duplicadas a cada re-execução.
cron_merge() {  # cron_merge <marcador> <assinatura_legada> <linha_nova>
  local marcador="$1" legado="$2" nova="$3"
  { grep -vF -e "$marcador" | grep -vF -e "$legado"; } || true
  printf '%s\n' "$nova"
}

# ── O segredo do cron mora num ARQUIVO, nunca na linha do crontab ────────────
# O `cron` do Ubuntu registra no syslog a linha de comando inteira de cada
# execução. Com `-H "Authorization: Bearer <segredo>"` escrito na linha, o
# segredo que libera as rotas de cron (e a de atualização do agente) ia para o
# log a cada minuto — medido numa VPS de produção em 2026-09-17: 24.827 linhas
# no journal, legíveis por qualquer coisa que leia o log do sistema e copiadas
# para cada relatório que alguém tira dele.
#
# Agora a linha aponta para `.env.cron-drain` (`curl -H @arquivo`, curl ≥ 7.55),
# que nasce com 600 e é regravado a cada install/update a partir do `.env`:
# trocar o segredo no `.env` e rodar o update basta para o cron acompanhar. O
# nome casa com `.env*` de propósito — `.gitignore` e `.dockerignore` já o
# deixam de fora.
gravar_cabecalho_do_cron() {  # gravar_cabecalho_do_cron <arquivo> <segredo>
  local arquivo="$1" segredo="$2" tmp
  # `mktemp` cria com 600 desde o primeiro byte: um `printf > arquivo` seguido
  # de `chmod` deixaria o segredo legível por um instante, e o `mv` troca de uma vez.
  tmp="$(mktemp "${arquivo}.XXXXXX")" || return 1
  if ! printf 'Authorization: Bearer %s\n' "$segredo" > "$tmp"; then rm -f "$tmp"; return 1; fi
  chmod 600 "$tmp" && mv -f "$tmp" "$arquivo"
}

setup_event_log_drain_cron() {
  # A troca da senha que vazou vive AQUI, e não no corpo do update.sh, porque
  # esta é a função que o corpo de QUALQUER update.sh já publicado chama depois
  # de reler este arquivo (bloco 7): o corpo que roda na atualização é o da
  # versão antiga, e só as funções são as novas. Fora do update.sh (install.sh
  # nasce marcado; o agent.sh chama a troca por conta própria) não se troca.
  if [ "$(basename "$0")" = update.sh ] && [ -z "${DESKCOMM_AGENT_REPORT:-}" ]; then
    trocar_segredo_do_cron_vazado || true
  fi
  command -v crontab >/dev/null 2>&1 || { c_ylw "$(t "⚠ 'crontab' não encontrado — instale o pacote 'cron' e rode de novo pra ativar as automações.")"; return 0; }

  local secret="${INTERNAL_CRON_SECRET:-}"
  [ -n "$secret" ] || secret="${INTERNAL_SECRET:-}"
  [ -n "$secret" ] || { c_ylw "$(t "⚠ falta INTERNAL_SECRET/INTERNAL_CRON_SECRET — não ativei o cron das automações.")"; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "$(t "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o cron das automações.")"; return 0; }

  local url_drain="${NEXT_PUBLIC_APP_URL}/api/v1/cron/event-log-drain"
  local marcador; marcador="$(cron_tag drain)"

  # "primeira vez" é sobre ESTA instalação, não sobre o host: com o teste antigo
  # ('existe alguma linha de event-log-drain?'), uma instalação nova numa VPS
  # que já roda outra se achava veterana e pulava a higienização de eventos.
  local first_time=1
  if crontab -l 2>/dev/null | grep -qF -e "$url_drain"; then first_time=0; fi

  local cabecalho="${PROJECT_DIR:-$PWD}/.env.cron-drain"
  gravar_cabecalho_do_cron "$cabecalho" "$secret" \
    || { c_ylw "$(t "⚠ não consegui gravar {1} — não ativei o cron das automações." "$cabecalho")"; return 0; }

  # A linha legada (com o Bearer escrito nela) sai pela assinatura da URL.
  # ⚠️ Numa instalação existente isso só acontece a partir do update SEGUINTE ao
  # que traz este conserto: o `update.sh` faz `source` deste arquivo ANTES do
  # `git checkout` da tag, então no update que o traz quem roda aqui ainda é a
  # versão anterior desta função.
  local cron_line="* * * * * curl -fsS -H @\"${cabecalho}\" \"${url_drain}\" >/dev/null 2>&1 ${marcador}"
  # ⚠️ `|| true` OBRIGATÓRIO, e não é defensividade: `crontab -l` sai com status
  # 1 (sem stdout, só um aviso no stderr) quando o usuário NUNCA teve crontab —
  # o caso NORMAL de uma VPS recém-provisionada, que é o caso normal de quem
  # instala este produto. Sob `set -o pipefail` (linha 3 deste arquivo, e
  # `install.sh:12`) esse 1 vaza pelo pipe mesmo com os estágios seguintes
  # bem-sucedidos — `false | true` também sai 1 —, e o `set -e` mata o
  # instalador AQUI, no bloco 11, DEPOIS de a linha do cron já ter sido gravada.
  # O dono vê o script morrer sem mensagem, numa instalação que na verdade
  # funcionou.
  #
  # ACHADO DUAS VEZES, POR DUAS PESSOAS QUE NÃO SE FALARAM, NO MESMO DIA:
  # @luiscgc91 (PR #683) e @rafaelbatistazz (issue #715 + PR #726), os dois
  # instalando numa VPS limpa. Os dois escreveram EXATAMENTE a mesma linha. Isso
  # não é redundância — é a medida de quanto o defeito doía, e a razão de este
  # comentário ser longo: ele existe para a terceira pessoa não precisar
  # descobrir de novo.
  #
  # A issue #715 descreve o sintoma como quem o viveu: o instalador para logo
  # depois de "✓ chave de cifra ativa no banco", cai na tela "A instalação
  # parou", e os contêineres estão SAUDÁVEIS. Rodar de novo passa — porque aí o
  # crontab já não está vazio, o que faz o defeito parecer fantasma.
  #
  # Reproduzido com um dublê de `crontab` que sai 1 no `-l`: sem o `|| true`, a
  # linha seguinte a este bloco nunca é alcançada. Vigiado por DOIS testes, de
  # propósito: `tests/shell/cron-sem-crontab-previo.test.sh` mede cada função
  # isolada, e o bloco `cron numa VPS sem crontab nenhum` de
  # `hostgator-setup-kit/test-validators.sh` (de @rafaelbatistazz) roda AS DUAS
  # no mesmo processo — como o `install.sh` faz — e confere que as duas linhas
  # foram gravadas.
  #
  # Stdin vazio para o `cron_merge` é exatamente o que "sem crontab prévio" deve
  # produzir — o comportamento não muda, só o status.
  ( { crontab -l 2>/dev/null || true; } | cron_merge "$marcador" "$url_drain" "$cron_line" ) | crontab -
  c_grn "$(t "✓ automações ativas (cron do event-log-drain, a cada minuto)")"

  if [ "$first_time" = 1 ]; then
    # 1ª ativação do cron (inclusive numa instalação já existente que nunca
    # teve o drain rodando): pode haver eventos 'pending' antigos acumulados.
    # Se o 1º drain os processasse, dispararia efeitos colaterais atrasados
    # (ex.: webhook de dias/semanas atrás) — surpresa indesejada pro dono do
    # CRM. Marcamos como 'done' só os realmente velhos (>7 dias); os recentes
    # continuam 'pending' e processam normalmente no próximo drain.
    step "$(t "Higienizando eventos pendentes antigos (1ª ativação do cron)")"
    psql_run -c "update event_log set status='done', updated_at=now() where status='pending' and created_at < now() - interval '7 days';" \
      >/dev/null 2>&1 \
      && c_grn "$(t "✓ eventos pendentes com mais de 7 dias marcados como concluídos")" \
      || c_ylw "$(t "⚠ não consegui higienizar eventos antigos — confira manualmente a tabela event_log se necessário.")"
  fi
}

# ── A senha que o log do sistema já guardou (#1054): trocar UMA vez ─────────
# Parar de escrever o segredo na linha do crontab (acima) estanca o vazamento
# daqui para frente; não desfaz o que já foi gravado. Em toda instalação que
# rodou a linha antiga, o segredo das rotinas está em `/var/log/syslog`, nos
# arquivos rotacionados e no journal — e continua abrindo as rotas de cron e a
# de atualização (`lib/auth/cron-auth.ts`, `app/api/v1/system/agent/route.ts`)
# para quem ler esse log. Esta função troca o segredo sozinha, uma vez na vida
# da instalação, sem pedir edição de `.env` a ninguém (doutrina de packaging).
#
# QUAL segredo: o mesmo que `setup_event_log_drain_cron` punha na linha —
# `INTERNAL_CRON_SECRET`, ou `INTERNAL_SECRET` quando o primeiro está vazio. O
# outro nunca foi para o log e fica como está.
#
# QUEM LÊ, e por isso a ordem gerar → `.env` → recriar → arquivo do cron:
#   - o `app` (rotas de cron, /system/agent, /system/relogio/tick, /health) lê
#     os dois pelo `env_file: .env`, no boot do contêiner;
#   - o `scheduler` lê só `INTERNAL_SECRET`, por interpolação no compose;
#   - o `.env.cron-drain` (a linha do drain) e o `agent.sh` (a cada 5 min, do
#     `.env`, no início de cada execução).
# O `dc up -d` recria só o que mudou de configuração; o arquivo do cron é
# regravado logo depois. No intervalo, uma batida de minuto do drain pode
# levar 401 — a seguinte já vai com a senha nova.
#
# QUEM NÃO PODE TROCAR: o `update.sh` dirigido pelo botão da tela. Quem o
# dirige é o `agent.sh` que já estava rodando, com a senha VELHA numa variável;
# trocada no meio, o `run_result` dele leva 401 e a tela nunca sabe como a
# atualização terminou. Nesse caso a troca fica para a próxima execução do
# `agent.sh` (≤5 min), que é lido do disco a cada vez e já é o novo.
#
# Uma vez só: a marca em disco é o que impede gerar senha nova a cada update.
# A instalação nova nasce marcada (`marcar_segredo_do_cron_como_novo`, no
# install.sh): a senha dela nunca foi para linha nenhuma.
#
# Devolve 0 quando trocou OU quando não havia nada a trocar (e só no primeiro
# caso deixa SEGREDO_DO_CRON_TROCADO=1); 1 quando tentou e não conseguiu —
# nesse caso o `.env` volta ao que era e a marca NÃO é gravada, para a próxima
# execução tentar de novo.
MARCA_SEGREDO_DO_CRON_NOME=".deskcomm-segredo-do-cron-trocado"

marcar_segredo_do_cron_como_novo() {
  # Só marca se ESTE host nunca teve a linha antiga: reinstalar por cima de uma
  # instalação que vazou não pode pular a troca.
  if { crontab -l 2>/dev/null || true; } | grep -qF 'Authorization: Bearer'; then return 0; fi
  : > "${PROJECT_DIR:-$PWD}/${MARCA_SEGREDO_DO_CRON_NOME}" 2>/dev/null || true
}

trocar_segredo_do_cron_vazado() {
  SEGREDO_DO_CRON_TROCADO=""
  local dir="${PROJECT_DIR:-$PWD}"
  local marca="${dir}/${MARCA_SEGREDO_DO_CRON_NOME}" envfile="${dir}/.env"
  [ -e "$marca" ] && return 0

  local chave=""
  if [ -n "${INTERNAL_CRON_SECRET:-}" ]; then chave=INTERNAL_CRON_SECRET
  elif [ -n "${INTERNAL_SECRET:-}" ]; then chave=INTERNAL_SECRET
  fi
  # Sem segredo, ou sem nunca ter tido a linha do drain neste host: nada foi
  # para o log, e trocar seria reiniciar o app à toa.
  if [ -z "$chave" ] \
     || ! { crontab -l 2>/dev/null || true; } | grep -qF '/api/v1/cron/event-log-drain'; then
    : > "$marca" 2>/dev/null || true
    return 0
  fi

  # Mesmo cadeado do agent.sh: nunca trocar com uma atualização pelo botão em
  # andamento (quem a dirige ainda fala com a senha velha), nem duas vezes ao
  # mesmo tempo (update.sh no terminal e agent.sh no cron).
  local tem_cadeado=""
  if command -v flock >/dev/null 2>&1; then
    exec 8>"${dir}/.update.lock"
    flock -n 8 || { exec 8>&-; return 0; }
    tem_cadeado=1
  fi
  if [ -e "$marca" ]; then [ -n "$tem_cadeado" ] && exec 8>&-; return 0; fi

  local velho="${!chave}" novo=""
  novo="$(openssl rand -hex 32 2>/dev/null)" || novo=""
  if [ -z "$novo" ]; then
    [ -n "$tem_cadeado" ] && exec 8>&-
    c_ylw "$(t "⚠ não consegui gerar a senha nova das rotinas — tento de novo na próxima atualização.")"
    return 1
  fi

  step "$(t "Trocando a senha interna das rotinas (a antiga ficou no log do sistema)")"
  set_env_var "$envfile" "$chave" "$novo"
  export "${chave}=${novo}"
  if ! dc up -d >/dev/null 2>&1; then
    set_env_var "$envfile" "$chave" "$velho"
    export "${chave}=${velho}"
    dc up -d >/dev/null 2>&1 || true
    [ -n "$tem_cadeado" ] && exec 8>&-
    c_ylw "$(t "⚠ não consegui reiniciar o app com a senha nova — mantive a antiga e tento de novo na próxima atualização.")"
    return 1
  fi
  wait_app_healthy 20 3 >/dev/null \
    || c_ylw "$(t "⚠ o app ainda não respondeu depois da troca — a senha nova já está no .env e segue valendo.")"
  gravar_cabecalho_do_cron "${dir}/.env.cron-drain" "$novo" || true
  : > "$marca" 2>/dev/null || true
  [ -n "$tem_cadeado" ] && exec 8>&-
  SEGREDO_DO_CRON_TROCADO=1

  c_grn "$(t "✓ senha interna das rotinas trocada — a que ficou gravada no log do sistema não abre mais nada")"
  c_ylw "$(t "  Recomendado (não obrigatório): apagar os logs antigos, onde a senha velha aparece.")"
  c_ylw "$(t "  Numa VPS Ubuntu/Debian, como root:")"
  c_ylw "    sudo truncate -s 0 /var/log/syslog && sudo rm -f /var/log/syslog.*"
  c_ylw "    sudo journalctl --rotate && sudo journalctl --vacuum-time=1s"
  return 0
}

# Ativa (idempotente) o cron do agente de atualização: a cada 5 minutos ele
# avisa o app da versão instalada e, se alguém clicou em "Atualizar agora" na
# tela, roda o update.sh sozinho. É o que faz o botão da tela existir de
# verdade — sem cron, a tela mostra "atualização automática indisponível" pra
# sempre. Chamada por install.sh e update.sh (bloco 7) — re-rodar não duplica
# a linha do crontab.
setup_update_agent_cron() {
  command -v crontab >/dev/null 2>&1 || { c_ylw "$(t "⚠ 'crontab' não encontrado — o botão de atualizar pela tela não vai funcionar.")"; return 0; }
  local secret="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
  [ -n "$secret" ] || { c_ylw "$(t "⚠ falta INTERNAL_SECRET — não ativei o agente de atualização.")"; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "$(t "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o agente de atualização.")"; return 0; }

  # `cd` explícito: o agent.sh chama enter_project(), que acha o projeto pelo
  # DIRETÓRIO CORRENTE. No cron o CWD é o home do dono do crontab — sem o cd,
  # a linha só funciona por acidente (instalação padrão em /root/deskcommcrm) e
  # morre calada a cada 5 minutos em qualquer REPO_DIR customizado ou /opt.
  # A assinatura legada inclui o PROJECT_DIR: é o que distingue a linha desta
  # instalação da linha de uma vizinha, que roda o mesmo agent.sh em outra pasta.
  local legado="cd ${PROJECT_DIR} && bash hostgator-setup-kit/agent.sh"
  local marcador; marcador="$(cron_tag agent)"
  local cron_line="*/5 * * * * ${legado} >/dev/null 2>&1 ${marcador}"
  # Mesmo motivo do drain acima, e é por isso que o conserto é nos DOIS: a
  # primeira instalação passa pelos dois blocos na mesma rodada.
  ( { crontab -l 2>/dev/null || true; } | cron_merge "$marcador" "$legado" "$cron_line" ) | crontab -
  c_grn "$(t "✓ atualização pela tela ativa (agente a cada 5 minutos)")"
}

# Garante a chave de cifra dos segredos (webhooks/Nuvemshop) e a semeia no
# banco (private.app_secrets, migration 0041). Idempotente: reusa a chave do
# .env se existir (trocá-la invalidaria dados já cifrados); gera se ausente e
# appenda ao .env. Chamada por install.sh e update.sh APÓS aplicar o baseline.
ensure_encryption_key() {
  local envfile="${1:-.env}"
  local key="${NUVEMSHOP_OAUTH_ENCRYPTION_KEY:-}"
  if [ -z "$key" ] && [ -f "$envfile" ]; then
    key="$(grep -E '^NUVEMSHOP_OAUTH_ENCRYPTION_KEY=' "$envfile" | head -1 | cut -d= -f2- | tr -d "'\"" || true)"
  fi
  if [ -z "$key" ]; then
    key="$(openssl rand -hex 32)"
    printf '\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=%s\n' "$key" >> "$envfile"
    c_grn "$(t "✓ chave de cifra dos segredos gerada e gravada no .env")"
  fi
  export NUVEMSHOP_OAUTH_ENCRYPTION_KEY="$key"

  # Semeia no banco — é de lá que as funções de cifra leem (Supabase não
  # permite configurar a chave via parâmetro de banco).
  psql_run -c "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '${key}') on conflict (name) do update set value = excluded.value, updated_at = now();" \
    >/dev/null 2>&1 \
    && c_grn "$(t "✓ chave de cifra ativa no banco (segredos de webhook são guardados cifrados)")" \
    || c_ylw "$(t "⚠ não consegui semear a chave de cifra no banco — segredos de webhook não poderão ser salvos até rodar update.sh de novo.")"

  # ── Chave do CPF (#2522) ───────────────────────────────────────────────────
  # `encrypt_cpf`/`decrypt_cpf` (migration 0597) leem `private.app_secrets`
  # na linha `cpf_key`. SEM esta linha toda gravação de contato COM CPF cai na
  # degradação: o contato é salvo sem CPF e a busca por CPF não acha ninguém —
  # exatamente o problema que o reportante do #2522 descreveu.
  local cpf="${CPF_ENCRYPTION_KEY:-}"
  if [ -z "$cpf" ] && [ -f "$envfile" ]; then
    cpf="$(grep -E '^CPF_ENCRYPTION_KEY=' "$envfile" | head -1 | cut -d= -f2- | tr -d "'\"" || true)"
  fi
  if [ -z "$cpf" ]; then
    cpf="$(openssl rand -base64 32)"
    printf '\nCPF_ENCRYPTION_KEY=%s\n' "$cpf" >> "$envfile"
    c_grn "$(t "✓ chave de cifra do CPF gerada e gravada no .env")"
  fi
  export CPF_ENCRYPTION_KEY="$cpf"

  psql_run -c "insert into private.app_secrets (name, value) values ('cpf_key', '${cpf}') on conflict (name) do update set value = excluded.value, updated_at = now();" \
    >/dev/null 2>&1 \
    && c_grn "$(t "✓ chave de cifra do CPF ativa no banco (contato com CPF é salvo cifrado)")" \
    || c_ylw "$(t "⚠ não consegui semear a chave de cifra do CPF no banco — o contato será salvo sem CPF até rodar update.sh de novo.")"
}

# ── A ÚLTIMA RELEASE ESTÁVEL PUBLICADA ──────────────────────────────────────
#
# ⚠️ TAG EXISTIR NÃO É RELEASE PUBLICADA, e confundir as duas instala código
# que ninguém lançou.
#
# Caso real (2026-09-13): `v1.20.0` existe como tag annotated criada À MÃO no
# repositório oficial — a mensagem da própria tag registra que o CI recusou
# criá-la — enquanto `/releases/latest` continuava devolvendo `v1.19.0`.
# `git tag -l 'v*' --sort=-v:refname | head -1`, que era o que este kit usava,
# responde "v1.20.0" e manda todo clone do mundo instalar um código sem
# release, sem changelog e sem os cinco checks obrigatórios da `main`.
#
# `/releases/latest` é a pergunta certa: a própria API do GitHub define esse
# endpoint como a última release que NÃO é draft e NÃO é prerelease — os dois
# filtros que queremos, aplicados na origem, sem precisar ordenar nada aqui.
#
# O repositório sai do `origin` (e não de uma constante) para que um fork com
# releases próprias funcione sem editar o kit; `DESKCOMM_RELEASES_LATEST_URL`
# troca o endereço inteiro quando é preciso.
#
# Devolve string VAZIA quando não dá para saber (sem rede, API fora, fork sem
# release). Vazio é "não sei" — e quem chama TEM de tratar isso como "não sei",
# nunca como "não há versão nova". Cair de volta para `git tag` aqui seria
# reintroduzir exatamente o defeito que esta função existe para matar.
ultima_release_estavel() {
  local origem slug url tag
  origem="$(git config --get remote.origin.url 2>/dev/null || true)"

  # Endereço explícito primeiro: é o caminho dos testes (um JSON local via
  # `file://`) e de quem opera um fork com releases num lugar próprio.
  url="${DESKCOMM_RELEASES_LATEST_URL:-}"

  if [ -z "$url" ]; then
    case "$origem" in
      https://github.com/*|http://github.com/*|git@github.com:*)
        slug="$(printf '%s' "$origem" \
          | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##; s#^https?://[^/]+/##')"
        url="https://api.github.com/repos/${slug}/releases/latest"
        ;;
      *)
        # Origin FORA do GitHub (espelho, caminho local): ali não existe API de
        # release, e a maior tag é a única resposta que existe — o mesmo que o
        # kit fazia antes. Toda instalação real clona do GitHub (install.sh) e
        # nunca cai aqui; quem cai é o repositório descartável dos testes.
        git tag -l 'v*' --sort=-v:refname | head -1
        return 0
        ;;
    esac
  fi

  # `-f` faz o curl falhar em 404 (repo sem release nenhuma) em vez de devolver
  # o corpo de erro, que o sed abaixo interpretaria como ausência de tag_name.
  tag="$(curl -fsSL --max-time 20 -H 'Accept: application/vnd.github+json' "$url" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

  # Sem jq de propósito: o kit não pode exigir jq numa VPS de cliente. O
  # `tag_name` é o primeiro campo desse formato no JSON de uma release e não
  # contém aspas, então o sed é suficiente — e a validação abaixo recusa
  # qualquer coisa que não tenha cara de versão, em vez de confiar no parse.
  case "$tag" in
    v[0-9]*) printf '%s\n' "$tag" ;;
    *) printf '' ;;
  esac
}
