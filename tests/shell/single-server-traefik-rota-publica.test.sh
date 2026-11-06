#!/usr/bin/env bash
# #2945 — o FIM da instalação volta a PROVAR que a rota PÚBLICA `/auth/v1/*`
# chega ao GoTrue do Supabase no modo `REVERSE_PROXY=traefik`.
#
# O QUE ESTÁ SOB PROVA
#
# O #2933 mandou o `v_sb_key()` do install.sh perguntar ao gateway INTERNO
# (`SUPABASE_INTERNAL_URL`) — o certo atrás de Cloudflare laranja, o padrão do
# kit. De efeito colateral, a instalação perdeu a única coisa que provava, sem
# querer, que a rota pública `/auth/v1/*` chega ao Envoy do Supabase (#2099):
# sem as etiquetas do Traefik, ela terminava verde e o erro só aparecia no
# primeiro login. A sonda `sondar_rota_publica_do_supabase` (`_common.sh`)
# devolve essa prova: bate em `https://DOMINIO/auth/v1/settings` com a anon key
# e reprova quando quem responde é o app (404, ou o 3xx para `/login` que o
# Traefik da hospedagem provoca), citando o #2099.
#
# QUATRO BLOCOS
#
#   (1) COMPORTAMENTO da sonda, com o `curl` dublado: 200 do GoTrue aprova; a
#       ASSINATURA do app REPROVA e a mensagem cita o #2099 — e ela tem duas
#       formas, o 404 e o 3xx para `/login` (o que o Traefik da hospedagem
#       provoca de verdade: o pedido cai no CRM e o CRM manda para a tela de
#       login); falha transitória (000) ganha nova tentativa; as duas formas da
#       assinatura são DEFINITIVAS (uma chamada só, não se insiste contra quem
#       já respondeu); e o que NÃO é a assinatura (000, 5xx, um 3xx para outro
#       lugar) não para a instalação — devolve 2, que o chamador trata como
#       aviso. O dublê registra a URL e o cabeçalho de cada chamada, e é o que
#       prova que a sonda usa a URL PÚBLICA com o sufixo `/auth/v1/settings` e
#       a anon key — não o gateway interno da VPS.
#
#   (2) A GUARDA, lida do install.sh e AVALIADA de verdade (não uma
#       reimplementação, que ficaria verde com o install.sh sabotado): a sonda
#       entra no modo traefik com o Supabase desta VPS, e NÃO entra em caddy —
#       nem num traefik com o Supabase na NUVEM, em que a URL pública não tem
#       as APIs e o 404 seria o mesmo falso alarme que o #2933 tirou da fase 2.
#
#   (3) O QUE O install.sh FAZ COM O rc, também lido de lá e AVALIADO: 0
#       aprova, 1 PARA a instalação, 2 AVISA e segue. Sem este bloco, "só a
#       assinatura para a instalação" seria promessa de comentário: o dia em
#       que alguém trocar o `case` por um `else die` que mata qualquer falha,
#       nada mais acusaria.
#
#   (4) AS PONTAS: onde a sonda mora, onde ela é chamada, e o comentário do
#       install-single-server.sh, que passou a citar o 3xx do app.
#
# Nada aqui toca Docker, rede ou a máquina de quem roda: o `curl` é dublê e
# nenhuma chamada HTTP acontece de verdade.
#
#   bash tests/shell/single-server-traefik-rota-publica.test.sh
set -uo pipefail
unset COMPOSE_PROJECT_NAME SINGLE_SERVER REVERSE_PROXY TRAEFIK_ENABLE \
  TRAEFIK_HOST TRAEFIK_NETWORK SUPABASE_INTERNAL_URL APP_SAUDAVEL 2>/dev/null || true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
KIT="$ROOT/hostgator-setup-kit"
COMMON="$KIT/_common.sh"
INSTALL_SH="$KIT/install.sh"
INSTALADOR="$KIT/install-single-server.sh"
DOMINIO="https://crm.exemplo.com.br"
# O destino que o app devolve quando o Traefik entrega `/auth/v1/*` ao CRM: o
# pedido cai no app, e o app manda para a tela de login com o `next` de volta.
# É a forma MEDIDA numa instalação real (307, não 404).
LOGIN="https://crm.exemplo.com.br/login?next=%2Fauth%2Fv1%2Fsettings"
ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.assinatura-de-teste"
FAILS=0

