#!/usr/bin/env bash
# diagnostico.sh — "esta instalação foi afetada pelo worker que nunca era atualizado?"
#
# READ-ONLY ABSOLUTO. Não escreve arquivo, não puxa imagem, não sobe nem reinicia
# nada, não toca no .env. Só lê o estado e explica. É seguro rodar em produção,
# a qualquer hora, quantas vezes quiser — que é exatamente o que vai acontecer.
#
# ── Por que ele NÃO consulta o /api/v1/health ────────────────────────────────
# Seria o caminho óbvio, e é o errado: até a versão que conserta isto, o health
# lia `process.env.npm_package_version`, que é `undefined` sob `CMD ["node",
# "server.js"]`. TODA instalação — afetada ou não — responde `0.1.0`. Um detector
# que perguntasse a ele daria a mesma resposta para os dois casos, que é o mesmo
# que não perguntar. Medido em produção: `version: "0.1.0"` numa instalação
# comprovadamente afetada.
#
# ── Por que ele é AUTOCONTIDO (não sourceia o _common.sh) ────────────────────
# Duas razões, e as duas são o mesmo problema: ele roda em máquinas ANTIGAS. O
# `_common.sh` do disco de uma instalação legada é o de dois meses atrás, e
# depender dele seria diagnosticar o passado com a ferramenta do passado. E
# precisa poder ser baixado avulso, sem clonar nada:
#
#   curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/hostgator-setup-kit/diagnostico.sh | bash
#
# ── O que ele pode assumir que existe ────────────────────────────────────────
# Medido numa VPS real: bash 5.1, docker, docker compose, curl, sed/awk/grep.
# NÃO assume `jq` nem `node` (node não existe fora dos contêineres).
set -uo pipefail   # sem `-e`: um comando que falha é DADO, não motivo de abortar

COMPOSE_FILE="docker-compose.prod.yml"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; B=$'\033[1m'; D=$'\033[2m'; Z=$'\033[0m'
else
  R=''; G=''; Y=''; B=''; D=''; Z=''
fi

titulo() { printf '\n%s%s%s\n' "$B" "$*" "$Z"; }
item()   { printf '  %s\n' "$*"; }

# ── 0. Achar a instalação ────────────────────────────────────────────────────
# O install.sh clona em ./deskcommcrm por padrão, mas o operador pode ter posto
# em qualquer lugar. Procuramos no cwd, no caminho padrão, e por último varremos
# — em profundidade limitada, para não passear pelo disco inteiro.
achar_projeto() {
  local c
  for c in . ./deskcommcrm /root/DeskcommCRM /root/deskcommcrm /opt/deskcommcrm /var/www/crm; do
    [ -f "$c/$COMPOSE_FILE" ] && { (cd "$c" && pwd); return 0; }
  done
  c="$(find /root /opt /home /var/www -maxdepth 4 -name "$COMPOSE_FILE" 2>/dev/null | head -1)"
  [ -n "$c" ] && { dirname "$c"; return 0; }
  return 1
}

PROJETO="$(achar_projeto)" || {
  printf '%s✖ Não achei uma instalação do DeskcommCRM nesta máquina.%s\n' "$R" "$Z"
  printf '  Rode este script de dentro da pasta do projeto (a que tem %s).\n' "$COMPOSE_FILE"
  exit 2
}
cd "$PROJETO" || exit 2

printf '%s══ Diagnóstico do DeskcommCRM ══%s\n' "$B" "$Z"
item "${D}pasta: $PROJETO${Z}"
item "${D}data:  $(date -u '+%Y-%m-%d %H:%M UTC')${Z}"

if ! docker info >/dev/null 2>&1; then
  printf '\n%s✖ O Docker não respondeu.%s Sem ele não dá para diagnosticar nada.\n' "$R" "$Z"
  printf '  Tente: sudo systemctl start docker\n'
  exit 2
fi

# ── 1. Coletar os sinais ─────────────────────────────────────────────────────
# Cada um foi medido numa instalação afetada de verdade antes de virar regra.

# (a) O .env conhece as imagens novas? Instalação legada não tem essas chaves —
#     elas passaram a existir junto com a correção.
ENV_TEM_WORKER=nao
[ -f .env ] && grep -qE '^WORKER_IMAGE=' .env 2>/dev/null && ENV_TEM_WORKER=sim

# (b) Qual imagem cada serviço está usando AGORA.
#     `compose ps --format` funciona nas versões que o kit instala; se falhar,
#     caímos no `docker inspect` do contêiner pelo nome do projeto.
PROJ_NOME="$(basename "$PROJETO" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
PROJ_NOME="${PROJ_NOME#"${PROJ_NOME%%[!_-]*}"}"

