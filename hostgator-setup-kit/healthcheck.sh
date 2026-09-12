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

step "E-mails de acesso (confirmar conta e redefinir senha)"
# ── Por que esta seção existe ────────────────────────────────────────────────
# Num Supabase PRÓPRIO, quem renderiza estes dois e-mails é o GoTrue, e o molde
# padrão dele linka para `/auth/v1/verify`, que devolve um `code` PKCE. O
# verificador desse code vive num cookie SameSite=Strict, e clique vindo de
# webmail é navegação cross-site: o cookie não viaja e a sessão nunca fecha.
# Medido em produção em 2026-09-10 — a conta era confirmada e a pessoa entrava
# sem organização e sem menu.
#
# O conserto é apontar `GOTRUE_MAILER_TEMPLATES_*` para a rota do app. Como o
# GoTrue não é serviço deste compose (o kit sobe app, worker, scheduler, waha,
# redis, srh e caddy — o Supabase próprio fica FORA), o kit não tem como
# escrever essa configuração. O que ele pode, e é o que faz aqui, é MEDIR o
# estado e dizer as duas linhas exatas. Silêncio aqui seria o `return` mudo que
# o invariante 6(c) do Sistema Vivo proíbe.
case "${NEXT_PUBLIC_SUPABASE_URL:-}" in
  https://*.supabase.co*)
    c_grn "✓ Supabase na nuvem — os e-mails são configurados pela Management API."
    c_dim "  Quem cuida disso é: bash hostgator-setup-kit/marca-emails.sh"
    ;;
  "")
    c_ylw "⚠ NEXT_PUBLIC_SUPABASE_URL vazia no .env — não dá para saber a topologia."
    ;;
  *)
    c_dim "  Supabase próprio: aqui não existe Management API, a ligação é por env do GoTrue."

    # (a) A rota do app responde? Perguntamos de DENTRO da rede do compose, como
    #     na seção de saúde acima: a rota é pública, mas o host pode estar atrás
    #     de proxy e um erro de TLS aqui seria diagnóstico errado.
    molde="$(dc exec -T app node -e "
fetch('http://127.0.0.1:3000/email-templates/confirmation').then(r=>r.text()).then(t=>{console.log(t);process.exit(0)}).catch(()=>process.exit(1))
" 2>/dev/null || echo '')"
    if printf '%s' "$molde" | grep -q 'token_hash={{ .TokenHash }}'; then
      c_grn "✓ o app serve o molde em /email-templates/confirmation"
    elif [ -n "$molde" ]; then
      c_ylw "⚠ /email-templates/confirmation respondeu, mas sem o token_hash esperado."
      c_ylw "  Esta versão do app é anterior à correção. Rode: bash hostgator-setup-kit/update.sh"
    else
      c_ylw "⚠ o app não serviu /email-templates/confirmation."
      c_ylw "  Ou está fora do ar, ou é uma versão anterior à correção."
    fi

    # (b) O GoTrue desta máquina está apontado para lá? Ele não é nosso, então
    #     lemos o ambiente de QUALQUER contêiner que declare a variável — é
    #     leitura, não escrita, e é o único jeito de responder sem adivinhar.
    apontado=""; dono=""
    # A chave sai de uma VARIÁVEL, não literal dentro do `sed`: o
    # test-validators.sh varre o kit cobrando que todo `GOTRUE_MAILER_TEMPLATES_*=`
    # escrito aqui seja URL http(s), e um `s/^CHAVE=//p` entraria nessa varredura
    # como se `//p` fosse o valor configurado.
    chave=GOTRUE_MAILER_TEMPLATES_CONFIRMATION
    for c in $(docker ps --format '{{.Names}}' 2>/dev/null); do
      v="$(docker inspect --format \
        '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null \
        | sed -n "s/^${chave}=//p" | head -1)"
      [ -n "$v" ] && { apontado="$v"; dono="$c"; break; }
    done
    if [ -z "$apontado" ]; then
      c_ylw "⚠ nenhum GoTrue desta máquina aponta para o molde do app."
      c_ylw "  Os e-mails de acesso vão sair no modelo padrão, e o link dele NÃO fecha"
      c_ylw "  a sessão quando o clique vem do webmail."
      c_ylw "  Acrescente ao serviço 'auth' do SEU Supabase (não a este compose):"
      c_ylw "    GOTRUE_MAILER_TEMPLATES_CONFIRMATION=${NEXT_PUBLIC_APP_URL:-https://SEU_DOMINIO}/email-templates/confirmation"
      c_ylw "    GOTRUE_MAILER_TEMPLATES_RECOVERY=${NEXT_PUBLIC_APP_URL:-https://SEU_DOMINIO}/email-templates/recovery"
      c_dim "  (se o seu Supabase roda em outra máquina, confira lá — daqui não dá para ver)"
    else
      case "$apontado" in
        http*/email-templates/*)
          c_grn "✓ o GoTrue ($dono) busca o molde do app"
          c_dim "  $apontado" ;;
        http*)
          c_ylw "⚠ o GoTrue ($dono) busca um molde que não é o do app:"
          c_ylw "  $apontado" ;;
        *)
          c_red "✗ o GoTrue ($dono) está com CAMINHO DE ARQUIVO, não URL:"
          c_red "  $apontado"
          c_red "  O GoTrue cola isso no fim do SITE_URL e busca por HTTP — o cliente"
          c_red "  recebe a tela de login dentro do e-mail. Troque por uma URL http(s)." ;;
      esac
    fi
    ;;
esac
