#!/usr/bin/env bash
# test-update-com-dados.sh — o `update.sh` do cliente roda sobre um banco COM
# DADOS, e nada neste repo exercitava isso.
#
# ## O que este script prova, e por que nenhum outro prova
#
# `pnpm test:db` aplica o `baseline.sql` duas vezes num Postgres efêmero e
# VAZIO. Isso mede idempotência de DDL — e o próprio `CLAUDE.md` diz que não é a
# mesma coisa que idempotência de DDL SOBRE DADOS:
#
#   "pnpm test:db aplica o baseline num banco VAZIO. Ele mede idempotência de
#    DDL, não de DDL sobre dados. Constraint que só quebra com linha existente
#    NÃO é pega ali."
#
# O caminho real do cliente é outro: o `update.sh` re-aplica o `baseline.sql`
# num banco que já atende gente. Uma constraint nova que os dados dele violem,
# um `add column not null` sem default, um `drop column` sobre coluna
# preenchida — nada disso aparece no banco vazio, e tudo aparece no dele.
#
# Este script fecha essa lacuna: aplica o baseline (install), SEMEIA dados que
# exercitam as constraints, e re-aplica (update) com ON_ERROR_STOP=1.
#
# ⚠️ A flag na segunda passada é o ponto inteiro. O `update.sh` real roda SEM
# ela e filtra erro por texto — então lá um erro fora da lista passa despercebido.
# Aqui a flag transforma "re-aplicar terminou" em "re-aplicar não errou", que é
# a diferença que a issue #184 mediu (301 erros dentro de um verde).
#
# ## O ESTADO do objeto entre as duas passadas (issue #1086)
#
# Desde a #1086 ele também mede o estado de um objeto, e não só o texto do
# baseline: o `pg_class.oid` da view `calendar_selected_external_events`. O que a
# view tem na forma alvo (`create or replace view`) PRESERVA o OID; o `drop` +
# `create` que os blocos 0225/0261 faziam a cada passada trocava — o objeto era
# apagado e recriado a cada `update.sh`. A prova da ida (clone antigo, com
# `select e.*` e o `title`, continua migrando) mora aqui pelo mesmo motivo que a
# da volta: é o único lugar que re-aplica o arquivo inteiro sobre um banco que já
# tem objeto e dado.
#
# ## Como esta lacuna foi descoberta
#
# Por acidente, em 2026-08-27: para gerar `database.types.ts` de uma fonte fiel,
# alguém precisou aplicar o baseline atual num Supabase com dados. Deu exit 0 —
# o que é ótimo, e o problema é que ninguém sabia, porque ninguém tinha rodado.
#
# ## O que ele NÃO prova
#
# Não sobe um Supabase completo: usa o `pgvector/pgvector` na major do piso,
# com o mesmo prelude de stubs do `scripts/test-db.sh`. O que faltava ao
# `test:db` eram os DADOS, não o `storage` — e trocar o container por um stack
# inteiro custaria minutos e brigaria por porta com quem estiver trabalhando.
# Se um dia a diferença virar o `storage`, este script precisa mudar de base.
#
# ## Quem chama
#
# O job `invariants` do CI (`pnpm test:db:update`), nas DUAS majors da matriz
# (pg15 e pg17) — a variável de major é a mesma dos dois scripts.
#
# Uso:  pnpm test:db:update          (= bash scripts/test-update-com-dados.sh)
#       TEST_DB_IMAGE=pgvector/pgvector:pg17 pnpm test:db:update   # outra major
# Requisito: Docker rodando. Não toca no seu banco nem nos seus contêineres.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/supabase/baseline.sql"
CONTAINER="deskcomm-update-dados-$$"
# A major, pelo mesmo mecanismo do `scripts/test-db.sh` (o comentário longo
# está lá): quem PEDE escolhe, quem não pede fica no PISO. Assim o mesmo script
# serve às duas pontas — a versão que prometemos suportar (pg15, padrão) e a que
# gerou o `pg_dump` do baseline (pg17, o que a matriz do CI passa).
IMAGE="${TEST_DB_IMAGE:-pgvector/pgvector:pg15}"

[ -f "$BASELINE" ] || { echo "FATAL: $BASELINE não encontrado" >&2; exit 1; }