check() {
  local descricao="$1"
  shift
  if "$@"; then
    printf '  ✓ %s\n' "$descricao"
  else
    printf '  ✗ %s\n' "$descricao"
    FAILS=$((FAILS + 1))
  fi
}
igual() { [ "$1" = "$2" ] || { printf '    esperado [%s], veio [%s]\n' "$2" "$1"; return 1; }; }
contem() { case "$1" in *"$2"*) return 0 ;; *) printf '    [%s] não está em [%s]\n' "$2" "$1"; return 1 ;; esac; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ════════════════════════════════════════════════════════════════════════════
# (1) A sonda — o `_common.sh` DE VERDADE, com o `curl` dublado
# ════════════════════════════════════════════════════════════════════════════
# O dublê devolve os códigos na ordem dada (o último repete quando a lista
# acaba) e REGISTRA a URL e o cabeçalho de cada chamada. É a mesma forma que o
# test-validators.sh usa para os validadores do install.sh: a função real, sob
# um `curl` que não sai da máquina.
#
# O dublê também responde `%{redirect_url}` — a sonda passou a pedir os dois no
# mesmo `-w` (código e destino), porque sem seguir o redirecionamento é o
# DESTINO que diz se o 3xx veio do app. Os destinos são o quarto argumento, na
# mesma forma da lista de códigos, e o vazio quer dizer "sem redirecionamento"
# (o pedaço sai vazio, como no curl de verdade quando não houve Location).
sonda_roda() {  # sonda_roda <casa> <códigos, um por linha> [anon key] [destinos, um por linha] → "rc|saída"
  local casa="$1" codigos="$2" anon="${3-$ANON}" destinos="${4-}" rc saida
  mkdir -p "$casa"
  saida="$(CODIGOS="$codigos" DESTINOS="$destinos" CONTADOR="$casa/contador" REGISTRO="$casa/registro" \
    bash -c '
      set -uo pipefail
      curl() {
        local prev="" url="" fmt="" so_codigo=0 hdr=""
        for a in "$@"; do
          case "$prev" in
            -w) fmt="$a";;
            -o) so_codigo=1;;
            -H) hdr="$a";;
          esac
          case "$a" in http://*|https://*) url="$a";; esac
          prev="$a"
        done
        printf "%s\t%s\n" "$url" "$hdr" >> "$REGISTRO"
        local n; n="$(cat "$CONTADOR" 2>/dev/null || printf 0)"; n=$((n + 1)); printf "%s" "$n" > "$CONTADOR"
        local code; code="$(printf "%s\n" "$CODIGOS" | sed -n "${n}p")"
        [ -n "$code" ] || code="$(printf "%s\n" "$CODIGOS" | tail -1)"
        local destino=""
        if [ -n "$DESTINOS" ]; then
          destino="$(printf "%s\n" "$DESTINOS" | sed -n "${n}p")"
          [ -n "$destino" ] || destino="$(printf "%s\n" "$DESTINOS" | tail -1)"
        fi
        [ "$so_codigo" = 1 ] || printf "%s" "{}"
        [ -z "$fmt" ] || {
          fmt="${fmt//%\{http_code\}/$code}"
          fmt="${fmt//%\{redirect_url\}/$destino}"
          printf "%s" "$fmt"
        }
        return 0
      }
      . "$1/_common.sh"
      set +e
      sondar_rota_publica_do_supabase "$2" "$3" 3 1
    ' _ "$KIT" "$DOMINIO" "$anon" 2>&1)" && rc=0 || rc=$?
  printf '%s|%s' "$rc" "$saida"
}
chamadas() { [ -f "$1/registro" ] && wc -l < "$1/registro" | tr -d '[:space:]' || printf 0; }

