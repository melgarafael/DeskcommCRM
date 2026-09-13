#!/usr/bin/env bash
# O aviso que assume a porta enquanto o CRM esta parado para mexer no banco.
#
# ## Por que um conteiner separado, e nao um "modo manutencao" dentro do app
#
# Porque o app e justamente quem precisa PARAR. Medido na instalacao real: com
# ele de pe, 60 travamentos ao aplicar o baseline; com ele parado e mais tres
# pecas do Supabase, zero. Um modo dentro dele exigiria mante-lo no ar, que e o
# oposto do conserto.
#
# E nao ha `middleware.ts` no projeto (medido em 2026-09-12). Criar um so para
# isto poria uma peca no caminho de TODA requisicao do produto para resolver uma
# janela de poucos minutos por atualizacao.
#
# ## As DUAS hospedagens, e por que o caminho e diferente em cada uma
#
# O kit atende dois arranjos de proxy, e eles nao se parecem:
#
#   traefik  → o proxy da hospedagem LE LABELS dos conteineres. O aviso sobe com
#              as mesmas regras de roteamento do app e prioridade maior, e o
#              proxy passa a entregar o aviso sem ninguem editar nada.
#
#   caddy    → o proxy e NOSSO, e a regra dele mora num arquivo dentro do
#              conteiner (`reverse_proxy app:3000` no Caddyfile). Editar esse
#              arquivo no meio de uma atualizacao e mexer em configuracao que o
#              dono pode ter customizado. O caminho aqui e outro: o aviso entra
#              na rede interna com o APELIDO `app` enquanto o CRM esta parado, e
#              atende em 3000. O Caddy procura no mesmo lugar de sempre e acha
#              quem responder.
#
# ⚠️ O apelido e o motivo de `manutencao_desce` vir ANTES de `dc up -d app`, e
# nao depois. Com os dois de pe ao mesmo tempo, o Docker faz rodizio entre eles:
# metade das pessoas veria "estamos atualizando" com o CRM ja no ar. A janela
# que se abre por vir antes dura o `docker rm` — e, nela, o que aparece e o
# mesmo 502 que aparecia o tempo todo antes desta pagina existir.
#
# ## O que foi MEDIDO no compose, contra o que o plano dizia
#
# O plano desta onda escrevia `${APP_DOMAIN}` e `tls=true`. As duas estao
# erradas e as duas quebrariam a instalacao:
#
#   - a variavel do dominio e `DOMAIN` (docker-compose.traefik.yml). `APP_DOMAIN`
#     nao existe em lugar nenhum do kit, e sob `set -u` a atualizacao morreria
#     na linha — com o CRM ja parado;
#   - `tls=true` sem `certresolver` faz o Traefik servir o certificado interno
#     dele. Quem abrisse o CRM durante a atualizacao veria um aviso de site
#     inseguro, que e pior que o erro de conexao que ja via.
set -euo pipefail

NOME_DA_MANUTENCAO="deskcomm-manutencao"

manutencao_sobe() {
  local html="$KIT_DIR/manutencao"
  [ -d "$html" ] || return 0
  docker rm -f "$NOME_DA_MANUTENCAO" >/dev/null 2>&1 || true

  local args=(
    -d --name "$NOME_DA_MANUTENCAO"
    -v "$html/index.html:/usr/share/nginx/html/index.html:ro"
    -v "$html/nginx.conf:/etc/nginx/conf.d/default.conf:ro"
  )

  if [ "${REVERSE_PROXY:-caddy}" = "traefik" ]; then
    local rede="${TRAEFIK_NETWORK:-traefik}"
    local ep="${TRAEFIK_ENTRYPOINT:-websecure}"
    local ep_http="${TRAEFIK_ENTRYPOINT_HTTP:-web}"
    local cr="${TRAEFIK_CERTRESOLVER:-letsencrypt}"
    local dom="${DOMAIN:-}"
    # Sem dominio nao ha rota possivel. Calar aqui e melhor que subir um
    # conteiner que nunca sera alcancado e que alguem tera de limpar a mao.
    [ -n "$dom" ] || return 0
    args+=(
      --network "$rede"
      --label "traefik.enable=true"
      --label "traefik.docker.network=$rede"
      # Prioridade 500: acima de qualquer regra `Host(...)` (a prioridade padrao
      # do Traefik e o TAMANHO da regra) e abaixo do 1000 do bloqueio do webhook
      # global do WAHA, que continua tendo de barrar durante a atualizacao.
      --label "traefik.http.routers.deskcomm-manutencao.rule=Host(\`$dom\`)"
      --label "traefik.http.routers.deskcomm-manutencao.entrypoints=$ep"
      --label "traefik.http.routers.deskcomm-manutencao.tls.certresolver=$cr"
      --label "traefik.http.routers.deskcomm-manutencao.priority=500"
      --label "traefik.http.routers.deskcomm-manutencao.service=deskcomm-manutencao"
      # O redirecionamento http→https vive nos labels do APP, e o app esta
      # parado — o Traefik so enxerga conteiner em execucao, entao aquela regra
      # some junto. Por isso o aviso atende nas duas portas em vez de redirecionar.
      --label "traefik.http.routers.deskcomm-manutencao-http.rule=Host(\`$dom\`)"
      --label "traefik.http.routers.deskcomm-manutencao-http.entrypoints=$ep_http"
      --label "traefik.http.routers.deskcomm-manutencao-http.priority=500"
      --label "traefik.http.routers.deskcomm-manutencao-http.service=deskcomm-manutencao"
      --label "traefik.http.services.deskcomm-manutencao.loadbalancer.server.port=3000"
    )
  else
    args+=(--network "$(nome_do_projeto_atual)_internal" --network-alias app)
  fi

  docker run "${args[@]}" nginx:alpine >/dev/null 2>&1 || true
}

manutencao_desce() {
  docker rm -f "$NOME_DA_MANUTENCAO" >/dev/null 2>&1 || true
}
