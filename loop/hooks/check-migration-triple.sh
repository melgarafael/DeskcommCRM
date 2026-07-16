#!/usr/bin/env bash
# check-migration-triple.sh — a tripla de migration é indivisível (doutrina do repo).
# Commit que ADICIONA arquivo em supabase/migrations/*.sql precisa, no MESMO commit:
#   1. mudança em supabase/baseline.sql (apêndice idempotente)
#   2. mudança em supabase/migrations/MANIFEST.md (linha na tabela Applied)
# E o NNNN do nome novo não pode existir em NENHUMA branch local — a cadeia
# vendaval/F2-* tem migrations não mergeadas; colisão de sequência é bug real.
# Bypass (correção orientada pelo dono): DESKCOMM_GOV_MIGRATION_EDIT=1.
set -euo pipefail

[ "${DESKCOMM_GOV_MIGRATION_EDIT:-0}" = "1" ] && exit 0

# Migrations novas (status A) neste commit
new_migrations=$(git diff --cached --name-status \
  | awk '$1 == "A" && $2 ~ /^supabase\/migrations\/.*\.sql$/ { print $2 }')
[ -z "$new_migrations" ] && exit 0

staged=$(git diff --cached --name-only)

if ! grep -qx 'supabase/baseline.sql' <<<"$staged"; then
  echo "pre-commit BLOQUEADO: migration nova sem apêndice em supabase/baseline.sql no MESMO commit." >&2
  echo "A tripla é indivisível (CLAUDE.md §Migrations): migrations/*.sql + baseline.sql + MANIFEST.md." >&2
  echo "Sem o baseline, self-hosters nunca recebem a mudança. Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2
  exit 1
fi

if ! grep -qx 'supabase/migrations/MANIFEST.md' <<<"$staged"; then
  echo "pre-commit BLOQUEADO: migration nova sem linha em supabase/migrations/MANIFEST.md no MESMO commit." >&2
  echo "A tripla é indivisível (CLAUDE.md §Migrations): migrations/*.sql + baseline.sql + MANIFEST.md." >&2
  echo "Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2
  exit 1
fi

# Sequência NNNN única contra TODAS as branches locais
while IFS= read -r path; do
  fname=$(basename "$path")
  nnnn=$(sed -nE 's/^[0-9]+_([0-9]{4})_.+\.sql$/\1/p' <<<"$fname")
  if [ -z "$nnnn" ]; then
    echo "pre-commit BLOQUEADO: '$fname' não segue o padrão <timestamp>_<NNNN>_<slug>.sql do repo." >&2
    exit 1
  fi
  while IFS= read -r branch; do
    conflict=$(git ls-tree -r --name-only "$branch" -- supabase/migrations 2>/dev/null \
      | grep -E "^supabase/migrations/[0-9]+_${nnnn}_.+\.sql$" || true)
    if [ -n "$conflict" ]; then
      echo "pre-commit BLOQUEADO: sequência NNNN=$nnnn de '$fname' já existe na branch '$branch':" >&2
      echo "  $conflict" >&2
      echo "Escolha o próximo NNNN livre em TODAS as branches locais (git branch --format='%(refname:short)' + git ls-tree)." >&2
      echo "Correção orientada pelo dono: DESKCOMM_GOV_MIGRATION_EDIT=1." >&2
      exit 1
    fi
  done < <(git branch --format='%(refname:short)')
done <<<"$new_migrations"

exit 0
