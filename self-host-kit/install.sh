#!/usr/bin/env bash
#
# DeskcommCRM — instalador self-host para VPS (HostGator).
#
# Idempotente: pode rodar de novo sem estragar nada. Dependências no host:
# só docker, docker compose, git, openssl, curl. psql/bootstrap rodam via Docker.
#
# Uso:
#   bash install.sh            # interativo (pergunta o que falta)
#   bash install.sh --yes      # não-interativo (usa .env já preenchido)
#
set -euo pipefail

# Diretório onde este script (e _common.sh, seu irmão) vivem — capturado ANTES
# de qualquer 'cd' (step 2 pode entrar num repo clonado à parte).
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

REPO_URL="${REPO_URL:-https://github.com/melgarafael/DeskcommCRM.git}"
# Uma constante, dois usos (o fim feliz e o fim travado) — e o comecar.sh tem a
# gêmea. Link repetido à mão vira link divergente na primeira troca.
COMUNIDADE_URL="https://lp-comunidade.automatiklabs.com.br"
REPO_DIR="${REPO_DIR:-deskcommcrm}"
COMPOSE="docker-compose.prod.yml"
COMPOSE_TRAEFIK="docker-compose.traefik.yml"
NONINTERACTIVE=0
[ "${1:-}" = "--yes" ] && NONINTERACTIVE=1

# Este script é standalone de propósito (roda antes do clone, então não dá para
# usar o _common.sh). As duas funções abaixo são gêmeas das de lá — se mexer
# numa, mexa na outra.
dc() {
  if [ "${REVERSE_PROXY:-caddy}" = "traefik" ]; then
    docker compose -f "$COMPOSE" -f "$COMPOSE_TRAEFIK" "$@"
  else
    docker compose -f "$COMPOSE" "$@"
  fi
}
dc_files() {
  if [ "${REVERSE_PROXY:-caddy}" = "traefik" ]; then
    printf -- '-f %s -f %s' "$COMPOSE" "$COMPOSE_TRAEFIK"
  else
    printf -- '-f %s' "$COMPOSE"
  fi
}

# ── Aparência ───────────────────────────────────────────────────────────────
# Cor só quando há terminal de verdade. Antes o ANSI saía sempre, inclusive
# quando a saída vai para arquivo — o agent.sh redireciona o update.sh (`>
# "$LOG"`) e o esc() de lá precisa varrer byte a byte para tirar esses escapes
# do heartbeat. Desligar na origem é a correção de causa. NO_COLOR é a
# convenção que quem roda em CI espera; FORCE_COLOR é a válvula de quem quer
# cor mesmo em pipe.
if   [ -n "${NO_COLOR:-}" ];    then COLOR=0
elif [ -n "${FORCE_COLOR:-}" ]; then COLOR=1
elif [ -t 1 ];                  then COLOR=1
else                                 COLOR=0
fi

# paint <código ANSI> <texto…>. Sem cor, imprime o texto cru — nunca some.
paint() { local code="$1"; shift; if [ "$COLOR" = 1 ]; then printf '\033[%sm%s\033[0m\n' "$code" "$*"; else printf '%s\n' "$*"; fi; }
c_red() { paint 31 "$*"; }
c_grn() { paint 32 "$*"; }
c_ylw() { paint 33 "$*"; }
c_dim() { paint 2  "$*"; }
die()   { c_red "✖ $*"; exit 1; }
step()  { printf '\n'; paint 1 "▶ $*"; }

# A resposta é sim? Aceita o que gente digita de verdade: s, S, sim, SIM, y,
# yes, com espaço em volta. Cada prompt comparava a resposta com uma string
# exata, então "S" e "sim" — a resposta certa, com a tecla errada — caíam no
# ramo do NÃO. No gate do DNS isso encerrava a instalação com uma frase que nem
# correspondia à escolha da pessoa. Gêmea da de _common.sh: se mexer numa,
# mexa na outra. Coberta por test-validators.sh.
resposta_sim() {
  local r
  r="$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  case "$r" in s|sim|y|yes) return 0;; *) return 1;; esac
}

# ── Fases da jornada ────────────────────────────────────────────────────────
# Os passos técnicos (step) são muitos e alguns são condicionais — numerá-los
# daria um "7 de 11" que muda conforme o caminho de cada instalação. As FASES
# são estáveis: são o mapa que a pessoa acompanha para saber onde está e
# quanto falta, num processo que leva minutos e é o primeiro contato dela com
# o produto.
FASE_TOTAL=4
fase() { printf '\n'; paint 1 "━━━ Fase $1/$FASE_TOTAL · $2"; }

# ── Marca ───────────────────────────────────────────────────────────────────
# Logo em blocos (fonte ANSI Shadow). Os blocos saem no MESMO verde do "✓" já
# usado aqui, e o relevo (═╗║╝╚╔) em dim: essa dupla lê tanto em terminal de
# fundo escuro quanto claro, sem precisar detectar o tema — uma cor de acento
# clara sumiria no branco de quem usa terminal claro.
#
# A pintura é por substituição literal de string (${x//…}), não por classe de
# caractere em sed/awk: sob LC_ALL=C essas ferramentas tratam a entrada como
# BYTES, e todos esses glifos começam com 0xE2 — uma classe [╗║…] casaria
# pedaço de █ e embaralharia o desenho na VPS de quem roda em locale C.
LOGO_COLS=71
banner() {
  local cols linha ch
  cols="$(tput cols 2>/dev/null || echo 80)"
  case "$cols" in ''|*[!0-9]*) cols=80;; esac
  printf '\n'
  # Terminal estreito recebe a versão de uma linha: logo quebrado no meio é
  # pior do que logo nenhum.
  if [ "$COLOR" != 1 ] || [ "$cols" -lt $((LOGO_COLS + 2)) ]; then
    paint 1 "  DESKCOMM"
  else
    # Tela limpa: tira o ruído do clone/apt de cima do logo. Exige TTY de
    # verdade (não basta COLOR=1): com FORCE_COLOR numa saída redirecionada, um
    # "limpe a tela" no meio do arquivo é lixo que ninguém pediu.
    [ -t 1 ] && printf '\033[2J\033[H'
    while IFS= read -r linha; do
      linha="${linha//█/$'\033[32m'█$'\033[0m'}"
      for ch in ═ ╗ ║ ╝ ╚ ╔; do linha="${linha//$ch/$'\033[2m'$ch$'\033[0m'}"; done
      printf '  %s\n' "$linha"
    done <<'LOGO'
██████╗ ███████╗███████╗██╗  ██╗ ██████╗ ██████╗ ███╗   ███╗███╗   ███╗
██╔══██╗██╔════╝██╔════╝██║ ██╔╝██╔════╝██╔═══██╗████╗ ████║████╗ ████║
██║  ██║█████╗  ███████╗█████╔╝ ██║     ██║   ██║██╔████╔██║██╔████╔██║
██║  ██║██╔══╝  ╚════██║██╔═██╗ ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║
██████╔╝███████╗███████║██║  ██╗╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║
╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝
LOGO
  fi
  printf '\n'
  c_dim "  Agentes de IA que atendem no WhatsApp, dentro do seu CRM."
  c_dim "  Open-source · roda no seu servidor · os dados são seus."
}

# ── Rede de segurança: nenhuma saída silenciosa ─────────────────────────────
# Antes, qualquer comando que falhasse sob `set -e` derrubava o script sem
# dizer nada (o caso real: um psql com connection string errada saía com
# código 2 dentro de uma substituição, e a pessoa só via o terminal voltar).
# Instalação é o primeiro contato com o produto: morrer mudo aqui é perder o
# usuário. Este trap garante que TODA saída != 0 explique o que fazer.
show_recovery() {
  local dir="${PROJECT_DIR:-$(pwd)}"
  c_red ""
  c_red "═══════════════════════════════════════════════════════"
  c_red " A instalação parou. Nada ficou pela metade sem conserto."
  c_red "═══════════════════════════════════════════════════════"
  printf '\n%s\n\n' "Como voltar atrás e recomeçar do zero:"
  printf '  %s\n' "cd ${dir}"
  printf '  %s\n' "rm -f .env                                    # apaga a configuração digitada"
  printf '  %s\n' "docker compose $(dc_files) down -v          # derruba o que subiu"
  printf '  %s\n' "bash ${KIT_DIR:-hostgator-setup-kit}/install.sh   # começa de novo"
  printf '\n%s\n' "Se o schema chegou a ser aplicado e você quer o banco limpo de novo,"
  printf '%s\n'   "abra o Supabase > SQL Editor e rode (ATENÇÃO: apaga todos os dados):"
  printf '  %s\n\n' "drop schema public cascade; create schema public;"
}
trap 'rc=$?; [ "$rc" -ne 0 ] && show_recovery; exit $rc' EXIT

# ── Validadores ─────────────────────────────────────────────────────────────
# Cada validador recebe o valor, imprime a explicação do problema em português
# e devolve != 0. Rodam ANTES de o valor entrar no .env — é o único momento em
# que a pessoa ainda pode corrigir sem desfazer nada. Um dado errado que passa
# daqui só aparece minutos depois, como erro técnico em outro lugar.

