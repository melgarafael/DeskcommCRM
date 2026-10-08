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

# minuto|timeout|caminho — uma linha por cron. O caminho vai COMPLETO de
# propósito: o literal `api/v1/cron/<rota>` é o contrato que
# tests/unit/cron-routes-scheduled.test.ts (e mais dois) leem por grep — esse
# teste compara a lista com o diretório app/api/v1/cron, e rota criada sem
# agendamento reprova o CI.
# A agenda do Google entra com DUAS cadências, e elas são diferentes de propósito.
#
# RENOVAÇÃO a cada 10 min: o access_token do Google expira em cerca de 1h, e a
# rodada só renova quem está a menos de 15 min do vencimento. Dez minutos deixa
# pelo menos uma tentativa de folga dentro da janela — a 15 min, um tick atrasado
# já deixaria o token vencer. É barata: só toca conexão perto de expirar, e
# rodada vazia não audita.
#
# SYNC a cada 15 min, e NÃO na mesma cadência. Os custos são diferentes: renovar
# é uma requisição por conexão que está vencendo; sincronizar é uma por
# calendário, sempre. Colar as duas obrigaria a escolher entre renovar raro
# demais (e a agenda morre) ou sincronizar caro demais (e gasta cota do cliente).
#
# ⚠️ E o comentário fica AQUI, fora da string: dentro de CRONS= ele não seria
# comentário, seria DADO — e crase em prosa dentro de aspas duplas o shell
# EXECUTA. Foi o que quebrou o entrypoint na primeira tentativa desta linha.
CRONS="
* * * * *|240|api/v1/cron/prospecting
* * * * *|25|api/v1/cron/agent-dispatcher
* * * * *|25|api/v1/cron/followup-flow-worker
* * * * *|45|api/v1/cron/event-log-drain
* * * * *|25|api/v1/cron/routing-worker
*/5 * * * *|25|api/v1/cron/recover-stuck-messages
* * * * *|25|api/v1/cron/proposta-travada
* * * * *|45|api/v1/cron/webhook-replay
*/5 * * * *|25|api/v1/cron/storage-redaction?limit=50
*/5 * * * *|25|api/v1/cron/snooze-watcher
*/5 * * * *|60|api/v1/cron/handoff-devolucao
# A CAMPANHA. Minuto a minuto, e a rodada manda no máximo uma mensagem por
# número: é o cron que dá a cadência base, e o ritmo da campanha e do canal
# (channel_knobs + pacing_ledger) só sabem torná-la mais lenta.
* * * * *|45|api/v1/cron/campaign-worker
*/5 * * * *|60|api/v1/cron/webhook-log-retention
*/5 * * * *|45|api/v1/cron/channel-health
*/10 * * * *|60|api/v1/cron/contact-avatars
*/10 * * * *|60|api/v1/cron/agenda-google-refresh
*/15 * * * *|90|api/v1/cron/agenda-google-sync
# A IDA. Cadência mais curta que a volta de propósito: quem marcou pela tela
# espera ver o compromisso no celular dele em minutos, e a ida é barata (só
# manda o que mudou). A volta é cara — varre calendário inteiro — e por isso
# roda a cada 15.
*/5 * * * *|60|api/v1/cron/agenda-google-push
# O LEMBRETE. A cada 5 minutos porque a antecedência é escolhida pelo dono no
# tipo de agendamento; uma varredura mais lenta transformaria avisar 30 minutos
# antes em avisar entre 30 e 45 minutos antes. Barato: só olha compromisso
# confirmado, futuro e ainda não avisado.
*/5 * * * *|45|api/v1/cron/agenda-reminder
*/15 * * * *|45|api/v1/cron/agenda-expira-pendentes
*/15 * * * *|60|api/v1/cron/risk-watcher
# O CASO PARADO. De hora em hora, e não a cada 5 minutos: o prazo é de 24h, e
# uma varredura mais frequente só gastaria consulta para descobrir o mesmo nada.
7 * * * *|60|api/v1/cron/case-stale-watcher
*/30 * * * *|60|api/v1/cron/contact-phones
17 * * * *|60|api/v1/cron/contact-proposals-watcher
23 * * * *|60|api/v1/cron/followup-sem-agente
# O ANIVERSÁRIO. De hora em hora, e não uma vez ao dia, porque quem decide o
# momento é o relógio de parede de CADA organização: a rodada só age naquela
# cujo fuso marca a hora de parabenizar. Uma varredura diária em UTC felicitaria
# no dia errado metade do mundo e de madrugada boa parte do resto. Barato: quem
# não configurou a automação não chega a ser varrido.
7 * * * *|60|api/v1/cron/contact-birthdays
# A DATA DO FUNIL (#989). Mesma cadência e mesmo motivo do aniversário: de hora
# em hora, e quem decide o momento é o relógio de parede de CADA organização —
# a rodada só age naquela que marca a hora da varredura. Minuto diferente do
# aniversário para as duas não disputarem a mesma batida num self-host pequeno.
23 * * * *|60|api/v1/cron/lead-date-field-due
# #1540 — silêncio e etapa parada: gatilhos por TEMPO (ausência de evento), então
# rodam de hora em hora e a trava no event_log (regra:negócio:âncora) segura a
# repetição enquanto a âncora não mudar. Minuto 37, e não o 23 da data do funil:
# as duas varrem crm_leads e não devem disputar a mesma batida num self-host pequeno.
37 * * * *|60|api/v1/cron/lead-time-triggers
# A COBRANCA DOS SEUS CLIENTES. De hora em hora: a reativacao chega pelo aviso
# do provedor, em segundos, e a hora so pesa na regua, que conta em dias. Minuto
# 43, longe das outras varreduras horarias. Chave desligada: sai na hora.
43 * * * *|120|api/v1/cron/cobranca
# O canal mudo (doc 11, decisão B): varredura de banco, sem rede, com régua em
# DIAS. Diária e de madrugada porque o estado que ela lê muda em dias — de 5 em
# 5 minutos seriam 288 varreduras para nada, e o aviso chegaria na mesma hora.
50 5 * * *|60|api/v1/cron/canal-mudo-watcher
0 12 * * *|60|api/v1/cron/lgpd-sla-watcher
30 3 * * *|120|api/v1/cron/kb-conversations-batch
15 4 * * *|60|api/v1/cron/sync-model-catalog
40 4 * * *|120|api/v1/cron/data-retention
0 8 * * *|60|api/v1/cron/proposal-expiry
30 8 * * *|60|api/v1/cron/proposal-promised-not-created
0 6 * * 0|60|api/v1/cron/proposal-acceptance-rate
20 5 * * *|120|api/v1/cron/media-retention
# AS RECORRÊNCIAS. Uma vez ao dia é o bastante: o que ela gera é uma conta a
# pagar, e a diferença entre nascer às 5h ou às 17h não muda nada para quem paga.
# Barato: uma consulta por instalação, e quem não tem molde nenhum sai na hora.
50 5 * * *|60|api/v1/cron/recurring-entries
"

