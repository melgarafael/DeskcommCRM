#!/usr/bin/env bash
# Restaura o banco a partir de um dump gerado pelo backup.sh.
# Só restaura num banco VAZIO: num banco que já tem as tabelas do sistema ele
# para antes, sem alterar nada (#2120) — ver a checagem abaixo.
#
# ⚠ O dump do backup.sh sai SEM --clean: não traz DROP/TRUNCATE nem IF NOT
# EXISTS, e ele traz os schemas internos (auth, storage, realtime, vault) e
# extensões como pg_net — então "already exists" e "extension is not
# available" aparecem também num banco VAZIO. Por isso a checagem abaixo é a
# que decide: se public já tem tabelas, paramos ANTES do psql com mensagem
# própria (#2120), em vez de dizer "✓ banco restaurado" sobre ~2.800 erros.
#
# As flags `-v ON_ERROR_STOP=1 --single-transaction` saíram daqui por medição
# do mantenedor em 03/10: elas fazem o restore falhar também em banco vazio
# (rc=3, 0 tabelas) em Supabase novo, Postgres 17 puro e database nova — o
# caminho que hoje funciona deixaria de funcionar. Sem elas, o psql avisa e
# segue, saindo 0 também quando NÃO restaurou (#2381: 2.887 `permission
# denied` e o script imprimia "✓ banco restaurado"). Por isso o veredito não é
# o rc do psql — e, desde a reescrita pedida pelo mantenedor em 16/10, também
# não é a leitura dos erros impressos: é a CONFERÊNCIA DO RESULTADO,
# logo abaixo, contra os blocos COPY do próprio dump. A conexão é a MESMA da
# atualização (url_do_restore → url_do_schema, #2381): o dono esperado.
#
#   bash hostgator-setup-kit/restore.sh backups/db-20260702-030000.sql.gz
source "$(dirname "$0")/_common.sh"
enter_project

DUMP="${1:-}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || die "Uso: restore.sh <arquivo-db-*.sql.gz>"

# Confira os arquivos ANTES de escrever no banco ou limpar um volume. Descobrir
# um .tgz cortado só no `tar xzf` já teria apagado as sessões/anexos anteriores;
# e, com o banco restaurado, a guarda de banco vazio impediria repetir o script.
# `gzip -t` percorre também o CRC: listar nomes no tar não basta para isso.
WAHA_TAR="${DUMP/db-/waha-}"
WAHA_TAR="${WAHA_TAR%.sql.gz}.tgz"
STORAGE_TAR="$(dirname "$DUMP")/storage-$(basename "$DUMP" .sql.gz | sed 's/^db-//').tgz"

conferir_snapshot() {
  [ -f "$1" ] || return 0
  # O GNU tar pode aceitar um gzip de texto curto como se fosse um tar vazio.
  # Descompactar fora dele e listar o stdin faz o mesmo conteúdo ser recusado.
  # Drene o padding depois do fim do tar: sem isso o gunzip pode receber SIGPIPE
  # e o pipefail recusaria também um tar íntegro com blocos de preenchimento.
  if ! gzip -t "$1" 2>/dev/null || ! gunzip -c "$1" 2>/dev/null | (
    rc_tar=0
    tar tf - >/dev/null 2>&1 || rc_tar=$?
    cat >/dev/null || exit 1
    exit "$rc_tar"
  ); then
    die "O snapshot $1 está corrompido, incompleto ou não é um tar.gz válido: nada foi restaurado nem apagado. Recupere uma cópia íntegra do backup antes de tentar de novo."
  fi
}

if ! gzip -t "$DUMP" 2>/dev/null; then
  die "O dump $DUMP está corrompido ou incompleto: nada foi restaurado nem apagado. Recupere uma cópia íntegra do backup antes de tentar de novo."
fi
conferir_snapshot "$WAHA_TAR"
if [ "${SINGLE_SERVER:-0}" = "1" ]; then
  conferir_snapshot "$STORAGE_TAR"
fi