# Lê uma claim de um JWT do Supabase (chaves legadas 'eyJ...'). Só serve para
# dar mensagem de erro melhor — quem decide de verdade é a chamada HTTP real.
jwt_claim() {
  local p="${1#*.}"; p="${p%%.*}"
  p="${p//-/+}"; p="${p//_//}"
  case $(( ${#p} % 4 )) in 2) p="${p}==";; 3) p="${p}=";; esac
  printf '%s' "$p" | base64 -d 2>/dev/null \
    | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
}
# Referência do projeto (o 'abcdef' de https://abcdef.supabase.co)
sb_ref() { local u="${1#https://}"; printf '%s' "${u%%.*}"; }

v_domain() {
  case "$1" in
    http*) echo "Digite só o domínio, sem https:// — ex.: crm.suaempresa.com.br"; return 1;;
    */*)   echo "Digite só o domínio, sem barra nem caminho — ex.: crm.suaempresa.com.br"; return 1;;
    *.*)   return 0;;
    *)     echo "Isso não parece um domínio (falta o ponto) — ex.: crm.suaempresa.com.br"; return 1;;
  esac
}

v_email() {
  case "$1" in *@*.*) return 0;; esac
  echo "E-mail inválido — precisa ter @ e um domínio, ex.: voce@suaempresa.com.br"
  return 1
}

# A cor da marca. Aceita SÓ `#` + 6 dígitos hex, e essa estreiteza é medida, não
# gosto: o `marca-emails.sh:125` reconhece exatamente essa forma e cai calado no
# verde do produto em qualquer outra (`case "$ACCENT" in \#[0-9a-fA-F]x6`),
# enquanto o `ehHexValido` de `lib/branding/rampa.ts:49` aceita mais quatro
# formas (`#abc`, `abc`, `aabbcc` além de `#aabbcc`) e pinta a tela com elas. Um
# validador frouxo produziria o pior desfecho possível: a cor do revendedor na
# TELA e o verde do produto no PRIMEIRO e-mail que o cliente dele recebe — e
# split-brain de marca ninguém percebe, porque cada metade parece certa sozinha.
#
# Vazio passa porque o campo é opcional. Na entrevista o `ask_one` sequer chama
# o validador nesse caso (ele trata `-z "$input"` antes), então o `''` aqui é
# para quem reusar a função fora dela — e para que tirar o `opcional` do campo
# amanhã não vire uma instalação travada em quem não quer cor nenhuma.
v_hex() {
  case "$1" in ''|'#'[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) return 0;; esac
  echo "Use um código de cor como #7a5cd6 — cerquilha e 6 dígitos —, ou Enter para a cor do sistema"
  return 1
}

v_supabase_url() {
  case "$1" in
    https://*.supabase.co) ;;
    # Supabase SELF-HOSTED (ex.: https://db-crm.exemplo.com.br). A prova é a
    # chamada a /auth/v1/health logo abaixo, que vale para qualquer host — o
    # que se dispensa aqui é só a suposição de que todo Supabase é o da nuvem.
    https://*) ;;
    *supabase.co*) echo "Cole a URL completa, começando com https:// — ex.: https://abcdefgh.supabase.co"; return 1;;
    *) echo "A URL precisa começar com https://. Na nuvem ela fica em Settings > API > Project URL (termina em .supabase.co); num Supabase próprio, é o endereço do seu servidor."; return 1;;
  esac
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$1/auth/v1/health" 2>/dev/null)" || code=000
  if [ "$code" = "000" ]; then
    echo "Não consegui alcançar $1 — confira se o projeto existe, está ativo (projeto pausado não responde) e se o VPS tem internet."
    return 1
  fi
  return 0
}

# Confere formato + faz a chamada real que só a chave certa responde.
# $2 = papel esperado ('anon' ou 'service_role')
v_sb_key() {
  local key="$1" want="$2" url="${NEXT_PUBLIC_SUPABASE_URL:-}"
  case "$key" in
    eyJ*)
      local role ref
      role="$(jwt_claim "$key" role)"; ref="$(jwt_claim "$key" ref)"
      if [ -n "$role" ] && [ "$role" != "$want" ]; then
        echo "Essa é a chave '${role}', e aqui eu preciso da '${want}'. Em Settings > API elas ficam uma embaixo da outra — confira qual copiou."
        return 1
      fi
      if [ -n "$ref" ] && [ -n "$url" ] && [ "$ref" != "$(sb_ref "$url")" ]; then
        echo "Essa chave é de OUTRO projeto Supabase (${ref}), e a URL que você deu é do projeto $(sb_ref "$url"). Copie as duas do mesmo projeto."
        return 1
      fi;;
    sb_publishable_*|sb_secret_*) : ;;  # formato novo do Supabase — a prova é a chamada HTTP
    *) echo "Isso não parece uma chave do Supabase (elas começam com 'eyJ' ou 'sb_'). Pegue em Settings > API."; return 1;;
  esac
  [ -z "$url" ] && return 0
  local code
  if [ "$want" = "service_role" ]; then
    # Rota de administração: a anon leva 401 aqui. É o que separa uma da outra.
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
      -H "apikey: $key" -H "Authorization: Bearer $key" \
      "$url/auth/v1/admin/users?page=1&per_page=1" 2>/dev/null)" || code=000
  else
    # /auth/v1/settings é a rota que a anon PODE abrir. Não use /rest/v1/: ele
    # responde 401 "Only the service_role API key can be used for this endpoint"
    # até para a anon correta — validador que reprova o dado certo é pior que
    # nenhum. Provado nesta VPS: settings dá 200 para as chaves do projeto e 401
    # para lixo e para JWT de outro projeto.
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 -H "apikey: $key" "$url/auth/v1/settings" 2>/dev/null)" || code=000
  fi
  case "$code" in
    2*) return 0;;
    000) c_ylw "  ⚠ não consegui checar a chave online (sem resposta do Supabase); sigo com ela."; return 0;;
    401|403) echo "O Supabase recusou essa chave (resposta ${code}). Confira se copiou a '${want}' inteira, sem espaço no fim."; return 1;;
    *) echo "Resposta inesperada do Supabase ao testar a chave (${code}). Confira a chave e o projeto."; return 1;;
  esac
}
v_anon()    { v_sb_key "$1" anon; }
v_service() { v_sb_key "$1" service_role; }

v_db_url() {
  case "$1" in
    postgres://*|postgresql://*) ;;
    *) echo "A connection string começa com postgresql:// — copie em Settings > Database > Connection string, modo URI."; return 1;;
  esac
  case "$1" in
    *"[YOUR-PASSWORD]"*|*"[SUA-SENHA]"*|*"[your-password]"*)
      echo "Você colou a string com o [YOUR-PASSWORD] no meio — troque isso pela senha do banco (a que você definiu ao criar o projeto)."; return 1;;
  esac
  case "$1" in
    *db.*.supabase.co*)
      echo "Essa é a 'Direct connection' do Supabase — ela só existe em IPv6 e o VPS é IPv4, então nunca conecta."
      echo "   👉 Volte em Settings > Database e copie a do Session pooler (o host termina em .pooler.supabase.com)."
      return 1;;
  esac
  # Mesma família de projeto? (usuário do pooler é 'postgres.<ref>')
  local dbref="${1#*://}"; dbref="${dbref%%:*}"; dbref="${dbref#postgres.}"
  # Só a NUVEM tem <ref> a comparar. E a decisão é pelo HOST, nunca pela string
  # inteira: `case "$url" in *.supabase.co)` só casa quando a URL TERMINA nisso, e
  # ela chega com barra final, caminho ou espaço colado — é o que o address bar do
  # navegador entrega. Medido: com `https://<ref>.supabase.co/` a comparação era
  # pulada e uma connection string de OUTRO projeto passava, o que instala o
  # baseline.sql num banco e deixa o app falando com outro.
  local sbhost="${NEXT_PUBLIC_SUPABASE_URL:-}"
  sbhost="${sbhost#*://}"; sbhost="${sbhost%%/*}"
  sbhost="${sbhost%%[[:space:]]*}"; sbhost="${sbhost%%:*}"
  case "$sbhost" in
    *.supabase.co)
      if [ "$dbref" != "postgres" ] \
         && [ "$dbref" != "$(sb_ref "$NEXT_PUBLIC_SUPABASE_URL")" ]; then
        echo "Essa connection string é do projeto '${dbref}', mas a URL que você deu é do projeto '$(sb_ref "$NEXT_PUBLIC_SUPABASE_URL")'. Precisam ser o mesmo projeto."
        return 1
      fi;;
  esac
  local out
  if out="$(docker run --rm postgres:17-alpine psql "$1" -tAc 'select 1' 2>&1)"; then
    return 0
  fi
  echo "Não consegui conectar no banco. O Postgres respondeu:"
  printf '   %s\n' "$(printf '%s' "$out" | head -2)"
  case "$out" in
    *"could not translate host name"*)
      echo "   👉 Quase sempre é a senha com caractere especial: na URL ela precisa ser codificada."
      echo "      Troque  @ por %40   :  por %3A   /  por %2F   ?  por %3F   #  por %23";;
    *"password authentication failed"*)
      echo "   👉 Senha do banco errada. É a senha do PROJETO (definida ao criá-lo), não a da sua conta Supabase."
      echo "      Dá pra redefinir em Settings > Database > Reset database password.";;
    *"Network is unreachable"*|*"Cannot assign requested address"*)
      echo "   👉 Isso é o problema de IPv6: use a connection string do Session pooler, não a Direct connection.";;
  esac
  return 1
}

v_anthropic() {
  case "$1" in sk-ant-*) ;; *) echo "A chave da Anthropic começa com 'sk-ant-'. Pegue em console.anthropic.com > API Keys."; return 1;; esac
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://api.anthropic.com/v1/models \
    -H "x-api-key: $1" -H "anthropic-version: 2023-06-01" 2>/dev/null)" || code=000
  case "$code" in
    2*) return 0;;
    000) c_ylw "  ⚠ não consegui checar a chave online; sigo com ela."; return 0;;
    401) echo "A Anthropic recusou essa chave (401). Confira se está ativa e se copiou inteira."; return 1;;
    *)   c_ylw "  ⚠ a Anthropic respondeu ${code} ao testar a chave; sigo com ela."; return 0;;
  esac
}

# A OpenRouter entrou na lista de provedores (opção [1] da pergunta de qual IA
# vai atender) sem que este validador existisse. `ask_one` despacha o validador
# pelo NOME — `"$validator" "$input"` —, então um nome inexistente vira exit 127
# e o laço repete a pergunta para sempre: a pessoa que escolhe [1] não consegue
# terminar a instalação. E no caminho `--yes` a mesma ausência vira
# "OPENROUTER_API_KEY inválido" seguido de "Corrija o .env e rode de novo" —
# instrução impossível de cumprir, porque o .env está certo.
v_openrouter() {
  case "$1" in sk-or-*) ;; *) echo "A chave da OpenRouter começa com 'sk-or-'. Pegue em openrouter.ai/keys."; return 1;; esac
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://openrouter.ai/api/v1/key \
    -H "Authorization: Bearer $1" 2>/dev/null)" || code=000
  case "$code" in
    2*) return 0;;
    000) c_ylw "  ⚠ não consegui checar a chave online; sigo com ela."; return 0;;
    401) echo "A OpenRouter recusou essa chave (401). Confira se está ativa e se copiou inteira."; return 1;;
    *)   c_ylw "  ⚠ a OpenRouter respondeu ${code} ao testar a chave; sigo com ela."; return 0;;
  esac
}

v_openai() {
  [ -z "$1" ] && return 0   # opcional
  case "$1" in sk-*) ;; *) echo "A chave da OpenAI começa com 'sk-'. Pegue em platform.openai.com > API keys (ou deixe em branco)."; return 1;; esac
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://api.openai.com/v1/models \
    -H "Authorization: Bearer $1" 2>/dev/null)" || code=000
  case "$code" in
    2*) return 0;;
    000) c_ylw "  ⚠ não consegui checar a chave online; sigo com ela."; return 0;;
    401) echo "A OpenAI recusou essa chave (401). Confira se está ativa e se copiou inteira."; return 1;;
    *)   c_ylw "  ⚠ a OpenAI respondeu ${code} ao testar a chave; sigo com ela."; return 0;;
  esac
}

v_password() {
  [ "${#1}" -ge 8 ] && return 0
  echo "Senha muito curta (${#1} caracteres). Use pelo menos 8 — é a senha de admin do seu CRM."
  return 1
}

# ── Pergunta uma coisa, valida, e aceita 'voltar' ───────────────────────────
# Devolve 0 quando o valor foi aceito, 2 quando a pessoa pediu para voltar.
# Repete a pergunta enquanto o validador reprovar: o instalador não deixa mais
# ninguém avançar carregando um dado errado.
ask_one() {
  local var="$1" prompt="$2" default="${3:-}" validator="${4:-}" secret="${5:-}" optional="${6:-}"
  local cur="${!var:-}"
  [ -n "$cur" ] && return 0
  if [ "$NONINTERACTIVE" = 1 ]; then
    if [ -n "$default" ]; then printf -v "$var" '%s' "$default"; return 0; fi
    [ -n "$optional" ] && return 0
    die "Falta $var (modo --yes exige .env preenchido)."
  fi
  local input
  while :; do
    if [ "$secret" = "secret" ]; then
      if ! read -r -s -p "$prompt${default:+ [$default]}: " input; then
        die "A entrada terminou antes de eu receber $var. Rode o instalador num terminal interativo."
      fi
      echo
    else
      if ! read -r -p "$prompt${default:+ [$default]}: " input; then
        die "A entrada terminou antes de eu receber $var. Rode o instalador num terminal interativo."
      fi
    fi
    [ "$input" = "voltar" ] && return 2
    input="${input:-$default}"
    if [ -z "$input" ]; then
      [ -n "$optional" ] && { printf -v "$var" '%s' ""; return 0; }
      c_red "  Esse campo é obrigatório. (digite 'voltar' para refazer a pergunta anterior)"
      continue
    fi
    # Campo secreto não ecoa o que foi colado — a pessoa não vê se colou, então
    # tende a colar de novo "pra garantir", e cola duas vezes na mesma linha
    # (sem separador, vira um valor só, dobrado). Isso gera chaves/connection
    # strings inválidas com erro críptico lá na frente.
    if [ "$secret" = "secret" ]; then
      local len=${#input} half=$(( ${#input} / 2 ))
      if [ $((len % 2)) -eq 0 ] && [ "${input:0:half}" = "${input:half}" ]; then
        c_red "  Esse valor parece ter sido colado 2x seguidas (o campo é secreto e não mostra o que você cola). Cole uma vez só."
        continue
      fi
    fi
    if [ -n "$validator" ]; then
      printf '  … conferindo\r'
      local msg
      if ! msg="$("$validator" "$input" 2>&1)"; then
        printf '            \r'
        printf '\033[31m  ✖ %s\033[0m\n' "$(printf '%s' "$msg" | head -1)"
        printf '%s\n' "$(printf '%s' "$msg" | tail -n +2)" | grep -v '^$' || true
        c_dim "  (digite 'voltar' para refazer a pergunta anterior)"
        continue
      fi
      [ -n "$msg" ] && printf '%s\n' "$msg"
      printf '            \r'
    fi
    if [ "$secret" = "secret" ]; then c_grn "  ✓ recebido (${#input} caracteres)"; else c_grn "  ✓"; fi
    printf -v "$var" '%s' "$input"
    save_partial "$var"
    return 0
  done
}

# O limiar NÃO é 4 GB, e a diferença importa: `MemTotal` é o que sobra depois
# do que o kernel reserva para si, sempre menos do que foi vendido. Medido num
# kernel com 8 GiB configurados: 8025284 KB, ou 95,7% — na mesma proporção uma
# VPS de 4 GiB reporta ~4.012.000 KB, 0,3% acima de 4.000.000. E quem vende "4
# GB" em GB decimais entrega 3.906.250 KB, que reporta ~3.735.000. Ou seja: com
# o corte em 4.000.000 o aviso caía em cima de quem tinha ACABADO de comprar
# exatamente a VPS recomendada — a pior hora possível para dizer a alguém que o
# servidor dele é pequeno demais. 3.500.000 KB (3,34 GiB) deixa 4 GB de fora em
# qualquer convenção e ainda pega de sobra as de 2 e 3 GB, que sofrem de verdade.
RAM_MINIMA_KB=3500000
ram_abaixo_do_recomendado() { [ "${1:-0}" -lt "$RAM_MINIMA_KB" ]; }

# Uma linha de .env com o valor entre aspas DUPLAS e `\`, `"`, `$` e crase
# escapados — o que faz nome de empresa e senha sobreviverem à releitura.
#
# O encoding tem de servir a TRÊS consumidores, cada um com um parser próprio, e
# nenhum deles é o mesmo shell: o `load_env` do _common.sh (leitura manual, por
# onde passa todo script do kit), o `env_file: .env` do docker-compose.prod.yml
# (:34 e :71) e o `source .env && curl …` que o README ensina (:143).
#
# Era aspas SIMPLES, com a aspa do conteúdo escrita como `'\''` — shell válido,
# e só. O parser de dotenv do Compose não é um shell: ele lê aquela barra como
# começo de nome de variável e recusa o ARQUIVO INTEIRO. Medido no compose
# v2.38.2 com `APP_NAME=Sant'Ana Odontologia`:
#
#   failed to read .env: line 1: unexpected character "\" in variable name
#   "\''Ana Odontologia'"
#   config → rc=1 ; ps → rc=1 ; pull → rc=1   (o mesmo .env sem apóstrofo: rc=0)
#
# Nomes assim são comuns aqui — "Sant'Ana", "D'Ávila", "Espaço D'Or" —, APP_NAME
# é a última pergunta da entrevista e não tem validador. O desfecho era o pior
# tipo de quebra: Supabase provisionado, schema aplicado, admin criado, e TODO
# comando docker do kit morto, sem nada apontando para o .env.
#
# RESIDUAL MEDIDO, e a escolha por trás dele: o Compose desfaz `\"`, `\\` e `\$`
# dentro das aspas duplas, mas NÃO desfaz a crase escapada — um valor com crase
# chega ao contêiner com as barras (medido: `Loja \`date\` Ltda`). Escapá-la
# assim mesmo é deliberado: sem a barra, o `source .env` do README EXECUTA o que
# estiver entre crases. Caractere feio no contêiner é preço menor que execução
# de comando na máquina de quem instala. As duas outras pontas (load_env e
# source) recebem a crase intacta.
#
# Fica aqui em cima (e não junto do bloco que escreve o .env) porque o
# save_partial abaixo grava durante a ENTREVISTA, muito antes daquele bloco.
envq() { printf '%s="%s"\n' "$1" "$(printf '%s' "${2-}" | sed 's/[\\"$`]/\\&/g')"; }

# Guarda cada resposta no instante em que ela é aceita. Antes, as 12 respostas
# só viravam arquivo no FIM: quem travasse na connection string — a pergunta
# mais difícil, e a última das credenciais — perdia tudo o que já tinha digitado
# e recomeçava do zero na tentativa seguinte. Justamente quem mais precisa de
# uma segunda tentativa é quem tem menos paciência para redigitar 11 campos.
# Mesma permissão do .env (600): o conteúdo é o mesmo, inclusive os segredos.
PARTIAL_FILE="${PARTIAL_FILE:-.env.partial}"
save_partial() {
  local var="$1" val="${!1-}" tmp="${PARTIAL_FILE}.tmp.$$"
  umask 077
  { [ -f "$PARTIAL_FILE" ] && grep -vE "^${var}=" "$PARTIAL_FILE" || true; } > "$tmp"
  envq "$var" "$val" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$PARTIAL_FILE"
}

# Quem publica 80 ou 443 NO HOST? Lê linhas "nome|projeto|imagem|portas" (o
# formato do docker ps) e ecoa "nome|imagem" do primeiro que casar.
#
# O lado que importa da coluna Ports é o ANTES da seta — "0.0.0.0:80->80/tcp" é
# host 80; "0.0.0.0:8080->80/tcp" é host 8080 e NÃO disputa nada. A primeira
# versão disto olhava `docker port` ancorado na porta INTERNA, e errava dos dois
# lados: abortava a instalação por causa de um phpMyAdmin em `-p 8080:80` (com
# 80/443 livres, mandando o dono derrubar o site dele), e deixava passar um proxy
# real em `-p 80:8080`, que é como se sobe Traefik sem privilégio.
#
# Separador é "|", não TAB: tab é IFS-whitespace, então dois tabs seguidos viram
# um só e o campo vazio do meio SOME — um proxy subido com `docker run` (sem
# label de compose) perdia a imagem, e o Traefik da hospedagem chamado
# "coolify-proxy" era classificado como intruso.
dono_das_portas() {  # dono_das_portas  < linhas   → ecoa "nome|projeto|imagem"
  local nome proj img ports
  while IFS='|' read -r nome proj img ports; do
    [ -n "$nome" ] || continue
    case "${ports// /}" in
      *:80-\>*|*:443-\>*) printf '%s|%s|%s' "$nome" "$proj" "$img"; return 0;;
    esac
  done
  return 1
}

# `nome_do_projeto_compose` e a checagem da rede externa do proxy vivem em
# _common.sh: o update.sh precisa das mesmas duas coisas e duplicá-las era
# garantir que uma das cópias envelhecesse. Este arquivo as usa depois do
# `source` do bloco 2 (nada acima dele depende delas).

# A pergunta que decide é "o Docker consegue publicar a porta?", e a resposta
# vem de TENTAR — não de inferir. Toda heurística sobre `docker port` ou `ss`
# erra em algum caso real (proxy sem privilégio publicando 80:8080, app em
# 8080:80, bind só no loopback, `ss` fora do PATH, userland-proxy desligado), e
# erra dos dois lados: ou aborta uma instalação boa, ou entrega o choque de
# portas lá na frente. Publicar de mentirinha usa exatamente a mecânica que o
# Caddy vai usar, então não há espaço entre o teste e a realidade.
# O contêiner sai na hora; a imagem é a mesma que o compose do kit já usa.
porta_publicavel() {  # porta_publicavel <porta>
  docker run --rm -p "$1:$1" --entrypoint /bin/true alpine:3.20 >/dev/null 2>&1
}

# A decisão final, isolada para poder ser exercitada sem Docker: este é o ponto
# que já errou duas vezes (uma tratando o próprio Caddy como intruso, outra
# deixando passar proxy que não fosse Traefik), e nas duas o erro só apareceu
# rodando de verdade numa VPS.
# Ecoa: caddy | traefik | bloqueia
decide_proxy() {  # decide_proxy <portas_ocupadas> <projeto_do_dono> <projeto_atual> <imagem> <nome>
  local ocupadas="${1:-}" dono_proj="${2:-}" meu_proj="${3:-}" img="${4:-}" nome="${5:-}"
  [ -z "$ocupadas" ] && { printf 'caddy'; return 0; }
  # As portas estão com ESTA MESMA instalação, já no ar: é a re-execução, que o
  # próprio kit ensina como caminho para corrigir uma resposta.
  [ -n "$dono_proj" ] && [ "$dono_proj" = "$meu_proj" ] && { printf 'caddy'; return 0; }
  eh_traefik "$img" "$nome" && { printf 'traefik'; return 0; }
  printf 'bloqueia'
}

# É um Traefik? Compara em minúsculas o par imagem+nome. A versão anterior usava
# `*[Tt]raefik*`, que só tem classe de equivalência no primeiro caractere:
# um contêiner "TRAEFIK-PROXY" escapava e era tratado como intruso.
eh_traefik() {  # eh_traefik <imagem> <nome>
  case "$(printf '%s %s' "${1:-}" "${2:-}" | tr '[:upper:]' '[:lower:]')" in
    *traefik*) return 0;;
  esac
  return 1
}

# O ÚNICO Traefik de uma lista do `docker ps` — e só quando é único.
#
# Existe porque a busca por porta publicada NÃO enxerga proxy em modo host:
# compartilhando a stack de rede da máquina, ele ouve 80/443 sem publicar nada e
# a coluna Ports do `docker ps` sai VAZIA. Medido no docker 28.3.2: um contêiner
# em `--network host` sai com Ports=[] mesmo subido com `-p 80:80` (o daemon
# avisa "Published ports are discarded when using host network mode"); controle
# positivo, o mesmo nginx numa bridge com `-p 8080:80` sai com
# "0.0.0.0:8080->80/tcp". É o caso da Hostinger, e sem este caminho o dono das
# portas fica "não identificado" — a instalação morre no painel de bloqueio.
#
# Falha FECHADA no plural: com dois Traefiks não dá para saber qual está com as
# portas, e chutar publica o CRM atrás do proxy errado — um site que "instala com
# sucesso" e não responde. Nesse caso ninguém é eleito e o painel de bloqueio, que
# ao menos diz o que fazer, volta a ser o desfecho.
unico_traefik() {  # unico_traefik  < linhas "nome|projeto|imagem|portas"  → ecoa "nome|projeto|imagem"
  local nome proj img ports achado="" n=0
  while IFS='|' read -r nome proj img ports; do
    [ -n "$nome" ] || continue
    eh_traefik "$img" "$nome" || continue
    achado="$nome|$proj|$img"; n=$((n + 1))
  done
  [ "$n" = 1 ] || return 1
  printf '%s' "$achado"
}

# Qual rede gravar em TRAEFIK_NETWORK. Isolada do Docker para poder ser
# exercitada: é aqui que moram DUAS conclusões opostas, e cada uma já foi a
# única implementada em algum momento do kit.
#
#   Traefik numa bridge PRÓPRIA  → a rede dele (o app é anexado a ela).
#     Medido com Traefik v3.3 real: com o label apontando para a rede do projeto
#     a requisição fica em HTTP 000 (timeout) mesmo com o contêiner nas duas
#     redes; só apontando para a rede do PROXY vira HTTP 200.
#
#   Traefik em modo HOST         → uma bridge NOSSA, que o instalador cria.
#     Aqui o proxy não está em rede nenhuma do Docker (`.NetworkSettings.Networks`
#     devolve a string "host", que existe no `docker network ls` mas com driver
#     `host` e não aceita contêiner junto de uma bridge). Compartilhando a stack
#     do host ele alcança qualquer bridge por IP — medido nesta máquina: contêiner
#     em `--network host` faz `curl` no IP de um contêiner numa bridge separada e
#     recebe HTTP 200. Então a rede a apontar é uma bridge onde o app esteja, e
#     usamos uma dedicada em vez da `_internal` do projeto por dois motivos
#     medidos: (1) o compose recusa `external` apontando para a rede que ele
#     mesmo criaria — "network <projeto>_internal declared as external, but could
#     not be found" numa instalação nova; (2) a `internal` tem o redis SEM SENHA,
#     e a rede do proxy é a única que um dia pode receber contêiner de fora.
rede_do_traefik() {  # rede_do_traefik <NetworkMode do contêiner> <redes do contêiner> <bridge do projeto>
  local netmode="${1:-}" redes="${2:-}" nossa="${3:-}"
  [ "$netmode" = host ] && { printf '%s' "$nossa"; return 0; }
  printf '%s' "$redes" | awk '{print $1}'
}

# Um Traefik eleito pela varredura de MODO HOST é suspeita, não prova. A eleição
# por porta publicada tem a evidência na mão — a coluna Ports diz `:80->`. A
# varredura por `--network host` não tem nenhuma: em modo host a coluna sai vazia
# para TODO mundo, então o que ela responde é "existe um único Traefik em modo
# host nesta máquina", e não "é ele quem está com as portas". Basta um nginx ou
# apache NATIVO segurando 80/443 e um Traefik em modo host servindo outra coisa
# para o instalador publicar o CRM atrás de um proxy que não atende: "instalou
# com sucesso" e o site mudo — o desfecho silencioso que este bloco inteiro
# existe para evitar.
#
# Fechado na AÇÃO, aberto na INFORMAÇÃO: quem está na frente do terminal
# confirma (e a pergunta diz o que foi encontrado); quem rodou --yes leva uma
# recusa que ensina a saída, que é declarar REVERSE_PROXY=traefik no .env. A
# declaração explícita continua valendo — ali a escolha é de quem instala, não
# um chute do instalador.
# Ecoa: segue | pergunta | recusa
confianca_no_dono_das_portas() {  # confianca_no_dono_das_portas <veio_da_varredura_host> <noninteractive>
  local varredura="${1:-0}" nao_interativo="${2:-0}"
  [ "$varredura" = 1 ] || { printf 'segue'; return 0; }
  [ "$nao_interativo" = 1 ] && { printf 'recusa'; return 0; }
  printf 'pergunta'
}

# Esconde o miolo de um segredo para a tela de conferência.
mask() {
  local v="$1"
  if [ -z "$v" ]; then printf '(vazio)'; return; fi
  if [ "${#v}" -le 12 ]; then printf '%s' "****"; else printf '%s…%s (%d caracteres)' "${v:0:8}" "${v: -4}" "${#v}"; fi
}

# Lê as 4 credenciais que o supabase-provision.sh imprime (`CHAVE='valor'`) SEM
# interpretar o conteúdo.
#
# Por que não `eval`: os valores saem de `printf "%s='%s'"` sem escapar a aspa
# simples, então um valor que contenha `'` fecha o literal e o resto da linha
# volta a ser CÓDIGO — e `SUPABASE_REGION`, que vem do ambiente, é interpolada
# dentro da connection string que sai de lá. Mesma postura do `load_env`
# (_common.sh): casa a chave contra uma lista fixa e copia o valor como texto.
# Chave fora da lista é ignorada, então a saída nunca cria variável arbitrária.
sb_carrega_credenciais() {
  local linha val
  while IFS= read -r linha; do
    val="${linha#*=\'}"; val="${val%\'}"
    case "$linha" in
      NEXT_PUBLIC_SUPABASE_URL=\'*\')      NEXT_PUBLIC_SUPABASE_URL="$val";;
      NEXT_PUBLIC_SUPABASE_ANON_KEY=\'*\') NEXT_PUBLIC_SUPABASE_ANON_KEY="$val";;
      SUPABASE_SERVICE_ROLE_KEY=\'*\')     SUPABASE_SERVICE_ROLE_KEY="$val";;
      SUPABASE_DB_URL=\'*\')               SUPABASE_DB_URL="$val";;
    esac
  done <<<"$1"
}

# Carrega só as funções acima, sem instalar nada — é assim que
# `test-validators.sh` exercita os validadores:  INSTALL_SH_LIB=1 . install.sh
if [ "${INSTALL_SH_LIB:-}" = "1" ]; then trap - EXIT; return 0; fi

banner

# ── 1. Preflight ────────────────────────────────────────────────────────────
fase 1 "Preparando o servidor"
step "Verificando dependências"

# VPS "cru" (Hetzner, DigitalOcean, Contabo…) não vem com Docker. Antes isto era
# um beco sem saída: o script morria dizendo "instale antes de continuar" e a
# pessoa — que por definição não é técnica — ficava sem saber como. Hospedagens
# com template (Hostinger, HostGator) já trazem Docker, então o caso nunca
# aparecia para quem escreveu o kit.
#
# O instalador oficial do Docker é o mesmo comando da documentação deles; não
# inventamos nada. Em modo interativo PERGUNTA (instalar coisa no servidor de
# alguém sem avisar é abuso de confiança); com --yes segue direto, que é o
# contrato desse modo.
if ! command -v docker >/dev/null 2>&1; then
  c_ylw "⚠ Docker não está instalado — é o motor que roda o CRM."
  instalar=1
  if [ "$NONINTERACTIVE" = 0 ]; then
    read -r -p "  Posso instalar agora? (S/n) " r
    case "${r:-S}" in [Nn]*) instalar=0;; esac
  fi
  if [ "$instalar" = 1 ]; then
    c_dim "  Instalando (get.docker.com — o instalador oficial). Leva 1-2 minutos…"
    # A saída vai para um log em vez de /dev/null: silenciar o stderr também
    # deixava a falha MUDA (disco cheio, apt travado, arquitetura sem pacote
    # viravam todos a mesma frase genérica) — exatamente o que o trap lá em cima
    # existe para impedir. Tela limpa no caminho feliz, causa real no caminho ruim.
    _docker_log="$(mktemp)"
    if ! curl -fsSL https://get.docker.com | sh >"$_docker_log" 2>&1; then
      c_red "  Últimas linhas do instalador do Docker:"; tail -15 "$_docker_log" >&2
      die "Não consegui instalar o Docker (log em $_docker_log). Rode 'curl -fsSL https://get.docker.com | sh' e tente de novo."
    fi
    rm -f "$_docker_log"; unset _docker_log
    command -v docker >/dev/null 2>&1 || die "Docker instalou mas não ficou no PATH. Reabra o terminal e rode de novo."
    c_grn "✓ Docker instalado"
  else
    die "Sem Docker não dá para seguir. Instale com: curl -fsSL https://get.docker.com | sh"
  fi
fi

for bin in docker git openssl curl; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' não encontrado. Instale antes de continuar."
done
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) não encontrado."
docker info >/dev/null 2>&1 || die "O daemon do Docker não está rodando (ou seu usuário não tem permissão)."
c_grn "✓ docker, git, openssl, curl ok"

# RAM: a imagem é pré-buildada, então a stack SOBE com 2GB. Mas o runbook de produção
# declara 4GB como mínimo de operação: 7 contêineres, e o WAHA usa ~150MB por sessão
# sobre ~300MB de overhead do Node. Avisar só abaixo de 1.5GB deixava o operador
# instalar em 2GB achando que estava dentro do recomendado.
if [ -r /proc/meminfo ]; then
  mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  if ram_abaixo_do_recomendado "$mem_kb"; then
    c_ylw "⚠ Este servidor tem ~$((mem_kb/1024))MB de RAM. O CRM sobe, mas fica no limite:"
    c_ylw "  são 7 contêineres e o WhatsApp usa ~150MB por número conectado."
    c_ylw "  Adicione swap antes de operar — ver docs/runbooks/waha-hostgator.md."
  fi
fi

# ── 2. Repositório ──────────────────────────────────────────────────────────
step "Localizando o projeto"
if [ -f "$COMPOSE" ]; then
  c_grn "✓ rodando dentro do repositório"
elif [ -f "$REPO_DIR/$COMPOSE" ]; then
  cd "$REPO_DIR"; c_grn "✓ repositório em ./$REPO_DIR"
else
  c_ylw "Clonando $REPO_URL ..."
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
  cd "$REPO_DIR"
fi
PROJECT_DIR="$(pwd)"
source "$KIT_DIR/_common.sh"

# ── 3. Coleta de config ─────────────────────────────────────────────────────
fase 2 "Suas informações"
step "Configuração"
# Se já existe .env, carrega pra não repetir perguntas (idempotência).
if [ -f .env ]; then load_env .env; c_grn "✓ .env existente carregado"; fi
# Respostas guardadas de uma tentativa que não chegou ao fim. Carregam DEPOIS do
# .env de propósito: se as duas fontes têm a chave, a mais recente é esta.
if [ -f "$PARTIAL_FILE" ]; then
  load_env "$PARTIAL_FILE"
  c_grn "✓ retomando: $(grep -c '=' "$PARTIAL_FILE" 2>/dev/null || echo 0) resposta(s) guardadas da tentativa anterior"
  c_dim "  (para responder tudo de novo do zero: rm $PARTIAL_FILE)"
fi

# ── Proxy reverso: quem está com as portas 80 e 443? ────────────────────────
# Fica AQUI, logo depois de ler o .env e ANTES de qualquer coisa cara: era a
# última etapa da fase 2, então quem esbarrava neste problema já tinha criado um
# projeto Supabase, respondido tudo e esperado o clone — para só então o
# `docker compose up` morrer com "Bind for 0.0.0.0:80 failed: port is already
# allocated". Descobrir isso antes de cobrar qualquer trabalho é o mínimo.
#
# A varredura NÃO procura por "traefik": procura por QUEM PUBLICA as portas, e
# só depois pergunta o que é. A versão anterior só reconhecia Traefik, então um
# Caddy — inclusive o de outro DeskcommCRM instalado na mesma VPS — passava
# despercebido e a instalação escolhia `caddy`, garantindo o choque de portas.
# Medido numa VPS com produção rodando: exatamente esse erro, na fase 4.
#
# Contêineres DESTA instalação são ignorados: numa re-execução o nosso próprio
# Caddy está de pé publicando 80/443, e tratá-lo como "outro proxy" mataria a
# idempotência — que é justamente o que permite rodar de novo para corrigir uma
# resposta errada.
proj_atual="$(nome_do_projeto_atual)"

portas_ocupadas=""; n_ocupadas=0
porta_publicavel 80  || { portas_ocupadas="80"; n_ocupadas=1; }
porta_publicavel 443 || { portas_ocupadas="${portas_ocupadas:+$portas_ocupadas e }443"; n_ocupadas=$((n_ocupadas + 1)); }

# Identificação do ocupante — só para a MENSAGEM. Quem decide é o teste acima,
# então não saber quem é NUNCA vira "pode instalar": a falha é fechada.
# O "|| true" não é decorativo: numa atribuição o status do pipeline vira o
# status do script, e sob `set -e` + `pipefail` um docker ps que falhe (ou um
# SIGPIPE do consumidor) mataria o instalador mudo, no meio da fase 2.
dono_portas=""; dono_projeto=""; dono_imagem=""
if [ -n "$portas_ocupadas" ]; then
  _dono="$(docker ps --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Image}}|{{.Ports}}' 2>/dev/null | dono_das_portas || true)"
  if [ -n "$_dono" ]; then
    dono_portas="${_dono%%|*}"; _resto="${_dono#*|}"
    dono_projeto="${_resto%%|*}"; dono_imagem="${_resto#*|}"
    unset _resto
  fi
  unset _dono
fi

# Ninguém PUBLICA as portas, mas elas estão ocupadas: o candidato é um proxy em
# modo host, que ouve 80/443 pela stack de rede da máquina e por isso sai com a
# coluna Ports vazia (a medição está em `unico_traefik`). Sem este ramo o dono
# ficava "não identificado" e a instalação parava no painel de bloqueio — que
# manda pôr REVERSE_PROXY=traefik no .env, caminho que também morria adiante.
# É exatamente a VPS Hostinger da issue #139.
#
# A eleição fica MARCADA: quem veio daqui não tem a coluna Ports como prova, e o
# `case` abaixo trata essa diferença (ver `confianca_no_dono_das_portas`).
dono_por_varredura_host=0
if [ -n "$portas_ocupadas" ] && [ -z "$dono_portas" ]; then
  _host="$(docker ps --filter network=host --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Image}}|{{.Ports}}' 2>/dev/null | unico_traefik || true)"
  if [ -n "$_host" ]; then
    dono_portas="${_host%%|*}"; _resto="${_host#*|}"
    dono_projeto="${_resto%%|*}"; dono_imagem="${_resto#*|}"
    dono_por_varredura_host=1
    unset _resto
  fi
  unset _host
fi

# Inicializado sempre: o bloco da rede do Traefik, mais abaixo, lê esta variável
# sem default, e sob `set -u` uma instalação que já traz REVERSE_PROXY=traefik no
# .env (portanto sem passar pela detecção) morreria com "unbound variable".
traefik_container=""

if [ -z "${REVERSE_PROXY:-}" ]; then
  # A exclusão da própria instalação acontece AQUI, não na varredura: o teste de
  # bind não tem como se auto-excluir, então filtrar o nosso contêiner antes só
  # produzia um "ocupado por ninguém" — bloqueio sem um comando sequer.
  case "$(decide_proxy "$portas_ocupadas" "$dono_projeto" "$proj_atual" "$dono_imagem" "$dono_portas")" in
  caddy)
    REVERSE_PROXY=caddy
    [ -n "$portas_ocupadas" ] && c_dim "  (as portas 80/443 já estão com esta instalação — seguindo)"
    ;;
  traefik)
    # O porquê de a varredura por modo host não bastar sozinha está em
    # `confianca_no_dono_das_portas`.
    case "$(confianca_no_dono_das_portas "$dono_por_varredura_host" "$NONINTERACTIVE")" in
    pergunta)
      c_ylw "⚠ As portas ${portas_ocupadas} estão ocupadas, mas NENHUM contêiner as publica."
      c_ylw "  O único Traefik em modo host aqui é '${dono_portas}'${dono_imagem:+ (imagem ${dono_imagem})}."
      printf '\n%s\n'   "  Em modo host o Docker não mostra as portas, então não consigo PROVAR que é ele"
      printf '%s\n\n'   "  quem atende o seu domínio — poderia ser um nginx/apache instalado no servidor."
      printf '%s\n'     "  Se for ele, o CRM sai publicado por ele e tudo funciona."
      printf '%s\n\n'   "  Se não for, o site vai subir e não responder — sem erro nenhum na tela."
      if ! read -r -p "  É o '${dono_portas}' que atende o seu site? (s/N) " _r; then _r=""; fi
      if ! resposta_sim "$_r"; then
        die "Ok, não vou arriscar. Descubra quem está com as portas 80/443 (ex.: 'ss -ltnp | grep :80')
e, se for mesmo um Traefik, ponha REVERSE_PROXY=traefik no .env e rode de novo."
      fi
      unset _r
      ;;
    recusa)
      c_red "✖ As portas ${portas_ocupadas} estão ocupadas, mas NENHUM contêiner as publica."
      printf '\n%s\n'   "  O único Traefik em modo host aqui é '${dono_portas}'${dono_imagem:+ (imagem ${dono_imagem})},"
      printf '%s\n\n'   "  e em modo host o Docker não mostra porta — não dá para provar que é ele quem atende."
      printf '%s\n'     "  Publicar o CRM atrás do proxy errado instala 'com sucesso' um site que não responde,"
      printf '%s\n\n'   "  então em modo --yes eu paro aqui em vez de chutar."
      printf '%s\n'     "  É esse Traefik mesmo? Ponha no .env e rode de novo:"
      printf '%s\n\n'   "       REVERSE_PROXY=traefik"
      printf '%s\n'     "  Não é? Confira quem está com as portas: ss -ltnp | grep -E ':80|:443'"
      die "Não consigo identificar com certeza o dono das portas ${portas_ocupadas} em modo --yes."
      ;;
    esac
    REVERSE_PROXY=traefik
    traefik_container="$dono_portas"
    c_ylw "⚠ Detectei um Traefik já rodando neste VPS (contêiner '${dono_portas}', ocupando 80/443)."
    c_ylw "  Vou publicar o CRM através dele em vez de subir um proxy próprio —"
    c_ylw "  desligar o Traefik quebraria o que a sua hospedagem instalou."
    ;;
  *)
    # A preposição vem junto do trecho: "por o contêiner" sai errado se a frase
    # fixar "por" e o pedaço variável começar com artigo. E a imagem só entra se
    # for conhecida — "(imagem )" vazio era o sintoma de um campo perdido.
    ocupante="${dono_portas:+pelo contêiner '${dono_portas}'${dono_imagem:+ (imagem ${dono_imagem})}}"
    ocupante="${ocupante:-por um programa do próprio servidor}"
    # Concordância com o número de portas: "A porta 80 e 443 já está ocupada"
    # saiu na prova real e denuncia texto montado sem olhar o próprio dado.
    if [ "$n_ocupadas" -gt 1 ]; then
      c_red "✖ As portas ${portas_ocupadas} já estão ocupadas ${ocupante}."
    else
      c_red "✖ A porta ${portas_ocupadas} já está ocupada ${ocupante}."
    fi
    printf '\n%s\n'   "  O CRM precisa dessas duas portas para publicar o site com HTTPS. Subir um"
    printf '%s\n\n'   "  segundo proxy nelas não funciona: o Docker recusa e a instalação para."
    printf '%s\n'     "  Como resolver, na ordem do mais provável:"
    printf '\n%s\n'   "  1. Já é outro DeskcommCRM neste servidor? Então use aquele — entre na"
    printf '%s\n'     "     pasta dele e rode: bash hostgator-setup-kit/update.sh"
    printf '\n%s\n'   "  2. Não usa mais o que está ocupando? Desligue e rode este instalador de novo:"
    [ -n "$dono_portas" ] && printf '%s\n' "       docker stop ${dono_portas}"
    printf '\n%s\n'   "  3. Quer manter os dois no ar? Aí o CRM tem de sair por um proxy só, e isso"
    printf '%s\n'     "     é configuração manual — o kit automatiza esse caminho apenas para"
    printf '%s\n\n'   "     Traefik (ponha REVERSE_PROXY=traefik no .env)."
    if [ "$n_ocupadas" -gt 1 ]; then
      die "Libere as portas ${portas_ocupadas} (ou use a instalação que já existe) e rode de novo."
    fi
    die "Libere a porta ${portas_ocupadas} (ou use a instalação que já existe) e rode de novo."
    ;;
  esac
fi

# Fica FORA do `case` porque quem põe REVERSE_PROXY=traefik no .env à mão — o
# caminho que o painel de bloqueio logo acima ENSINA — pula o `case` inteiro e
# chegava no bloco da rede com a variável vazia, para morrer em "Não consegui
# descobrir a rede Docker do seu Traefik". O instalador mandava fazer uma coisa
# que ele mesmo não sabia terminar.
if [ "${REVERSE_PROXY:-}" = "traefik" ] && [ -z "$traefik_container" ]; then
  if [ -n "$dono_portas" ] && eh_traefik "$dono_imagem" "$dono_portas"; then
    traefik_container="$dono_portas"
  else
    # Nem dono das portas nem modo host: o Traefik pode simplesmente estar
    # parado agora (painel reiniciando, VPS recém-ligada). Procurá-lo entre
    # TODOS os contêineres é o que resta — e continua fechado no plural, porque
    # apontar para o Traefik errado publica o CRM num proxy que ninguém acessa.
    _tk="$(docker ps --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Image}}|{{.Ports}}' 2>/dev/null | unico_traefik || true)"
    [ -n "$_tk" ] && traefik_container="${_tk%%|*}"
    unset _tk
  fi
fi

# ── Supabase automático (opcional) ──────────────────────────────────────────
# Criar o projeto no navegador e copiar 4 campos era o passo mais LENTO da
# instalação (medido: ~59min de preparação contra ~3min de script) e o mais
# fácil de errar — copiar a "Direct connection", que é IPv6-only e não conecta
# de um VPS IPv4, é a armadilha campeã.
#
# Com SUPABASE_ACCESS_TOKEN no ambiente e as credenciais ainda vazias, o
# projeto é criado aqui e as 4 variáveis entram direto no fluxo, sem copiar e
# colar. Sem o token, nada muda: seguem as perguntas de sempre.
if [ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  step "Criando o projeto Supabase automaticamente"
  _sb_out="$(bash "$KIT_DIR/supabase-provision.sh" "${APP_NAME:-DeskcommCRM}" "${SUPABASE_REGION:-sa-east-1}")" \
    || die "Não consegui criar o projeto Supabase. Crie no painel e rode de novo sem SUPABASE_ACCESS_TOKEN."
  # O script imprime `CHAVE='valor'` em stdout (o visual dele vai para stderr).
  # A leitura é por parse, não por `eval` — o porquê está em
  # sb_carrega_credenciais(), e `test-validators.sh` cobra isso.
  sb_carrega_credenciais "$_sb_out"
  unset _sb_out

  # Credencial que não chegou tem que parar AQUI. Sem esta checagem o install
  # seguiria com a variável vazia e morreria lá na frente, longe da causa — e a
  # pessoa veria "erro de conexão" em vez de "o provisionamento não devolveu X".
  if [ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" ] || [ -z "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ] \
     || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || [ -z "${SUPABASE_DB_URL:-}" ]; then
    die "O provisionamento não devolveu as 4 credenciais. Crie o projeto no painel e rode de novo sem SUPABASE_ACCESS_TOKEN."
  fi
  c_grn "✓ Supabase pronto — as 4 credenciais entraram sozinhas"
fi

# Cada linha: VARIÁVEL|pergunta|padrão|validador|secret|opcional
# A ordem importa: a URL do projeto vem antes das chaves porque os validadores
# das chaves batem contra ela (chave de outro projeto é erro comum e mudo).
# O bloco final (APP_NAME, SUPPORT_EMAIL, RESEND_*) fica por último de
# propósito: é tudo opcional, e perguntar no meio das credenciais faria parecer
# obrigatório. Todas as quatro aceitam Enter — e, quando vazias, o produto
# degrada de forma declarada (marca padrão; tela de suspensão sem endereço;
# convite mostrando o link de aceite na própria tela).
# ── Qual IA vai atender ─────────────────────────────────────────────────────
#
# Antes daqui o instalador só sabia pedir a chave da Anthropic, e quem já tinha
# conta em outro provedor descobria isso tarde: instalava, cadastrava a chave
# "errada", e o agente não respondia. A OpenRouter mudou a conta dessa escolha —
# uma chave só dá acesso a centenas de modelos de dezenas de fabricantes, o que
# costuma ser o caminho mais simples para quem está começando.
#
# A pergunta vem ANTES das credenciais porque é ela que decide QUAL credencial
# será pedida; perguntar depois obrigaria a voltar atrás.
escolher_provedor() {
  # Numa 2ª execução, o provedor já escolhido vira o default — quem re-roda o
  # script para corrigir outra coisa não deve ter que reescolher isto.
  local atual="${AI_PROVIDER:-}"
  if [ -z "$atual" ]; then
    if   [ -n "${OPENROUTER_API_KEY:-}" ]; then atual="openrouter"
    elif [ -n "${ANTHROPIC_API_KEY:-}" ];  then atual="anthropic"
    elif [ -n "${OPENAI_API_KEY:-}" ];     then atual="openai"
    fi
  fi

  if [ "$NONINTERACTIVE" = 1 ]; then
    AI_PROVIDER="${atual:-anthropic}"
    return 0
  fi

  printf '\n\033[1mQual inteligência artificial vai atender seus clientes?\033[0m\n\n'
  printf '  [1] OpenRouter  — uma chave, centenas de modelos de vários fabricantes.\n'
  printf '                    O caminho mais simples para experimentar. (openrouter.ai/keys)\n'
  printf '  [2] Anthropic   — o Claude. É o que melhor segue instruções longas e usa\n'
  printf '                    as ferramentas do CRM. (console.anthropic.com)\n'
  printf '  [3] OpenAI      — o GPT. (platform.openai.com/api-keys)\n'
  printf '\n'
  printf '  Dá para trocar depois, e por parte do sistema, em Agente de IA → Provedores.\n\n'

  local padrao_num=2
  case "$atual" in openrouter) padrao_num=1;; openai) padrao_num=3;; esac

  while :; do
    if ! read -r -p "Escolha (Enter = ${padrao_num}): " escolha; then escolha=""; fi
    [ -z "$escolha" ] && escolha="$padrao_num"
    case "$escolha" in
      1) AI_PROVIDER="openrouter"; break;;
      2) AI_PROVIDER="anthropic";  break;;
      3) AI_PROVIDER="openai";     break;;
      *) c_ylw "Digite 1, 2 ou 3.";;
    esac
  done
}
escolher_provedor

# O campo da chave do provedor ESCOLHIDO — e só dele. Pedir as três faria a
# pessoa achar que precisa das três.
case "$AI_PROVIDER" in
  openrouter) CAMPO_IA="OPENROUTER_API_KEY|Chave da OpenRouter — a IA que atende (openrouter.ai/keys)||v_openrouter|secret|";;
  openai)     CAMPO_IA="OPENAI_API_KEY|Chave da OpenAI — a IA que atende (platform.openai.com/api-keys)||v_openai|secret|";;
  *)          CAMPO_IA="ANTHROPIC_API_KEY|Chave da Anthropic — a IA que atende (console.anthropic.com)||v_anthropic|secret|";;
esac

# A chave da OpenAI é pedida À PARTE quando ela NÃO é o provedor de conversa,
# porque dois pontos do sistema dependem dela mesmo assim: ouvir áudio (o
# Whisper é da OpenAI) e indexar a base de conhecimento. Sem esta linha, quem
# escolhe OpenRouter instala achando que está completo e descobre semanas depois
# que o agente nunca ouviu um áudio — que é exatamente o defeito já visto em
# produção, com a chave certa no .env e indo para o endpoint errado.
if [ "$AI_PROVIDER" = "openai" ]; then
  CAMPO_OPENAI_EXTRA=""
else
  CAMPO_OPENAI_EXTRA="OPENAI_API_KEY|Chave da OpenAI — só para ouvir áudios e usar a base de conhecimento (Enter pula)||v_openai|secret|opcional"
fi

# ── A versão que esta instalação vai rodar ───────────────────────────────────
# Uma instalação nova nascia em `:latest`, e aqui `latest` NÃO quer dizer "a
# última release": ele segue a branch default, então ela
# segue o topo da `main` — código ainda não lançado. Quem instalava no dia 6
# e quem instalava no dia 20 rodavam software diferente, ambos dizendo "estou
# no latest", e o suporte não tinha como saber o quê. A issue #184 chegou
# descrevendo o ambiente como "latest do dia 06/08/2026", que é a admissão de
# que a versão não era nomeável.
#
# Resolvido no REMOTO porque o clone é `--depth 1` e não traz tag nenhuma.
VERSAO_ALVO="$(ultima_versao_publicada "$REPO_URL")"

# A tag do git é condição NECESSÁRIA, não suficiente: ela nasce minutos antes
# das imagens, e `deskcomm-worker`/`deskcomm-scheduler` só passaram a existir
# depois das releases que já estão publicadas — `deskcomm-worker:1.2.1` nunca
# vai existir, porque a v1.2.1 é passado. Sem esta conferência, o .env do
# cliente receberia duas referências impossíveis e o kit as construiria aqui em
# silêncio, do topo da main: app de uma release + worker de outro código.
#
# Cascata, do mais específico ao mais disponível. Cada nível pergunta pelas TRÊS
# imagens juntas, porque instalar com elas desalinhadas é o defeito, não a
# solução.
if [ -n "$VERSAO_ALVO" ] && trio_publicado "$VERSAO_ALVO"; then
  : # o caminho normal: as três publicadas na última versão
elif trio_publicado "stable"; then
  c_ylw "⚠ A versão ${VERSAO_ALVO:-mais recente} ainda não tem as três imagens publicadas."
  c_ylw "  Instalando pelo canal 'stable' (a última versão completa)."
  VERSAO_ALVO="stable"
elif [ -n "$VERSAO_ALVO" ]; then
  # Nem a versão nem o `stable` têm o trio. Segue assim mesmo — o compose tem
  # `build:` ao lado do `image:` do worker e do scheduler, então eles são
  # construídos aqui. É lento, mas instala. O que NÃO pode é isso acontecer
  # calado: o dono precisa saber que duas peças dele saíram do fonte local.
  c_ylw "⚠ As imagens do worker e do agendador ainda não estão publicadas."
  c_ylw "  Elas serão construídas neste servidor — leva alguns minutos a mais."
  c_ylw "  Rode 'bash hostgator-setup-kit/update.sh' quando a próxima versão sair."
else
  # Falha ABERTA: sem rede ou sem tag no remoto, segue como antes. Travar a
  # instalação por não resolver um número seria trocar previsibilidade por
  # disponibilidade — mas o aviso sai, porque o dono precisa saber que ficou
  # num canal móvel em vez de numa versão.
  VERSAO_ALVO="latest"
  c_ylw "⚠ Não consegui descobrir a última versão publicada (rede?)."
  c_ylw "  Instalando pelo canal 'latest'. Depois rode: bash hostgator-setup-kit/update.sh"
fi
IMAGEM_APP_DEFAULT="${IMG_APP}:${VERSAO_ALVO}"

FIELDS=(
  "DOMAIN|Domínio do CRM (ex: crm.suaempresa.com.br)||v_domain||"
  "ACME_EMAIL|Seu e-mail (avisos de SSL)||v_email||"
  "APP_IMAGE|Imagem Docker do app|${IMAGEM_APP_DEFAULT}|||"
  "NEXT_PUBLIC_SUPABASE_URL|Supabase Project URL (Settings > API)||v_supabase_url||"
  "NEXT_PUBLIC_SUPABASE_ANON_KEY|Supabase anon key (Settings > API)||v_anon||"
  "SUPABASE_SERVICE_ROLE_KEY|Supabase service_role key (Settings > API)||v_service|secret|"
  "SUPABASE_DB_URL|Supabase connection string — Session pooler, modo URI (Settings > Database)||v_db_url|secret|"
  "$CAMPO_IA"
  ${CAMPO_OPENAI_EXTRA:+"$CAMPO_OPENAI_EXTRA"}
  "OWNER_EMAIL|E-mail do primeiro admin (dono)||v_email||"
  "OWNER_PASSWORD|Senha do primeiro admin (mínimo 8 caracteres)||v_password|secret|"
  "APP_NAME|Nome que aparece na interface (Enter para o padrão)|DeskcommCRM|||"
  # Sem default, e `opcional`: em `--yes` o `ask_one` devolve 0 sem associar a
  # variável (campo sem default e sem `opcional` morre em `die`), e o `envq` lá
  # embaixo usa `${APP_ACCENT_HEX:-}`. Enter = a cor do produto, que é o
  # comportamento de sempre para quem não tem marca própria.
  "APP_ACCENT_HEX|Cor da sua marca em hex, ex.: #7a5cd6 (Enter usa a cor do sistema)||v_hex||opcional"
  "SUPPORT_EMAIL|E-mail de suporte que SEUS clientes veem (Enter pula)||v_email||opcional"
  "RESEND_API_KEY|Chave da Resend — envia convite e e-mail de LGPD (resend.com/api-keys, Enter pula)|||secret|opcional"
  "RESEND_FROM_EMAIL|Remetente dos e-mails, de um domínio verificado na Resend (Enter pula)||v_email||opcional"
)

field_at() { IFS='|' read -r F_VAR F_PROMPT F_DEF F_VAL F_SEC F_OPT <<< "${FIELDS[$1]}"; }

if [ "$NONINTERACTIVE" = 0 ]; then
  c_dim "Dica: em qualquer pergunta, digite 'voltar' para refazer a anterior."
  if [ "$AI_PROVIDER" != "openai" ]; then
    c_ylw "A chave da OpenAI é opcional, mas sem ela a IA não ouve áudio nem consulta a base de conhecimento."
  fi
fi

i=0
while [ "$i" -lt "${#FIELDS[@]}" ]; do
  field_at "$i"
  set +e; ask_one "$F_VAR" "$F_PROMPT" "$F_DEF" "$F_VAL" "$F_SEC" "$F_OPT"; rc=$?; set -e
  if [ "$rc" = "2" ]; then
    if [ "$i" -eq 0 ]; then c_ylw "  Essa já é a primeira pergunta."; continue; fi
    i=$((i-1)); field_at "$i"; unset "$F_VAR"      # limpa o anterior para ele ser perguntado de novo
  else
    i=$((i+1))
  fi
done

# ── Conferência: a última chance de corrigir sem desfazer nada ──────────────
# Numa 2ª execução todos os campos já vêm do .env — então esta tela é também
# o caminho para consertar um valor digitado errado antes, que antes ficava
# preso no .env sem nenhuma forma de trocar pelo instalador.
if [ "$NONINTERACTIVE" = 0 ]; then
  while :; do
    printf '\n\033[1mConfira antes de eu escrever a configuração:\033[0m\n\n'
    n=1
    for f in "${FIELDS[@]}"; do
      IFS='|' read -r v p _d _val sec _o <<< "$f"
      if [ "$sec" = "secret" ]; then printf '  [%2d] %-28s %s\n' "$n" "${v}" "$(mask "${!v:-}")"
      else printf '  [%2d] %-28s %s\n' "$n" "${v}" "${!v:-(vazio)}"; fi
      n=$((n+1))
    done
    printf '\n'
    if ! read -r -p "Está tudo certo? (Enter = continuar / número = corrigir): " answer; then answer=""; fi
    [ -z "$answer" ] && break
    case "$answer" in
      ''|*[!0-9]*) c_ylw "Digite o número do item que quer corrigir, ou Enter para continuar."; continue;;
    esac
    if [ "$answer" -lt 1 ] || [ "$answer" -gt "${#FIELDS[@]}" ]; then
      c_ylw "Número fora da lista."; continue
    fi
    field_at "$((answer-1))"; unset "$F_VAR"
    set +e; ask_one "$F_VAR" "$F_PROMPT" "$F_DEF" "$F_VAL" "$F_SEC" "$F_OPT"; set -e
  done
else
  # Sem tela para conferir: os validadores continuam sendo a rede de proteção.
  for f in "${FIELDS[@]}"; do
    IFS='|' read -r v _p _d val _sec opt <<< "$f"
    [ -z "$val" ] && continue
    [ -z "${!v:-}" ] && { [ -n "$opt" ] && continue; die "Falta $v (modo --yes exige .env preenchido)."; }
    if ! msg="$("$val" "${!v}" 2>&1)"; then
      c_red "✖ $v inválido:"; printf '%s\n' "$msg"
      die "Corrija o .env e rode de novo."
    fi
  done
fi

# Derivados
NEXT_PUBLIC_APP_URL="https://${DOMAIN}"
NEXT_PUBLIC_ADMIN_URL="https://${DOMAIN}"

# ── 4. Geração de segredos (idempotente: só gera o que falta) ────────────────
step "Gerando segredos"
gen_hex() { openssl rand -hex 32; }
gen_b64() { openssl rand -base64 32; }
: "${INTERNAL_SECRET:=$(gen_hex)}"
: "${INTERNAL_CRON_SECRET:=$(gen_hex)}"
: "${NUVEMSHOP_OAUTH_ENCRYPTION_KEY:=$(gen_hex)}"
: "${CPF_ENCRYPTION_KEY:=$(gen_b64)}"
: "${AI_CRED_AES_KEY:=$(gen_b64)}"
: "${WAHA_BYO_ENCRYPTION_KEY:=$(gen_b64)}"
: "${IMPERSONATE_COOKIE_SECRET:=$(gen_hex)}"
: "${LGPD_SIGNING_KEY:=$(gen_hex)}"
: "${WAHA_HMAC_SECRET:=$(gen_hex)}"
: "${SRH_TOKEN:=$(gen_hex)}"
: "${WAHA_API_KEY:=$(gen_hex)}"
# O container WAHA espera o HASH SHA512 hex; o app envia o plaintext no X-Api-Key.
WAHA_API_KEY_SHA512="$(printf '%s' "$WAHA_API_KEY" | openssl dgst -sha512 -hex | awk '{print $NF}')"
UPSTASH_REDIS_REST_TOKEN="$SRH_TOKEN"
c_grn "✓ segredos prontos"

# ── 5. Escreve .env (600) ───────────────────────────────────────────────────
# Onde o Traefik encontra o app. Os dois cenários e as duas medições que os
# separam estão em `rede_do_traefik`; aqui só se busca no Docker o que ela pede.
#
# A bridge reservada a este projeto sai de `rede_reservada_do_proxy` (_common.sh),
# que usa o mesmo nome que o compose calcula (NormalizeProjectName: minúsculas, só
# [a-z0-9_-], `_`/`-` iniciais aparados). Um `basename` cru diverge numa pasta com
# maiúscula, ponto ou underscore inicial — e aí o instalador cria uma rede e o
# compose procura outra.
rede_do_projeto="$(rede_reservada_do_proxy)"
if [ "$REVERSE_PROXY" = "traefik" ] && [ -z "${TRAEFIK_NETWORK:-}" ] && [ -n "$traefik_container" ]; then
  # "|| true" nas duas: sem ele o `die` explicativo logo abaixo — que é o
  # tratamento CERTO deste caso — é inalcançável. Numa atribuição o status do
  # pipeline vira o status do script; se o painel da hospedagem recriou o proxy
  # entre a detecção e aqui, o docker inspect sai 1, o 2>/dev/null engole a
  # mensagem e o instalador cai no painel genérico de erro sem dizer o que houve.
  traefik_netmode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$traefik_container" 2>/dev/null || true)"
  traefik_redes="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$traefik_container" 2>/dev/null || true)"
  TRAEFIK_NETWORK="$(rede_do_traefik "$traefik_netmode" "$traefik_redes" "$rede_do_projeto")"
  [ "$traefik_netmode" = "host" ] && \
    c_dim "  (o Traefik roda em modo host, então o CRM publica numa rede própria: ${TRAEFIK_NETWORK})"
fi
if [ "$REVERSE_PROXY" = "traefik" ] && [ -z "${TRAEFIK_NETWORK:-}" ]; then
  die "Não consegui descobrir a rede Docker do seu Traefik. Rode 'docker network ls',
identifique a rede dele e ponha TRAEFIK_NETWORK=<nome> no .env antes de tentar de novo."
fi
# Confere (e cria, quando a rede é a nossa) — em _common.sh, porque o update.sh
# precisa da mesma garantia antes do `dc up -d` dele. Também aplica o default
# 'traefik', então a variável está pronta para o .env logo abaixo.
garantir_rede_do_proxy

# ── Telemetria: perguntar, não presumir ─────────────────────────────────────
# Issue #100. Antes, quem não definisse SENTRY_DSN mandava relatório de erro pro
# Sentry da comunidade sem ter decidido nada — e só ficava sabendo na mensagem
# final, DEPOIS de instalado. Num produto que roda na infraestrutura do usuário,
# com dados de clientes dele, o consentimento vem antes.
# Quem já tem valor no .env manda: a pergunta não sobrescreve escolha anterior.
if [ -z "${SENTRY_DSN+x}" ]; then
  if [ "$NONINTERACTIVE" = 1 ]; then
    # Automação não consente por ninguém. Sem valor explícito, fica desligado.
    SENTRY_DSN="off"
  else
    step "Telemetria de erros (opcional)"
    printf '%s\n' "Podemos receber os relatórios de ERRO desta instalação (stack trace) para"
    printf '%s\n' "corrigir bugs que afetam todo mundo. CPF, telefone e e-mail são substituídos,"
    printf '%s\n' "cabeçalhos sensíveis removidos e tokens de webhook/convite redigidos da URL."
    printf '%s\n' "NÃO enviamos rastreamento de performance nem replay de sessão."
    printf '%s\n' "Seus dados de clientes, conversas e banco NUNCA saem daqui."
    printf '\n%s\n' "Você pode mudar depois no .env, a qualquer momento."
    read -r -p "  Enviar relatórios de erro anonimizados? (s/N) " _tel
    if resposta_sim "${_tel:-}"; then
      SENTRY_DSN=""
      c_grn "✓ Telemetria de erros ligada — obrigado, isso ajuda o projeto."
    else
      SENTRY_DSN="off"
      c_grn "✓ Telemetria desligada — nada será enviado."
    fi
  fi
fi

step "Escrevendo .env"
umask 077

# Todo valor sai pelo `envq` (definido lá em cima, junto do save_partial): entre
# aspas DUPLAS, com `\`, `"`, `$` e crase escapados. Sem isso, um
# `APP_NAME=Loja do João` (ou uma senha com # ou $) quebrava tudo que lê este
# arquivo com `source` — os scripts do kit e a receita do próprio README
# (`source .env && curl ...`) —, e a versão de aspas simples que veio antes
# quebrava o terceiro leitor, o `env_file: .env` do Compose, em todo nome com
# apóstrofo. O porquê de cada caractere escapado está no comentário do envq.

# ── Preserva o que o instalador NÃO conhece ────────────────────────────────
#
# O bloco abaixo fecha com `} > .env`, que é TRUNCANTE: ele reescreve o arquivo
# inteiro a partir de uma lista fechada de chaves. Quem acrescentou qualquer
# variável à mão — uma chave de provedor de IA que o kit ainda não pergunta, um
# knob de modelo, um endpoint próprio — PERDIA tudo ao re-rodar o script. E o
# README vende o install.sh como idempotente, então re-rodar é exatamente o que
# se espera de quem quer corrigir um dado.
#
# O sintoma é dos piores: a instalação continua subindo, sem erro nenhum, e só
# depois alguém descobre que o agente voltou ao provedor padrão.
#
# Aqui as chaves desconhecidas são lidas do .env atual e reemitidas no fim do
# arquivo novo. Comparação por NOME da variável, contra a lista que este script
# escreve — assim uma chave nova que o kit passe a conhecer deixa de ser
# "alheia" sozinha, sem ninguém precisar manter uma segunda lista.
PRESERVADAS=""
if [ -f .env ]; then
  # ── Antes de tudo: recarrega o .env atual no ambiente ────────────────────
  #
  # Este é o furo MAIOR, e ele é invisível: várias chaves da lista fechada são
  # escritas como `envq X "${X:-}"` — o valor da variável de SHELL. Numa
  # re-execução o shell não tem essas variáveis (o instalador só as coleta no
  # fluxo interativo, e chave opcional não é perguntada), então elas são
  # reescritas VAZIAS. Ou seja: a chave da OpenRouter que a pessoa configurou à
  # mão é APAGADA por uma linha que parecia estar só repassando o valor.
  #
  # NÃO recarregue o .env aqui. Havia um `set -a; . ./.env; set +a` neste ponto,
  # justificado por "carregar o .env atual primeiro faz `${X:-}` cair de volta no
  # valor que já existia" — e essa premissa é FALSA: `install.sh:757` já faz
  # `load_env .env` antes da entrevista, e `_common.sh:266` faz `printf -v` +
  # `export` incondicionalmente. O arquivo já está carregado e exportado aqui.
  #
  # O que a releitura fazia de fato era DESFAZER a entrevista: a pessoa corrigia
  # um valor errado na tela e o `.` sobrescrevia com o antigo do disco. Medido na
  # triagem; a preservação de variável alheia (o laço abaixo) continua
  # funcionando sem estas linhas.

  # `$KIT_DIR/install.sh`, não `"$0"`: este bloco roda DEPOIS do `cd` da linha
  # 662, e com `$0` relativo (o `bash install.sh` que o README:34 documenta) o
  # grep procura o arquivo no diretório errado e morre com "No such file or
  # directory" — matando a 2ª execução, que o README:126/:138 documentam como
  # suportada. `KIT_DIR` (linha 16) é absoluto e imune ao `cd`.
  CONHECIDAS="$(grep -oE "^\s*envq [A-Z_][A-Z0-9_]*" "$KIT_DIR/install.sh" | awk '{print $2}' | sort -u)"
  while IFS= read -r linha; do
    case "$linha" in
      ''|'#'*) continue;;
    esac
    nome="${linha%%=*}"
    case "$nome" in
      *[!A-Za-z0-9_]*|'') continue;;
    esac
    if ! printf '%s\n' "$CONHECIDAS" | grep -qx "$nome"; then
      PRESERVADAS="${PRESERVADAS}${linha}
"
    fi
  done < .env
  if [ -n "$PRESERVADAS" ]; then
    c_ylw "→ preservando $(printf '%s' "$PRESERVADAS" | grep -c .) variável(is) que você acrescentou à mão"
  fi
fi

# A tag que o dono escolheu (o campo APP_IMAGE é editável na entrevista) decide
# o pull_policy das três imagens. A regra é medida, não estética: com `always` e
# o registry sem responder para aquela referência, o `up -d` FALHA e o contêiner
# não sobe, mesmo com a imagem já no disco. Numa tag imutável isso não protege
# de nada — só amarra a subida do CRM à disponibilidade do GHCR. Numa tag móvel
# é o contrário: sem `always`, a versão nova nunca chega.
# Olha só o último segmento do caminho: `registry.local:5000/x/y` tem ':' e NÃO
# tem tag, e um `${APP_IMAGE##*:}` ingênuo devolveria "5000/x/y" como se fosse
# uma. Um `@sha256:...` cai aqui como tag imutável, que é o correto.
_ref_final="${APP_IMAGE##*/}"
case "$_ref_final" in
  *@sha256:*)
    # O operador pinou o app por DIGEST. Derivar a tag daí produziria
    # `deskcomm-worker:<hash-do-app>` — uma referência que não existe em lugar
    # nenhum, e o `pull` falharia com "manifest unknown" sem ninguém entender
    # por quê. Worker e scheduler vão para o canal estável, e o aviso sai porque
    # quem pinou por digest tinha um motivo e precisa saber que ele não se
    # propagou às outras duas.
    TAG_ALVO="stable"
    c_ylw "⚠ APP_IMAGE está pinado por digest."
    c_ylw "  O worker e o scheduler ficam em 'stable' — ajuste WORKER_IMAGE/SCHEDULER_IMAGE"
    c_ylw "  no .env se você precisa deles num digest específico também."
    ;;
  *:*) TAG_ALVO="${_ref_final##*:}" ;;
  *)   TAG_ALVO="latest" ;;   # imagem sem ':' é :latest por definição do Docker
