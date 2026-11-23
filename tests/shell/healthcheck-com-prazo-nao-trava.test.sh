#!/usr/bin/env bash
# O passo "Saúde interna do app" do healthcheck TERMINA (#5055).
#
#   bash tests/shell/healthcheck-com-prazo-nao-trava.test.sh
#
# MEDIDO em produção (v1.117.0): `/api/v1/health` respondia 200 `healthy` no
# mesmo instante em que o healthcheck ficava parado em
# "Saúde interna do app (/api/v1/health)". O passo é
#   saida="$(app_health_probe 30)"
# e o `app_health_probe` é `com_prazo 30 docker compose … exec -T app node -e …`:
#
#   - sem `</dev/null`, o `docker compose exec -T` herda o terminal e encaminha
#     o stdin. O `timeout` põe o filho num grupo de processos FORA do primeiro
#     plano; ler o terminal de lá PARA o processo (SIGTTIN). O TERM do prazo
#     fica pendente num processo parado, e o `timeout` espera por ele para
#     sempre — o passo nunca termina, com o app saudável.
#   - sem `-k`, um comando que ignora o TERM (ou um filho segurando o pipe)
#     prende a substituição de comando do mesmo jeito: o `timeout` manda TERM e
#     fica esperando.
#
# Nada aqui encosta em Docker nem no projeto real: o que roda é a função
# `com_prazo` do kit com comandos falsos, e o `healthcheck.sh` com um `docker`
# dublê. As provas são de TEMPO e de código de saída — é o que a issue pede
# ("o passo TERMINA"), e é o que o código antigo não entregava.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KIT="$(cd "$REPO_ROOT/hostgator-setup-kit" && pwd)"
FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Lê o stdin, como o `exec -T` do docker encaminha o do terminal.
cat > "$WORK/le-stdin.sh" <<'SH'
read -r linha
printf 'leu:[%s]\n' "${linha:-}"
SH
# 2. Segura o pipe e ignora o TERM: sem `-k` o `timeout` espera para sempre.
cat > "$WORK/segura-pipe.sh" <<'SH'
trap '' TERM
sleep 30
SH
printf 'echo ok\n' > "$WORK/rapido.sh"
printf 'exit 7\n' > "$WORK/falha.sh"

le_rc()  { printf '%s\n' "$1" | sed -n 's/^rc=\([0-9]*\) seg=.*/\1/p'; }
le_seg() { printf '%s\n' "$1" | sed -n 's/^rc=[0-9]* seg=\([0-9]*\)$/\1/p'; }

# Roda a sonda num processo à parte para ler TEMPO e rc do arquivo: se a guarda
# externa tiver de matar tudo (o defeito), não há arquivo — e o caso reprova em
# vez de travar a suíte.
sonda() {  # sonda <nome> <prazo> <script> [--pty]
  local nome="$1" prazo="$2" corpo="$3" pty="${4:-}" saida="$WORK/$1.saida"
  cat > "$WORK/probe-$nome.sh" <<'SH'
set -u
. "$KIT_DIR/_common.sh"
set +e   # o _common.sh liga `set -e`; aqui o código de saída é o dado do teste
inicio=$(date +%s)
com_prazo "$PRAZO" bash "$CORPO"
rc=$?
printf 'rc=%s seg=%s\n' "$rc" "$(( $(date +%s) - inicio ))" > "$SAIDA"
SH
  if [ "$pty" = "--pty" ]; then
    # O pty é o que reproduz o terminal do dono; a guarda externa impede que o
    # defeito (que não termina) trave a suíte.
    timeout -k 2 20 script -qec \
      "env KIT_DIR='$KIT' PRAZO='$prazo' CORPO='$corpo' SAIDA='$saida' bash '$WORK/probe-$nome.sh'" \
      /dev/null >/dev/null 2>&1
  else
    timeout -k 2 25 env KIT_DIR="$KIT" PRAZO="$prazo" CORPO="$corpo" SAIDA="$saida" \
      bash "$WORK/probe-$nome.sh" >/dev/null 2>&1
  fi
  cat "$saida" 2>/dev/null || echo 'matado-pela-guarda'
}

echo '── 1. comando que lê o stdin, num terminal (é o `docker compose exec -T`)'
if ! command -v script >/dev/null 2>&1; then
  printf '  ⚠ pulado: sem `script` (util-linux) não há pty para reproduzir o SIGTTIN\n'
else
  r="$(sonda le-stdin 2 "$WORK/le-stdin.sh" --pty)"
  printf '    resultado: %s\n' "$r"
  seg="$(le_seg "$r")"
  check "terminou (não ficou parado no stdin)" test -n "$seg"
  check "dentro do prazo, com folga (≤ 10s para um prazo de 2s)" test "${seg:-999}" -le 10
  check "a leitura viu o fim do stdin (rc=0), não o terminal" test "$(le_rc "$r")" = 0
