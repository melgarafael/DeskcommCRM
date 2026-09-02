#!/bin/sh
# Entrypoint do deskcomm-scheduler: escreve o crontab e entrega o PID 1 ao crond.
#
# Por que gerar em runtime em vez de assar o arquivo na imagem: o INTERNAL_SECRET
# só existe no .env do cliente, e o busybox crond não expande variáveis dentro da
# linha do cron. Então a expansão acontece aqui, uma vez, no start.
#
# O que MUDOU em relação ao `command:` inline do compose: não há mais
# `apk add --no-cache curl tzdata` a cada start. curl e tzdata vêm na imagem. O
# cron do cliente deixa de depender de a VPS ter internet e de o mirror do Alpine
# estar de pé no momento de um restart — que é justamente o momento em que a
# máquina está se recuperando de alguma coisa.
set -eu

if [ -z "${INTERNAL_SECRET:-}" ]; then
  echo "scheduler: INTERNAL_SECRET vazio — os crons responderiam 401 em silêncio." >&2
  echo "scheduler: confira a chave no .env e suba de novo." >&2
  exit 1
fi

# Constante, não configuração: `app` é o nome do serviço na rede interna do
# compose, e o scheduler não fala com mais nada. A primeira versão disto lia um
# `SCHEDULER_APP_ORIGIN` que o compose nunca repassava e nenhum template
# documentava — controle decorativo, que é pior que controle nenhum: quem o
# encontrasse no código o definiria no `.env` e não veria efeito.
APP_ORIGIN="http://app:3000"

# O crond executa cada linha por `/bin/sh -c`, então o segredo é REAVALIADO pelo
# shell na hora de disparar. Interpolá-lo cru dentro de aspas duplas fazia com
# que um `$` no valor virasse expansão de variável (o header sairia truncado, e
# todo cron responderia 401 em silêncio) e uma crase virasse substituição de
# comando — execução arbitrária a cada minuto. Medido com um segredo hostil: a
# versão com aspas duplas entregava `segrafaelmelgacoredo/Users/rafaelmelgaco…`,
# com o `whoami` EXECUTADO. Aqui o valor vai entre aspas SIMPLES, com as aspas
# simples internas escapadas — dentro delas o sh não interpreta nada.
SEGREDO_SEGURO="$(printf '%s' "$INTERNAL_SECRET" | sed "s/'/'\\\\''/g")"

# minuto|timeout|caminho — uma linha por cron. O caminho vai COMPLETO de
# propósito: o literal `api/v1/cron/<rota>` é o contrato que
# tests/unit/cron-routes-scheduled.test.ts (e mais dois) leem por grep — esse
# teste compara a lista com o diretório app/api/v1/cron, e rota criada sem
# agendamento reprova o CI.
CRONS="
* * * * *|25|api/v1/cron/agent-dispatcher
* * * * *|25|api/v1/cron/followup-flow-worker
* * * * *|45|api/v1/cron/event-log-drain
* * * * *|25|api/v1/cron/routing-worker
* * * * *|25|api/v1/cron/recover-stuck-messages
*/5 * * * *|25|api/v1/cron/storage-redaction?limit=50
*/5 * * * *|25|api/v1/cron/snooze-watcher
*/5 * * * *|25|api/v1/cron/attendant-heartbeat
*/5 * * * *|45|api/v1/cron/channel-health
*/10 * * * *|60|api/v1/cron/contact-avatars
*/10 * * * *|60|api/v1/cron/appointment-reminder
0 * * * *|60|api/v1/cron/appointment-outcome-nudge
*/15 * * * *|60|api/v1/cron/risk-watcher
*/30 * * * *|60|api/v1/cron/contact-phones
17 * * * *|60|api/v1/cron/contact-proposals-watcher
0 12 * * *|60|api/v1/cron/lgpd-sla-watcher
30 3 * * *|120|api/v1/cron/kb-conversations-batch
15 4 * * *|60|api/v1/cron/sync-model-catalog
10 3 * * *|60|api/v1/cron/event-log-purge
40 3 * * *|120|api/v1/cron/prune-old-media
"

# CRONTAB_PATH é ponto de injeção do teste (tests/shell/scheduler-entrypoint.test.sh).
# Sem ele este script só seria exercitável dentro de um contêiner — e o único
# artefato executável novo desta entrega ficaria sem gate nenhum, que foi
# exatamente o achado da revisão adversarial.
DESTINO="${CRONTAB_PATH:-/etc/crontabs/root}"

umask 077
: > "$DESTINO"
echo "$CRONS" | while IFS='|' read -r quando timeout rota; do
  [ -n "$rota" ] || continue
  printf '%s curl -fsS -m%s -H '"'"'Authorization: Bearer %s'"'"' "%s/%s" >/dev/null 2>&1\n' \
    "$quando" "$timeout" "$SEGREDO_SEGURO" "$APP_ORIGIN" "$rota" >> "$DESTINO"
done

exec crond -f -l 2