esac
case "$TAG_ALVO" in
  latest|main|stable) PULL_POLICY_ALVO="always" ;;
  *)                  PULL_POLICY_ALVO="missing" ;;
esac

{
  printf '# Gerado por install.sh — NÃO comitar. Contém segredos.\n'
  envq APP_IMAGE "$APP_IMAGE"
  envq APP_PULL_POLICY "$PULL_POLICY_ALVO"
  # Worker e scheduler acompanham a MESMA versão do app: um em 1.2.1 e outro em
  # `latest` é uma matriz de compatibilidade que ninguém testou. Estas duas
  # imagens existem desde que o worker deixou de ser `build:`-only — antes disso
  # ele era compilado aqui na VPS e nenhum update jamais o alcançava.
  envq WORKER_IMAGE "${IMG_WORKER}:${TAG_ALVO}"
  envq WORKER_PULL_POLICY "$PULL_POLICY_ALVO"
  envq SCHEDULER_IMAGE "${IMG_SCHEDULER}:${TAG_ALVO}"
  envq SCHEDULER_PULL_POLICY "$PULL_POLICY_ALVO"
  envq DOMAIN "$DOMAIN"
  envq ACME_EMAIL "$ACME_EMAIL"
  printf '# Proxy reverso: "caddy" (o kit sobe o dele nas portas 80/443) ou "traefik"\n'
  printf '# (o VPS já tem um Traefik nessas portas — Hostinger, Coolify, Dokploy...).\n'
  printf '# Em "traefik" entra o docker-compose.traefik.yml, que desliga o Caddy e\n'
  printf '# publica o app por labels. TRAEFIK_* só é lido nesse modo.\n'
  envq REVERSE_PROXY "$REVERSE_PROXY"
  # O default mora aqui, junto dos irmãos TRAEFIK_* logo abaixo, e não numa
  # atribuição solta lá atrás: em modo caddy ninguém DECIDE esta variável, e
  # depender de uma linha distante para ela existir é o tipo de laço que um
  # refactor do bloco de proxy corta sem perceber. Com `set -u` o preço é a VPS
  # limpa — a instalação mais comum de todas — parar aqui e deixar o .env pela
  # metade, com o bloco do Traefik verde em todos os testes.
  envq TRAEFIK_NETWORK "${TRAEFIK_NETWORK:-traefik}"
  envq TRAEFIK_ENTRYPOINT_HTTP "${TRAEFIK_ENTRYPOINT_HTTP:-web}"
  envq TRAEFIK_ENTRYPOINT "${TRAEFIK_ENTRYPOINT:-websecure}"
  envq TRAEFIK_CERTRESOLVER "${TRAEFIK_CERTRESOLVER:-letsencrypt}"
  envq NEXT_PUBLIC_SUPABASE_URL "$NEXT_PUBLIC_SUPABASE_URL"
  envq NEXT_PUBLIC_SUPABASE_ANON_KEY "$NEXT_PUBLIC_SUPABASE_ANON_KEY"
  envq SUPABASE_SERVICE_ROLE_KEY "$SUPABASE_SERVICE_ROLE_KEY"
  envq SUPABASE_DB_URL "$SUPABASE_DB_URL"
  envq NEXT_PUBLIC_APP_URL "$NEXT_PUBLIC_APP_URL"
  envq NEXT_PUBLIC_ADMIN_URL "$NEXT_PUBLIC_ADMIN_URL"
  printf '# Marca da instalação (white-label). Preencha APP_LOGO_URL com a URL de uma\n'
  printf '# imagem pública para trocar o texto por logo na sidebar. Ver lib/branding.ts.\n'
  printf '# APP_ACCENT_HEX é a SEMENTE da cor: o banco (platform_branding) manda depois\n'
  printf '# da primeira leitura, mas é daqui que sai a cor dos e-mails de acesso, que o\n'
  printf '# marca-emails.sh empurra para o GoTrue e o banco não alcança.\n'
  envq APP_NAME "$APP_NAME"
  envq APP_LOGO_URL "${APP_LOGO_URL:-}"
  # Perguntar sem gravar seria PIOR que não perguntar: este bloco fecha com
  # `} > .env`, que TRUNCA o arquivo a partir da lista fechada de `envq` acima e
  # abaixo — a pessoa responderia a cor e a perderia em silêncio, na mesma
  # execução. Enquanto a chave esteve fora desta lista, ela também não entrava em
  # `CONHECIDAS` (o grep de `envq` logo acima), então uma cor posta à mão no .env
  # sobrevivia por acaso, pelo laço de preservação — e não é de acaso que a
  # entrevista precisa.
  envq APP_ACCENT_HEX "${APP_ACCENT_HEX:-}"
  printf '# Endereço de suporte que o CLIENTE FINAL vê (conta suspensa, cobrança).\n'
  printf '# Vazio = a tela não mostra endereço nenhum.\n'
  envq SUPPORT_EMAIL "${SUPPORT_EMAIL:-}"
  # As três acima e as duas abaixo entram aqui pelo MESMO motivo, e não por
  # simetria: o .env é escrito com truncamento (`} > .env`, no fecho deste
  # bloco), então chave que este script não grava é APAGADA na execução
  # seguinte. Quem pôs a chave da Resend à mão a perdia no primeiro update —
  # num script que o README vende como idempotente.
  printf '# E-mail transacional. RESEND_FROM_EMAIL tem de ser de um domínio\n'
  printf '# VERIFICADO na SUA conta Resend. Vazio = e-mail desligado: o convite\n'
  printf '# mostra o link de aceite na tela e o export de LGPD fica pendente.\n'
  envq RESEND_API_KEY "${RESEND_API_KEY:-}"
  envq RESEND_FROM_EMAIL "${RESEND_FROM_EMAIL:-}"
  printf '# Qual provedor você escolheu na instalação. É o que faz a 2ª execução do\n'
  printf '# install.sh já vir com a sua escolha como padrão, em vez de re-adivinhar\n'
  printf '# pelas chaves presentes. A app não lê esta variável.\n'
  envq AI_PROVIDER "${AI_PROVIDER:-anthropic}"
  # `${ANTHROPIC_API_KEY:-}`, não `$ANTHROPIC_API_KEY`: quem escolhe OpenRouter
  # ou OpenAI nunca passa pelo campo da Anthropic, e sob `set -u` (linha 12) a
  # variável não associada derrubava o script AQUI — no meio da escrita do
  # .env, deixando o arquivo pela metade e a instalação sem como continuar.
  envq ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}"
  envq AI_GATEWAY_API_KEY "${AI_GATEWAY_API_KEY:-}"
  printf '# OpenRouter: alternativa ao AI Gateway para o chat da IA. A ordem de\n'
  printf '# resolução é AI_GATEWAY_API_KEY > OPENROUTER_API_KEY > provider direto,\n'
  printf '# então deixar vazio NÃO muda nada — o comportamento de hoje continua.\n'
  printf '# BASE_URL vazia = https://openrouter.ai/api/v1 (só mude se usa proxy).\n'
  envq OPENROUTER_API_KEY "${OPENROUTER_API_KEY:-}"
  envq OPENROUTER_BASE_URL "${OPENROUTER_BASE_URL:-}"
  printf '# OpenAI: transcrição dos áudios do WhatsApp (Whisper) + embeddings do RAG.\n'
  printf '# Opcional — sem ela a IA responde sem a base e pede o áudio em texto.\n'
  envq OPENAI_API_KEY "${OPENAI_API_KEY:-}"
  printf '# Telemetria de erros (você escolheu isto durante a instalação).\n'
  printf '#   "off"  = não envia nada.\n'
  printf '#   vazio  = só ERRO pro Sentry da comunidade, com CPF/telefone/e-mail\n'
  printf '#            substituídos e token de URL redigido. Sem trace, sem replay.\n'
  printf '#   <dsn>  = manda pro SEU Sentry (aí com performance e replay).\n'
  envq SENTRY_DSN "${SENTRY_DSN:-}"
  envq INTERNAL_SECRET "$INTERNAL_SECRET"
  envq INTERNAL_CRON_SECRET "$INTERNAL_CRON_SECRET"
  envq NUVEMSHOP_OAUTH_ENCRYPTION_KEY "$NUVEMSHOP_OAUTH_ENCRYPTION_KEY"
  envq CPF_ENCRYPTION_KEY "$CPF_ENCRYPTION_KEY"
  envq AI_CRED_AES_KEY "$AI_CRED_AES_KEY"
  envq WAHA_BYO_ENCRYPTION_KEY "$WAHA_BYO_ENCRYPTION_KEY"
  envq IMPERSONATE_COOKIE_SECRET "$IMPERSONATE_COOKIE_SECRET"
  envq LGPD_SIGNING_KEY "$LGPD_SIGNING_KEY"
  envq WAHA_API_BASE_URL "http://waha:3000"
  envq WAHA_WEBHOOK_BASE_URL "http://app:3000"
  envq WAHA_API_KEY "$WAHA_API_KEY"
  envq WAHA_API_KEY_SHA512 "$WAHA_API_KEY_SHA512"
  envq WAHA_HMAC_SECRET "$WAHA_HMAC_SECRET"
  printf '# "true" exige assinatura em todo webhook do WAHA. O WAHA Core NÃO assina,\n'
  printf '# então ligar isto sem um WAHA Plus (ou proxy que assine) para a ingestão\n'
  printf '# de mensagens. A rota global já não é publicada na internet (ver Caddyfile).\n'
  envq WAHA_WEBHOOK_REQUIRE_SIGNATURE "${WAHA_WEBHOOK_REQUIRE_SIGNATURE:-false}"
  # PINADA. Sem a tag, `devlikeapro/waha` é `:latest`, e esta linha gravava isso
  # no .env de todo cliente — por cima do default pinado do compose, que então
  # nunca chegava a ninguém. O `dc pull` de cada update entregava qualquer versão
  # que o upstream tivesse publicado, sem ninguém ter testado.
  # `latest-2026.7.2` é o mesmo digest de `latest` hoje (65e593e30bb7…).
  envq WAHA_IMAGE "${WAHA_IMAGE:-devlikeapro/waha:latest-2026.7.2}"
  envq WAHA_DEFAULT_ENGINE "${WAHA_DEFAULT_ENGINE:-NOWEB}"
  envq UPSTASH_REDIS_REST_URL "http://srh:80"
  envq UPSTASH_REDIS_REST_TOKEN "$UPSTASH_REDIS_REST_TOKEN"
  envq SRH_TOKEN "$SRH_TOKEN"
  envq NODE_ENV "production"
  envq NUVEMSHOP_ENABLED "false"
  envq INTERNAL_AGENT_RUN_STUB "false"
  envq OWNER_EMAIL "$OWNER_EMAIL"
  envq OWNER_PASSWORD "$OWNER_PASSWORD"
  # As variáveis que você acrescentou à mão, de volta — já no formato em que
  # estavam, sem passar por envq (o valor original já vem com as aspas dele).
  if [ -n "$PRESERVADAS" ]; then
    printf '\n# ── Acrescentadas manualmente (preservadas pelo install.sh) ──\n'
    printf '%s' "$PRESERVADAS"
  fi
} > .env
chmod 600 .env
# O .env definitivo existe: o rascunho cumpriu o papel e some — deixá-lo no
# disco seria uma segunda cópia dos segredos, e desatualizada na primeira
# correção que alguém fizer no .env.
rm -f "$PARTIAL_FILE"
c_grn "✓ .env escrito (permissão 600)"

