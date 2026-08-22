#!/usr/bin/env bash
#
# Sobe os e-mails de ACESSO (criar conta e recuperar senha) com a marca da
# instalação — assunto, corpo, cor do botão — e configura Site URL / Redirect
# URLs, que são pré-requisito do link funcionar.
#
#   bash marca-emails.sh                      # lê ../.env e sobe
#   bash marca-emails.sh --render-em /tmp/x   # só renderiza, não sobe nada
#
# ── POR QUE ISTO É UM SCRIPT, E NÃO UMA FUNÇÃO DO APP ───────────────────────
#
# Estes dois e-mails são renderizados pelo GoTrue, um TERCEIRO PROCESSO que
# roda na infraestrutura do Supabase. Nenhum TypeScript nosso executa ali: não
# existe `marcaDaSaida()` a chamar, não existe resolvedor a plugar. O único
# canal é texto empurrado por API. Por isso o artefato entregável não é o HTML
# — é o mecanismo que o sobe.
#
# E ele importa mais que os outros e-mails: o de confirmação de conta é o
# PRIMEIRO artefato que qualquer usuário de um revendedor recebe. Sem este
# script, ele chega dizendo "Confirm Your Signup" em inglês, no modelo padrão
# do Supabase, sem marca nenhuma.
#
# ── O QUE FOI MEDIDO (2026-08-14) ──────────────────────────────────────────
#
# O comentário de `app/auth/confirm/route.ts` afirmava que editar o corpo do
# e-mail exige SMTP customizado. Medido contra a Management API real:
#
#   PATCH /v1/projects/{ref}/config/auth  {"mailer_templates_confirmation_content": …}
#     → HTTP 200 num projeto com `smtp_host: null`
#     → GET seguinte devolve o conteúdo BYTE A BYTE
#
# Ou seja: o corpo do e-mail é editável sem SMTP próprio. O que o SMTP próprio
# resolve é o VOLUME (o remetente embutido do Supabase tem limite baixo).
#
# Também medido: projeto pausado responde `400 {"message":"Project is paused."}`.
# Por isso o passo de RELEITURA abaixo não é zelo — é a diferença entre "subiu"
# e "a API respondeu alguma coisa". Um script que confia no 2xx reporta sucesso
# num projeto pausado.
#
# ── NUNCA DERRUBA QUEM O CHAMA ─────────────────────────────────────────────
#
# `install.sh` e `update.sh` chamam este script. Falta de token, Supabase
# próprio (sem Management API), projeto pausado, rede fora: tudo imprime o que
# fazer e sai 0. Uma instalação não pode morrer porque o e-mail de boas-vindas
# ficou em inglês.
#
# Dependências: as mesmas do kit (bash + curl + awk). Sem jq, sem python.

set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJ_DIR="$(cd "$KIT_DIR/.." && pwd)"
API="https://api.supabase.com/v1"

# shellcheck source=_common.sh
. "$KIT_DIR/_common.sh"

# Vazio até o fim do laço: assim `--projeto` e `--env` não dependem da ordem
# em que forem passados.
ENV_FILE=""
RENDER_EM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --render-em) RENDER_EM="${2:-}"; shift 2 || shift;;
    --env)       ENV_FILE="${2:-}";  shift 2 || shift;;
    # O `install.sh` pode ter sido chamado de FORA do repositório (ele clona e
    # entra), e aí `KIT_DIR/..` não é a raiz do projeto — nem o `.env` nem
    # `supabase/templates/` estariam lá. Quem sabe onde o projeto está é quem
    # chama; por isso a origem é um parâmetro, não uma adivinhação.
    --projeto)   PROJ_DIR="${2:-}"; shift 2 || shift;;
    -h|--help)   sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *)           c_ylw "opção desconhecida: $1"; exit 0;;
  esac
done
[ -n "$ENV_FILE" ] || ENV_FILE="$PROJ_DIR/.env"

