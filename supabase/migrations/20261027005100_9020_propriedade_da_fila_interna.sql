-- manifest: A fila aceita gravação só de produtores internos; sessões mantêm leitura e comandos humanos delimitados, sem fabricar snapshots no enqueue.
-- 9020 — propriedade da fila interna, sem mudar as transições de produto.
--
-- O cliente de sessão lê status; aprovar resposta e autorizar entrega continuam
-- pelas RPCs SECURITY DEFINER já existentes, com os seus próprios guards.
-- Service role e a role dedicada do worker conservam os grants próprios.
-- Não altera policies, estados, índices, cron ou funções de negócio existentes.
-- A coluna nova começa NULL em todo legado. A antiga chave no payload NÃO é
-- origem autorizada e não é copiada nem limpa por reaplicação do baseline.

alter table public.job_queue
  add column if not exists catalog_presentation_snapshot jsonb;
comment on column public.job_queue.catalog_presentation_snapshot is
  'Estado dedicado da apresentação do catálogo com a identidade original da operação. Sem backfill do payload legado. Produzido por UPDATE interno sob o lease do job; não é input de enqueue.';

revoke all on table public.job_queue from public, anon, authenticated;
grant select on table public.job_queue to authenticated;
grant select, insert, update, delete on table public.job_queue to service_role;

-- Snapshot de execução não é input de enqueue, nem quando o enqueue vem do
-- scheduler. O produtor legítimo congela o snapshot depois do claim por UPDATE
-- do mesmo job running sob lease. JSON com a chave presente, mesmo null, recusa.
create or replace function public.fn_job_snapshot_interno_no_enqueue()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $f$
begin
  if new.payload ? 'catalog_presentation_snapshot'
     or new.catalog_presentation_snapshot is not null then
    raise exception 'job_snapshot_internal' using errcode = '42501';
  end if;
  return new;
end;
$f$;

-- Só o trigger usa esta função; nenhuma porta RPC ou grant novo de execução.
revoke all on function public.fn_job_snapshot_interno_no_enqueue()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_job_snapshot_interno_no_enqueue on public.job_queue;
create trigger trg_job_snapshot_interno_no_enqueue
  before insert on public.job_queue
  for each row execute function public.fn_job_snapshot_interno_no_enqueue();

-- O vínculo já existente é job_queue.contact_id → contacts.id (ON DELETE
-- CASCADE). Anonimizar não apaga a linha: a virada limpa SÓ o novo estado,
-- na org/contato da linha original, preservando status/IDs/lease e o vizinho.
create or replace function public.fn_limpar_snapshot_catalogo_ao_anonimizar()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $f$
begin
  update public.job_queue
     set catalog_presentation_snapshot = null
   where organization_id = old.organization_id
     and contact_id = old.id
     and catalog_presentation_snapshot is not null;
  return new;
end;
$f$;

-- Sem parâmetros e sem RPC: usa a identidade OLD da linha que foi anonimizada.
revoke all on function public.fn_limpar_snapshot_catalogo_ao_anonimizar()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_limpar_snapshot_catalogo_ao_anonimizar on public.contacts;
create trigger trg_limpar_snapshot_catalogo_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row when (new.is_anonymized and not old.is_anonymized)
  execute function public.fn_limpar_snapshot_catalogo_ao_anonimizar();