fi

echo '── 2. comando que segura o pipe e ignora o TERM (o `-k` do timeout)'
r="$(sonda segura-pipe 2 "$WORK/segura-pipe.sh")"
printf '    resultado: %s\n' "$r"
seg="$(le_seg "$r")"
check "terminou (o timeout não espera quem ignora o TERM)" test -n "$seg"
check "em até 12s: 2s de prazo + 5s do -k, com folga" test "${seg:-999}" -le 12
check "com código de prazo estourado (≠ 0)" \
  bash -c '[ -n "$1" ] && [ "$1" != 0 ]' _ "$(le_rc "$r")"

echo '── 3. o código do comando continua sendo o código do comando'
r="$( ( . "$KIT/_common.sh"; com_prazo 5 bash "$WORK/rapido.sh" ) 2>&1 )"; rc=$?
check "comando rápido: rc=0" test "$rc" -eq 0
check "e a saída passa intacta" test "$r" = ok
r="$( ( . "$KIT/_common.sh"; com_prazo 5 bash "$WORK/falha.sh" ) 2>&1 )"; rc=$?
check "comando que falha: rc=7 (não vira 124)" test "$rc" -eq 7

echo "── 4. o healthcheck chega ao veredito com um app que responde"
mkdir -p "$WORK/bin" "$WORK/projeto"
printf 'services:\n  app:\n    image: x\n' > "$WORK/projeto/docker-compose.prod.yml"
printf 'APP_IMAGE=exemplo/deskcommcrm:1.0.0\nNEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br\n' \
  > "$WORK/projeto/.env"
cat > "$WORK/bin/docker" <<'SH'
#!/usr/bin/env bash
# O `exec -T` encaminha o stdin: é aqui que o passo do healthcheck travava.
# A resposta segue o contrato do app_health_probe: status geral na 1a linha,
# o corpo do /api/v1/health na 2a (a sonda do Node imprime as duas).
case " $* " in
  *" exec "*)
    read -r _ || true
    printf 'healthy\n'
    printf '%s\n' '{"data":{"status":"healthy","checks":{"supabase":{"status":"ok"}}}}'
    ;;
esac
exit 0
SH
chmod +x "$WORK/bin/docker"

inicio=$(date +%s)
saida="$(cd "$WORK/projeto" && timeout -k 2 40 script -qec \
  "env -i PATH='$WORK/bin:$PATH' HOME='$WORK' bash '$KIT/healthcheck.sh'" /dev/null 2>&1)"; rc=$?
seg=$(( $(date +%s) - inicio ))
printf '    veredito em %ss\n' "$seg"
check "o healthcheck terminou (rc=0)" test "$rc" -eq 0
check "em até 35s (o prazo do passo é 30s)" test "$seg" -le 35
check "mostrando o corpo do /api/v1/health" \
  bash -c 'printf "%s" "$1" | grep -qF "\"status\":\"healthy\""' _ "$saida"
check "e o veredito do passo" bash -c 'printf "%s" "$1" | grep -qF "app saudável"' _ "$saida"

echo "── 5. app mudo: o passo termina no prazo e diz que não respondeu"
# O outro desfecho que a issue cobra: o `docker exec` que NÃO responde (o
# resolver saturado da #1955). Aqui o prazo é quem tem de encerrar o passo —
# nem o conserto (stdin fechado) nem o `-k` mudam isso.
mkdir -p "$WORK/bin-mudo"
cat > "$WORK/bin-mudo/docker" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *" exec "*) sleep 40 ;;
esac
exit 0
SH
chmod +x "$WORK/bin-mudo/docker"

inicio=$(date +%s)
saida="$(cd "$WORK/projeto" && timeout -k 2 45 script -qec \
  "env -i PATH='$WORK/bin-mudo:$PATH' HOME='$WORK' bash '$KIT/healthcheck.sh'" /dev/null 2>&1)"; rc=$?
seg=$(( $(date +%s) - inicio ))
printf '    veredito em %ss (rc=%s)\n' "$seg" "$rc"
check "o passo terminou no prazo (≤ 38s para um prazo de 30s)" test "$seg" -le 38
check "e o healthcheck saiu ≠ 0 (falha fechada)" test "$rc" -ne 0
check "com o aviso de que o app não respondeu" \
  bash -c 'printf "%s" "$1" | grep -qF "app não respondeu ao /api/v1/health"' _ "$saida"

echo
if [ "$FAILS" -eq 0 ]; then echo "ok — todas as verificações passaram"; else echo "FALHOU: $FAILS verificação(ões)"; exit 1; fi