echo "a sonda (#2945): 200 do GoTrue aprova; 404 do app e 307 para /login reprovam"

c200="$WORK/caso-200"
check "200 do GoTrue: a sonda APROVA a instalação" \
  igual "$(sonda_roda "$c200" 200)" '0|'
check "a sonda pergunta à URL PÚBLICA, com o sufixo /auth/v1/settings" \
  contem "$(cat "$c200/registro")" "${DOMINIO}/auth/v1/settings"
check "a sonda manda a anon key no cabeçalho apikey" \
  contem "$(cat "$c200/registro")" "apikey: ${ANON}"

c404="$WORK/caso-404"
saida404="$(sonda_roda "$c404" 404)"
check "404 do app: a sonda REPROVA a instalação" igual "${saida404%%|*}" '1'
check "404 do app: a mensagem diz que a rota do Supabase no Traefik não pegou" \
  contem "$saida404" "não pegou no Traefik"
check "404 do app: a mensagem cita a issue #2099" \
  contem "$saida404" "#2099"
check "404 do app: a mensagem diz que quem respondeu foi o CRM" \
  contem "$saida404" "quem respondeu foi o CRM"
check "404 é DEFINITIVO: uma única chamada (não se insiste contra o app)" \
  igual "$(chamadas "$c404")" '1'

# ── A assinatura do app, forma 2: o 307 para /login ─────────────────────────
# O caso MEDIDO numa instalação real atrás do Traefik da hospedagem: o pedido
# cai no CRM e o CRM responde 307 para a tela de login. A sonda não segue
# redirecionamento, então o que ela recebe é o 307 cru — e ele quer dizer
# exatamente o mesmo que o 404. Antes, lido como "código desconhecido", custava
# as 10 tentativas (30 s) e parava a instalação pela mensagem genérica.
c307="$WORK/caso-307"
saida307="$(sonda_roda "$c307" 307 "$ANON" "$LOGIN")"
check "307 para /login (o pedido caiu no CRM): a sonda REPROVA a instalação" \
  igual "${saida307%%|*}" '1'
check "…e a mensagem é a da assinatura, não a genérica" contem "$saida307" "não pegou no Traefik"
check "…citando a issue #2099" contem "$saida307" "#2099"
check "…e dizendo que quem respondeu foi o CRM" contem "$saida307" "quem respondeu foi o CRM"
check "…com o código e o destino na mensagem (307 para …/login)" \
  contem "$saida307" "307 para https://crm.exemplo.com.br/login"
check "…e sem a mensagem do \"não consegui provar\"" \
  bash -c 'case "$1" in *"Não consegui provar"*) exit 1;; esac' _ "$saida307"
check "307 é DEFINITIVO: uma única chamada (não se insiste contra o app)" \
  igual "$(chamadas "$c307")" '1'

# O 3xx que NÃO vai para /login não é assinatura nenhuma: é falha transitória
# como as outras, e uma instalação certa não pode cair por ele.
c307outro="$WORK/caso-307-outro"
check "3xx para outro lugar não é a assinatura: a sonda insiste e aprova no 200" \
  igual "$(sonda_roda "$c307outro" "$(printf '307\n200')" "$ANON" "https://outro.exemplo.com/qualquer")" '0|'
check "…e foram mesmo duas chamadas" igual "$(chamadas "$c307outro")" '2'

c000200="$WORK/caso-000-200"
check "falha transitória (000) seguida de 200: aprova na segunda tentativa" \
  igual "$(sonda_roda "$c000200" "$(printf '000\n200')")" '0|'
check "…e foram mesmo duas chamadas" igual "$(chamadas "$c000200")" '2'

c000="$WORK/caso-000"
saida000="$(sonda_roda "$c000" "$(printf '000\n000\n000')")"
check "esgotadas as tentativas sem 2xx: a sonda devolve 2 (não provou — o chamador AVISA e segue)" \
  igual "${saida000%%|*}" '2'
check "…e a mensagem também cita o #2099" contem "$saida000" "#2099"
check "…e é a mensagem do \"não consegui provar\", não a da assinatura" \
  contem "$saida000" "Não consegui provar"
