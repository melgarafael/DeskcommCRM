#!/usr/bin/env bash
# Troca o e-mail de LOGIN de um usuário — o caso normal é o dono, que numa
# instalação single-server nasce como `admin@<domínio>` (endereço que o
# instalador inventa e quase nunca é uma caixa de verdade). Enquanto ele for
# esse endereço, "esqueci minha senha" e os avisos por e-mail não chegam a
# ninguém.
#
# O e-mail de login mora em `auth.users` (GoTrue) e é o identificador da conta;
# a troca vai pela admin API, no mesmo molde do `reset-password.sh` — sem SMTP
# não há caminho por e-mail, e este é o script que resolve pelo terminal da VPS.
#
#   bash hostgator-setup-kit/change-email.sh admin@dominio.com.br dono@empresa.com.br
#
# Depois da troca: o endereço ANTIGO deixa de valer como login (a caixa dele não
# recebe mais recuperação de senha nem avisos), e o login passa a ser o novo —
# com a MESMA senha. O arquivo `.runtime/admin-credentials` do kit é atualizado
# quando guardava o endereço antigo.
source "$(dirname "$0")/_common.sh"
# `raiz` sai ANTES do `enter_project`: ele pode dar `cd deskcommcrm`, e daí em
# diante um `$0` relativo (rodado da pasta acima do projeto) já não resolve — o
# `cd` falhava DEPOIS da troca no Supabase, e os dois arquivos ficavam com o
# endereço antigo.
raiz="$(cd "$(dirname "$0")/.." && pwd -P)"
enter_project

ATUAL="${1:-}"
NOVO="${2:-}"
[ -n "$ATUAL" ] && [ -n "$NOVO" ] || die "Uso: change-email.sh <email-atual> <email-novo>"

# A validação não é enfeite: o endereço vira o LOGIN do dono e o corpo do PUT.
# Um e-mail com espaço, aspa ou barra invertida ou quebra o JSON ou cria um
# login que ninguém consegue digitar — e, nos dois casos, o dono descobre
# depois de perder o acesso.
[[ "$NOVO" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] \
  || die "'$NOVO' não parece um e-mail. Nada foi alterado."

[ "$ATUAL" != "$NOVO" ] || die "O e-mail novo é o mesmo do atual — nada a fazer."

step "Procurando $ATUAL"
uid="$(owner_id_by_email "$ATUAL")"
[ -n "$uid" ] || die "Usuário '$ATUAL' não encontrado. Confira o endereço com o dono (o instalador cria admin@<domínio>)."

corpo="$(corpo_troca_de_email "$NOVO")" || die "Não consegui montar o pedido para '$NOVO'."

# A chave entra no cabeçalho `apikey` e no `Authorization` (como no
# reset-password.sh). Sem ela o curl sai com "unbound variable" e a causa não
# aparece — melhor dizer o que falta.
[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] \
  || die "Falta SUPABASE_SERVICE_ROLE_KEY no .env desta instalação. Rode a partir da pasta do projeto."

# Resposta do GoTrue vai para um arquivo: é dela que sai a frase do erro quando
# o status não é 2xx (`email_exists`, endereço inválido, chave errada).
resposta="$(mktemp)"
trap 'rm -f "$resposta"' EXIT

step "Trocando o e-mail de login"
# O status HTTP é conferido em separado, e não só pelo `-f` do curl: 4xx/5xx
# também trazem corpo útil, e "sucesso" com HTTP != 2xx é exatamente o modo de
# falha que este script não pode ter (o dono sairia daqui achando que trocou).
http="$(curl -sS -o "$resposta" -w '%{http_code}' -X PUT "$(url_admin_user "$uid")" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  --data "$corpo")" || die "Falha de rede ao falar com o Supabase. Nada foi alterado."

case "$http" in
  2??) : ;;
  409|422)
    die "O Supabase recusou ($http). Nada foi alterado. Detalhe: $(tr -d '\n' < "$resposta" | head -c 300)"
    ;;
  *)
    die "O Supabase respondeu HTTP $http. Nada foi alterado. Detalhe: $(tr -d '\n' < "$resposta" | head -c 300)"
    ;;
esac

c_grn "✓ login trocado: $ATUAL → $NOVO (a senha continua a mesma)"

# ── Os arquivos do kit que guardavam o endereço antigo ───────────────────────
# O instalador grava o dono em DOIS lugares: `.runtime/admin-credentials`
# (600, é o que a tela final manda anotar) e `OWNER_EMAIL` no `.env` do
# projeto. Deixar o endereço velho ali faz o próximo `install.sh`/suporte
# procurar um login que já não existe — então os dois acompanham a troca, e só
# quando o valor neles é mesmo o endereço trocado (numa instalação em que o dono
# já foi outro, o arquivo não é mexido).
credenciais="${CREDENTIALS_FILE:-$raiz/.runtime/admin-credentials}"

# `unset OWNER_EMAIL` antes do load, e leitura só quando o arquivo existe: o
# `enter_project` já carregou o `.env`, que também exporta OWNER_EMAIL. Sem isso,
# um `.runtime/admin-credentials` ausente (instalação antiga, arquivo movido)
# herdava o valor do `.env` e o script anunciava "guardava outro endereço"
# olhando um valor que não estava naquele arquivo — medido no teste de payload.
atual_nas_credenciais=""
if [ -f "$credenciais" ]; then
  atual_nas_credenciais="$( ( unset OWNER_EMAIL; load_env "$credenciais" >/dev/null 2>&1
                              printf '%s' "${OWNER_EMAIL:-}" ) || true )"
  if [ "$atual_nas_credenciais" = "$ATUAL" ]; then
    set_env_var "$credenciais" OWNER_EMAIL "$NOVO"
    c_grn "✓ $(basename "$credenciais") atualizado: o login agora é $NOVO"
  elif [ -n "$atual_nas_credenciais" ]; then
    c_ylw "• $(basename "$credenciais") guardava outro endereço ($atual_nas_credenciais) — não mexi nele."
  fi
fi

if [ -f "${PROJECT_DIR:-.}/.env" ]; then
  atual_no_env="$( ( unset OWNER_EMAIL; load_env "${PROJECT_DIR:-.}/.env" >/dev/null 2>&1
                     printf '%s' "${OWNER_EMAIL:-}" ) || true )"
  if [ "$atual_no_env" = "$ATUAL" ]; then
    set_env_var "${PROJECT_DIR:-.}/.env" OWNER_EMAIL "$NOVO"
    c_grn "✓ OWNER_EMAIL do .env atualizado"
  fi
fi

printf '\n'
c_ylw "A partir de agora entre com $NOVO. A caixa $ATUAL não recebe mais recuperação de senha nem avisos do CRM."
c_ylw "Se a senha também se perdeu: bash hostgator-setup-kit/reset-password.sh $NOVO"