# Sai bem-sucedido depois de ensinar o passo manual. É o contrato deste script:
# ele informa, não interrompe.
instrua_e_saia() {
  printf '\n' >&2
  c_ylw "⚠ $1"
  printf '\n' >&2
  c_dim "  Para fazer à mão, no painel do Supabase:"
  c_dim "    1. Authentication → URL Configuration"
  c_dim "         Site URL:      ${APP_URL:-https://SEU_DOMINIO}"
  c_dim "         Redirect URLs: ${APP_URL:-https://SEU_DOMINIO}/auth/confirm"
  c_dim "    2. Authentication → Email Templates → Confirm signup / Reset password"
  c_dim "         <a href=\"{{ .RedirectTo }}&token_hash={{ .TokenHash }}\">Confirmar</a>"
  c_dim "         ⚠ o separador é & — um ? aqui quebra o link (vira ?type=x?token_hash=y)"
  printf '\n' >&2
  exit 0
}

# ── 1. A marca, lida do .env da instalação ─────────────────────────────────
[ -f "$ENV_FILE" ] && load_env "$ENV_FILE"

APP_NOME="${APP_NAME:-}"
[ -n "${APP_NOME//[[:space:]]/}" ] || APP_NOME="DeskcommCRM"
APP_URL="${NEXT_PUBLIC_APP_URL:-}"

# `#506d48` é o accent do tema claro do produto (grau 600 da rampa em
# lib/branding/regua-do-produto.ts) — o mesmo piso que `lib/branding/saida.ts`
# usa nos e-mails. Não é uma cor inventada aqui.
#
# A cor sai do `.env`, e desde 2026-08-14 o `install.sh` PERGUNTA e grava
# `APP_ACCENT_HEX` (campo em `FIELDS`, validado por `v_hex`, escrito pelo `envq`
# do bloco `} > .env`). Antes disso ele não gravava a chave — medido em
# `c8fc877d`: `grep -c APP_ACCENT_HEX install.sh` → 0 —, e a consequência não era
# teórica: o revendedor punha o nome dele na instalação e recebia o VERDE DO
# PRODUTO no primeiro e-mail que o cliente dele abria, em ~100% das instalações.
#
# ⚠️ LIMITE QUE PERMANECE: quem trocar a cor DEPOIS, pela tela `/admin/marca`,
# NÃO vê os e-mails de acesso acompanharem — eles são texto estático dentro do
# GoTrue e só mudam quando este script roda de novo. O que a entrevista conserta
# é o ponto de partida (a cor da instalação nasce certa); a defasagem posterior
# continua de pé.
#
# Esta defasagem é INERENTE ao mecanismo, não a esta escolha de fonte: o GoTrue
# guarda o texto do e-mail, não uma referência ao nosso resolvedor. Trocar o
# `.env` pelo banco como origem mudaria QUAL valor velho fica gravado, não o
# fato de ele ficar. Quem mexer aqui esperando "ler do banco resolve" precisa
# saber disso antes de escrever a primeira linha.
ACCENT="${APP_ACCENT_HEX:-}"
case "$ACCENT" in
  \#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
  *) ACCENT="#506d48";;
esac

# A frente do botão: preto ou branco, pela luminância relativa da cor de fundo.
#
# Isto DUPLICA a decisão de `melhorFrenteSobre` (lib/branding/contraste.ts) —
# de propósito, porque bash não importa TypeScript e a alternativa seria
# `#ffffff` fixo. E `#ffffff` fixo é o defeito concreto: uma marca amarela
# colada pelo revendedor produz texto branco sobre amarelo, ilegível, no
# PRIMEIRO e-mail que o cliente dele recebe. As duas implementações decidem a
# mesma coisa binária; divergir só é possível num intervalo estreito em torno
# do limiar, e nele as duas escolhas são legíveis.
frente_sobre() {
  local hex="${1#\#}"
  # `index()` numa tabela, e NÃO `strtonum("0x..")`: strtonum é extensão do
  # gawk. O Ubuntu de VPS traz mawk como `awk` por padrão e o macOS traz o awk
  # do BSD — em nenhum dos dois strtonum existe, e o erro ("calling undefined
  # function") derrubaria a função no cliente e não aqui.
  awk -v h="$hex" '
    function hexv(c) { return index("0123456789abcdef", tolower(c)) - 1 }
    function par(s)  { return hexv(substr(s,1,1))*16 + hexv(substr(s,2,1)) }
    BEGIN{
      r=par(substr(h,1,2)); g=par(substr(h,3,2)); b=par(substr(h,5,2));
      # Luminância perceptual (Rec. 601). Suficiente para escolher entre preto e
      # branco; não é o cálculo WCAG completo, e o comentário acima diz por quê.
      y=(0.299*r + 0.587*g + 0.114*b)/255;
      print (y > 0.6 ? "#171f15" : "#ffffff");
    }'
}
ACCENT_FG="$(frente_sobre "$ACCENT")"

