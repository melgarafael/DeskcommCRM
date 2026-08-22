#!/usr/bin/env bash
# Helpers compartilhados pelos scripts do kit. Sourced, não executado direto.
set -euo pipefail

COMPOSE="docker-compose.prod.yml"
COMPOSE_TRAEFIK="docker-compose.traefik.yml"

# Proxy reverso desta instalação. Vem do .env (load_env), com default 'caddy' —
# ou seja, toda instalação que já existe continua exatamente como está.
#
#   caddy   → o kit sobe o próprio Caddy nas portas 80/443 (VPS "cru")
#   traefik → a VPS JÁ tem um Traefik nessas portas (Hostinger, Coolify,
#             Dokploy...). Entra o override, que desliga o Caddy e publica o app
#             por labels. Ver o cabeçalho de docker-compose.traefik.yml.
#
# Todo `docker compose` do kit passa por aqui: com proxy externo, um comando sem
# o override subiria o Caddy e ele iria bater de frente com o Traefik.
dc() {
  if [ "${REVERSE_PROXY:-caddy}" = "traefik" ]; then
    docker compose -f "$COMPOSE" -f "$COMPOSE_TRAEFIK" "$@"
  else
    docker compose -f "$COMPOSE" "$@"
  fi
}

# A mesma lista de -f, como texto, para as mensagens que ensinam o comando ao
# dono. Se a mensagem omitisse o override numa instalação com proxy externo, o
# próprio dono derrubaria o site seguindo a instrução do kit.
dc_files() {
  if [ "${REVERSE_PROXY:-caddy}" = "traefik" ]; then
    printf -- '-f %s -f %s' "$COMPOSE" "$COMPOSE_TRAEFIK"
  else
    printf -- '-f %s' "$COMPOSE"
  fi
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
      die "Não consegui criar a rede Docker '$TRAEFIK_NETWORK'. O Docker respondeu:
  ${erro}"
    fi
    c_dim "  (rede '$TRAEFIK_NETWORK' criada — é por ela que o Traefik alcança o CRM)"
    ;;
  inexistente)
    die "A rede Docker '$TRAEFIK_NETWORK' não existe.
Rode 'docker network ls', identifique a rede do seu Traefik e ponha
TRAEFIK_NETWORK=<nome> no .env antes de tentar de novo."
    ;;
  driver_errado)
    # Mandar quem está em modo host "procurar a rede do seu Traefik" é mandar
    # procurar o que não existe: em modo host ele não está em rede nenhuma do
    # Docker. Para esse caso a saída é apagar a linha e deixar o kit decidir —
    # ele cria a bridge do projeto sozinho.
    die "A rede '$TRAEFIK_NETWORK' tem driver '$drv', e o app precisa
de uma bridge para o Traefik alcançar o contêiner. Se o seu Traefik roda em modo
host (é o caso quando 'docker ps' não mostra porta publicada nele), APAGUE a linha
TRAEFIK_NETWORK do .env: o kit cria e usa a rede '$nossa'.
Senão, rode 'docker network ls' e ponha a bridge certa em TRAEFIK_NETWORK no .env.
Se for uma overlay do Swarm, ela precisa ter sido criada com --attachable —
sem isso um contêiner de compose comum não consegue entrar nela."
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
step()  { printf '\n'; paint 1 "▶ $*"; }

# Gêmea da de install.sh (se mexer numa, mexa na outra) — ver o comentário lá
# para o defeito que ela fecha. Coberta por test-validators.sh.
resposta_sim() {
  local r
  r="$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  case "$r" in s|sim|y|yes) return 0;; *) return 1;; esac
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
  else die "Não achei $COMPOSE. Rode a partir da pasta do projeto."; fi
  [ -f .env ] || die "Falta o .env (rode install.sh primeiro)."
  load_env .env
  PROJECT_DIR="$(pwd)"
}

# psql efêmero via container (não exige psql no host).
psql_run() { docker run --rm -i postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "$@"; }

