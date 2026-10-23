#!/usr/bin/env bash
# O par VAPID (avisos com o app fechado) nasce sozinho pelo kit, só na lacuna, e
# nunca é trocado depois — num `.env` descartável, sem docker.
#
#   bash tests/shell/par-vapid.test.sh
#
# Por que cada guarda importa:
#   - trocar um par existente desliga os avisos de todo aparelho já inscrito, e
#     cada atendente teria de religá-los à mão (ADR-0006, D6);
#   - só UMA das chaves presente não é lacuna: gerar a outra quebraria o par;
#   - as duas chaves entram numa escrita só — interromper o kit entre duas
#     escritas deixaria meia chave, e o kit se recusaria a curar o que ele mesmo
#     estragou;
#   - a geração que falha não derruba a instalação nem a atualização: o push é
#     opcional, e o aviso diz como tentar de novo;
#   - `gravar_imagens` é a função que o update.sh ANTIGO chama depois de reler o
#     kit, então é por ela que o par chega já na primeira atualização.
set -uo pipefail
unset $(git rev-parse --local-env-vars)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1
KIT="$REPO_ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)" || exit 1
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

fail=0
check() {  # check <descrição> <comando...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  ✓ %s\n' "$d"; else printf '  ✗ %s\n' "$d"; fail=1; fi
}

# Roda uma função do kit dentro de <dir>, com um PATH opcional na frente.
no_kit() {  # no_kit <dir> <path-extra|""> <comando do kit>
  ( cd "$1" && PATH="${2:+$2:}$PATH" bash -c ". '$KIT/_common.sh'; $3" 2>&1 )
}
valor() { sed -n "s/^$2=//p" "$1" | tail -1 | tr -d "\"'"; }
contem() { printf '%s' "$1" | grep -qF -- "$2"; }