c_ylw "⚠ Isto vai restaurar o backup no banco em $NEXT_PUBLIC_SUPABASE_URL (só se ele estiver vazio)."
c_ylw "⚠ O dump do backup.sh sai SEM --clean: ele não restaura por cima de um banco que já tem o schema."
c_ylw "   Ele também traz auth, storage e extensões — os erros de \"already exists\" aparecem até em banco novo."

# #2120: checagem ANTES de pedir a confirmação. Se o banco já tem o schema,
# não adianta chamar o psql (o dump não tem --clean, então ele só gritaria),
# então paramos aqui com a mensagem certa. A contagem é medida em public — é
# onde o dump do backup.sh despeja as tabelas do produto. Os "already exists"
# de auth/storage e a extensão pg_net não entram nessa conta: são internas e
# existem até em banco recém-criado.
# A contagem NÃO pode comer o stdin: o `restore.sh` pede a confirmação logo
# abaixo, e quem chama alimenta tudo com printf 'RESTAURAR\n' | restore.sh.
# A contagem e o restore usam a MESMA conexão (url_do_restore → url_do_schema,
# #2381): a conta do dono, a mesma que a atualização usa — conferir com uma role
# e restaurar com outra mediria um banco que não é o do restore.
if tabela="$(pg_container -i postgres:17-alpine psql "$(url_do_restore)" \
      -tAc "select count(*) from pg_tables where schemaname='public'" \
      </dev/null 2>/dev/null)"; then
  # Falhar fechado também quando a conexão "deu certo" e a resposta não é um
  # número (vazio, aviso no stdout): sem saber a contagem, não restauramos.
  case "$tabela" in ''|*[!0-9]*)
    die "Não consegui conferir se o banco em $NEXT_PUBLIC_SUPABASE_URL está vazio (a contagem voltou [$tabela]): nada foi alterado." ;;
  esac
  if [ "$tabela" -gt 0 ]; then
    die "O banco em $NEXT_PUBLIC_SUPABASE_URL já tem as tabelas do sistema ($tabela em public): nada foi alterado. Este backup só volta num banco vazio — por exemplo, um projeto Supabase novo em que o instalador ainda não rodou. Veja \"Restaurar um backup\" em hostgator-setup-kit/README.md, ou peça ajuda."
  fi
else
  die "Não consegui conferir se o banco em $NEXT_PUBLIC_SUPABASE_URL está vazio: nada foi alterado."
fi

read -r -p "Digite 'RESTAURAR' para confirmar: " a
[ "$a" = "RESTAURAR" ] || die "Cancelado."

step "Restaurando $DUMP"
# Sem `-v ON_ERROR_STOP=1 --single-transaction` (medição do mantenedor em
# 03/10): com elas o restore falha também em banco VAZIO — Supabase novo,
# Postgres 17 puro e database nova deram rc=3 e 0 tabelas; sem elas, nos dois
# primeiros, o mesmo dump entrou com rc=0 e 110 tabelas. O dump traz auth, storage e
# extensões que já existem num Supabase novo, então o erro é normal ali. Quem
# segura o banco populado é a checagem de cima; aqui o psql avisa, segue e sai
# 0. Em falha fatal (conexão, disco) o banco pode ficar incompleto — sem a
# transação única não há rollback, por isso o aviso abaixo não promete mais
# que nada.
#
# #2381: psql SEM ON_ERROR_STOP sai rc=0 MESMO com erro, e foi isso que fez um
# dump que não restaurou NENHUMA linha terminar em "✓ banco restaurado" e
# exit 0 (2.887 linhas `permission denied`, single-server: a conexão era a do
# `postgres`, que não é dono de auth/storage/realtime). As flags continuam
# fora por medição; quem decide agora é o VEREDITO logo abaixo, sobre a saída
# INTEIRA do psql — capturada num log que segue aparecendo na tela (tee).
psql_log="$(mktemp "${TMPDIR:-/tmp}/restore-psql.XXXXXX")" \
  || die "Não consegui criar o arquivo temporário do log em ${TMPDIR:-/tmp} (disco cheio?): nada foi restaurado."
rc_restore=0
gunzip -c "$DUMP" | pg_container -i postgres:17-alpine psql "$(url_do_restore)" 2>&1 \
  | tee "$psql_log" || rc_restore=$?