check "…e o aviso diz que a instalação segue (não manda rodar de novo uma instalação que não parou)" \
  bash -c 'case "$1" in *"A instalação segue"*) case "$1" in *"rode a instalação de novo"*) exit 1 ;; esac ;; *) exit 1 ;; esac' _ "$saida000"
check "…depois das 3 tentativas" igual "$(chamadas "$c000")" '3'

csem="$WORK/caso-sem-chave"
saidasem="$(sonda_roda "$csem" 200 "")"
check "sem a anon key a sonda reprova com o diagnóstico certo (não faz um pedido cego)" \
  igual "${saidasem%%|*}" '1'
check "…e diz qual variável falta" contem "$saidasem" "NEXT_PUBLIC_SUPABASE_ANON_KEY"
check "…sem tocar a rede (nenhuma chamada registrada)" igual "$(chamadas "$csem")" '0'

# ════════════════════════════════════════════════════════════════════════════
# (2) A guarda — lida do install.sh e AVALIADA
# ════════════════════════════════════════════════════════════════════════════
echo
echo "a guarda (#2945): a sonda só entra no traefik, com o Supabase desta VPS"

# A linha `if` que abre o bloco, LIDA do arquivo e executada: a condição de
# verdade, não uma cópia. Se o install.sh deixar de exigir o modo traefik, é
# este caso que cai — reescrever a condição aqui ficaria verde com o fonte
# sabotado.
n_sonda="$(grep -n 'sondar_rota_publica_do_supabase' "$INSTALL_SH" | head -1 | cut -d: -f1)"
guarda=""
for ((i = n_sonda; i > 0; i--)); do
  linha="$(sed -n "${i}p" "$INSTALL_SH")"
  case "$linha" in
    if\ *then)
      guarda="${linha#if }"
      guarda="${guarda%then}"
      guarda="$(printf '%s' "$guarda" | sed 's/[[:space:];]*$//')"
      break
      ;;
  esac
done
check "li a guarda do install.sh (não é vacuidade — sem ela, o resto não mede nada)" \
  test -n "$guarda"

veredito_guarda() {  # veredito_guarda <REVERSE_PROXY> <SUPABASE_INTERNAL_URL> <APP_SAUDAVEL> → ENTRA|NAO
  REVERSE_PROXY="$1" SUPABASE_INTERNAL_URL="$2" APP_SAUDAVEL="$3" \
    bash -c "if $guarda; then printf ENTRA; else printf NAO; fi" 2>/dev/null
}
check "traefik + Supabase desta VPS + app saudável: a sonda ENTRA" \
  igual "$(veredito_guarda traefik http://127.0.0.1:8000 1)" ENTRA
check "CONTROLE Caddy: a sonda NÃO entra" \
  igual "$(veredito_guarda caddy http://127.0.0.1:8000 1)" NAO
check "CONTROLE sem REVERSE_PROXY no ambiente: o padrão caddy mantém a sonda fora" \
  igual "$(veredito_guarda '' http://127.0.0.1:8000 1)" NAO
check "CONTROLE Supabase na NUVEM (sem URL interna): a sonda NÃO entra" \
  igual "$(veredito_guarda traefik '' 1)" NAO
check "CONTROLE app não saudável: a sonda NÃO entra" \
  igual "$(veredito_guarda traefik http://127.0.0.1:8000 0)" NAO

# ════════════════════════════════════════════════════════════════════════════
# (3) O que o install.sh FAZ com o rc — lido de lá e AVALIADO
# ════════════════════════════════════════════════════════════════════════════
echo
echo "o rc (#2945): 0 aprova, 1 PARA a instalação, 2 avisa e segue"