# ── 6. Checagem de DNS ──────────────────────────────────────────────────────
fase 3 "Banco de dados e domínio"
step "Conferindo DNS de ${DOMAIN}"
public_ip="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo '')"
# Um domínio pode ter A (IPv4) e AAAA (IPv6) ao mesmo tempo, e o resolver não
# garante ordem entre eles. Comparar só o PRIMEIRO endereço (o antigo `hosts`
# + `head -1`) dava falso alarme sempre que o AAAA vinha antes do A: o DNS
# estava correto, o SSL ia ser emitido normalmente, e mesmo assim o instalador
# dizia que o domínio não apontava pra cá — assustando quem instala bem na hora
# em que ela mais precisa de confiança. `ahosts` lista TODOS os endereços; basta
# que UM deles seja o IP do VPS.
resolved="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || echo '')"
if [ -n "$public_ip" ] && case " $resolved " in *" $public_ip "*) true;; *) false;; esac; then
  c_grn "✓ ${DOMAIN} → ${public_ip} (aponta pra este VPS)"
else
  # DNS recém-apontado leva minutos para propagar: chegar aqui é estado NORMAL,
  # não erro. Antes havia uma única saída — responder exatamente "s" — e
  # qualquer outra coisa matava a instalação. Agora o padrão é esperar junto com
  # a pessoa: Enter reconsulta, e sair é uma escolha explícita dela.
  while [ "$NONINTERACTIVE" = 0 ]; do
    c_ylw "⚠ ${DOMAIN} resolve para '${resolved:-nada}' e o IP deste VPS é '${public_ip:-desconhecido}'."
    c_ylw "  O SSL (Let's Encrypt) só será emitido quando o A-record apontar pra cá."
    printf '\n%s\n'   "  No painel do seu domínio, crie um registro A apontando ${DOMAIN}"
    printf '%s\n\n'   "  para ${public_ip:-o IP deste servidor}. Costuma valer em poucos minutos."
    printf '%s\n'     "  Enter = conferir de novo"
    printf '%s\n'     "  c     = continuar assim mesmo (o site sobe sem cadeado até o DNS valer)"
    printf '%s\n'     "  s     = sair e voltar depois (o que você já respondeu fica guardado)"
    if ! read -r -p "  > " a; then a="s"; fi
    case "$(printf '%s' "$a" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in
      c|continuar) c_ylw "  Seguindo sem o DNS pronto — lembre de apontar o A-record."; break;;
      s|sair|n|nao) die "Ajuste o A-record de ${DOMAIN} para ${public_ip:-o IP deste servidor} e rode o instalador de novo.";;
      *)
        resolved="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || echo '')"
        if [ -n "$public_ip" ] && case " $resolved " in *" $public_ip "*) true;; *) false;; esac; then
          c_grn "✓ ${DOMAIN} → ${public_ip} (agora aponta pra este VPS)"; break
        fi
        c_ylw "  Ainda não propagou. Dá pra esperar e tentar de novo."
        ;;
    esac
  done