cleanup() { docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> subindo $IMAGE como $CONTAINER (porta escolhida pelo daemon)"
docker run -d --rm --name "$CONTAINER" -p "127.0.0.1::5432" \
  --label "deskcomm.harness=update-com-dados" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres "$IMAGE" >/dev/null

# `pg_isready` e `psql` sem `-h` mentem aqui: o initdb sobe um servidor
# temporário que atende pelo socket local e depois o derruba antes de subir o
# definitivo. Forçar `-h 127.0.0.1` faz o libpq usar TCP; esse servidor
# temporário não escuta TCP, então só damos o banco por pronto quando o servidor
# definitivo já está aceitando conexões. Mantemos o cliente dentro do próprio
# contêiner para o único requisito do harness continuar sendo Docker.
pronto=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    pronto=1; break
  fi
  sleep 1
done
[ "$pronto" = 1 ] || { echo "FATAL: postgres não subiu em 90s" >&2; exit 1; }

psql_stop() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f -; }

# ── instrumentos da view de ocupação (issue #1086) ───────────────────────────
# Os três leem o ESTADO do banco, e é isso que os faz valer: `create or replace
# view` preserva `pg_class.oid`, `drop` + `create` troca. Sem OID medido, "a view
# não foi recriada" seria relato sobre o texto do baseline, não prova.
oid_da_view() {
  docker exec "$CONTAINER" psql -U postgres -d postgres -tAc "
    select c.oid from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'calendar_selected_external_events';"
}

colunas_da_view() {
  docker exec "$CONTAINER" psql -U postgres -d postgres -tAc "
    select coalesce(string_agg(a.attname, ',' order by a.attnum), '(view ausente)')
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'calendar_selected_external_events'
       and a.attnum > 0 and not a.attisdropped;"
}

