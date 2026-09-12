#!/usr/bin/env bash
# Prova que o instalador SOBREVIVE numa VPS que nunca teve crontab — os dois
# blocos de cron de `_common.sh` (`setup_event_log_drain_cron` e
# `setup_update_agent_cron`).
#
#   bash tests/shell/cron-sem-crontab-previo.test.sh
#
# ── O defeito que ele guarda, e por que ele é P0 ─────────────────────────────
#
# `crontab -l` sai com status **1** (sem stdout, só um aviso no stderr) quando o
# usuário NUNCA teve crontab. Isso não é caso de borda: é o estado de uma VPS
# recém-provisionada, ou seja, o estado NORMAL de quem instala este produto.
#
# `_common.sh:3` e `install.sh:12` abrem com `set -euo pipefail`. Sob `pipefail`
# o 1 vaza pelo pipe mesmo com os estágios seguintes bem-sucedidos (`false |
# true` também sai 1), e o `set -e` mata o instalador no bloco 11 — **depois**
# de a linha do cron já ter sido gravada. O dono vê o script morrer sem
# mensagem, numa instalação que na verdade tinha funcionado.
#
# Achado por @luiscgc91 no PR #683, e reproduzido antes de ser consertado.
#
# ── Por que este teste executa o arquivo de verdade ──────────────────────────
#
# Um teste que só procurasse `|| true` no texto passaria verde com o `|| true`
# no lugar errado. Aqui o `_common.sh` REAL é carregado, com dublês de
# `crontab`, `psql_run` e das funções de cor, e o que se mede é se a execução
# CHEGA À LINHA seguinte ao bloco.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }

# ── Dublê de `crontab`: a VPS que nunca teve um ──────────────────────────────
mkdir -p "$WORK/bin"
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "-l" ]; then
  echo "no crontab for root" >&2
  exit 1
fi
cat > "${CRONTAB_ESCRITO:-/dev/null}"
exit 0
STUB
chmod +x "$WORK/bin/crontab"

# O roteiro roda num bash filho, com o MESMO `set -euo pipefail` do instalador.
executar_bloco() {  # executar_bloco <nome-da-funcao>
  local fn="$1"
  cat > "$WORK/roteiro.sh" <<ROTEIRO
set -euo pipefail
export PATH="$WORK/bin:\$PATH"
export CRONTAB_ESCRITO="$WORK/gravado.txt"
# ⚠️ SEM ESTAS DUAS, as funções RETORNAM CEDO com um aviso amarelo e o teste
# mediria o nada — "sobreviveu" seria verdade por nunca ter chegado ao bloco.
# Foi o que o controle positivo pegou na primeira escrita deste arquivo.
export INTERNAL_SECRET="segredo-de-teste"
export NEXT_PUBLIC_APP_URL="https://exemplo.invalido"
export PROJECT_DIR="$WORK"
psql_run() { return 0; }
step() { :; }
source "$RAIZ/hostgator-setup-kit/_common.sh" >/dev/null 2>&1
$fn >/dev/null 2>&1
echo "CHEGOU-AO-FIM"
ROTEIRO
  bash "$WORK/roteiro.sh" 2>/dev/null | tail -1
}

chegou() { [ "$(executar_bloco "$1")" = "CHEGOU-AO-FIM" ]; }

echo "cron sem crontab prévio:"

# CONTROLE POSITIVO — sem isto, um `_common.sh` que nem carrega daria "falha"
# em tudo e o teste pareceria estar medindo.
dubles_sai_1() { PATH="$WORK/bin:$PATH" "$WORK/bin/crontab" -l >/dev/null 2>&1; [ "$?" -eq 1 ]; }
check "o dublê de crontab reproduz o estado da VPS nova (\`-l\` sai 1)" dubles_sai_1

check "o instalador sobrevive ao bloco do drain de eventos" chegou setup_event_log_drain_cron
check "o instalador sobrevive ao bloco do agente de atualização" chegou setup_update_agent_cron

# ── O outro lado: a linha do cron continua sendo gravada ─────────────────────
# Sem isto, "sobreviveu" poderia significar "não fez nada".
rm -f "$WORK/gravado.txt"
executar_bloco setup_event_log_drain_cron >/dev/null
gravou() { grep -q "event-log-drain" "$WORK/gravado.txt" 2>/dev/null; }
check "a linha do drain foi mesmo gravada no crontab" gravou

if [ "$FAILS" -gt 0 ]; then printf '\n%d falha(s)\n' "$FAILS"; exit 1; fi
printf '\ntudo verde\n'
