#!/usr/bin/env bash
# Prova que a senha das rotinas que o log do sistema guardou (#1054) é trocada
# sozinha, UMA vez, sem pedir edição de `.env` — e que a troca não acontece onde
# quebraria alguém.
#
#   bash tests/shell/senha-do-cron-vazada.test.sh
#
# O `_common.sh` e o `agent.sh` REAIS são executados. Os dublês ficam no PATH
# (`docker`, `crontab`, `curl`, `git`, `openssl` fica o real) e registram o que
# foi chamado. O que se mede é o EFEITO em disco: o `.env`, o arquivo do
# cabeçalho do cron, o crontab e a marca — não o texto do script.
#
# Os scripts chamadores (`update.sh`, `install.sh`) são embrulhos mínimos com o
# NOME certo, porque é pelo nome (`$0`) que `setup_event_log_drain_cron` decide
# se é o update.sh — o corpo real deles faz git/pull/baseline, fora do alcance
# desta prova. O `agent.sh` roda inteiro.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$RAIZ/hostgator-setup-kit"
WORK="$(mktemp -d)"
[ -n "${MANTER:-}" ] || trap 'rm -rf "$WORK"' EXIT; echo "WORK=$WORK"

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }

VELHA="segredo-velho-que-foi-pro-syslog-a1b2c3"
URL="https://crm.exemplo.com.br"

mkdir -p "$WORK/bin"
# docker: `compose ... exec` é a sonda de saúde (responde healthy); o resto
# registra a chamada. DOCKER_FALHA_UP=1 faz o `up` falhar.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
case " $* " in
  *" exec "*) printf 'healthy\n{}\n'; exit 0 ;;
  *" up "*)   printf '%s\n' "$*" >> "$DUBLE_LOG/docker-up"; [ -z "${DOCKER_FALHA_UP:-}" ] || exit 1; exit 0 ;;
esac
exit 0
STUB
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -l) [ -f "$DUBLE_LOG/crontab" ] || { echo "no crontab for root" >&2; exit 1; }; cat "$DUBLE_LOG/crontab" ;;
  -)  cat > "$DUBLE_LOG/crontab.novo" && mv "$DUBLE_LOG/crontab.novo" "$DUBLE_LOG/crontab" ;;
esac
STUB
# curl: o agent.sh anuncia a versão; a resposta não pede atualização.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
prev=""; for a in "$@"; do [ "$prev" = "-H" ] && case "$a" in Authorization:*) printf '%s\n' "$a" >> "$DUBLE_LOG/curl-auth" ;; esac; prev="$a"; done
printf '{"data":{"update_requested":false}}\n200'
STUB
cat > "$WORK/bin/git" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in rev-parse) echo abc1234 ;; esac
exit 0
STUB
# A guarda de arquitetura do `_common.sh` recusa install/update em ARM (o Mac
# de quem roda a suíte); a VPS de verdade é x86_64.
cat > "$WORK/bin/uname" <<'STUB'
#!/usr/bin/env bash
echo x86_64
STUB
chmod +x "$WORK/bin/"*

# Um projeto fresco por cenário. `legado=1` = o crontab tem a linha antiga,
# com a senha escrita — o estado de toda instalação anterior ao #1054.
novo_projeto() {  # novo_projeto <nome> <legado:0|1|sem-drain>
  local p="$WORK/$1"
  mkdir -p "$p/proj/hostgator-setup-kit" "$p/log"
  cp "$KIT/_common.sh" "$KIT/_i18n.sh" "$KIT/agent.sh" "$p/proj/hostgator-setup-kit/"
  : > "$p/proj/docker-compose.prod.yml"
  printf 'INTERNAL_SECRET="segredo-do-scheduler-9z9z"\nINTERNAL_CRON_SECRET="%s"\nNEXT_PUBLIC_APP_URL="%s"\n' "$VELHA" "$URL" > "$p/proj/.env"
  case "$2" in
    1) printf '* * * * * curl -fsS -H "Authorization: Bearer %s" "%s/api/v1/cron/event-log-drain" >/dev/null 2>&1\n' "$VELHA" "$URL" > "$p/log/crontab" ;;
    0) printf '* * * * * curl -fsS -H @"%s/.env.cron-drain" "%s/api/v1/cron/event-log-drain" >/dev/null 2>&1 # deskcomm:%s:drain\n' "$p/proj" "$URL" "$p/proj" > "$p/log/crontab"
       printf 'Authorization: Bearer %s\n' "$VELHA" > "$p/proj/.env.cron-drain"; chmod 600 "$p/proj/.env.cron-drain" ;;
    sem-drain) : ;;
  esac
  # Os embrulhos com o NOME que a função confere.
  for nome in update install; do
    cat > "$p/proj/hostgator-setup-kit/$nome.sh" <<ROTEIRO