# O bloco de verdade, LIDO do install.sh (da linha que zera o rc até o `esac`)
# e EXECUTADO com a sonda e as saídas trocadas por dublês: é a decisão real que
# está sob prova, não uma reimplementação dela. Se o bloco mudar de forma, o
# caso "não é vacuidade" cai e avisa.
n_rc="$(grep -n '^  rota_publica_rc=0$' "$INSTALL_SH" | head -1 | cut -d: -f1)"
n_case="$(grep -n 'case "\$rota_publica_rc" in' "$INSTALL_SH" | head -1 | cut -d: -f1)"
n_esac="$(awk -v i="${n_case:-0}" 'NR >= i && /^  esac$/ { print NR; exit }' "$INSTALL_SH")"
bloco_rc=""
if [ -n "$n_rc" ] && [ -n "$n_case" ] && [ -n "$n_esac" ]; then
  bloco_rc="$(sed -n "${n_rc},${n_esac}p" "$INSTALL_SH")"
fi
check "li o tratamento do rc do install.sh (não é vacuidade)" test -n "$bloco_rc"

veredito_rc() {  # veredito_rc <rc devolvido pela sonda> → OK|PARA|AVISO
  RC_DA_SONDA="$1" BLOCO="$bloco_rc" bash -c '
    set -uo pipefail
    DOMAIN="crm.exemplo.com.br"
    t() { printf "%s" "$1"; }
    c_grn() { printf "OK"; }
    c_ylw() { printf "AVISO"; }
    die() { printf "PARA"; }
    sondar_rota_publica_do_supabase() { printf "diagnóstico do #2945"; return "$RC_DA_SONDA"; }
    eval "$BLOCO"
  ' 2>/dev/null
}
check "rc 0 (a rota chegou ao GoTrue): a instalação segue verde" \
  igual "$(veredito_rc 0)" OK
check "rc 1 (a assinatura do app): a instalação PARA" igual "$(veredito_rc 1)" PARA
check "rc 2 (não provei): a instalação AVISA e SEGUE — não aborta" \
  igual "$(veredito_rc 2)" AVISO
check "CONTROLE rc desconhecido (5xx, 521, 000 de outra origem): nunca vira verde" \
  igual "$(veredito_rc 9)" AVISO

# ════════════════════════════════════════════════════════════════════════════
# (4) As pontas: onde a sonda mora, onde ela é chamada, e o comentário do #2099
# ════════════════════════════════════════════════════════════════════════════
echo
echo "as pontas (#2945)"

check "a sonda está em _common.sh (a lib compartilhada pelo kit)" \
  grep -q '^sondar_rota_publica_do_supabase()' "$COMMON"
check "sintaxe Bash válida em _common.sh, install.sh e install-single-server.sh" \
  bash -c 'for f in "$@"; do bash -n "$f" || exit 1; done' _ "$COMMON" "$INSTALL_SH" "$INSTALADOR"
check "sintaxe Bash válida neste teste" bash -n "${BASH_SOURCE[0]}"

n_health="$(grep -n 'wait_app_healthy 30 3' "$INSTALL_SH" | head -1 | cut -d: -f1)"
check "a sonda é chamada DEPOIS do healthcheck do app" \
  test "${n_sonda:-0}" -gt "${n_health:-999999}"
n_banner="$(grep -n 'Instalação concluída!' "$INSTALL_SH" | tail -1 | cut -d: -f1)"
check "a sonda é chamada ANTES da tela final (a prova não chega depois do verde)" \
  test "${n_sonda:-0}" -lt "${n_banner:-0}"
check "a URL sondada é o domínio do .env (DOMAIN), e não a URL do Supabase da nuvem" \
  grep -q 'sondar_rota_publica_do_supabase "https://\${DOMAIN}"' "$INSTALL_SH"

# O pedido 2 do autor: o comentário do install-single-server.sh afirmava que
# `v_sb_key()` chama a rota pública — não chama mais desde o #2933.
check "o comentário não afirma mais que v_sb_key() chama a rota pública" \
  bash -c '! grep -q "v_sb_key() chama" "$1"' _ "$INSTALADOR"
check "…e aponta a sonda que passou a provar a rota pública" \
  grep -q 'sondar_rota_publica_do_supabase' "$INSTALADOR"

echo
if [ "$FAILS" -ne 0 ]; then
  printf '%d caso(s) reprovado(s)\n' "$FAILS"
  exit 1
fi
echo "todos os casos passaram"