fi

# ── 7. Aplica o schema (baseline) no Supabase — via container postgres ───────
step "Aplicando o schema no Supabase (baseline.sql)"
if [ -f supabase/baseline.sql ]; then
  # O baseline é um pg_dump: referencia public.vector, public.citext e gin_trgm_ops
  # (pg_trgm) mas NÃO cria as extensões. Supabase não as habilita no schema public por
  # padrão — criamos aqui, senão o schema quebra no meio (ex.: "type public.vector does
  # not exist"). Idempotente (if not exists).
  docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
    "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;" \
    >/dev/null 2>&1 \
    && c_grn "✓ extensões (vector, citext, pg_trgm) habilitadas no public" \
    || c_ylw "⚠ não consegui habilitar as extensões — o schema pode falhar abaixo."
  SCHEMA_LOG="$PROJECT_DIR/baseline-apply.log"
  # Banco novo ou re-execução? Re-aplicar com ON_ERROR_STOP pararia no primeiro
  # "já existe" (ex.: multiple primary keys) e PULARIA o resto do arquivo —
  # inclusive o apêndice com as migrations novas. Banco existente = modo update
  # (mesmo contrato do update.sh); banco novo = ON_ERROR_STOP e falha é FATAL
  # (schema pela metade = app sem RLS).
  # O `|| true` não é preguiça: sem ele, um psql que falha aqui sai com código 2
  # dentro da substituição e, com `set -e` + `pipefail`, derruba o instalador sem
  # imprimir nada (o 2>/dev/null já tinha engolido a causa). Preferimos seguir e
  # deixar o erro aparecer no ponto em que dá para explicá-lo.
  has_schema="$(docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -tAc \
    "select 1 from information_schema.tables where table_schema='public' and table_name='organizations' limit 1" 2>/dev/null | tr -d '[:space:]' || true)"

  if [ "$has_schema" = "1" ]; then
    c_ylw "• schema já existe — re-aplicando em modo update (erros 'já existe' são esperados e ficam no log)"
    raw="$(docker run --rm -i -v "$PROJECT_DIR/supabase/baseline.sql:/baseline.sql:ro" \
          postgres:17-alpine psql "$SUPABASE_DB_URL" -q -f /baseline.sql 2>&1 || true)"
    printf '%s\n' "$raw" > "$SCHEMA_LOG"
    benign='already exists|multiple primary keys|multiple default values|is already a member|already a partition'
    unexpected="$(printf '%s\n' "$raw" | grep -iE 'ERROR|FATAL' | grep -viE "$benign" || true)"
    if [ -n "$unexpected" ]; then
      c_ylw "⚠ Erros no banco que NÃO são os esperados (log completo: $SCHEMA_LOG):"
      printf '%s\n' "$unexpected" | head -20
    else
      c_grn "✓ schema re-aplicado (apêndice de migrations incluído)"
    fi
  else
    if docker run --rm -i -v "$PROJECT_DIR/supabase/baseline.sql:/baseline.sql:ro" \
        postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f /baseline.sql \
        > "$SCHEMA_LOG" 2>&1; then
      c_grn "✓ schema aplicado (log: $SCHEMA_LOG)"
    else
      tail -5 "$SCHEMA_LOG"
      die "baseline falhou num banco NOVO — o schema ficaria incompleto (sem RLS). Log completo: $SCHEMA_LOG"
    fi
  fi

  # Verificação real, não wishful thinking: o app precisa das tabelas core.
  n_tables="$(docker run --rm postgres:17-alpine psql "$SUPABASE_DB_URL" -tAc \
    "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null | tr -d '[:space:]')"
  if [ "${n_tables:-0}" -ge 30 ]; then
    c_grn "✓ verificação: ${n_tables} tabelas no schema public"
  else
    c_ylw "⚠ verificação: só ${n_tables:-0} tabelas no schema public — confira $SCHEMA_LOG"
  fi
