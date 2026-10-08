#!/usr/bin/env bash
# ── O install.sh não deixa arquivo temporário para trás ─────────────────────
#
# O DEFEITO: o passo dos e-mails de acesso (passo 7) cria
# `PENDENCIA_EMAIL="$(mktemp)"` para o `marca-emails.sh` escrever o que não
# conseguiu fazer, e a tela final lê esse arquivo — mas ninguém o apagava.
# Medido numa VPS de teste: um `/tmp/tmp.*` (600, 231 bytes) por instalação que
# passou do passo 7, três sobras em três instalações.
#
# O QUE ESTE ARQUIVO PROVA: com `TMPDIR` apontando para uma pasta só dele, o
# install.sh roda de ponta a ponta (docker, curl, crontab e uname são dublês) e a
# pasta termina VAZIA nas três saídas que existem depois do passo 7:
#   1. a instalação concluída (a pendência ainda aparece na tela final — o
#      arquivo não pode sumir ANTES de ser lido);
#   2. "quase lá — falta o app responder" (o ramo que desliga o trap de saída);
#   3. a morte no meio, depois do passo 7 (o bootstrap do dono falha → `die`).
# E o inverso: o trap só apaga o que o próprio install.sh criou — um
# `PENDENCIA_EMAIL` herdado do ambiente sobrevive a uma morte ANTES do passo 7.
#
# O mktemp do macOS ignora o TMPDIR quando não recebe modelo (o GNU respeita):
# sem o dublê abaixo, no Mac o temporário iria para /var/folders e a pasta do
# teste ficaria vazia COM o defeito — verde falso. O controle 0 prova que o
# mktemp que o install.sh vai chamar cai mesmo na pasta do teste.
#
# NÃO prova nada sobre uma VPS de verdade: nenhum contêiner sobe.
#
#   bash tests/shell/install-nao-deixa-temporario.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
WORK="$(mktemp -d)"
# Sem sandbox próprio os dublês abaixo iriam para /bin: para antes de plantar nada.
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ]; then
  echo "abortado: mktemp -d não devolveu um sandbox (WORK='$WORK')" >&2
  exit 1
fi
trap '[ "${DK_KEEP:-0}" = 1 ] || rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublês ───────────────────────────────────────────────────────────────────
REAL_UNAME="$(command -v uname)"
REAL_MKTEMP="$(command -v mktemp)"
mkdir -p "$WORK/bin"
# docker: registra a chamada; `APP_DOENTE=1` faz o probe do app não responder
# (ramo "quase lá"); `FALHA_BOOTSTRAP=1` faz o psql do bootstrap do dono falhar
# (ramo `die`). O bootstrap é reconhecido pelo SQL no stdin, não pela ordem.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  *baseline.sql*) [ "${FALHA_BASELINE:-0}" = 1 ] && exit 1; exit 0 ;;
  *psql*)
    if [ "${FALHA_BOOTSTRAP:-0}" = 1 ] && grep -q 'declare v_org' 2>/dev/null; then exit 1; fi
    exit 0 ;;
esac
case "$1" in
  compose)
    case "$*" in
      *" exec "*) [ "${APP_DOENTE:-0}" = 1 ] && exit 1
                  printf 'healthy\n{"data":{"status":"healthy"}}\n' ;;
    esac ;;
esac
exit 0
STUB
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *ghcr.io/token*) printf '{"token":"duble"}' ;;
  *ghcr.io/v2/*)   printf 200 ;;
  # v_supabase_url: só o GoTrue passa (400 + o "msg" dele, como medido).
  */auth/v1/verify*) printf '{"msg":"Verify requires a verification type"}\n400' ;;
  *)               printf 200 ;;
esac
STUB
# crontab: nunca o da máquina de quem roda. Só consome stdin onde o real consome.
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -l) [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0 ;;
  -)  cat > "$FAKE_CRONTAB" ;;
esac
exit 0
STUB
cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
# mktemp sem modelo (e `-d` sem modelo): modelo explícito em $TMPDIR, que é onde
# o GNU já cria. Qualquer outra forma vai intacta para o mktemp real.
cat > "$WORK/bin/mktemp" <<STUB
#!/usr/bin/env bash
case "\$*" in
  '')   exec "$REAL_MKTEMP" "\${TMPDIR:-/tmp}/tmp.XXXXXXXXXX" ;;
  -d)   exec "$REAL_MKTEMP" -d "\${TMPDIR:-/tmp}/tmp.XXXXXXXXXX" ;;
esac
exec "$REAL_MKTEMP" "\$@"
STUB
chmod +x "$WORK/bin/"*

mkjwt() {
  local payload; payload="$(printf '{"iss":"supabase","ref":"%s","role":"%s"}' "$2" "$1" \
    | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
  printf 'eyJhbGciOiJIUzI1NiJ9.%s.assinatura' "$payload"
}