# ── 2. Renderiza os modelos ────────────────────────────────────────────────
MARCADOR="marca-emails $(date +%s)"

# Substituição LITERAL, não `sed s|…|…|`. O nome da marca é texto que o
# operador digita: "Vendas & Cia" faria o `&` do lado direito de um `sed` valer
# como "o trecho casado" e o e-mail sairia dizendo "Vendas __APP_NAME__ Cia".
# `|`, `\` e `/` no nome têm famílias de estrago parecidas. `index`/`substr` não
# interpretam caractere nenhum.
trocar() {  # trocar <chave> <valor>   (texto em stdin, resultado em stdout)
  awk -v k="$1" -v v="$2" '{
    out=""; s=$0;
    while ((p=index(s,k))>0) { out = out substr(s,1,p-1) v; s = substr(s,p+length(k)) }
    print out s
  }'
}

# O nome da marca entra em TEXTO HTML. Sem escape, uma marca chamada
# `Loja <b>Top</b>` injeta markup no corpo do e-mail, e `&` cru já é HTML
# inválido. Só o corpo é escapado — o ASSUNTO é cabeçalho de e-mail, texto
# puro, e `&amp;` ali apareceria literalmente na caixa de entrada.
#
# Feito com `trocar` (index/substr do awk) e NÃO com `${s//&/&amp;}`: o bash
# 5.2 passou a expandir `&` no lado direito de `${x//p/r}` para o trecho
# CASADO, como o sed sempre fez. Medido aqui: `Loja <b>Top</b> & Cia` saía
# `Loja <lt;b>gt;Top...` — o `&` de `&lt;` virava o próprio `<`. Escapar com
# `\&` consertaria no 5.2 e quebraria no bash 4 de uma VPS antiga, que é
# exatamente o público do kit.
escapar_html() {
  printf '%s' "$1" \
    | trocar '&' '&amp;' \
    | trocar '<' '&lt;' \
    | trocar '>' '&gt;' \
    | trocar '"' '&quot;'
}

# Tira o bloco de comentário de manutenção do topo do modelo — ele fala de
# placeholder, de `--render-em` e do porquê do `&`, tudo endereçado a quem edita
# o repositório. Empurrar isso para dentro do e-mail de todo cliente do
# revendedor seria vazar nota interna (e o próprio texto do comentário sairia
# com os placeholders já substituídos, o que confunde ainda mais).
sem_nota_interna() {
  awk 'BEGIN{ pulando=0 }
       NR==1 && $0 ~ /^[[:space:]]*<!--/ { pulando=1 }
       pulando==1 { if ($0 ~ /-->/) { pulando=0 }; next }
       { print }'
}

renderizar() {  # renderizar <arquivo>
  local arq="$1"
  [ -f "$arq" ] || return 1
  # O marcador é a PROVA de releitura (passo 6): ASCII puro e sem `<`, `>` nem
  # `&` no texto que será procurado, porque o JSON que a API devolve escapa
  # esses três (`<`, `>`, `&`) e um grep pelo original falharia
  # num conteúdo que subiu perfeitamente.
  printf '<!-- %s -->\n' "$MARCADOR"
  sem_nota_interna < "$arq" \
    | trocar "__APP_NAME__" "$(escapar_html "$APP_NOME")" \
    | trocar "__ACCENT_FG__" "$ACCENT_FG" \
    | trocar "__ACCENT__" "$ACCENT"
}

