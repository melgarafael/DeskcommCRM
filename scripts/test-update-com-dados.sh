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
# ## Como esta lacuna foi descoberta
#
# Por acidente, em 2026-08-27: para gerar `database.types.ts` de uma fonte fiel,
# alguém precisou aplicar o baseline atual num Supabase com dados. Deu exit 0 —
# o que é ótimo, e o problema é que ninguém sabia, porque ninguém tinha rodado.
#
# ## O que ele NÃO prova
#
# Não sobe um Supabase completo: usa `pgvector/pgvector:pg17` com o mesmo
# prelude de stubs do `scripts/test-db.sh`. O que faltava ao `test:db` eram os
# DADOS, não o `storage` — e trocar o container por um stack inteiro custaria
# minutos e brigaria por porta com quem estiver trabalhando.
# Se um dia a diferença virar o `storage`, este script precisa mudar de base.
#
# Uso:  bash scripts/test-update-com-dados.sh
# Requisito: Docker rodando. Não toca no seu banco nem nos seus contêineres.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/supabase/baseline.sql"
CONTAINER="deskcomm-update-dados-$$"
IMAGE="pgvector/pgvector:pg17"

[ -f "$BASELINE" ] || { echo "FATAL: $BASELINE não encontrado" >&2; exit 1; }

cleanup() { docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> subindo $IMAGE como $CONTAINER (porta escolhida pelo daemon)"
docker run -d --rm --name "$CONTAINER" -p "127.0.0.1::5432" \
  --label "deskcomm.harness=update-com-dados" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres "$IMAGE" >/dev/null

# `pg_isready` mente aqui: o initdb sobe um servidor temporário só em socket.
pronto=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    pronto=1; break
  fi
  sleep 1
done
[ "$pronto" = 1 ] || { echo "FATAL: postgres não subiu em 90s" >&2; exit 1; }

psql_stop() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f -; }

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

echo "==> UPDATE: re-aplicando baseline.sql SOBRE OS DADOS, com ON_ERROR_STOP=1"
psql_stop < "$BASELINE" >/dev/null
echo "    ✓ update ok — nenhuma constraint quebrou sobre dado existente"

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

echo "==> update-com-dados verde"