set -euo pipefail
source "\$(dirname "\$0")/_common.sh"
enter_project
psql_run() { :; }
[ "$nome" = install ] && marcar_segredo_do_cron_como_novo
setup_event_log_drain_cron
ROTEIRO
  done
}

rodar() {  # rodar <cenario> <script> [VAR=valor...]
  local p="$WORK/$1" s="$2"; shift 2
  ( cd "$p/proj" && env PATH="$WORK/bin:$PATH" DUBLE_LOG="$p/log" "$@" bash "hostgator-setup-kit/$s" ) > "$p/log/saida-$s" 2>&1
}

valor_env() { grep -E "^$2=" "$WORK/$1/proj/.env" | tail -1 | cut -d= -f2- | tr -d '"'; }
ups() { [ -f "$WORK/$1/log/docker-up" ] && wc -l < "$WORK/$1/log/docker-up" | tr -d ' ' || echo 0; }

echo "update.sh no terminal, numa instalação que vazou a senha"
novo_projeto a 1
rodar a update.sh
NOVA="$(valor_env a INTERNAL_CRON_SECRET)"
check "rodou até o fim (saída 0)" grep -q 'automações ativas' "$WORK/a/log/saida-update.sh"
check "a senha no .env mudou" [ "$NOVA" != "$VELHA" ]
check "a senha nova tem 64 hex" bash -c '[[ "$1" =~ ^[0-9a-f]{64}$ ]]' _ "$NOVA"
check "o INTERNAL_SECRET (que nunca foi pro log) ficou como estava" [ "$(valor_env a INTERNAL_SECRET)" = "segredo-do-scheduler-9z9z" ]
check "os contêineres foram recriados (1 up -d)" [ "$(ups a)" = 1 ]
check "o arquivo do cron leva a senha nova" [ "$(cat "$WORK/a/proj/.env.cron-drain")" = "Authorization: Bearer $NOVA" ]
check "nenhuma linha do crontab carrega senha" bash -c '! grep -q "Bearer" "$1"' _ "$WORK/a/log/crontab"
check "a marca foi gravada" [ -e "$WORK/a/proj/.deskcomm-segredo-do-cron-trocado" ]
check "o aviso recomenda apagar os logs antigos" grep -q 'apagar os logs antigos' "$WORK/a/log/saida-update.sh"

echo "de novo: não troca outra vez"
rodar a update.sh
check "a senha é a mesma da primeira troca" [ "$(valor_env a INTERNAL_CRON_SECRET)" = "$NOVA" ]
check "nenhum up -d a mais" [ "$(ups a)" = 1 ]

echo "update.sh numa instalação que já tinha o arquivo do cron (#1054 já aplicado)"
novo_projeto b 0
rodar b update.sh
NOVA_B="$(valor_env b INTERNAL_CRON_SECRET)"
check "troca mesmo com o arquivo já existindo" [ "$NOVA_B" != "$VELHA" ]
check "o arquivo passa a levar a senha nova" [ "$(cat "$WORK/b/proj/.env.cron-drain")" = "Authorization: Bearer $NOVA_B" ]
check "a linha do crontab continua uma só" [ "$(grep -c 'event-log-drain' "$WORK/b/log/crontab")" = 1 ]

echo "update.sh dirigido pelo botão da tela: NÃO troca (o agente fala com a senha velha)"
novo_projeto c 1
rodar c update.sh DESKCOMM_AGENT_REPORT=1
check "a senha segue a velha" [ "$(valor_env c INTERNAL_CRON_SECRET)" = "$VELHA" ]
check "sem marca — a troca fica para o agent.sh" [ ! -e "$WORK/c/proj/.deskcomm-segredo-do-cron-trocado" ]
check "nenhum up -d" [ "$(ups c)" = 0 ]