# A view expõe a coluna `title`? É o que separa a forma antiga (`select e.*`, da
# v1.26.0) da forma alvo, e o que a guarda de forma dos blocos 0225/0261 lê para
# decidir se derruba. Vírgula nos dois lados: casa a coluna inteira, não pedaço de
# nome.
tem_title() {
  case ",$(colunas_da_view)," in
    *,title,*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "==> prelude (os stubs que um Postgres cru não tem)"
# Extraído do scripts/test-db.sh em vez de duplicado: prelude que diverge do
# harness mediria um mundo que o gate obrigatório não conhece.
prelude=$(sed -n "/^psql_install <<'SQL'$/,/^SQL$/p" "$ROOT/scripts/test-db.sh" | sed '1d;$d')
# Guarda de instrumento: se a extração falhar (o test-db.sh muda de forma), o
# prelude sai VAZIO e o install falha longe daqui, com um erro que não menciona
# prelude nenhum. Aconteceu ao escrever este script: o regex sem o apóstrofo
# final extraiu zero linhas e o sintoma foi `type public.vector does not exist`.
if [ "$(grep -c 'create extension' <<<"$prelude")" -lt 3 ]; then
  echo "FATAL: a extração do prelude de scripts/test-db.sh falhou (sem 'create extension')." >&2
  echo "       O formato daquele arquivo mudou — conserte o recorte aqui, e não duplique o prelude." >&2
  exit 1
fi
psql_stop <<<"$prelude"
echo "    ✓ prelude ok ($(wc -l <<<"$prelude" | tr -d ' ') linhas, extraídas do harness)"

echo "==> INSTALL: baseline.sql com ON_ERROR_STOP=1"
psql_stop < "$BASELINE" >/dev/null
echo "    ✓ install ok"

echo "==> SEMEANDO DADOS — é isto que o test:db não faz"
psql_stop <<'SQL' >/dev/null
insert into auth.users (id, email) values
  ('11111111-0000-4000-8000-000000000001', 'dono@update-com-dados.test'),
  ('11111111-0000-4000-8000-000000000002', 'atendente@update-com-dados.test')
  on conflict (id) do nothing;

insert into public.organizations (id, slug, legal_name, display_name) values
  ('22222222-0000-4000-8000-00000000000a', 'update-dados-a', 'Update Dados A', 'A'),
  ('22222222-0000-4000-8000-00000000000b', 'update-dados-b', 'Update Dados B', 'B')
  on conflict (id) do nothing;

insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
  ('11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-00000000000a', 'admin', now()),
  ('11111111-0000-4000-8000-000000000002', '22222222-0000-4000-8000-00000000000a', 'agent', now())
  on conflict do nothing;

insert into public.contacts (id, organization_id, name) values
  ('33333333-0000-4000-8000-000000000001', '22222222-0000-4000-8000-00000000000a', 'Maria Silva')
  on conflict (id) do nothing;

-- Agenda: linhas em TODAS as tabelas com CHECK de vocabulário, para o update
-- encontrar dado onde as constraints moram.
insert into public.calendar_appointments
  (organization_id, contact_id, owner_user_id, title, notes,
   starts_at, ends_at, status, created_by_kind, source)
values
  ('22222222-0000-4000-8000-00000000000a', '33333333-0000-4000-8000-000000000001',
   '11111111-0000-4000-8000-000000000002', 'Consulta', 'anotação',
   now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed', 'user', 'ui')
on conflict do nothing;

insert into public.calendar_availability_exceptions
  (organization_id, user_id, exception_date, reason)
values ('22222222-0000-4000-8000-00000000000a', '11111111-0000-4000-8000-000000000002',
        current_date + 5, 'feriado')
on conflict do nothing;

insert into public.calendar_connections
  (organization_id, user_id, account_email, status)
values ('22222222-0000-4000-8000-00000000000a', '11111111-0000-4000-8000-000000000002',
        'agenda@update-com-dados.test', 'healthy')
on conflict do nothing;
SQL
linhas=$(docker exec "$CONTAINER" psql -U postgres -d postgres -tAc "
  select (select count(*) from public.organizations)
       + (select count(*) from public.contacts)
       + (select count(*) from public.calendar_appointments)
       + (select count(*) from public.calendar_event_types);")
echo "    ✓ $linhas linhas semeadas (event_types vêm do trigger da 0185)"

# Guarda de vacuidade: um seed que falhasse em silêncio faria o passo seguinte
# medir exatamente o que o test:db já mede — um banco vazio.
[ "${linhas:-0}" -ge 5 ] || {
  echo "FATAL: o seed não produziu dado suficiente ($linhas). Sem dados, este script" >&2
  echo "       vira uma cópia cara do test:db e passa verde sem medir nada novo." >&2
  exit 1
}

# A IDENTIDADE DO QUE JÁ ESTAVA CERTO (issue #1041).
#
# "A re-aplicação não errou e não perdeu dado" não diz se ela REFEZ trabalho.
# Um bloco que derruba e recria uma coluna gerada reescreve a tabela inteira sob
# trava exclusiva, com o app no ar, e termina no mesmo estado: as duas checagens
# acima continuam verdes. O que denuncia o trabalho refeito é o catálogo:
#
#   - reescrita de tabela troca o `relfilenode`;
#   - coluna derrubada e recriada gasta um número de coluna (`attnum`) que não
#     volta, e o Postgres conta coluna apagada no teto de 1600;
#   - índice, constraint ou view derrubados e recriados ganham OID novo.
#
# Nada disso depende do volume de dados, então a sonda vale no banco pequeno
# daqui.
#
# ⚠️ É uma LISTA FIXA dos objetos que a #1041 guardou, não uma varredura do
# arquivo: um bloco novo que derrube e recrie algo fora desta lista nasce
# invisível aqui, e o verde não afirma nada sobre ele. O apêndice ainda tem
# outros pares "derruba e recria" — dezenas de CHECK e FK (que revalidam sem
# reescrever a tabela), policies e gatilhos. (A view
# `calendar_selected_external_events` tem sonda própria neste script, a da
# issue #1086.) Para virar catraca, esta sonda teria de varrer o catálogo
# inteiro, e não é o que ela faz.
identidade() {
  docker exec "$CONTAINER" psql -U postgres -d postgres -tA -c "
    with alvo(item, rel) as (values
      ('índice idx_followup_enrollments_one_live',           'public.idx_followup_enrollments_one_live'),
      ('índice calendar_appointments_google_evento_key',     'public.calendar_appointments_google_evento_key'),
      ('índice calendar_appointments_pendente_no_google_idx','public.calendar_appointments_pendente_no_google_idx'),
      ('view calendar_google_reconcilable_appointments',     'public.calendar_google_reconcilable_appointments'))
    select item || '=' || coalesce(to_regclass(rel)::oid::text, 'AUSENTE') from alvo
    union all
    select 'constraint calendar_external_events_periodo_valido=' || coalesce((
      select oid::text from pg_constraint
       where conname = 'calendar_external_events_periodo_valido'
         and conrelid = 'public.calendar_external_events'::regclass), 'AUSENTE')
    union all
    select 'arquivo da tabela calendar_appointments=' || relfilenode
      from pg_class where oid = 'public.calendar_appointments'::regclass
    union all
    select 'colunas já numeradas em ' || c.relname || '=' || max(a.attnum)
      from pg_attribute a join pg_class c on c.oid = a.attrelid
     where a.attrelid in ('public.calendar_appointments'::regclass, 'public.user_organizations'::regclass)
     group by c.relname
    order by 1;"
}
identidade_antes=$(identidade)
# Guarda de vacuidade: um objeto que não existisse antes compararia AUSENTE com
# AUSENTE e passaria verde sem medir nada.
if grep -q 'AUSENTE' <<<"$identidade_antes"; then
  echo "FATAL: a sonda de identidade não achou um dos objetos que ela vigia:" >&2
  grep 'AUSENTE' <<<"$identidade_antes" >&2
  echo "       Renomearam ou removeram o objeto? Atualize a lista em identidade()." >&2
  exit 1
fi
[ "$(wc -l <<<"$identidade_antes" | tr -d ' ')" -eq 8 ] || {
  echo "FATAL: a sonda de identidade devolveu $(wc -l <<<"$identidade_antes" | tr -d ' ') itens, e não 8." >&2
  exit 1
}

echo "==> UPDATE: re-aplicando baseline.sql SOBRE OS DADOS, com ON_ERROR_STOP=1"
# O OID é lido ANTES da passada que o aceite da issue #1086 mede: este banco já
# está no estado final (o install acabou de rodar), então a view não pode ser
# derrubada nem recriada daqui em diante.
oid_antes=$(oid_da_view)
[ -n "$oid_antes" ] || {
  echo "FATAL: a view calendar_selected_external_events não existe depois do install." >&2
  echo "       Sem ela, este passo mediria o vazio — o install é o controle dele." >&2
  exit 1
}
psql_stop < "$BASELINE" >/dev/null
echo "    ✓ update ok — nenhuma constraint quebrou sobre dado existente"

echo "==> a view de ocupação não pode ser derrubada nem recriada pelo update (issue #1086)"
oid_depois=$(oid_da_view)
if [ "$oid_antes" != "$oid_depois" ]; then
  echo "FATAL: o update trocou o OID da view de ocupação ($oid_antes -> $oid_depois):" >&2
  echo "       ela foi derrubada e recriada. 'create or replace view' preserva o OID," >&2
  echo "       'drop' mais 'create' não — é a guarda de forma dos blocos 0225/0261 do" >&2
  echo "       baseline que impede isso, e a issue #1086 é essa." >&2
  exit 1
fi
if tem_title; then
  echo "FATAL: a view de ocupação expõe a coluna title depois do update." >&2
  echo "       Ela nasce da lista explícita dos blocos 0225/0261, sem title; com ele," >&2
  echo "       o texto do compromisso pessoal do Google volta ao alcance do membro." >&2
  exit 1
fi
echo "    ✓ OID $oid_depois, igual antes e depois — a view não foi tocada"

echo "==> conferindo que o dado SOBREVIVEU à re-aplicação"
depois=$(docker exec "$CONTAINER" psql -U postgres -d postgres -tAc "
  select (select count(*) from public.organizations)
       + (select count(*) from public.contacts)
       + (select count(*) from public.calendar_appointments)
       + (select count(*) from public.calendar_event_types);")
if [ "$depois" != "$linhas" ]; then
  echo "FATAL: a re-aplicação MUDOU a contagem de linhas ($linhas -> $depois)." >&2
  echo "       O baseline deve ser aditivo sobre banco existente; algo apagou ou duplicou." >&2
  exit 1
fi
echo "    ✓ $depois linhas, iguais antes e depois"

echo "==> conferindo que a re-aplicação não REFEZ o que já estava certo (issue #1041)"
identidade_depois=$(identidade)
if [ "$identidade_depois" != "$identidade_antes" ]; then
  echo "FATAL: a re-aplicação refez trabalho num banco que já estava no estado final:" >&2
  diff <(printf '%s\n' "$identidade_antes") <(printf '%s\n' "$identidade_depois") \
    | sed -n 's/^> /       depois: /p; s/^< /       antes:  /p' >&2
  echo "       Cada linha acima é um bloco do baseline que derruba e recria sem conferir" >&2
  echo "       se o banco já está como ele quer. Guarde o bloco num 'do \$\$' que só age" >&2
  echo "       quando o catálogo difere do alvo." >&2
  exit 1
fi
echo "    ✓ $(wc -l <<<"$identidade_depois" | tr -d ' ') objetos com a mesma identidade antes e depois"

echo "==> clone antigo: a view da v1.26.0 (select e.*, com title) tem de continuar migrando"
# O estado da v1.26.0, no banco: a view com `e.*`. É o ÚNICO caminho em que a
# guarda derruba a view — de propósito, e uma vez só. Sem ela, `create or replace
# view` sobre essa forma responde `cannot drop columns from view` e o update do
# cliente PARA.
#
# Montado à mão em vez de re-aplicar um baseline antigo: o que a guarda lê é a
# FORMA da view, e é a forma que esta sonda monta. O resto do banco já está no
# estado final, que é o pior caso para ela (só a view destoa).
psql_stop <<'SQL' >/dev/null
drop view public.calendar_selected_external_events;
create view public.calendar_selected_external_events with (security_invoker = true) as
  select e.* from public.calendar_external_events e
   where e.status <> 'cancelled'
     and public.fn_google_counts_for_conflicts(e.organization_id, e.connection_id, e.external_calendar_id);
SQL

# Controle positivo: sem o `title` esta sonda mediria uma view que JÁ estava na
# forma alvo, e o passo abaixo passaria verde sem exercitar a guarda nenhuma vez.
if ! tem_title; then
  echo "FATAL: a view do clone de teste não expõe a coluna title." >&2
  echo "       Ela não é a forma antiga, então este passo não mede migração nenhuma." >&2
  exit 1
fi

oid_antes=$(oid_da_view)
if ! psql_stop < "$BASELINE" >/dev/null; then
  echo "FATAL: o update sobre o clone antigo FALHOU. O clone que ainda tem a view com" >&2
  echo "       title não sai do lugar sem a guarda de forma dos blocos 0225/0261 —" >&2
  echo "       é a migração da issue #1086 que quebrou, não o update em geral." >&2
  exit 1
fi
if tem_title; then
  echo "FATAL: o update deixou a view do clone com a coluna title: passou sem migrar." >&2
  exit 1
fi
oid_migrado=$(oid_da_view)
if [ "$oid_antes" = "$oid_migrado" ]; then
  echo "FATAL: o update não tocou a view do clone antigo (OID $oid_antes nos dois lados)." >&2
  echo "       A guarda não derrubou a forma antiga, e ela precisa cair UMA vez." >&2
  exit 1
fi
echo "    ✓ clone antigo migrou: OID $oid_antes -> $oid_migrado, sem o title"

echo "==> e, migrada, a passada seguinte não pode mexer nela outra vez (issue #1086)"
oid_antes="$oid_migrado"
psql_stop < "$BASELINE" >/dev/null
oid_depois=$(oid_da_view)
if [ "$oid_antes" != "$oid_depois" ]; then
  echo "FATAL: depois de migrar, a passada seguinte derrubou a view de novo" >&2
  echo "       ($oid_antes -> $oid_depois). A guarda tem de agir uma vez só: o que ela" >&2
  echo "       deixou no banco é a forma alvo, e a forma alvo não se derruba." >&2
  exit 1
fi
echo "    ✓ OID $oid_depois, estável na passada seguinte"

echo "==> update-com-dados verde"