else
  c_ylw "⚠ supabase/baseline.sql não encontrado — pulei (aplique o schema manualmente)."
fi

# ── 7.5 E-mails de acesso (criar conta / recuperar senha) ───────────────────
# O e-mail de confirmação de conta é o PRIMEIRO artefato que qualquer usuário
# recebe. Sem este passo ele chega no modelo padrão do Supabase — em inglês,
# "Confirm Your Signup", sem marca nenhuma — numa instalação em que tudo o mais
# já está com a marca de quem hospeda.
#
# Chamado SEMPRE, com ou sem token: sem `SUPABASE_ACCESS_TOKEN` o script imprime
# o passo manual do painel e sai 0. É informação que vale mais aqui, no fim da
# instalação, do que num documento que ninguém vai abrir.
#
# `|| true` como cinto de segurança: o script já promete nunca sair diferente de
# 0, e mesmo assim a instalação não pode morrer por causa do e-mail.
bash "$KIT_DIR/marca-emails.sh" --projeto "$PROJECT_DIR" || true

# ── 8. Bootstrap do 1º dono (cria no Auth + promove via psql) ───────────────
step "Criando o primeiro admin (${OWNER_EMAIL})"
# 1) Cria o usuário no Supabase Auth. Se já existe, a API responde 422 — ignoramos
#    (|| true): a re-execução é idempotente, o passo seguinte encontra o usuário.
curl -fsS -X POST "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${OWNER_EMAIL}\",\"password\":\"${OWNER_PASSWORD}\",\"email_confirm\":true}" \
  >/dev/null 2>&1 || true

