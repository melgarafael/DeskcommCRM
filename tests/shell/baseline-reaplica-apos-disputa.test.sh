#!/usr/bin/env bash
# Prova de `reaplicar_baseline` (hostgator-setup-kit/_common.sh), com `docker`
# substituído por um dublê que devolve a saída do psql passada a passada.
#
#   bash tests/shell/baseline-reaplica-apos-disputa.test.sh
#
# O defeito, medido numa VPS real na v1.27.3: o update.sh re-aplicou o baseline
# com o app atendendo, dois comandos perderam um `deadlock detected`, e um deles
# era o `create policy` logo depois do `drop policy` da mesma policy. O psql
# seguiu (é o contrato sem ON_ERROR_STOP), o script avisou e seguiu também, e
# `ai_knowledge_sources` ficou sem a policy de leitura até alguém refazer o
# bloco à mão.
#
# O que está sob prova:
#   1. erro de disputa numa passada → o arquivo é aplicado DE NOVO, e o veredito
#      é o da última passada (a que fica no banco);
#   2. disputa que não passa → desiste no teto e devolve o erro, sem "✓";
#   3. erro que não é de disputa (permissão, dado) → uma passada só: repetir
#      daria o mesmo erro, mais tarde;
#   4. o psql que não chega ao fim do arquivo NUNCA é lido como sucesso, mesmo
#      quando a mensagem de conexão perdida não traz a palavra ERROR;
#   5. o ruído benigno de sempre não dispara passada nenhuma;
#   6. uma lista de erros maior que o buffer do pipe não cega a função (pipefail);
#   7. conexão que nem chega a abrir também é refeita, e o veredito cita a causa,
#      não a linha de dica do psql;
#   8. nome de host que não existe NÃO é refeito (é configuração), e a falha
#      temporária de DNS é;
#   9. a listagem de uma nova passada põe a linha de disputa primeiro, mesmo atrás
#      de muitas outras, e diz quantas ficaram de fora.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublê de `docker` ────────────────────────────────────────────────────────
# Cada chamada que aplica o baseline consome a próxima passada do roteiro:
# `$ROTEIRO/passada.N` é o que o psql imprime, `$ROTEIRO/saida.N` o código com
# que ele sai (0 quando o arquivo não existe). Passada sem roteiro sai limpa.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *" -f /b.sql "*)
    n=$(( $(cat "$ROTEIRO/n" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$n" > "$ROTEIRO/n"
    [ -f "$ROTEIRO/passada.$n" ] && cat "$ROTEIRO/passada.$n"
    exit "$(cat "$ROTEIRO/saida.$n" 2>/dev/null || echo 0)" ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/docker"

printf 'select 1;\n' > "$WORK/baseline.sql"

# Saídas de psql copiadas da forma real (update-1.27.3.log da VPS, 2026-09-15).
BENIGNO='psql:/b.sql:1918: ERROR:  multiple primary keys for table "ai_agent_runs" are not allowed
psql:/b.sql:2554: ERROR:  relation "ai_invocations_org_created_idx" already exists'
DEADLOCK='psql:/b.sql:16766: ERROR:  deadlock detected
DETAIL:  Process 4121 waits for AccessExclusiveLock on relation 29187 of database 5; blocked by process 3987.
HINT:  See server log for query details.'

# roteiro <passada> <saída do psql> [código de saída]
roteiro() {
  printf '%s\n' "$2" > "$ROTEIRO/passada.$1"
  [ $# -ge 3 ] && printf '%s' "$3" > "$ROTEIRO/saida.$1"
  return 0
}

novo_caso() {
  ROTEIRO="$WORK/roteiro.$1"
  rm -rf "$ROTEIRO"; mkdir -p "$ROTEIRO"
  : > "$WORK/docker.log"
}

# Roda a função num bash filho, com o `set -euo pipefail` que o _common.sh liga
# nos scripts de verdade, e guarda o que a prova lê: código, veredito, tela, log.
rodar() {
  bash -c '
    export PATH="$1/bin:$PATH" DOCKER_LOG="$1/docker.log" ROTEIRO="$2"
    export SUPABASE_DB_URL="postgresql://postgres:x@db.exemplo:5432/postgres"
    export BASELINE_ESPERA_S=0
    source "$3/hostgator-setup-kit/_common.sh" >/dev/null 2>&1
    if reaplicar_baseline "$1/baseline.sql" "$1/apply.log"; then rc=0; else rc=1; fi
    printf "%s" "$rc" > "$1/rc"
    printf "%s" "${BASELINE_INESPERADO-<nunca definido>}" > "$1/inesperado"
    printf "%s" "${BASELINE_PASSADAS-<nunca definido>}" > "$1/passadas-declaradas"
  ' _ "$WORK" "$ROTEIRO" "$RAIZ" > "$WORK/tela" 2>&1
}

rc()          { cat "$WORK/rc"; }
passadas()    { grep -c -- '-f /b.sql' "$WORK/docker.log"; }
inesperado()  { cat "$WORK/inesperado"; }
e_igual()     { [ "$1" = "$2" ]; }
declaradas()  { cat "$WORK/passadas-declaradas"; }
# Here-string, não `printf | grep -q`: o caso 6 passa listas maiores que o buffer
# do pipe, e sob pipefail o próprio instrumento cegaria.
contem()      { grep -qiE -- "$2" <<<"$1"; }
nao_contem()  { ! grep -qiE -- "$2" <<<"$1"; }

echo "── 0. O dublê é o que a prova pensa que é"
# Controle positivo: sem ele, uma função que nunca chama o docker daria
# "uma passada só" por zero passadas, e os casos 3 e 5 ficariam verdes medindo nada.
novo_caso controle
roteiro 1 "$DEADLOCK"
PATH="$WORK/bin:$PATH" DOCKER_LOG="$WORK/docker.log" ROTEIRO="$ROTEIRO" \
  docker run --rm -i postgres:17-alpine psql x -q -f /b.sql > "$WORK/controle" 2>&1
check "uma chamada do psql consome a passada 1 do roteiro" grep -q "deadlock detected" "$WORK/controle"
check "e o log do dublê conta a chamada" e_igual "$(passadas)" 1

echo "── 1. Deadlock na 1ª passada, limpa na 2ª: aplica de novo e o veredito é o da 2ª"
novo_caso disputa-passa
roteiro 1 "$BENIGNO
$DEADLOCK"
roteiro 2 "$BENIGNO"
rodar
check "devolve sucesso" e_igual "$(rc)" 0
check "aplicou o arquivo duas vezes" e_igual "$(passadas)" 2
check "o veredito não carrega o deadlock da 1ª passada" e_igual "$(inesperado)" ""
check "a tela diz que está aplicando de novo, e que é seguro" grep -q "aplicando de novo, é seguro (passada 2 de 3)" "$WORK/tela"
check "  e mostra O QUE não aplicou — o ✓ depois de uma disputa não é mudo" grep -q "psql:/b.sql:16766: ERROR:  deadlock detected" "$WORK/tela"
check "  sem repetir na tela o ruído benigno" nao_contem "$(cat "$WORK/tela")" "multiple primary keys"
check "BASELINE_PASSADAS diz 2, para quem chama contar ao dono" e_igual "$(declaradas)" 2
check "o log guarda as DUAS passadas, com cabeçalho" e_igual "$(grep -c '^── passada ' "$WORK/apply.log")" 2
check "  e o deadlock da 1ª continua lá para quem investigar" grep -q "deadlock detected" "$WORK/apply.log"

echo "── 2. Disputa que não passa: desiste no teto e devolve o erro"
novo_caso disputa-persiste
roteiro 1 "$DEADLOCK"; roteiro 2 "$DEADLOCK"; roteiro 3 "$DEADLOCK"; roteiro 4 ""
rodar
check "devolve falha" e_igual "$(rc)" 1
check "parou no teto de 3 passadas (não tentou a 4ª)" e_igual "$(passadas)" 3
check "o veredito traz o deadlock" contem "$(inesperado)" "deadlock detected"
check "BASELINE_PASSADAS diz 3" e_igual "$(declaradas)" 3

echo "── 3. Erro que não é de disputa: uma passada só"
novo_caso permissao
roteiro 1 'psql:/b.sql:88: ERROR:  permission denied for schema public'
roteiro 2 ""
rodar
check "devolve falha" e_igual "$(rc)" 1
check "não re-aplicou (repetir daria o mesmo erro)" e_igual "$(passadas)" 1
check "o veredito traz o erro de permissão" contem "$(inesperado)" "permission denied"

echo "── 4. psql que não chega ao fim do arquivo nunca é sucesso"
novo_caso conexao-cai
# Sem a palavra ERROR de propósito: é o que isola a leitura do código de saída.
roteiro 1 'psql:/b.sql:9000: server closed the connection unexpectedly
	This probably means the server terminated abnormally
	before or while processing the request.
psql:/b.sql:9000: connection to server was lost' 2
roteiro 2 ""
rodar
check "conexão que cai no meio vira nova passada" e_igual "$(passadas)" 2
check "  e, limpa a 2ª, devolve sucesso" e_igual "$(rc)" 0

novo_caso conexao-cai-sempre
# O par que faltava: sem ele, o "devolve sucesso" acima ficava verde também numa
# função que nem lê o código de saída (ela devolveria 0 já na 1ª passada).
for n in 1 2 3; do
  roteiro "$n" 'psql:/b.sql:9000: server closed the connection unexpectedly
psql:/b.sql:9000: connection to server was lost' 2
done
rodar
check "conexão que cai em todas as passadas devolve falha" e_igual "$(rc)" 1
check "  depois das 3 passadas" e_igual "$(passadas)" 3

novo_caso docker-falha
roteiro 1 'Unable to find image postgres:17-alpine locally' 125
roteiro 2 ""
rodar
check "saída 125 sem mensagem reconhecível devolve falha" e_igual "$(rc)" 1
check "  sem nova passada (não é disputa)" e_igual "$(passadas)" 1
check "  e o veredito diz que não chegou ao fim, com o código" contem "$(inesperado)" "não chegou ao fim do arquivo \(o psql saiu com código 125\)"

echo "── 5. Ruído benigno não é aviso nem motivo para aplicar de novo"
novo_caso benigno
roteiro 1 "$BENIGNO"
roteiro 2 "$DEADLOCK"
rodar
check "devolve sucesso" e_igual "$(rc)" 0
check "uma passada só" e_igual "$(passadas)" 1
check "veredito vazio" e_igual "$(inesperado)" ""
check "a tela não fala em aplicar de novo" nao_contem "$(cat "$WORK/tela")" "aplicando de novo"

echo "── 6. Lista de erros maior que o buffer do pipe (pipefail) não cega a função"
# Uma role sem dono gera milhares de "must be owner". Com `printf | grep -q`, o
# grep achava o deadlock na 1ª linha e saía; o printf levava SIGPIPE e, sob
# pipefail, o pipeline virava falha — a disputa deixava de ser reconhecida.
novo_caso lista-grande
GRANDE="$(printf '%s\n' "$DEADLOCK"; for i in $(seq 1 4000); do printf 'psql:/b.sql:%s: ERROR:  must be owner of table tabela_%s\n' "$i" "$i"; done)"
roteiro 1 "$GRANDE"
roteiro 2 ""
check "o roteiro é mesmo maior que o buffer de um pipe (64 KB)" test "$(wc -c < "$ROTEIRO/passada.1" | tr -d ' ')" -gt 65536
rodar
check "a disputa no topo de uma lista grande ainda é reconhecida (aplicou de novo)" e_igual "$(passadas)" 2
check "  e a 2ª passada limpa devolve sucesso" e_igual "$(rc)" 0

echo "── 7. Conexão que nem abre: nova passada, e o veredito cita a causa"
novo_caso conexao-recusada
# Saída real do psql 17 com o servidor parado (medida em 2026-09-16).
RECUSADA='psql: error: connection to server at "db.exemplo" (192.168.65.254), port 5432 failed: Connection refused
	Is the server running on that host and accepting TCP/IP connections?
connection to server at "db.exemplo" (fdc4:f303:9324::254), port 5432 failed: Network unreachable
	Is the server running on that host and accepting TCP/IP connections?'
roteiro 1 "$RECUSADA" 2
roteiro 2 ""
rodar
check "servidor que recusa a conexão vira nova passada" e_igual "$(passadas)" 2
check "  e, no ar na 2ª, devolve sucesso" e_igual "$(rc)" 0

novo_caso conexao-recusada-sempre
for n in 1 2 3; do roteiro "$n" "$RECUSADA" 2; done
rodar
check "recusada nas 3 passadas devolve falha" e_igual "$(rc)" 1
check "  o veredito cita a causa (Network unreachable)" contem "$(inesperado)" "não chegou ao fim do arquivo \(o psql saiu com código 2\): connection to server .*Network unreachable"
check "  e não a linha de dica do psql" nao_contem "$(inesperado)" "Is the server running"

novo_caso conexao-recusada-ipv4
# Só IPv4, sem a tentativa IPv6 "Network unreachable" — que casa outro termo da
# regra e escondia a remoção de "Connection refused".
roteiro 1 'psql: error: connection to server at "db.exemplo" (10.0.0.5), port 5432 failed: Connection refused
	Is the server running on that host and accepting TCP/IP connections?' 2
roteiro 2 ""
rodar
check "recusa só em IPv4 também vira nova passada" e_igual "$(passadas)" 2

echo "── 8. Nome de host: inexistente é configuração, falha temporária de DNS é conexão"
novo_caso host-inexistente
roteiro 1 'psql: error: could not translate host name "db.exemplo.errado" to address: Name or service not known' 2
roteiro 2 ""
rodar
check "host que não existe não é refeito (1 passada)" e_igual "$(passadas)" 1
check "  e devolve falha" e_igual "$(rc)" 1

# Quem isola o termo novo da regra é o caso de cima (host inexistente): a frase do
# psql traz "could not translate host name" nas DUAS falhas, então o caso abaixo
# sozinho ficaria verde com qualquer um dos dois termos na regra. Os dois formam o par.
novo_caso dns-temporario
roteiro 1 'psql: error: could not translate host name "db.exemplo" to address: Temporary failure in name resolution' 2
roteiro 2 ""
rodar
check "falha temporária de DNS vira nova passada" e_igual "$(passadas)" 2
check "  e, resolvida, devolve sucesso" e_igual "$(rc)" 0

echo "── 9. A listagem põe a disputa primeiro e conta o que ficou de fora"
novo_caso listagem
LISTA="$(for i in $(seq 1 15); do printf 'psql:/b.sql:%s: ERROR:  must be owner of table tabela_%s\n' "$i" "$i"; done; printf '%s\n' 'psql:/b.sql:16766: ERROR:  deadlock detected')"
roteiro 1 "$LISTA"
roteiro 2 ""
rodar
check "a linha do deadlock aparece na tela mesmo sendo a 16ª" grep -q "psql:/b.sql:16766: ERROR:  deadlock detected" "$WORK/tela"
check "  e a listagem diz quantas ficaram de fora" grep -q "(e mais 6 linhas)" "$WORK/tela"

if [ "$FAILS" -gt 0 ]; then printf '\n%d falha(s)\n' "$FAILS"; exit 1; fi
printf '\ntudo verde\n'
