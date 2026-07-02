#!/usr/bin/env bash
# Diagnóstico rápido: estado dos containers + saúde do app (Supabase/Redis/WAHA).
source "$(dirname "$0")/_common.sh"
enter_project

step "Containers"
docker compose -f "$COMPOSE" ps

step "Saúde interna do app (/api/v1/health)"
# Roda de dentro da rede do compose (a rota não é exposta publicamente sem TLS).
out="$(docker compose -f "$COMPOSE" exec -T app node -e "
fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})
" 2>/dev/null || echo '')"
if [ -n "$out" ]; then
  printf '%s\n' "$out"
  printf '%s' "$out" | grep -q '"status":"ok"' && c_grn "✓ app saudável" || c_ylw "⚠ algum subsistema degradado (veja o JSON acima)."
else
  c_ylw "⚠ app não respondeu. Logs: docker compose -f $COMPOSE logs --tail=50 app"
fi