# 2) Resolve o id direto do auth.users e cria org + membership + platform_admin.
#    Resolver o uid DENTRO do SQL evita parsing frágil de JSON e funciona tanto para
#    usuário recém-criado quanto para um que já existia (re-execução).
docker run --rm -i postgres:17-alpine psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 <<SQL \
  && c_grn "✓ dono criado e promovido a super-admin" \
  || die "Não consegui promover o admin. Confira a service_role key, a URL e a connection string do Supabase."
do \$\$
declare v_org uuid; v_uid uuid;
begin
  select id into v_uid from auth.users where email = '${OWNER_EMAIL}';
  if v_uid is null then
    raise exception 'usuário % não encontrado no auth.users (a criação no Auth falhou?)', '${OWNER_EMAIL}';
  end if;
  select id into v_org from public.organizations where slug='minha-empresa';
  if v_org is null then
    insert into public.organizations (slug, display_name, legal_name, created_by)
    values ('minha-empresa','Minha Empresa','Minha Empresa', v_uid) returning id into v_org;
  end if;
  -- O provedor que a pessoa ESCOLHEU passa a valer no banco. O trigger
  -- fn_seed_org_llm_defaults semeia 'anthropic' fixo — o que estava certo
  -- enquanto a Anthropic era a única chave que este script pedia. Desde que
  -- ele pergunta qual IA vai atender, ignorar a resposta significava: quem
  -- escolhe OpenRouter instala, cadastra a chave, e todo caminho que passa
  -- pelo agent-engine resolve 'anthropic' — sem chave da Anthropic, erro de
  -- "IA não configurada" em tudo, mandando cadastrar a chave que ele decidiu
  -- não usar. Só o provider: o modelo padrão fica com o que o trigger semeou
  -- até alguém escolher em Agente de IA -> Provedores, porque adivinhar um id
  -- de modelo de outro provedor aqui seria inventar um valor não verificado.
  if '${AI_PROVIDER}' not in ('', 'anthropic') then
    update public.organizations
       set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb), '{llm,provider}',
             to_jsonb('${AI_PROVIDER}'::text), true)
     where id = v_org;
  end if;
  insert into public.user_organizations (user_id, organization_id, role, accepted_at)
  values (v_uid, v_org, 'admin', now())
  on conflict (user_id, organization_id) do update set role='admin', revoked_at=null;
  if not exists (select 1 from public.platform_admins where user_id=v_uid and revoked_at is null) then
    insert into public.platform_admins (user_id, granted_by, scope, reason)
    values (v_uid, v_uid, 'full', 'Bootstrap inicial do self-host');
  end if;