if [ "$rc_restore" -ne 0 ]; then
  rm -f "$psql_log"
  die "Falha na restauração (psql saiu com $rc_restore) — o dump NÃO restaurou. Confira o log acima e o estado do banco antes de repetir."
fi

# ── O VEREDITO É A CONFERÊNCIA DO RESULTADO (#2381, reescrita de 16/10) ─────
#
# A lista de erros "tolerados" saiu daqui, e quem a derrubou foi a MEDIÇÃO: os
# erros inofensivos mudam com o papel e com a versão do Postgres. No mesmo
# restore que voltou com as 189 tabelas de public, o usuário em auth.users, a
# organização e a FK (medição do mantenedor de 07/10, em `supabase/postgres`
# 15.8 e 17.6, pela role supabase_admin), o psql imprime também
# `multiple primary keys for table ... are not allowed` e `duplicate key value
# violates unique constraint "schema_migrations_pkey"` — dois erros dos
# schemas internos que NÃO custam uma linha sequer de public, e que nenhuma
# lista de tolerados cobre. Com a lista decidindo, aquele restore que
# FUNCIONOU terminava em die (falso negativo).
#
# Quem decide agora é o RESULTADO: o que o dump DECLARA carregar (as contagens
# dos blocos COPY de public e de auth.users) contra o que o banco realmente
# tem ao fim do psql. O veredito só sai quando a conferência fecha, e o que não
# fechar aparece NOMEADO — (tabela, esperado, obtido) — no relatório abaixo.
#
# O caminho de erro do psql continua FALHANDO ALTO e antes de tudo isto: exit
# code ≠ 0 morre no `die` logo acima. O que mudou é só o caminho dos erros que
# o psql IMPRIME sem derrubar o exit code — eles continuam na tela (o `tee`),
# mas não decidem mais o veredito.
#
# Nada aqui depende de ferramenta que o kit não tenha: psql (o mesmo
# pg_container de sempre), awk/grep/sed e gunzip, os mesmos do backup.sh.
conf_dir="$(mktemp -d "${TMPDIR:-/tmp}/restore-conf.XXXXXX")" \
  || die "Não consegui criar o diretório temporário da conferência em ${TMPDIR:-/tmp} (disco cheio?): o dump pode ter entrado, mas NADA foi conferido."

