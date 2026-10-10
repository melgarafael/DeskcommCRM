-- 0200 · O worker que empurra compromisso para o Google NUNCA empurrou nada.
--
-- ─── O sintoma, medido em produção ──────────────────────────────────────────
-- Log do contêiner de `crm.deskcomm.com.br`, a cada 5 minutos, desde o deploy
-- da v1.7.0:
--
--   {"level":"warn","msg":"[agenda-google-push] leitura falhou",
--    "error":"invalid input syntax for type timestamp with time zone:
--             \"google_synced_at\""}
--
-- ─── A causa ────────────────────────────────────────────────────────────────
-- `app/api/v1/cron/agenda-google-push/route.ts` pedia os pendentes assim:
--
--   .or("google_synced_at.is.null,updated_at.gt.google_synced_at")
--
-- O PostgREST trata o lado DIREITO de `gt.` como VALOR LITERAL, nunca como nome
-- de coluna: ele tenta converter a string "google_synced_at" em `timestamptz` e
-- recusa a consulta INTEIRA. Não é que a comparação dava errado — é que nenhuma
-- linha voltava, jamais. A ida ao Google nunca aconteceu em instalação nenhuma.
--
-- ─── Por que uma coluna gerada, e não uma RPC ───────────────────────────────
-- A pergunta "esta linha ainda precisa ir ao Google?" é DERIVADA de duas colunas
-- da própria linha. Derivado que alguém precisa lembrar de atualizar é derivado
-- que diverge — o mesmo argumento que já sustenta `contacts.wa_identity` e
-- `contacts.wa_lid` neste schema. A coluna gerada faz o PostgREST conseguir
-- filtrar (`.eq("needs_google_push", true)`) sem inventar RPC nova, que traria
-- de brinde a obrigação de revogar `execute` de `public` e de `anon`.
--
-- MEDIDO antes de escolher esta via, porque este repo já quebrou escrevendo em
-- coluna `GENERATED`: os 11 sítios que tocam `calendar_appointments` foram
-- lidos, e NENHUM faz upsert de linha inteira — todo `insert`/`update` nomeia
-- as colunas uma a uma. Ver `app/api/v1/agenda/agendamentos/_handler.ts:150`.
--
-- O nome é inglês (`needs_google_push`) porque o schema inteiro é: `wa_identity`,
-- `email_normalized`, `google_synced_at`. Comentário em português, identificador
-- em inglês — é a convenção em vigor neste arquivo.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️ DOIS RELÓGIOS — e é isto que faz o conserto ser DUAS coisas, não uma
-- ═══════════════════════════════════════════════════════════════════════════
-- A coluna gerada sozinha trocaria "nunca empurra" por "empurra para sempre", e
-- o segundo é PIOR: ele queima a cota da API do Google reenviando o mesmo evento
-- a cada 5 minutos, e ninguém vê, porque o log de sucesso parece saudável.
--
-- O motivo é que os dois lados da comparação vinham de relógios DIFERENTES:
--
--   `updated_at`       ← `fn_set_updated_at()`, um trigger, com `now()` do
--                         POSTGRES (o instante de início da transação);
--   `google_synced_at` ← `new Date().toISOString()` do NODE, calculado no worker
--                         ANTES de a requisição sair.
--
-- O do Node é sempre ANTERIOR — latência de rede e do PostgREST, mais qualquer
-- desvio de relógio entre o contêiner do app e o do banco. Então, logo depois de
-- uma sincronização bem-sucedida:
--
--   updated_at (banco, depois) > google_synced_at (app, antes)  →  TRUE
--
-- e a linha volta à fila na rodada seguinte. Para sempre.
--
-- ─── Por que um trigger, e não consertar o worker ───────────────────────────
-- Consertar a chamada resolveria UM sítio. O trigger resolve a CLASSE: a partir
-- daqui, quem quer que grave `google_synced_at` — este worker, uma rota futura,
-- um backfill à mão num psql — recebe o carimbo do BANCO, no mesmo `now()` da
-- transação que move o `updated_at`. Os dois lados passam a sair do mesmo
-- relógio, e a comparação vira exata em vez de provável.
--
-- Ele NÃO carimba quando o valor novo é `NULL`: gravar `google_synced_at = null`
-- é como se força uma re-sincronização de propósito, e transformar isso em
-- "agora" faria o produto ignorar um pedido explícito.

alter table public.calendar_appointments
  add column if not exists needs_google_push boolean
  generated always as (google_synced_at is null or updated_at > google_synced_at) stored;

comment on column public.calendar_appointments.needs_google_push is
  'Derivada: a linha ainda não foi ao Google, ou mudou depois da última ida. Existe porque o PostgREST não compara coluna com coluna — o filtro do worker de push é `.eq("needs_google_push", true)`.';

create or replace function public.fn_carimbar_ida_ao_google()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  -- `now()` e não `new.updated_at`: os dois são o instante de início da
  -- transação, então o valor é o mesmo — e usar `now()` remove a dependência de
  -- ORDEM entre este trigger e o de `updated_at` (triggers `before` disparam em
  -- ordem de NOME, que é uma amarra frágil demais para uma igualdade da qual
  -- depende o fim de um laço).
  if new.google_synced_at is not null
     and (tg_op = 'INSERT' or new.google_synced_at is distinct from old.google_synced_at) then
    new.google_synced_at := now();
  end if;
  return new;
end
$fn$;

revoke execute on function public.fn_carimbar_ida_ao_google() from public, anon, authenticated;
grant  execute on function public.fn_carimbar_ida_ao_google() to service_role;

drop trigger if exists trg_calendar_appointments_carimbo_do_google on public.calendar_appointments;
create trigger trg_calendar_appointments_carimbo_do_google
  before insert or update on public.calendar_appointments
  for each row execute function public.fn_carimbar_ida_ao_google();

-- O recorte exato do worker: pendentes, de quem tem dono, na ordem em que ele
-- lê. Parcial porque a esmagadora maioria das linhas de uma agenda madura já
-- foi sincronizada, e um índice cheio pagaria por elas em toda escrita.
create index if not exists calendar_appointments_pendente_no_google_idx
  on public.calendar_appointments (starts_at)
  where needs_google_push and owner_user_id is not null;