imagem_do_servico() {  # imagem_do_servico <serviço>
  local svc="$1" img
  img="$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Service}}|{{.Image}}' 2>/dev/null \
        | awk -F'|' -v s="$svc" '$1==s{print $2; exit}')"
  [ -z "$img" ] && img="$(docker inspect "${PROJ_NOME}-${svc}-1" --format '{{.Config.Image}}' 2>/dev/null)"
  printf '%s' "$img"
}

IMG_WORKER="$(imagem_do_servico worker)"
IMG_APP="$(imagem_do_servico app)"

# (c) A imagem do worker veio do NOSSO CI, ou foi construída nesta máquina?
#
#     O sinal é `org.opencontainers.image.revision`, e a escolha dele não é
#     arbitrária: ele é o ÚNICO label que só o CI produz. Medido nas duas
#     imagens lado a lado —
#
#       publicada pelo CI : created, description, licenses, revision, source,
#                           title, url, version
#       construída aqui   : licenses, source, title
#
#     `source`, `licenses` e `title` vêm do `LABEL` do Dockerfile, então uma
#     imagem local os carrega também; `revision` (e `version`) vêm do
#     docker/metadata-action, que só roda no CI.
#
#     A primeira versão deste detector decidia pelo NOME da imagem ("tem host,
#     logo veio de registro") e só consultava os labels quando o nome não tinha
#     host. Uma sabotagem derrubou isso em um comando: construí local, taguei
#     como `ghcr.io/melgarafael/deskcomm-worker:falsificado`, e o diagnóstico
#     deu "NÃO afetada" numa instalação afetada. Pior: o comentário ao lado do
#     código afirmava que os labels pegariam esse caso — a prosa descrevia uma
#     proteção que o código não implementava.
LABEL_SOURCE=""
LABEL_REVISION=""
CRIADA_WORKER=""
CRIADA_APP=""
if [ -n "$IMG_WORKER" ]; then
  LABEL_SOURCE="$(docker image inspect "$IMG_WORKER" \
                  --format '{{index .Config.Labels "org.opencontainers.image.source"}}' 2>/dev/null)"
  [ "$LABEL_SOURCE" = "<no value>" ] && LABEL_SOURCE=""
  LABEL_REVISION="$(docker image inspect "$IMG_WORKER" \
                    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)"
  [ "$LABEL_REVISION" = "<no value>" ] && LABEL_REVISION=""
  # ATENÇÃO ao usar `docker image inspect`, e não `docker inspect <contêiner>`:
  # o `.Created` do CONTÊINER é a hora em que ele foi recriado, e um `up -d`
  # recria todos juntos — na produção os dois batiam no mesmo segundo enquanto
  # as IMAGENS estavam a 13 dias de distância. Perguntar ao contêiner daria
  # falso negativo justamente no caso real.
  CRIADA_WORKER="$(docker image inspect "$IMG_WORKER" --format '{{.Created}}' 2>/dev/null | cut -c1-10)"
fi
[ -n "$IMG_APP" ] && CRIADA_APP="$(docker image inspect "$IMG_APP" --format '{{.Created}}' 2>/dev/null | cut -c1-10)"

# A decisão é do `revision`, sozinho. O nome da imagem entra depois, só na
# explicação — ele é sugestivo e falsificável, o label não.
WORKER_DO_CI=nao
[ -n "$LABEL_REVISION" ] && WORKER_DO_CI=sim

# Dois sabores de "construída aqui", com consequências diferentes para o texto:
#   legado      → sem label nenhum: Dockerfile.worker antigo, anterior à correção
#   build local → tem `source` mas não `revision`: Dockerfile atual, compilado
#                 nesta máquina (docker-compose.build.yml). Pode ser deliberado.
SABOR_LOCAL=legado
[ -n "$LABEL_SOURCE" ] && SABOR_LOCAL=build_local

# ── 2. O veredito ────────────────────────────────────────────────────────────
# Afetado = o worker NÃO veio de um registro. Os outros sinais entram como
# corroboração e como explicação, não como critério — um deles sozinho pode
# variar por instalação, a origem da imagem não.
AFETADO=nao
[ "$WORKER_DO_CI" = "nao" ] && AFETADO=sim

titulo "O que está rodando"
item "app     : ${IMG_APP:-(não encontrado)}${CRIADA_APP:+   ${D}imagem de $CRIADA_APP${Z}}"
item "worker  : ${IMG_WORKER:-(não encontrado)}${CRIADA_WORKER:+   ${D}imagem de $CRIADA_WORKER${Z}}"

if [ -z "$IMG_WORKER" ]; then
  printf '\n%s⚠ Não achei o contêiner do worker.%s\n' "$Y" "$Z"
  printf '  Ou a stack está parada, ou esta instalação não tem o agente de IA.\n'
  printf '  Suba com: docker compose -f %s up -d   e rode este diagnóstico de novo.\n' "$COMPOSE_FILE"
  exit 2
