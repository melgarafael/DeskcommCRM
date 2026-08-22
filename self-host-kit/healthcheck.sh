#!/usr/bin/env bash
# Diagnóstico rápido: estado dos containers + saúde do app (Supabase/Redis/WAHA).
source "$(dirname "$0")/_common.sh"
enter_project

step "Containers"
dc ps

step "Saúde interna do app (/api/v1/health)"
# Roda de dentro da rede do compose (a rota não é exposta publicamente sem TLS).
out="$(dc exec -T app node -e "
fetch('http://127.0.0.1:3000/api/v1/health').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})
" 2>/dev/null || echo '')"
if [ -n "$out" ]; then
  printf '%s\n' "$out"
  printf '%s' "$out" | grep -q '"status":"ok"' && c_grn "✓ app saudável" || c_ylw "⚠ algum subsistema degradado (veja o JSON acima)."
else
  c_ylw "⚠ app não respondeu. Logs: docker compose $(dc_files) logs --tail=50 app"
fi

step "Atualização pela tela (agente do host)"
# Achado numa VPS real: o cron do agente é instalado no TOPO do update.sh, de
# propósito (para sobreviver a uma saída antecipada) — e isso cria uma janela em
# que o agente existe e o schema do banco ainda não. Ele então bate 500 a cada 5
# minutos, com o erro indo só para o .update-agent.log e o `>/dev/null` do cron.
# Para o dono, o sintoma é "o botão nunca apareceu": nenhuma pista, nenhum alarme.
# Este bloco é a pista.
if crontab -l 2>/dev/null | grep -q 'hostgator-setup-kit/agent.sh'; then
  c_grn "✓ agente instalado no cron (a cada 5 minutos)"
  log="$PROJECT_DIR/.update-agent.log"
  # Recência pela MTIME do arquivo, não parseando a data de dentro: `date -d` é
  # sintaxe GNU e falha calado no BSD/macOS, devolvendo "sem falhas" para um
  # agente que está falhando agora. `find -mmin` é portátil.
  if [ -s "$log" ] && [ -n "$(find "$log" -mmin -120 2>/dev/null)" ]; then
    c_ylw "⚠ o agente falhou recentemente ao falar com o app:"
    c_ylw "  $(tail -2 "$log" | head -1)"
    c_ylw "  Se o botão de atualizar não aparece na tela, é por isto."
    c_ylw "  Quase sempre resolve rodando: bash hostgator-setup-kit/update.sh"
  else
    c_grn "✓ sem falhas recentes do agente"
  fi
else
  c_ylw "⚠ o agente NÃO está no cron — o botão de atualizar não vai aparecer na tela."
  c_ylw "  Ative rodando: bash hostgator-setup-kit/update.sh"
fi