# Formato que o navegador e o web-push exigem: base64url sem padding; pública
# com 65 bytes começando em 0x04 (ponto não comprimido da P-256); privada com 32.
par_valido() {  # par_valido <envfile>
  local pub priv hex
  pub="$(valor "$1" VAPID_PUBLIC_KEY)"; priv="$(valor "$1" VAPID_PRIVATE_KEY)"
  [ "${#pub}" -eq 87 ] && [ "${#priv}" -eq 43 ] || return 1
  [[ "$pub$priv" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  hex="$(printf '%s=' "$pub" | tr '_-' '/+' | base64 -d 2>/dev/null | od -An -v -tx1 | tr -d ' \n')"
  [ "${#hex}" -eq 130 ] && [ "${hex:0:2}" = 04 ] || return 1
  hex="$(printf '%s=' "$priv" | tr '_-' '/+' | base64 -d 2>/dev/null | od -An -v -tx1 | tr -d ' \n')"
  [ "${#hex}" -eq 64 ]
}
uma_linha_de_cada() {
  [ "$(grep -c '^VAPID_PUBLIC_KEY=' "$1")" -eq 1 ] && [ "$(grep -c '^VAPID_PRIVATE_KEY=' "$1")" -eq 1 ]
}
permissao_600() { [ "$(ls -l "$1" | cut -c1-10)" = "-rw-------" ]; }

caso() {  # caso <nome> <conteúdo do .env> → cria o diretório e imprime o caminho
  mkdir -p "$WORK/$1"
  printf '%s' "$2" > "$WORK/$1/.env"
  chmod 644 "$WORK/$1/.env"
  printf '%s' "$WORK/$1"
}

echo "── lacuna: as duas chaves faltando → o par nasce"
D="$(caso a $'DOMAIN=crm.exemplo.com.br\nOUTRA=1\n')"
SAIDA="$(no_kit "$D" "" "completar_par_vapid .env")"
check "(a) linha ausente → par válido (87/43, base64url, 65 bytes começando em 04)" par_valido "$D/.env"
check "    uma linha de cada chave" uma_linha_de_cada "$D/.env"
check "    as outras linhas continuam lá" grep -qx 'OUTRA=1' "$D/.env"
check "    anuncia que criou, e que não se troca" contem "$SAIDA" "não troque"
check "(j) o .env segue com permissão 600" permissao_600 "$D/.env"

D="$(caso b $'VAPID_PUBLIC_KEY=""\nVAPID_PRIVATE_KEY=""\n')"
no_kit "$D" "" "completar_par_vapid .env" >/dev/null
check "(b) vazio no formato do install (\"\") → par válido" par_valido "$D/.env"
check "    sem linha duplicada" uma_linha_de_cada "$D/.env"

D="$(caso c $'VAPID_PUBLIC_KEY=\nVAPID_PRIVATE_KEY=\n')"
no_kit "$D" "" "completar_par_vapid .env" >/dev/null
check "(c) vazio nu, como no .env.hostgator.example → par válido" par_valido "$D/.env"

# Um .env editado no Windows: o app faz trim() e vê vazio; o kit tem de ver igual,
# senão a tela pede para atualizar e a atualização não faz nada, para sempre.
D="$(caso l $'VAPID_PUBLIC_KEY=\r\nVAPID_PRIVATE_KEY= \r\n')"
no_kit "$D" "" "completar_par_vapid .env" >/dev/null
check "(l) só espaço/CR (a régua do trim() do app) → conta como vazio e gera" par_valido "$D/.env"

echo "── par existente: intocável"
PAR_ORIGINAL=$'VAPID_PUBLIC_KEY="BPub"\nVAPID_PRIVATE_KEY="priv"\nX=1\n'
D="$(caso d "$PAR_ORIGINAL")"; cp "$D/.env" "$D/original"
SAIDA="$(no_kit "$D" "" "completar_par_vapid .env")"
check "(d) as duas preenchidas → arquivo byte a byte igual" cmp -s "$D/.env" "$D/original"
check "    e calado" test -z "$SAIDA"

D="$(caso e $'VAPID_PUBLIC_KEY="BPub"\nVAPID_PRIVATE_KEY=""\n')"; cp "$D/.env" "$D/original"
SAIDA="$(no_kit "$D" "" "completar_par_vapid .env")"
check "(e) só uma das chaves → não gera a outra (arquivo igual)" cmp -s "$D/.env" "$D/original"
check "    e avisa, dizendo como sair" contem "$SAIDA" "Não gerei a outra"
check "    pela atualização (sem --force: ela cria o par mesmo sem versão nova)" contem "$SAIDA" "rode: bash hostgator-setup-kit/update.sh"
check "    e não manda forçar (--force refaz backup e banco, e pode voltar de versão)" bash -c "! printf '%s' \"\$1\" | grep -q -- --force" _ "$SAIDA"

D="$(caso e2 $'VAPID_PRIVATE_KEY="priv"\n')"; cp "$D/.env" "$D/original"
no_kit "$D" "" "completar_par_vapid .env" >/dev/null
check "(e) só a privada, sem a linha da pública → também intocável" cmp -s "$D/.env" "$D/original"

# `export ` na frente e espaço no começo: o leitor de .env do Compose aceita as
# duas formas, então elas também são um par que existe.
D="$(caso m $'export VAPID_PUBLIC_KEY=BOld\n  export VAPID_PRIVATE_KEY=old\n')"; cp "$D/.env" "$D/original"
SAIDA="$(no_kit "$D" "" "completar_par_vapid .env")"
check "(m) par escrito com 'export ' e recuo → intocável (sem segundo par)" cmp -s "$D/.env" "$D/original"
check "    e calado: é um par inteiro, não meia chave" test -z "$SAIDA"

D="$(caso m2 $'export VAPID_PUBLIC_KEY=\n VAPID_PRIVATE_KEY=""\nX=1\n')"
no_kit "$D" "" "completar_par_vapid .env" >/dev/null
check "(m) vazio escrito com 'export '/recuo → par válido" par_valido "$D/.env"
check "    e as linhas vazias antigas saem (uma linha VAPID de cada)" \
  test "$(grep -cE 'VAPID_(PUBLIC|PRIVATE)_KEY=' "$D/.env")" -eq 2

D="$(caso f $'X=1\n')"
no_kit "$D" "" "completar_par_vapid .env" >/dev/null
cp "$D/.env" "$D/depois-da-1a"
SAIDA="$(no_kit "$D" "" "completar_par_vapid .env")"
check "(f) 2ª passada não muda um byte" cmp -s "$D/.env" "$D/depois-da-1a"
check "    e fica calada" test -z "$SAIDA"

echo "── o caminho da atualização"
D="$(caso g $'APP_IMAGE=x\nWAHA_IMAGE=devlikeapro/waha-plus:2026.7.2\n')"
no_kit "$D" "" "gravar_imagens .env 9.9.9" >/dev/null
check "(g) gravar_imagens (a função que o update.sh antigo chama) gera o par" par_valido "$D/.env"
check "    e grava as imagens como antes" grep -q '^APP_IMAGE=.*:9\.9\.9$' "$D/.env"

D="$(caso g2 $'VAPID_PUBLIC_KEY=""\nVAPID_PRIVATE_KEY=""\n')"
EXPORTADO="$(no_kit "$D" "" "VAPID_PUBLIC_KEY=''; export VAPID_PUBLIC_KEY; completar_par_vapid .env >/dev/null; printf '%s' \"\${#VAPID_PUBLIC_KEY}\"")"
check "(g) o par também vai para o ambiente (que tinha o vazio do load_env)" test "$EXPORTADO" = 87

echo "── a geração que falha não derruba nada"
mkdir -p "$WORK/bin-falha" "$WORK/bin-lixo"
printf '#!/usr/bin/env bash\nexit 1\n' > "$WORK/bin-falha/openssl"
# DER curto: o formato não é o esperado → falha fechado, nunca grava lixo.
printf '#!/usr/bin/env bash\ncase "$1" in ecparam) echo PEM ;; *) printf "abc" ;; esac\n' > "$WORK/bin-lixo/openssl"
chmod +x "$WORK/bin-falha/openssl" "$WORK/bin-lixo/openssl"
for dub in falha lixo; do
  D="$(caso "h-$dub" $'X=1\n')"; cp "$D/.env" "$D/original"
  SAIDA="$(no_kit "$D" "$WORK/bin-$dub" "completar_par_vapid .env; echo rc=\$?")"
  check "(h) openssl $dub → arquivo intacto" cmp -s "$D/.env" "$D/original"
  check "    sai com 0 (o push é opcional)" contem "$SAIDA" "rc=0"
  check "    e avisa como tentar de novo, sem --force" contem "$SAIDA" "tentar de novo: bash hostgator-setup-kit/update.sh"
  check "    (e não manda forçar)" bash -c "! printf '%s' \"\$1\" | grep -q -- --force" _ "$SAIDA"
done

# Como root o `chmod 444` não segura a escrita: o caso não tem como acontecer
# e a prova mediria o root, não o kit. Pula AVISANDO, nunca em silêncio.
if [ "$(id -u)" -eq 0 ]; then
  echo "  - (i) pulado: rodando como root, o chmod 444 não impede a escrita"
else
D="$(caso i $'X=1\n')"; cp "$D/.env" "$D/original"; chmod 444 "$D/.env"
SAIDA="$(no_kit "$D" "" "completar_par_vapid .env")"
check "(i) .env somente-leitura → não toca" cmp -s "$D/.env" "$D/original"
check "    mas avisa que não conseguiu escrever (a tela manda atualizar)" contem "$SAIDA" "não consigo escrever"
fi

D="$(caso i2 $'VAPID_PUBLIC_KEY=BPub\nVAPID_PRIVATE_KEY=priv\n')"; chmod 444 "$D/.env"
SAIDA="$(no_kit "$D" "" "completar_par_vapid .env")"
check "    somente-leitura com o par presente → calado (não há o que escrever)" test -z "$SAIDA"

# A cópia temporária leva todos os segredos do .env: nasce 600, não com a umask.
mkdir -p "$WORK/bin-chmod"
cat > "$WORK/bin-chmod/chmod" <<'STUB'
#!/usr/bin/env bash
ls -l "${@: -1}" | cut -c1-10 >> "$CHMOD_LOG"
exec /bin/chmod "$@"
STUB
/bin/chmod +x "$WORK/bin-chmod/chmod"
D="$(caso n $'X=1\n')"
( umask 022; CHMOD_LOG="$WORK/chmod.log" no_kit "$D" "$WORK/bin-chmod" "completar_par_vapid .env" >/dev/null )
check "(n) a cópia temporária já nasce -rw------- (antes do chmod)" \
  test "$(head -1 "$WORK/chmod.log" 2>/dev/null)" = "-rw-------"

D="$WORK/sem-env"; mkdir -p "$D"
SAIDA="$(no_kit "$D" "" "completar_par_vapid .env; echo rc=\$?")"
check "    sem .env → não cria um, e sai com 0" test ! -e "$D/.env"
check "    (rc=0)" contem "$SAIDA" "rc=0"

echo "── o install chama a mesma função, depois de escrever o .env"
L_ENV="$(grep -n '^} > \.env$' "$KIT/install.sh" | head -1 | cut -d: -f1)"
L_PAR="$(grep -n '^completar_par_vapid \.env' "$KIT/install.sh" | head -1 | cut -d: -f1)"
check "(k) install.sh chama completar_par_vapid .env logo depois de '} > .env'" \
  test -n "$L_ENV" -a -n "$L_PAR" -a "${L_PAR:-0}" -gt "${L_ENV:-0}"

if [ "$fail" -ne 0 ]; then printf '\npar-vapid: FALHOU\n'; exit 1; fi
printf '\npar-vapid: tudo verde\n'