HTML_CONFIRM="$(renderizar "$PROJ_DIR/supabase/templates/confirmation.html")" || instrua_e_saia "não achei supabase/templates/ — rode de dentro do repositório."
HTML_RECOVERY="$(renderizar "$PROJ_DIR/supabase/templates/recovery.html")" || instrua_e_saia "não achei supabase/templates/ — rode de dentro do repositório."

if [ -n "$RENDER_EM" ]; then
  # O caminho de quem roda GoTrue self-hosted: lá não existe Management API, e
  # `GOTRUE_MAILER_TEMPLATES_*` aponta para ARQUIVO. Apontar para o modelo cru
  # entregaria `__APP_NAME__` ao cliente final.
  mkdir -p "$RENDER_EM" || instrua_e_saia "não consegui escrever em $RENDER_EM"
  printf '%s\n' "$HTML_CONFIRM"  > "$RENDER_EM/confirmation.html"
  printf '%s\n' "$HTML_RECOVERY" > "$RENDER_EM/recovery.html"
  c_grn "✓ modelos renderizados em $RENDER_EM (marca: $APP_NOME, accent: $ACCENT)"
  c_dim "  GoTrue self-hosted: aponte GOTRUE_MAILER_TEMPLATES_CONFIRMATION/RECOVERY para eles."
  exit 0
fi

