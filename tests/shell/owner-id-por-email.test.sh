#!/usr/bin/env bash
# Prova de `owner_id_by_email` em `_common.sh` — a resolução de UUID por e-mail
# que sustenta o `reset-password.sh`, único caminho de recuperação de senha de
# uma instalação sem SMTP (o estado normal de um self-host).
#
#   bash tests/shell/owner-id-por-email.test.sh
#
# ── O defeito que ele guarda, medido contra um GoTrue de verdade ────────────
#
# A função pedia `?filter=email.eq.<email>` — sintaxe do PostgREST. O GoTrue não
# fala essa expressão: ele trata a string INTEIRA como termo de busca por
# substring. Nenhum e-mail contém "email.eq.", então a resposta era sempre
# vazia. Medido em 2026-09-03, projeto de produção, e-mail existente:
#
#   GET /auth/v1/admin/users?filter=email.eq.<existente>  → 200 {"users":[]}
#   GET /auth/v1/admin/users?filter=<existente>           → 200 {"users":[<ele>]}
#
# Consequência: `reset-password.sh` morria com "Usuário não encontrado" para
# TODO e-mail. Não era intermitente; nunca funcionou.
#
# ── E por que o casamento tem de ser EXATO ──────────────────────────────────
#
# Justamente por ser substring, pedir `ana@empresa.com` traz também
# `mariana@empresa.com`. Um `head -1` cego devolveria o UUID da outra pessoa
# numa função cujo único consumidor TROCA SENHA. Medido no mesmo projeto:
# `?filter=gmail.com` devolveu 2 de 2 usuários.
#
# Nada aqui toca a rede: `curl` é um dublê que devolve um corpo canônico do
# GoTrue e registra a URL pedida.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

ANA=11111111-1111-4111-8111-111111111111
MARIANA=22222222-2222-4222-8222-222222222222
ELIAS=33333333-3333-4333-8333-333333333333
VIZINHO=44444444-4444-4444-8444-444444444444

# ── Dublê de curl ────────────────────────────────────────────────────────────
# Imita o GoTrue: `filter` é SUBSTRING sobre o e-mail. Devolve os usuários que
# casam, na ordem em que estão cadastrados, com o mesmo formato de campo do
# GoTrue real (id → aud → role → email). Registra a URL em $WORK/url.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<STUB
#!/usr/bin/env bash
url=""
for a in "\$@"; do case "\$a" in http*) url="\$a" ;; esac; done
printf '%s\n' "\$url" >> "$WORK/url"
[ "\${CURL_FALHA:-0}" = "1" ] && exit 22
termo="\${url#*filter=}"; termo="\${termo%%&*}"
[ "\${BUSCA_FROUXA:-0}" = "1" ] && termo=""
u() {  # u <uuid> <email>
  case "\$2" in
    *"\$termo"*) printf '{"id":"%s","aud":"authenticated","role":"authenticated","email":"%s"},' "\$1" "\$2" ;;
  esac
}
printf '{"users":['
# A ORDEM importa e é o miolo do caso: o GoTrue devolve por data de cadastro, e
# o `head -1` só erra quando o INTRUSO vem antes do alvo. Com o alvo em primeiro
# lugar, um casamento ingênuo acerta por sorte e o teste não vigia nada —
# medido: nesta ordem invertida a sabotagem passava verde.
u $MARIANA    "mariana@empresa.com"
u $ANA        "ana@empresa.com"
u $VIZINHO    "eliasXgervanno@empresa.com"
u $ELIAS      "elias.gervanno@empresa.com"
printf ']}'
STUB
chmod +x "$WORK/bin/curl"
PATH="$WORK/bin:$PATH"

# `_common.sh` roda com `set -e`; a subshell impede que um `exit` dele derrube
# este arquivo. As duas variáveis de ambiente são o que a função lê.
resolve() {  # resolve <email> → uuid no stdout
  (
    NEXT_PUBLIC_SUPABASE_URL="https://exemplo.supabase.co" \
    SUPABASE_SERVICE_ROLE_KEY="chave-de-teste" \
    bash -c '. "$0"/_common.sh 2>/dev/null || true
             owner_id_by_email "$1"' "$KIT_DIR" "$1" 2>/dev/null
  )
}

printf '\n▶ a função resolve o usuário certo\n'

check "e-mail existente devolve o UUID dele" \
  test "$(resolve 'ana@empresa.com')" = "$ANA"

# O caso que o `head -1` cego errava: `ana@` é substring de `mariana@`, e a Ana
# vem ANTES na lista — então acertar aqui não prova nada sozinho. O caso abaixo
# é o que prova.
check "pedir mariana@ NÃO devolve o UUID da ana@ (substring)" \
  test "$(resolve 'mariana@empresa.com')" = "$MARIANA"

# ── Ressalva honesta sobre o caso abaixo ────────────────────────────────────
# Em BRE o `.` casa qualquer caractere, e é por isso que a função escapa o
# e-mail antes de montar o padrão. Só que, com o GoTrue REAL, esse escape nunca
# chega a ser exercitado: a busca dele é por substring LITERAL, então
# `eliasXgervanno@` jamais entra numa resposta a `elias.gervanno@` e não há o
# que confundir. Medi: com o dublê fiel, remover o escape não muda nada.
#
# O caso existe assim mesmo, e vale pelo que guarda: um GoTrue que afrouxe a
# busca (outro campo, outra versão) passaria a devolver o vizinho, e aí o
# escape é a única coisa entre a troca de senha e a pessoa errada. `BUSCA_FROUXA`
# simula exatamente esse futuro. Não afirmo que ele detecta um defeito de hoje.
check "com busca frouxa, o ponto do e-mail não vira coringa" \
  test "$(BUSCA_FROUXA=1 resolve 'elias.gervanno@empresa.com')" = "$ELIAS"

printf '\n▶ a URL pedida (a causa raiz)\n'

: > "$WORK/url"; resolve 'ana@empresa.com' >/dev/null
check "a query NÃO usa 'email.eq.' (sintaxe PostgREST que o GoTrue não fala)" \
  bash -c '! grep -q "email\.eq\." "$1"' _ "$WORK/url"
check "a query manda o e-mail cru em filter=" \
  grep -q "filter=ana@empresa.com" "$WORK/url"

printf '\n▶ falha FECHADA (o consumidor troca senha; errar a pessoa é pior que não achar)\n'

check "e-mail inexistente devolve vazio" \
  test -z "$(resolve 'ninguem@empresa.com')"
check "curl falhando devolve vazio, sem derrubar quem chama" \
  test -z "$(CURL_FALHA=1 resolve 'ana@empresa.com')"

printf '\n▶ o call site (guardar a função não basta se ninguém a chama)\n'

check "reset-password.sh resolve o uid pela função" \
  grep -qE 'owner_id_by_email "\$EMAIL"' "$KIT_DIR/reset-password.sh"
check "reset-password.sh morre quando o uid vem vazio" \
  grep -qE '\[ -n "\$uid" \] \|\| die' "$KIT_DIR/reset-password.sh"

printf '\n'
[ "$FAILS" -eq 0 ] && { printf '✓ owner-id-por-email: tudo verde\n'; exit 0; }
printf '✗ owner-id-por-email: %d falha(s)\n' "$FAILS"; exit 1
