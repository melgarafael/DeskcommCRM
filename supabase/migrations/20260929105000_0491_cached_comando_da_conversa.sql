-- ---- cached_comando: coluna materializada de comando_da_conversa (migration 0491) ----
--
-- ## O problema, medido em producao em 2026-09-29
--
-- ?comando_da_conversa=in.(aguardando,automatico) retornava HTTP 500 com
-- latencia consistente de ~8,5 s (statement_timeout do Postgres). Causa raiz:
--
--   * comando_da_conversa(conversations) e campo calculado PostgREST (funcao
--     de linha). Para filtrar, o banco avalia a funcao para CADA linha da org.
--
--   * A funcao chama dois subselects em contacts por linha:
--       coalesce((select ct.force_human from contacts where ct.id = c.contact_id), false)
--       coalesce((select ct.is_blocked  from contacts where ct.id = c.contact_id), false)
--     Com N conversas: 1 + 2N queries. Num tenant com ~400 conversas = 800+ subselects.
--
-- ## A solucao
--
-- 1. Coluna real cached_comando text em conversations, mantida por trigger.
-- 2. Indice direto (organization_id, cached_comando, last_message_at DESC).
-- 3. Trigger em contacts que recalcula cached_comando das conversas abertas
--    quando force_human ou is_blocked muda.
-- 4. O handler filtra por cached_comando (coluna com indice) em vez de
--    comando_da_conversa (campo calculado sem indice).
--
-- A funcao calculada comando_da_conversa(conversations) CONTINUA EXISTINDO
-- para retrocompatibilidade com MCP tools e consumidores externos.
--
-- Toda instrucao usa if not exists / create or replace / drop ... if exists.
-- Reaplicar em instalacao que ja tem a coluna e safe.

-- 1. Adiciona a coluna se nao existir
alter table public.conversations
  add column if not exists cached_comando text;

-- 2. Backfill usando fn_comando_da_conversa (IMMUTABLE)
update public.conversations c
set cached_comando = public.fn_comando_da_conversa(
  c.status,
  c.assigned_to_user_id,
  c.bot_silenced_until,
  coalesce((select ct.force_human from public.contacts ct where ct.id = c.contact_id), false),
  coalesce((select ct.is_blocked  from public.contacts ct where ct.id = c.contact_id), false),
  now()
)
where cached_comando is null;

-- 3. Indice principal: cobre filtro das abas Fila e Automatico, com ordenacao.
create index if not exists idx_conversations_cached_comando
  on public.conversations (organization_id, cached_comando, last_message_at desc nulls last);

-- Indice auxiliar para o trigger em contacts.
create index if not exists idx_conversations_contact_id_open
  on public.conversations (contact_id, organization_id)
  where status not in ('closed', 'archived', 'resolved')
    and assigned_to_user_id is null;

-- 4. Trigger em conversations: mantem cached_comando atualizado em INSERT/UPDATE.
create or replace function public.fn_sync_cached_comando()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_force_human boolean;
  v_is_blocked  boolean;
begin
  if tg_op = 'DELETE' then return old; end if;

  select
    coalesce(ct.force_human, false),
    coalesce(ct.is_blocked,  false)
  into v_force_human, v_is_blocked
  from public.contacts ct
  where ct.id = new.contact_id;

  new.cached_comando := public.fn_comando_da_conversa(
    new.status,
    new.assigned_to_user_id,
    new.bot_silenced_until,
    coalesce(v_force_human, false),
    coalesce(v_is_blocked,  false),
    now()
  );

  return new;
end;
$$;

drop trigger if exists trg_sync_cached_comando on public.conversations;
create trigger trg_sync_cached_comando
  before insert or update
  on public.conversations
  for each row
  execute function public.fn_sync_cached_comando();

-- 5. Trigger em contacts: propaga mudanca de force_human/is_blocked.
create or replace function public.fn_sync_cached_comando_via_contact()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if (old.force_human is not distinct from new.force_human)
    and (old.is_blocked is not distinct from new.is_blocked) then
    return new;
  end if;

  update public.conversations c
  set cached_comando = public.fn_comando_da_conversa(
    c.status,
    c.assigned_to_user_id,
    c.bot_silenced_until,
    coalesce(new.force_human, false),
    coalesce(new.is_blocked,  false),
    now()
  )
  where c.contact_id = new.id
    and c.assigned_to_user_id is null
    and c.status not in ('closed', 'archived', 'resolved');

  return new;
end;
$$;

drop trigger if exists trg_sync_cached_comando_via_contact on public.contacts;
create trigger trg_sync_cached_comando_via_contact
  after update of force_human, is_blocked
  on public.contacts
  for each row
  execute function public.fn_sync_cached_comando_via_contact();

-- 6. Revogacao (doutrina: funcao nova em public recebe revoke explicito).
revoke execute on function public.fn_sync_cached_comando() from public, anon, authenticated;
revoke execute on function public.fn_sync_cached_comando_via_contact() from public, anon, authenticated;