# ── 3. Dá para subir? ──────────────────────────────────────────────────────
[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || instrua_e_saia \
  "sem SUPABASE_ACCESS_TOKEN — não dá para configurar os e-mails de acesso sozinho.
    Pegue um token em https://supabase.com/dashboard/account/tokens, rode
    \`export SUPABASE_ACCESS_TOKEN=sbp_...\` e chame este script de novo."

# O ref do projeto sai da URL: https://<ref>.supabase.co. Supabase PRÓPRIO
# (self-hosted) não tem Management API nenhuma — e nesse caso o passo é por env
# do GoTrue, não por API.
REF=""
case "${NEXT_PUBLIC_SUPABASE_URL:-}" in
  https://*.supabase.co*) REF="${NEXT_PUBLIC_SUPABASE_URL#https://}"; REF="${REF%%.supabase.co*}";;
esac
[ -n "$REF" ] || instrua_e_saia \
  "NEXT_PUBLIC_SUPABASE_URL não é um projeto da nuvem do Supabase (${NEXT_PUBLIC_SUPABASE_URL:-vazio}).
    Num Supabase próprio, use GOTRUE_MAILER_TEMPLATES_* apontando para os
    arquivos de \`marca-emails.sh --render-em <dir>\`."

api() {  # api <método> <caminho> [corpo]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$API$path" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"
  fi
}

# Mesmo extrator plano do supabase-provision.sh:123, e pelo mesmo motivo — o
# kit promete depender só de bash+curl. O `|| true` mantém a mensagem de erro
# ALCANÇÁVEL: campo ausente faria o grep sair 1 e, com pipefail, derrubaria a
# atribuição antes da linha que explica o problema.
json_str() { grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" <<<"$1" | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true; }

# Escapa uma string para dentro de um JSON. Não escapa acento nem `&`: JSON
# aceita UTF-8 cru, e o que precisa sair são barra, aspas, tab e quebra de linha.
json_escape() {
  awk 'BEGIN{ORS=""}
       { gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); gsub(/\t/,"\\t"); gsub(/\r/,"");
         printf "%s%s", (NR>1 ? "\\n" : ""), $0 }' <<<"$1"
}

step "Configurando os e-mails de acesso (marca: $APP_NOME)"

atual="$(api GET "/projects/$REF/config/auth")"
case "$atual" in
  *'"message"'*) instrua_e_saia "a API do Supabase recusou a leitura: $(json_str "$atual" message)";;
esac

# ── 4. Site URL e Redirect URLs: acrescentar, nunca substituir ─────────────
#
# Sobrescrever a lista apagaria domínios que o operador acrescentou (staging,
# app antigo, deep link do celular) e o sintoma seria "o login parou de voltar"
# — longe daqui e sem relação óbvia com "eu mexi nos e-mails".
SITE_ATUAL="$(json_str "$atual" site_url)"
ALLOW_ATUAL="$(json_str "$atual" uri_allow_list)"

SITE_NOVO="$SITE_ATUAL"
if [ -n "$APP_URL" ]; then
  # Troca só quando está vazio ou no default de projeto novo do Supabase.
  # Um Site URL que o operador escolheu fica como está — com aviso.
  case "$SITE_ATUAL" in
    ""|"http://localhost:3000"|"http://localhost:3000/") SITE_NOVO="$APP_URL";;
    *)
      if [ "${SITE_ATUAL%/}" != "${APP_URL%/}" ]; then
        c_ylw "  • Site URL já está em $SITE_ATUAL (deixei como está; o app usa $APP_URL)"
      fi;;
  esac
fi

ALLOW_NOVO="$ALLOW_ATUAL"
if [ -n "$APP_URL" ]; then
  for entrada in "${APP_URL%/}/auth/confirm" "${APP_URL%/}/**"; do
    case ",$ALLOW_NOVO," in
      *",$entrada,"*) ;;
      *) [ -n "$ALLOW_NOVO" ] && ALLOW_NOVO="$ALLOW_NOVO,$entrada" || ALLOW_NOVO="$entrada";;
    esac
  done
fi

# ── 5. Sobe ────────────────────────────────────────────────────────────────
corpo="{
  \"mailer_subjects_confirmation\": \"$(json_escape "Confirme seu e-mail — $APP_NOME")\",
  \"mailer_subjects_recovery\": \"$(json_escape "Redefinir senha — $APP_NOME")\",
  \"mailer_templates_confirmation_content\": \"$(json_escape "$HTML_CONFIRM")\",
  \"mailer_templates_recovery_content\": \"$(json_escape "$HTML_RECOVERY")\",
  \"site_url\": \"$(json_escape "$SITE_NOVO")\",
  \"uri_allow_list\": \"$(json_escape "$ALLOW_NOVO")\"
}"

resposta="$(api PATCH "/projects/$REF/config/auth" "$corpo")"

# ── 6. RELEITURA — a única prova que vale ──────────────────────────────────
#
# Não confie no 2xx. Medido: projeto pausado devolve 400 com
# {"message":"Project is paused."} e um script que só olhasse o código de saída
# do curl reportaria sucesso. E o modo de falha pior é o oposto — API que
# ACEITA e IGNORA — que nenhum código de status denuncia.
depois="$(api GET "/projects/$REF/config/auth")"
if grep -qF "$MARCADOR" <<<"$depois"; then
  c_grn "✓ e-mails de acesso configurados e CONFERIDOS (reli o que gravei)"
  c_dim "    assunto:  Confirme seu e-mail — $APP_NOME"
  c_dim "    botão:    $ACCENT sobre texto $ACCENT_FG"
  [ "$SITE_NOVO" = "$SITE_ATUAL" ] || c_dim "    site url: $SITE_NOVO"
  [ "$ALLOW_NOVO" = "$ALLOW_ATUAL" ] || c_dim "    redirect: $ALLOW_NOVO"
  exit 0
fi

motivo="$(json_str "$resposta" message)"
[ -n "$motivo" ] || motivo="$(json_str "$depois" message)"
instrua_e_saia "os e-mails de acesso NÃO foram configurados${motivo:+ — $motivo}.
    Reli a configuração depois de gravar e o conteúdo que mandei não estava lá.
    A instalação continua funcionando; só os e-mails ficam no modelo padrão."