# CRONTAB_PATH é ponto de injeção do teste (tests/shell/scheduler-entrypoint.test.sh).
# Sem ele este script só seria exercitável dentro de um contêiner — e o único
# artefato executável novo desta entrega ficaria sem gate nenhum, que foi
# exatamente o achado da revisão adversarial.
DESTINO="${CRONTAB_PATH:-/etc/crontabs/root}"

umask 077
# O segredo vai num ARQUIVO, nunca na linha do crontab. Cada linha vira o
# argumento de um `/bin/sh -c`, e argumento de processo aparece no `ps` do host
# para qualquer usuário local enquanto o job roda — e o curl vive até o `-m`.
# O curl lê o header com `-H @arquivo` (curl ≥ 7.55), o mesmo padrão do
# `.env.cron-drain` do kit. De brinde, o valor deixa de passar pelo sh do crond:
# `$`, crase e aspas no segredo não precisam mais de escape nenhum.
# CRON_AUTH_DIR é ponto de injeção do teste, como o CRONTAB_PATH abaixo.
AUTH_DIR="${CRON_AUTH_DIR:-/run/deskcomm-cron}"
AUTH_FILE="$AUTH_DIR/header"
mkdir -p "$AUTH_DIR"
chmod 700 "$AUTH_DIR"
# Com o umask 077 o arquivo nasce 600 desde o primeiro byte; o chmod cobre um
# arquivo que já existisse de um start anterior.
printf 'Authorization: Bearer %s\n' "$INTERNAL_SECRET" > "$AUTH_FILE"
chmod 600 "$AUTH_FILE"

: > "$DESTINO"
echo "$CRONS" | while IFS='|' read -r quando timeout rota; do
  [ -n "$rota" ] || continue
  # `>/dev/null` só no STDOUT: o corpo da resposta é grande e não interessa aqui.
  # O STDERR era o que a redireção antiga (`>/dev/null 2>&1`) engolia junto — e
  # foi ali que a issue #1109 ficou seis versões invisível: o `sync-model-catalog`
  # tomava 401 do scheduler todo dia, o `curl -f` saía diferente de zero e o
  # crontab descartava saída E erro, então o catálogo ficava vazio sem que
  # ninguém visse um sintoma. Agora o status continua no STDERR do `curl -fsS`
  # (é o `-S` que o imprime) e, quando o comando falha, a linha acrescenta uma
  # frase dizendo qual rota falhou e o que conferir — os dois no STDERR, que o
  # `crond -f` entrega ao `docker logs` do scheduler. Em rodada saudável não há
  # uma linha a mais: o `||` só dispara em falha.
  # % é proibido aqui (crontab de vixie trata como início de stdin) e `$`/crase
  # seriam reavaliados pelo sh do crond — nenhum dos dois aparece na mensagem.
  printf '%s curl -fsS -m%s -H '"'"'@%s'"'"' "%s/%s" >/dev/null || echo "deskcomm-cron: FALHOU %s — veja o erro do curl logo acima; se for 401 ou 403, o segredo que este scheduler manda não é o que o app enxerga: confira INTERNAL_SECRET/INTERNAL_CRON_SECRET no .env e rode docker compose up -d --force-recreate app scheduler" >&2\n' \
    "$quando" "$timeout" "$AUTH_FILE" "$APP_ORIGIN" "$rota" "$rota" >> "$DESTINO"
done

exec crond -f -l 2
