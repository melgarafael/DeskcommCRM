-- manifest: Fila de entrada por número (ADR-0008, fatia 2; #5374, de @ThiagoBarbosa05). `channel_routing_policies.sector_id` (nullable, FK composta para `attendant_sectors`): a conversa nova do número nasce nessa fila, e a conversa ENCERRADA que o contato reabre (mesma linha, `fn_service_inbound`) entra nela quando está sem fila — só no INSERT, quem já é cliente nunca entraria. Com o módulo `setores` desligado o gatilho não grava nada (mesma leitura do claim). `fn_set_channel_routing_with_sector` grava a fila pela tela: exige admin (ou platform admin full), repete as guardas de `fn_set_channel_routing` e recusa setor de outra organização e fila sem atendente ativo. NULL = comportamento de hoje. Espelho no baseline em duas metades: coluna e funções antes da VARREDURA anon; FK e gatilho no fim. Gates: tests/invariants/setor-de-entrada-do-canal.test.ts.
alter table public.channel_routing_policies
  add column if not exists sector_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.channel_routing_policies'::regclass
       and conname = 'channel_routing_policies_sector_fkey'
  ) then
    alter table public.channel_routing_policies
      add constraint channel_routing_policies_sector_fkey
      foreign key (organization_id, sector_id)
      references public.attendant_sectors (organization_id, id)
      on delete set null (sector_id);
  end if;
end;
$$;

create or replace function public.fn_conversation_apply_channel_sector()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A guarda mora no corpo, não num WHEN do gatilho: um WHEN sobre
  -- `new.sector_id` prende a coluna ao gatilho e o `drop column` da 9062
  -- (fila-de-atendimento-destino.test.ts, upgrade) passa a ser recusado.
  if new.sector_id is not null or new.channel_session_id is null then
    return new;
  end if;
  -- A conversa é 1:1 por (organização, contato, número) e o contato que volta
  -- tem a MESMA linha reaberta por UPDATE (fn_service_inbound). Só no INSERT,
  -- quem já é cliente nunca entraria na fila. Na reabertura, a fila só é
  -- aplicada quando a conversa está sem fila: uma transferência anterior fica.
  if tg_op = 'UPDATE' and not (
    old.status in ('closed', 'resolved', 'archived')
    and new.status not in ('closed', 'resolved', 'archived')
  ) then
    return new;
  end if;
  -- Mesma leitura do claim (fn_channel_routing_claim): com o módulo desligado
  -- a fila não manda, e gravá-la seria deixar uma fila sem tela que a mostre.
  if not exists (
    select 1 from public.platform_config pc
     where pc.chave = 'MODULO_SETORES' and pc.valor = 'ligado'
  ) then
    return new;
  end if;
  select p.sector_id into new.sector_id
    from public.channel_routing_policies p
   where p.organization_id = new.organization_id
     and p.channel_session_id = new.channel_session_id
     and p.sector_id is not null;
  return new;
end;
$$;

revoke execute on function public.fn_conversation_apply_channel_sector() from public, anon, authenticated;
grant execute on function public.fn_conversation_apply_channel_sector() to service_role;

create or replace function public.fn_set_channel_routing_with_sector(
  p_org uuid, p_channel uuid, p_users uuid[], p_mode text,
  p_default_assignee uuid, p_sector uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  -- Definir a fila de entrada do número é gesto de admin (ADR-0008, "Quem
  -- pode o quê"). As demais guardas (suporte de escrita, MFA, canal e membros
  -- da organização) são as de fn_set_channel_routing, chamada logo abaixo.
  if auth.uid() is null
     or not (public.fn_role_at_least(p_org, 'admin') or public.fn_is_platform_admin_full()) then
    raise exception 'routing_forbidden' using errcode = '42501';
  end if;

  result := public.fn_set_channel_routing(
    p_org, p_channel, p_users, false, p_mode, p_default_assignee
  );

  if p_sector is not null then
    if not exists (
      select 1 from public.attendant_sectors
       where organization_id = p_org and id = p_sector
    ) then
      raise exception 'routing_invalid_sector' using errcode = '22023';
    end if;
    -- Fila sem atendente ativo não recebe a entrada do número (ADR-0008,
    -- risco "Fila sem membro"): toda conversa nova ficaria parada nela.
    if not exists (
      select 1 from public.attendant_sector_members m
        join public.user_organizations u
          on u.organization_id = m.organization_id and u.user_id = m.user_id
       where m.organization_id = p_org and m.sector_id = p_sector
         and u.revoked_at is null and u.role in ('agent', 'manager', 'admin')
    ) then
      raise exception 'routing_sector_without_members' using errcode = '22023';
    end if;
  end if;

  update public.channel_routing_policies
     set sector_id = p_sector
   where organization_id = p_org and channel_session_id = p_channel;

  return result || jsonb_build_object('sector_id', p_sector);
end;
$$;

revoke all on function public.fn_set_channel_routing_with_sector(uuid, uuid, uuid[], text, uuid, uuid) from public, anon;
grant execute on function public.fn_set_channel_routing_with_sector(uuid, uuid, uuid[], text, uuid, uuid) to authenticated;

drop trigger if exists trg_conversation_apply_channel_sector on public.conversations;
create trigger trg_conversation_apply_channel_sector
before insert or update of status on public.conversations
for each row
execute function public.fn_conversation_apply_channel_sector();
