#!/bin/sh
# ── O VIGIA DO DRENO DE EVENTOS ─────────────────────────────────────────────
#
# Chamado pelo crontab do HOST, de 15 em 15 minutos (o `scheduler` do compose
# chama o mesmo dreno a cada minuto). O relato da issue #2235 mediu o defeito:
# o `event-log-drain` rodava DUAS vezes por minuto — uma pelo contêiner
# `scheduler`, outra por esta linha do host — e ~62% das chamadas `service_role`
# ao PostgREST eram da `event_log`, o endpoint nº 1 do egress de um kit parado.
#
# O que NÃO se perde: se o `scheduler` cair (contêiner parado, imagem quebrada,
# `docker compose up` sem o serviço), o dreno não pode parar — sem ele, toda
# automação, webhook e derivação de mídia para em silêncio. Por isso a linha do
# host não é removida: ela vira VIGIA, e só bate no dreno quando o `scheduler`
# NÃO está de pé. Instalação saudável paga ~4 chamadas/hora em vez de 60.
#
# A regra de falha é ABERTA, de propósito: `docker` ausente, sem permissão no
# socket ou compose com outro nome de projeto ⇒ o vigia NÃO consegue provar que
# o scheduler está vivo, então ele roda o dreno. Na dúvida, o evento chega —
# no pior caso voltamos ao comportamento antigo por algumas horas, nunca a um
# dreno parado (que é a promessa do produto que se quebra em silêncio).
#
# uso: drain-watchdog.sh <url-do-cron> <arquivo-do-cabecalho> <projeto-compose>
set -u

url="${1:-}"
cabecalho="${2:-}"
projeto="${3:-}"

if [ -z "$url" ] || [ -z "$cabecalho" ]; then
  echo "drain-watchdog: falta a URL ou o arquivo do segredo — não disparei o dreno." >&2
  exit 2
fi

# `com.docker.compose.service` e `.project` são rótulos que o compose grava em
# todo contêiner que ele cria; filtrar por eles acha o scheduler desta
# instalação sem depender de QUAL arquivo de compose ela usa (prod, single-server
# ou local) nem do diretório de trabalho deste script. `docker ps` sem `-a` só
# lista o que está RODANDO — um contêiner parado não conta como dreno de pé.
if command -v docker >/dev/null 2>&1 && [ -n "$projeto" ]; then
  vivo="$(docker ps -q \
    --filter "label=com.docker.compose.project=$projeto" \
    --filter "label=com.docker.compose.service=scheduler" 2>/dev/null)"
  if [ -n "$vivo" ]; then
    exit 0
  fi
fi

exec curl -fsS -m 45 -H @"$cabecalho" "$url" >/dev/null 2>&1