end \$\$;
SQL

# ── 9. Sobe a stack ─────────────────────────────────────────────────────────
fase 4 "Colocando o CRM no ar"
step "Puxando a imagem e subindo os serviços"
# A guarda existe porque dar `image:` a um serviço que era build-only mudou o
# comportamento do `pull`: antes ele PULAVA o worker ("Skipped - No image to be
# pulled"), agora FALHA a operação inteira se a referência não resolver. E há
# três motivos reais para não resolver logo depois de um release: pacote novo no
# GHCR nasce PRIVADO até alguém trocar a visibilidade na mão; a tag git existe
# minutos antes das imagens; e o GHCR pode estar fora do ar.
#
# Sem esta guarda, uma instalação NOVA morria no passo 9 — com o banco já
# provisionado e o .env já escrito. O `up -d` seguinte não precisa do pull: o
# worker e o scheduler têm `build:` ao lado do `image:`, e o Compose os constrói
# quando a imagem não existe (medido).
if ! dc pull; then
  c_ylw "⚠ Não consegui puxar todas as imagens do registro."
  c_ylw "  Sigo assim mesmo: o que faltar é construído aqui (mais lento, mesmo resultado)."
fi
dc up -d
c_grn "✓ containers no ar"

# ── 10. Healthcheck ─────────────────────────────────────────────────────────
step "Aguardando o app ficar saudável"
# Antes isto abria um socket na porta 3000 e dava por bom. A porta abre assim
# que o Node sobe, então o "✓" saía com o app ainda sem banco — e o bloco
# "Instalação concluída!" saía logo atrás, incondicionalmente. Um falso verde
# no exato momento em que a pessoa decide se confia no produto. Agora o critério
# é o mesmo do update.sh: a rota /api/v1/health responder "status":"ok".
if health_body="$(wait_app_healthy 30 3)"; then
  APP_SAUDAVEL=1
  c_grn "✓ app no ar e saudável"
else
  APP_SAUDAVEL=0
  c_ylw "⚠ os contêineres subiram, mas o app não respondeu que está saudável."
  # "|| true": mesma família do pipe que matava o supabase-provision.sh — o
  # corpo passa de 200 bytes, o head fecha o pipe e o printf leva SIGPIPE.
  [ -n "$health_body" ] && c_dim "  última resposta: $(printf '%s' "$health_body" | head -c 200 || true)"
fi

# ── 11. Automações (cron do drain de eventos) ───────────────────────────────
step "Ativando as automações"
ensure_encryption_key .env
setup_event_log_drain_cron
setup_update_agent_cron

# ── Final ───────────────────────────────────────────────────────────────────
# O app não confirmou que está de pé: dizer "Instalação concluída!" aqui seria
# mentir na única tela que a pessoa vai ler inteira. Ela recebe o estado real e
# o caminho de diagnóstico — e não a receita de apagar tudo do show_recovery,
# que existe para quem parou no MEIO. Aqui nada ficou pela metade: a config
# está salva e a stack está de pé; falta o app responder.
if [ "${APP_SAUDAVEL:-0}" != 1 ]; then
  cat <<INCOMPLETO

$(c_ylw "═══════════════════════════════════════════════════════")
$(c_ylw " Quase lá — falta o app responder")
$(c_ylw "═══════════════════════════════════════════════════════")

  A configuração está salva e os contêineres estão no ar. Você NÃO precisa
  refazer nada — falta o app dizer que está saudável.

  O motivo mais comum é uma chave faltando ou errada no .env. O log diz qual:

       docker compose $(dc_files) logs --tail=50 app

     procure por: [env] Falha de validação

  Diagnóstico completo dos serviços:

       bash ${KIT_DIR}/healthcheck.sh

  Depois de corrigir o .env, é só subir de novo (nada é perdido):

       docker compose $(dc_files) up -d

  Travou? Leve o log para a comunidade — tem gente que já passou por isso:

       ${COMUNIDADE_URL}

INCOMPLETO
  # Sai != 0 para que automação (e o --yes) saiba que não terminou saudável,
  # mas sem o trap: a receita de "apague tudo e recomece" não cabe aqui.
  trap - EXIT
  exit 1
fi

cat <<DONE

$(c_grn "═══════════════════════════════════════════════════════")
$(c_grn " Instalação concluída!")
$(c_grn "═══════════════════════════════════════════════════════")

  1. Acesse:  https://${DOMAIN}
     (o SSL leva ~1min pra emitir no primeiro acesso)

  2. Faça login com:
       e-mail: ${OWNER_EMAIL}
       senha:  (a que você definiu)

  3. Conecte o WhatsApp (2º passo do onboarding):
       Deixe o WhatsApp JÁ ABERTO em Configurações → Aparelhos conectados
       antes de abrir a tela — o QR code vale só uns minutos. Se expirar,
       o próprio CRM tem o botão "Gerar novo QR Code".

  4. Ao terminar o onboarding, o CRM pede a verificação em duas etapas:
       tenha o Google Authenticator/Authy à mão e GUARDE os códigos de
       recuperação que aparecem. Perdeu o celular? bash hostgator-setup-kit/reset-mfa.sh ${OWNER_EMAIL}

$(c_grn "  ─── A comunidade ──────────────────────────────────────")

  É onde saem os avisos de versão nova, os agentes que outras pessoas já
  configuraram e a resposta de quem roda exatamente este CRM:

       ${COMUNIDADE_URL}

  Telemetria: por padrão os erros desta instalação são enviados ao Sentry do
  projeto, o que ajuda a corrigir falhas que afetam todo mundo. Para desligar,
  ponha SENTRY_DSN='off' no .env e rode: docker compose $(dc_files) up -d

  Comandos úteis:
    ver logs:      docker compose $(dc_files) logs -f app
    reiniciar:     docker compose $(dc_files) restart
    atualizar:     bash hostgator-setup-kit/update.sh
    backup:        bash hostgator-setup-kit/backup.sh
    trocar config: bash hostgator-setup-kit/install.sh
                   (mostra tudo o que você respondeu e deixa corrigir por número)
    recomeçar:     docker compose $(dc_files) down -v && rm -f .env
                   (derruba tudo; depois rode o install.sh de novo)

DONE