echo "agent.sh na execução seguinte: troca e já anuncia com a senha nova"
rodar c agent.sh
NOVA_C="$(valor_env c INTERNAL_CRON_SECRET)"
check "a senha no .env mudou" [ "$NOVA_C" != "$VELHA" ]
check "a marca foi gravada" [ -e "$WORK/c/proj/.deskcomm-segredo-do-cron-trocado" ]
check "a linha legada do crontab foi reescrita" bash -c '! grep -q "Bearer" "$1"' _ "$WORK/c/log/crontab"
check "o anúncio da versão foi com a senha NOVA" grep -qx "Authorization: Bearer $NOVA_C" "$WORK/c/log/curl-auth"
check "nenhuma chamada saiu com a senha velha" bash -c '! grep -q "$1" "$2"' _ "$VELHA" "$WORK/c/log/curl-auth"
check "a troca ficou registrada no log do agente" grep -q 'troquei a senha interna' "$WORK/c/proj/.update-agent.log"
rodar c agent.sh
check "a próxima execução do agente não troca de novo" [ "$(valor_env c INTERNAL_CRON_SECRET)" = "$NOVA_C" ]

echo "instalação nova: nasce marcada, sem troca"
novo_projeto d sem-drain
rodar d install.sh
check "a marca foi gravada" [ -e "$WORK/d/proj/.deskcomm-segredo-do-cron-trocado" ]
check "a senha é a que o install gerou" [ "$(valor_env d INTERNAL_CRON_SECRET)" = "$VELHA" ]
check "nenhum up -d" [ "$(ups d)" = 0 ]
rodar d agent.sh
check "o agent.sh depois dela também não troca" [ "$(valor_env d INTERNAL_CRON_SECRET)" = "$VELHA" ]

echo "reinstalar por cima de uma instalação que vazou: NÃO marca"
novo_projeto e 1
rodar e install.sh
check "sem marca — a próxima atualização ainda troca" [ ! -e "$WORK/e/proj/.deskcomm-segredo-do-cron-trocado" ]

echo "host que nunca teve a linha do drain: nada vazou, nada a trocar"
novo_projeto f sem-drain
rodar f update.sh
check "a senha segue a mesma" [ "$(valor_env f INTERNAL_CRON_SECRET)" = "$VELHA" ]
check "nenhum up -d" [ "$(ups f)" = 0 ]
check "marcado para não perguntar de novo" [ -e "$WORK/f/proj/.deskcomm-segredo-do-cron-trocado" ]

echo "o app não sobe com a senha nova: volta a velha e tenta de novo depois"
novo_projeto g 1
rodar g update.sh DOCKER_FALHA_UP=1
check "o .env voltou para a senha velha" [ "$(valor_env g INTERNAL_CRON_SECRET)" = "$VELHA" ]
check "sem marca — tenta na próxima" [ ! -e "$WORK/g/proj/.deskcomm-segredo-do-cron-trocado" ]
check "o arquivo do cron segue com a senha que o app aceita" [ "$(cat "$WORK/g/proj/.env.cron-drain")" = "Authorization: Bearer $VELHA" ]
check "a atualização não morreu por isso" grep -q 'automações ativas' "$WORK/g/log/saida-update.sh"

echo "só INTERNAL_SECRET (o CRON vazio): troca o que foi pro log"
novo_projeto h 1
sed -i.bak -E 's/^INTERNAL_CRON_SECRET=.*/INTERNAL_CRON_SECRET=""/' "$WORK/h/proj/.env"
rodar h update.sh
check "o INTERNAL_SECRET mudou" [ "$(valor_env h INTERNAL_SECRET)" != "segredo-do-scheduler-9z9z" ]
check "o arquivo do cron leva o INTERNAL_SECRET novo" [ "$(cat "$WORK/h/proj/.env.cron-drain")" = "Authorization: Bearer $(valor_env h INTERNAL_SECRET)" ]

echo
if [ "$FAILS" -gt 0 ]; then echo "✗ $FAILS falha(s)"; exit 1; fi
echo "✓ senha do cron vazada: todos os casos passaram"