# rodar <nome do caso> [VAR=valor do docker...] → OUT, TMPD, RC
rodar() {
  local caso="$1"; shift
  local raiz="$WORK/$caso" proj="$WORK/$caso/crm"
  mkdir -p "$proj/supabase" "$raiz/tmp"
  cp -R "$REPO_ROOT/hostgator-setup-kit" "$proj/"
  : > "$proj/supabase/baseline.sql"
  : > "$proj/docker-compose.prod.yml"
  cat > "$proj/.env" <<ENV
DOMAIN='crm.exemplo.com.br'
ACME_EMAIL='eu@exemplo.com.br'
NEXT_PUBLIC_SUPABASE_URL='https://abcdefghijklmnop.supabase.co'
NEXT_PUBLIC_SUPABASE_ANON_KEY='$(mkjwt anon abcdefghijklmnop)'
SUPABASE_SERVICE_ROLE_KEY='$(mkjwt service_role abcdefghijklmnop)'
SUPABASE_DB_URL='postgresql://postgres.abcdefghijklmnop:senha@aws-1-sa-east-1.pooler.supabase.com:5432/postgres'
ANTHROPIC_API_KEY='sk-ant-teste'
OWNER_EMAIL='eu@exemplo.com.br'
OWNER_PASSWORD='senha12345'
ENV
  OUT="$raiz/saida.txt"; TMPD="$raiz/tmp"; RC=0
  # `SUPABASE_ACCESS_TOKEN=` vazio: o marca-emails.sh não chama rede e ESCREVE a
  # pendência — é o caso em que o arquivo temporário tem conteúdo.
  ( cd "$proj" && env PATH="$WORK/bin:$PATH" TMPDIR="$TMPD" \
      DOCKER_LOG="$raiz/docker.log" FAKE_CRONTAB="$raiz/crontab.txt" \
      SUPABASE_ACCESS_TOKEN= "$@" \
      bash hostgator-setup-kit/install.sh --yes
  ) 2>&1 < /dev/null | sed -E 's/\x1b\[[0-9;]*m//g' > "$OUT" || RC=$?
}
sobras() { find "$TMPD" -mindepth 1 | sed "s#^$TMPD/#  sobra: #"; }
vazio() { [ -z "$(find "$TMPD" -mindepth 1 -print -quit)" ] || { sobras; return 1; }; }
passou_do_passo_7() { grep -q 'Criando o primeiro admin' "$OUT"; }

echo '── 0. controle: o mktemp que o install.sh chama cai no TMPDIR do teste'
CTRL="$WORK/controle"; mkdir -p "$CTRL"
for forma in '' -d; do
  f="$(env PATH="$WORK/bin:$PATH" TMPDIR="$CTRL" mktemp $forma)"
  case "$f" in
    "$CTRL"/*) printf '  ✓ mktemp %s cria dentro do TMPDIR\n' "${forma:-(sem modelo)}"; rm -rf "$f" ;;
    *) rm -rf "$f"
       echo "  ✗ SONDA CEGA: 'mktemp $forma' criou '$f', fora de '$CTRL'." >&2
       echo "    As provas de 'pasta vazia' abaixo passariam mesmo com o defeito." >&2
       exit 1 ;;
  esac
done

echo
echo '── 1. instalação concluída'
rodar concluida
check "saiu com 0" [ "$RC" -eq 0 ]
check "chegou à tela final (controle: o cenário mede a instalação inteira)" \
  grep -q 'Instalação concluída' "$OUT"
check "a pendência dos e-mails ainda aparece na tela final" \
  grep -q 'O que o passo automático encontrou' "$OUT"
check "nenhum arquivo temporário ficou para trás" vazio

echo
echo '── 2. "quase lá" — o app não respondeu (o ramo que desliga o trap)'
rodar quase APP_DOENTE=1
check "saiu com 1 (contrato: automação sabe que não terminou)" [ "$RC" -eq 1 ]
check "passou do passo 7 (controle)" passou_do_passo_7
check "terminou na tela de 'falta o app responder' (controle)" \
  grep -q 'falta o app responder' "$OUT"
check "nenhum arquivo temporário ficou para trás" vazio

echo
echo '── 3. a instalação morre depois do passo 7 (bootstrap do dono falha)'
rodar morre FALHA_BOOTSTRAP=1
check "saiu com != 0" [ "$RC" -ne 0 ]
check "passou do passo 7 (controle)" passou_do_passo_7
check "morreu com a tela de recuperação (controle)" \
  grep -q 'A instalação parou' "$OUT"
check "nenhum arquivo temporário ficou para trás" vazio

echo
echo '── 4. PENDENCIA_EMAIL herdado do ambiente, morte ANTES do passo 7'
mkdir -p "$WORK/herdado"
ALHEIO="$WORK/herdado/arquivo-alheio.txt"; echo 'não é do install.sh' > "$ALHEIO"
rodar herdado FALHA_BASELINE=1 PENDENCIA_EMAIL="$ALHEIO"
check "morreu no baseline, antes do passo 7 (controle)" \
  grep -q 'baseline falhou' "$OUT"
check "não passou do passo 7 (controle)" eval '! passou_do_passo_7'
check "saiu com != 0" [ "$RC" -ne 0 ]
check "o arquivo que o install.sh não criou continua lá" [ -f "$ALHEIO" ]

echo
if [ "$FAILS" -eq 0 ]; then
  echo "OK — o install.sh não deixa temporário e só apaga o que criou."
else
  echo "FALHOU — $FAILS prova(s)."
fi
exit $((FAILS > 0))
