#!/usr/bin/env bash
# guard-protected-paths.sh — hook PreToolUse do Claude Code (via .claude/settings.json,
# armado por loop/setup-claude-guard.mjs). Bloqueia (exit 2; stderr volta ao modelo
# como ensino):
#   - Edit/Write em plan/features.json (mutação só via node loop/update-feature.ts)
#   - Edit/Write em tests/invariants/* quando o arquivo JÁ existe (arquivo novo passa)
#   - comandos Bash que deletem testes ou a suíte de invariantes
set -euo pipefail

input=$(cat)
tool=$(jq -r '.tool_name // empty' <<<"$input")

deny() {
  echo "BLOQUEADO: $1" >&2
  echo "Se isso bloqueia sua feature, abra um item em loop/inbox.items.md (formato em loop/INBOX.md) e devolva BLOCKED." >&2
  exit 2
}

case "$tool" in
  Edit|Write)
    path=$(jq -r '.tool_input.file_path // empty' <<<"$input")
    case "$path" in
      *plan/features.json)
        deny "plan/features.json não se edita com Edit/Write — mutação de passes/verification só via 'node loop/update-feature.ts'."
        ;;
      *tests/invariants/*)
        # Arquivo pré-existente é congelado; escrita de arquivo NOVO passa
        # (G1-03 e fases seguintes criam invariantes).
        if [ -f "$path" ]; then
          deny "tests/invariants/** é congelado — invariante existente não se edita (flip legítimo de test.fails: sessão humana com DESKCOMM_GOV_INVARIANTS_EDIT=1 no commit)."
        fi
        ;;
    esac
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
    # Fronteira antes do comando de deleção inclui aspas, '(' e '=' — pega
    # deleção embrulhada em sh -c '...' / bash -c "..." (ERE em variável por
    # causa do quoting das aspas dentro da classe).
    del_start="(^|[;&|(\"'[:space:]=])(rm|unlink|git[[:space:]]+rm)[[:space:]]"
    if grep -Eq "$del_start" <<<"$cmd"; then
      # Avalia só os SEGMENTOS de deleção (cada trecho para no próximo ; & |):
      # 'rm dist/bundle.js && pnpm test' passa (o "pnpm test" fica fora do
      # segmento do rm); 'rm -rf test' na raiz veta.
      segments=$(grep -oE "(rm|unlink|git[[:space:]]+rm)[[:space:]][^;&|]*" <<<"$cmd" || true)
      # 'tests?' como palavra/componente: fronteira dos dois lados que não
      # continua um nome — 'lib/test;echo' e './test' vetam,
      # 'build/test-output.txt' e 'test_helpers.py' não.
      if grep -Eq "tests/invariants|\.test\.|\.spec\.|__tests__|(^|[^-_.[:alnum:]])tests?(\$|[^-_.[:alnum:]])" <<<"$segments"; then
        deny "deleção de teste/invariante não é permitida ao loop — teste incômodo vai pra inbox, não pro rm."
      fi
    fi
    ;;
esac

exit 0