# ── As três imagens que NÓS publicamos ───────────────────────────────────────
# O namespace é constante e literal de propósito: ele está gravado no .env de
# toda instalação viva, e derivá-lo de variável faria o kit antigo (que já está
# no disco do cliente) e o novo montarem strings diferentes.
IMG_NS="ghcr.io/melgarafael"
IMG_APP="${IMG_NS}/deskcommcrm"
IMG_WORKER="${IMG_NS}/deskcomm-worker"
IMG_SCHEDULER="${IMG_NS}/deskcomm-scheduler"

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
ghcr_status() {
  local img="$1" tag="$2" tok
  tok="$(curl -fsS --max-time 6 \
          "https://ghcr.io/token?scope=repository:melgarafael/${img}:pull&service=ghcr.io" 2>/dev/null \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')" || true
  if [ -z "$tok" ]; then printf '000'; return 0; fi
  curl -s -o /dev/null --max-time 6 -w '%{http_code}' \
    -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/melgarafael/${img}/manifests/${tag}" 2>/dev/null || printf '000'
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
trio_publicado() {
  local tag="$1" i
  for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do
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
owner_id_by_email() {
  local email="$1"
  curl -fsS "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users?filter=email.eq.${email}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" 2>/dev/null \
    | grep -o '"id":"[0-9a-f-]\{36\}"' | head -1 | sed 's/.*:"//;s/"//'
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

setup_event_log_drain_cron() {
  command -v crontab >/dev/null 2>&1 || { c_ylw "⚠ 'crontab' não encontrado — instale o pacote 'cron' e rode de novo pra ativar as automações."; return 0; }

  local secret="${INTERNAL_CRON_SECRET:-}"
  [ -n "$secret" ] || secret="${INTERNAL_SECRET:-}"
  [ -n "$secret" ] || { c_ylw "⚠ falta INTERNAL_SECRET/INTERNAL_CRON_SECRET — não ativei o cron das automações."; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o cron das automações."; return 0; }

  local url_drain="${NEXT_PUBLIC_APP_URL}/api/v1/cron/event-log-drain"
  local marcador; marcador="$(cron_tag drain)"

  # "primeira vez" é sobre ESTA instalação, não sobre o host: com o teste antigo
  # ('existe alguma linha de event-log-drain?'), uma instalação nova numa VPS
  # que já roda outra se achava veterana e pulava a higienização de eventos.
  local first_time=1
  if crontab -l 2>/dev/null | grep -qF -e "$url_drain"; then first_time=0; fi

  local cron_line="* * * * * curl -fsS -H \"Authorization: Bearer ${secret}\" \"${url_drain}\" >/dev/null 2>&1 ${marcador}"
  ( crontab -l 2>/dev/null | cron_merge "$marcador" "$url_drain" "$cron_line" ) | crontab -
  c_grn "✓ automações ativas (cron do event-log-drain, a cada minuto)"

  if [ "$first_time" = 1 ]; then
    # 1ª ativação do cron (inclusive numa instalação já existente que nunca
    # teve o drain rodando): pode haver eventos 'pending' antigos acumulados.
    # Se o 1º drain os processasse, dispararia efeitos colaterais atrasados
    # (ex.: webhook de dias/semanas atrás) — surpresa indesejada pro dono do
    # CRM. Marcamos como 'done' só os realmente velhos (>7 dias); os recentes
    # continuam 'pending' e processam normalmente no próximo drain.
    step "Higienizando eventos pendentes antigos (1ª ativação do cron)"
    psql_run -c "update event_log set status='done', updated_at=now() where status='pending' and created_at < now() - interval '7 days';" \
      >/dev/null 2>&1 \
      && c_grn "✓ eventos pendentes com mais de 7 dias marcados como concluídos" \
      || c_ylw "⚠ não consegui higienizar eventos antigos — confira manualmente a tabela event_log se necessário."
  fi
}

# Ativa (idempotente) o cron do agente de atualização: a cada 5 minutos ele
# avisa o app da versão instalada e, se alguém clicou em "Atualizar agora" na
# tela, roda o update.sh sozinho. É o que faz o botão da tela existir de
# verdade — sem cron, a tela mostra "atualização automática indisponível" pra
# sempre. Chamada por install.sh e update.sh (bloco 7) — re-rodar não duplica
# a linha do crontab.
setup_update_agent_cron() {
  command -v crontab >/dev/null 2>&1 || { c_ylw "⚠ 'crontab' não encontrado — o botão de atualizar pela tela não vai funcionar."; return 0; }
  local secret="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
  [ -n "$secret" ] || { c_ylw "⚠ falta INTERNAL_SECRET — não ativei o agente de atualização."; return 0; }
  [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || { c_ylw "⚠ falta NEXT_PUBLIC_APP_URL — não ativei o agente de atualização."; return 0; }

  # `cd` explícito: o agent.sh chama enter_project(), que acha o projeto pelo
  # DIRETÓRIO CORRENTE. No cron o CWD é o home do dono do crontab — sem o cd,
  # a linha só funciona por acidente (instalação padrão em /root/deskcommcrm) e
  # morre calada a cada 5 minutos em qualquer REPO_DIR customizado ou /opt.
  # A assinatura legada inclui o PROJECT_DIR: é o que distingue a linha desta
  # instalação da linha de uma vizinha, que roda o mesmo agent.sh em outra pasta.
  local legado="cd ${PROJECT_DIR} && bash hostgator-setup-kit/agent.sh"
  local marcador; marcador="$(cron_tag agent)"
  local cron_line="*/5 * * * * ${legado} >/dev/null 2>&1 ${marcador}"
  ( crontab -l 2>/dev/null | cron_merge "$marcador" "$legado" "$cron_line" ) | crontab -
  c_grn "✓ atualização pela tela ativa (agente a cada 5 minutos)"
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
    c_grn "✓ chave de cifra dos segredos gerada e gravada no .env"
  fi
  export NUVEMSHOP_OAUTH_ENCRYPTION_KEY="$key"

  # Semeia no banco — é de lá que as funções de cifra leem (Supabase não
  # permite configurar a chave via parâmetro de banco).
  psql_run -c "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '${key}') on conflict (name) do update set value = excluded.value, updated_at = now();" \
    >/dev/null 2>&1 \
    && c_grn "✓ chave de cifra ativa no banco (segredos de webhook são guardados cifrados)" \
    || c_ylw "⚠ não consegui semear a chave de cifra no banco — segredos de webhook não poderão ser salvos até rodar update.sh de novo."
}