# 1. O ESPERADO: as contagens que os blocos COPY do dump declaram. Só public e
#    auth.users entram: os outros schemas do dump (auth, storage, realtime,
#    vault) são internos do Supabase e já vêm prontos num banco novo — contar
#    linha deles mediria o Supabase, não o produto. O nome da tabela vem
#    entre aspas quando o identificador exige, e é desaspeado aqui.
if ! gunzip -c "$DUMP" 2>/dev/null | awk '
      !dentro && /^COPY / {
        resto = substr($0, 6)
        fim = index(resto, " (")
        nome = fim ? substr(resto, 1, fim - 1) : resto
        gsub(/"/, "", nome)
        dentro = 0
        if (nome ~ /^public\./ || nome == "auth.users") { alvo = nome; n = 0; dentro = 1 }
        next
      }
      dentro && /^\\\.$/ { printf "%s|%d\n", alvo, n; dentro = 0; next }
      dentro { n++ }
    ' > "$conf_dir/esperado"; then
  rm -rf "$conf_dir" "$psql_log"
  die "Não consegui ler o dump ($DUMP) para conferir o resultado: arquivo cortado ou corrompido. NADA foi considerado restaurado."
fi

# Dump sem nenhum COPY de public/auth.users não tem como ser conferido — e um
# backup sem as tabelas do produto não é um backup (o backup.sh despeja pela
# conexão de schema justamente para isso não acontecer). Falha FECHADO: na
# dúvida, não se anuncia ✓.
if [ ! -s "$conf_dir/esperado" ]; then
  rm -rf "$conf_dir" "$psql_log"
  die "O dump ($DUMP) não declara nenhum COPY de public nem de auth.users: não há o que conferir, e um backup sem as tabelas do produto não é um backup. NADA foi considerado restaurado."
fi

# 2. O QUE O BANCO TEM: as tabelas de public e auth que existem ao fim do
#    psql. É esta lista que diz o que FALTOU — uma tabela do dump que não
#    aparece aqui não voltou.
if ! pg_container postgres:17-alpine psql "$(url_do_restore)" -tA \
      -c "/*conf-tabelas*/ select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','auth') and c.relkind in ('r','p') order by 1" \
      </dev/null > "$conf_dir/existentes" 2>"$conf_dir/tabelas.err"; then
  cat "$conf_dir/tabelas.err" >&2 2>/dev/null || true
  rm -rf "$conf_dir" "$psql_log"
  die "Não consegui conferir o resultado: a consulta das tabelas do banco falhou. NADA foi considerado restaurado."
fi

# 3. As LINHAS de cada tabela que existe nos dois lados — uma única consulta
#    `union all`, montada aqui com o nome vindo do próprio banco (por isso
#    não há "relation does not exist" no meio, que abortaria a contagem
#    inteira). Identificadores vão entre aspas, para nome com maiúscula,
#    espaço ou hífen não virar outra tabela.
query_linhas="$(awk -F'|' -v aspa="$(printf '\047')" -v existentes_arq="$conf_dir/existentes" '
  FILENAME == existentes_arq { existe[$1] = 1; next }
  ($1 in existe) {
    ponto = index($1, ".")
    esquema = substr($1, 1, ponto - 1)
    tabela = substr($1, ponto + 1)
    gsub(/"/, "\"\"", esquema)
    gsub(/"/, "\"\"", tabela)
    printf "%sselect %s%s%s as t, count(*) as n from \"%s\".\"%s\"", \
      (montado++ ? " union all " : ""), aspa, $1, aspa, esquema, tabela
  }
' "$conf_dir/existentes" "$conf_dir/esperado")"

: > "$conf_dir/obtido"
if [ -n "$query_linhas" ]; then
  if ! pg_container postgres:17-alpine psql "$(url_do_restore)" -tA -F'|' \
        -c "/*conf-linhas*/ $query_linhas" </dev/null > "$conf_dir/obtido" 2>"$conf_dir/linhas.err"; then
    cat "$conf_dir/linhas.err" >&2 2>/dev/null || true
    rm -rf "$conf_dir" "$psql_log"
    die "Não consegui conferir o resultado: a contagem de linhas por tabela falhou. NADA foi considerado restaurado."
  fi
fi

# 4. A CONFERÊNCIA: tabela a tabela, esperado (COPY do dump) × obtido (banco).
#    FALTA = o dump declara a tabela e ela não está no banco; DIFERENTE =
#    está, com outra contagem. Os dois saem nomeados, com esperado e obtido.
relatorio="$(awk -F'|' -v esperado_arq="$conf_dir/esperado" '
  FILENAME == esperado_arq {
    if (!($1 in obtido))
      printf "    | FALTA %s (esperado %s linha(s), obtido: tabela ausente no banco)\n", $1, $2
    else if (obtido[$1] != $2)
      printf "    | DIFERENTE %s (esperado %s linha(s), obtido %s)\n", $1, $2, obtido[$1]
    next
  }
  { obtido[$1] = $2 }
' "$conf_dir/obtido" "$conf_dir/esperado")"

if [ -n "$relatorio" ]; then
  printf '%s\n' "$relatorio"
  # O motivo mais comum de a conferência não fechar é escrita recusada — e o
  # que se pode fazer com isso depende de ONDE o banco mora. Num Supabase
  # próprio (single-server) o dono dos schemas internos é a role
  # supabase_admin, e o kit tem essa credencial no `.env` do Supabase; num
  # Supabase GERENCIADO ela não existe para o operador, e pedir por ela é
  # pedir o que ele não tem.
  if grep -qiE 'permission denied|must be owner|is not the owner|no (pg_hba|password)|authentication failed' "$psql_log" 2>/dev/null; then
    if [ "${SINGLE_SERVER:-0}" = "1" ]; then
      c_ylw "    ⚠ O banco recusou escrita: no Supabase quem é dono de auth, storage e realtime é a role supabase_admin. Neste Supabase PRÓPRIO você tem essa credencial — declare SUPABASE_DB_ADMIN_URL no .env com a connection string do dono e rode de novo."
    else
      c_ylw "    ⚠ O banco recusou parte da escrita. Num Supabase GERENCIADO não existe — e não é preciso — uma conexão de supabase_admin: quem escreve é a role dona do projeto, a da senha de banco do painel, que é a mesma que já está em SUPABASE_DB_URL. Confira a senha do projeto e rode de novo; se o que faltou foi só o schema interno (auth/storage), o produto não depende dele para subir."
    fi
  fi
  qtd_fora="$(printf '%s\n' "$relatorio" | grep -c . || true)"
  rm -rf "$conf_dir"; rm -f "$psql_log"
  die "O dump NÃO restaurou: a conferência do resultado acusou $qtd_fora tabela(s) fora do que os COPY do dump declaram (acima). NADA foi considerado restaurado: o banco está incompleto, e repetir não conserta sozinho."
fi

# Passou: o psql pode ter IMPRESSO o que quiser (o dump sem --clean grita em
# banco novo, e o supabase_admin grita "multiple primary keys"), mas o que o
# dump declara está no banco, linha a linha. O número de erros vira aviso, não
# veredito.
erros_impressos="$(grep -cE '^(ERROR|FATAL|PANIC):' "$psql_log" 2>/dev/null || true)"
tabelas_conferidas="$(grep -c . "$conf_dir/esperado" || true)"
linhas_conferidas="$(awk -F'|' '{ t += $2 } END { printf "%d", t + 0 }' "$conf_dir/esperado")"
rm -rf "$conf_dir"; rm -f "$psql_log"
if [ "${erros_impressos:-0}" -gt 0 ]; then
  c_dim "  (o psql imprimiu $erros_impressos erro(s) acima — nenhum deles custou uma linha: quem decide o veredito é a conferência do resultado)"
fi
c_grn "✓ banco restaurado — $tabelas_conferidas tabela(s) de public/auth.users conferidas contra os COPY do dump ($linhas_conferidas linha(s))"

# Restaura o estado das sessões do WhatsApp (WAHA) se o snapshot emparelhado existir
if [ -f "$WAHA_TAR" ]; then
  step "Restaurando sessões do WhatsApp de $WAHA_TAR"
  vol="$(volume_waha_data)"
  WAHA_DIR="$(cd "$(dirname "$WAHA_TAR")" && pwd)"
  WAHA_FILE="$(basename "$WAHA_TAR")"
  docker run --rm -v "${vol}:/data" -v "${WAHA_DIR}:/in:ro" alpine:3.20 \
    sh -c "rm -rf /data/* && tar xzf /in/${WAHA_FILE} -C /data" \
    && c_grn "✓ sessões do WhatsApp restauradas" \
    || die "Falha ao restaurar sessões do WhatsApp. O banco JÁ foi restaurado; as sessões podem estar incompletas. Confira o volume antes de reiniciar o app — repetir este script não restaura por cima do banco."
fi

# Single-server: os anexos voltam junto com o banco (ver backup.sh).
if [ "${SINGLE_SERVER:-0}" = "1" ]; then
  if [ -f "$STORAGE_TAR" ]; then
    step "Restaurando os arquivos anexados de $STORAGE_TAR"
    docker run --rm -v "$(dir_do_supabase)/volumes/storage:/data" \
      -v "$(cd "$(dirname "$STORAGE_TAR")" && pwd):/in:ro" alpine:3.20 \
      sh -c "find /data -mindepth 1 -delete && tar xzf /in/$(basename "$STORAGE_TAR") -C /data" \
      && c_grn "✓ anexos restaurados" \
      || die "Falha ao restaurar os anexos. O banco JÁ foi restaurado; os anexos podem estar incompletos. Confira o Storage antes de reiniciar o app — repetir este script não restaura por cima do banco."
  else
    c_ylw "⚠ Não achei $(basename "$STORAGE_TAR") ao lado do dump: o banco voltou, os ANEXOS não."
  fi
fi

c_ylw "Reinicie o app: docker compose $(dc_files) restart app"
