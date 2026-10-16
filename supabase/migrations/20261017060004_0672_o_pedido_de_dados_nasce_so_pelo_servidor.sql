-- manifest: **O pedido de dados LGPD nasce e anda só pelo caminho do servidor, e o da Nuvemshop espera a aprovação (doc 134, opção A).** O webhook `customer/data_request` (`app/api/v1/webhooks/nuvemshop/customer-data-request/route.ts`) passa a só criar o pedido em `received`; a exportação é disparada pela aprovação (`app/api/v1/lgpd/requests/[id]/approve/route.ts`), e o worker (`workers/lgpd-export-worker.ts`) só exporta evento que traga a marca da aprovação (`manually_approved` + `approved_by`). Este arquivo endurece o banco na mesma direção: (1) `lgpd.data_request_received` e `lgpd.redact_received` passam a nascer só sem sessão de usuário — um gatilho `before insert` em `event_log` recusa com 42501 (`reserved_server_event`) quando `auth.uid()` não é nulo, o que alcança `emit_event`, `fn_log_event` e qualquer outro caminho até a tabela; é gatilho e não a lista de tipos reservados de `emit_event` porque a função está sendo redefinida em outro PR em voo, e duas redefinições paralelas apagam a linha uma da outra no merge sem conflito no git; (2) `insert`, `update`, `delete` e `truncate` em `lgpd_requests` saem de `anon` e `authenticated` — leitura pela RLS continua igual, e toda escrita do produto já era pela chave de serviço (`lib/lgpd/repository.ts`, os workers e as rotas). Mesmo bloco, letra a letra, no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon. Gates: `tests/invariants/pedido-de-dados-nasce-so-pelo-servidor.test.ts` (viewer e admin não emitem os dois tipos nem gravam em `lgpd_requests`; o servidor emite e grava; tipo comum segue livre; migration e apêndice iguais) e `workers/lgpd-export-worker.test.ts` (o pedido da Nuvemshop não é enviado antes da aprovação e é enviado depois).

-- 0672: o pedido de dados nasce e anda só pelo caminho do servidor (doc 134).
--
-- O bloco abaixo é o MESMO, letra a letra, no apêndice de `supabase/baseline.sql`
-- — é ele que o `update.sh` reaplica a cada atualização.

-- ---- o pedido de dados nasce só pelo caminho do servidor (migration 0672) ----
-- A exportação de dados do titular só começa pela aprovação de alguém da
-- equipe, na tela do pedido; a anonimização, pelo webhook assinado ou pela
-- mesma aprovação. Os dois eventos que acordam esses workers são, então, fatos
-- do SERVIDOR (chave de serviço, sem sessão), nunca um pedido de login. O
-- gatilho fica em `event_log`, e não na lista de `emit_event`, para valer em
-- todo caminho até a tabela. O `when` mantém o custo fora das demais inserções.
--
-- A escrita em `lgpd_requests` é do servidor pela mesma razão: o pedido nasce
-- do webhook (`lib/lgpd/repository.ts`) e muda de estado pelos workers e pela
-- aprovação. A leitura pela sessão continua como está (RLS).

create or replace function public.fn_event_log_lgpd_so_do_servidor()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
begin
  if new.event_type in ('lgpd.data_request_received', 'lgpd.redact_received')
     and auth.uid() is not null then
    raise exception 'reserved_server_event' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke all on function public.fn_event_log_lgpd_so_do_servidor() from public, anon, authenticated;
grant execute on function public.fn_event_log_lgpd_so_do_servidor() to service_role;

drop trigger if exists trg_event_log_lgpd_so_do_servidor on public.event_log;
create trigger trg_event_log_lgpd_so_do_servidor
  before insert on public.event_log
  for each row
  when (new.event_type in ('lgpd.data_request_received', 'lgpd.redact_received'))
  execute function public.fn_event_log_lgpd_so_do_servidor();

revoke insert, update, delete, truncate on table public.lgpd_requests from anon, authenticated;