fi

if [ "$AFETADO" = "nao" ]; then
  titulo "${G}✓ Esta instalação NÃO está afetada.${Z}"
  item "O worker roda uma imagem publicada (${IMG_WORKER})."
  item "Ele recebe as correções de cada versão, como o resto do sistema."
  # Não é o incidente do worker congelado — por isso o exit continua 0 —, mas é
  # um estado que a doutrina proíbe (invariante 3: instalação de cliente não
  # aponta para tag móvel) e que o U6-c mediu acontecer de verdade: a primeira
  # execução do update.sh numa instalação legada traz o worker publicado e o
  # deixa seguindo `stable`. Na release seguinte esse canal se move, e um
  # `up -d` levaria o worker sozinho para a versão nova enquanto o app fica na
  # antiga. Um aviso em cinza-claro era pouco para isso.
  if [ "$ENV_TEM_WORKER" = "nao" ]; then
    tag_do_worker="${IMG_WORKER##*:}"
    case "$tag_do_worker" in
      latest|main|stable)
        printf '\n'
        item "${Y}⚠ Mas a versão do agente está SOLTA.${Z}"
        item "  Ele está seguindo o canal '${tag_do_worker}', não uma versão fixa — então pode"
        item "  saltar sozinho para a próxima versão num reinício, enquanto o resto do"
        item "  servidor continua onde está."
        item "  ${B}Rode 'bash hostgator-setup-kit/update.sh' mais uma vez${Z} para fixar tudo na"
        item "  mesma versão. É rápido: não há o que baixar de novo."
        ;;
      *)
        item "${D}(o .env não fixa WORKER_IMAGE, mas a imagem não está num canal móvel)${Z}"
        ;;
    esac
  fi
  exit 0
fi

titulo "${R}✗ Esta instalação ESTÁ afetada.${Z}"
item "O worker — o processo que faz o agente de IA atender — está rodando uma"
item "imagem ${B}construída dentro deste servidor${Z}, não a publicada pelo projeto."
printf '\n'
item "${B}Como sabemos:${Z}"
item "  • a imagem '${IMG_WORKER}' não tem a marca de revisão que o nosso CI"
item "    carimba em toda imagem publicada (org.opencontainers.image.revision)"
if [ "$SABOR_LOCAL" = "build_local" ]; then
  item "  • ela tem as demais etiquetas do projeto, então foi construída a partir"
  item "    do código atual — pode ter sido uma escolha sua (build local)"
fi
[ "$ENV_TEM_WORKER" = "nao" ] && item "  • o .env desta instalação não fixa a versão do worker"

if [ -n "$CRIADA_WORKER" ] && [ -n "$CRIADA_APP" ] && [ "$CRIADA_WORKER" != "$CRIADA_APP" ]; then
  printf '\n'
  item "${B}O quanto ele ficou para trás:${Z}"
  item "  o app é de ${CRIADA_APP} e o worker é de ${CRIADA_WORKER}."
  # `date -d` é GNU; numa VPS Ubuntu existe. Se não existir, o texto acima já
  # entregou as duas datas — a conta é conforto, não o dado.
  if command -v date >/dev/null 2>&1 && date -d "$CRIADA_APP" +%s >/dev/null 2>&1; then
    DIAS=$(( ( $(date -d "$CRIADA_APP" +%s) - $(date -d "$CRIADA_WORKER" +%s) ) / 86400 ))
    [ "$DIAS" -gt 0 ] && item "  são ${B}${DIAS} dias${Z} de correções que o agente não recebeu."
  fi
fi

cat <<TEXTO

  ${B}O que isso significa na prática${Z}
  O resto do sistema foi atualizando normalmente. Só o agente de IA ficou parado
  no código do dia em que você instalou — inclusive correções de coisas que o seu
  cliente sente: resposta saindo duplicada, áudio e imagem que o cliente manda não
  virando conteúdo para a IA, e classificação de sentimento falhando em silêncio.

  Nada foi perdido: conversas, contatos e a conexão do WhatsApp estão intactos.
  O que faltou foi o agente receber as melhorias.

  ${B}O que fazer${Z}
  O conserto é uma atualização normal, e ${B}quem decide quando é você${Z}:

      cd $PROJETO
      bash hostgator-setup-kit/update.sh

  Ele faz backup do banco antes, e o passo a passo — com como voltar atrás — está
  em docs/runbooks/remediar-worker-congelado.md.

  ${D}Este diagnóstico não mudou nada na sua instalação. Só olhou.${Z}
TEXTO
exit 1
