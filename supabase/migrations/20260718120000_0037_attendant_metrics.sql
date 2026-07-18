-- 0037_attendant_metrics — G4-04: métricas por responsável (spec 13 §6).
-- Filtro por atendente no funil + performance individual (manager+). Definições
-- congeladas na spec 13 §6 ANTES deste código.
--
-- Estratégia de escopo (o gate é a RLS, não uma checagem paralela): a agregação
-- é uma função SQL **SECURITY INVOKER** (default) — as policies de crm_leads
-- (0036, fn_can_view_lead) e conversations (0035, fn_can_view_conversation) se
-- aplicam DENTRO da função. agent agregando ⇒ RLS colapsa aos próprios; manager+
-- ⇒ org-wide + filtro opcional por owner/assignee (p_owner). Nunca cross-tenant:
-- organization_id = p_org (resolvido de fonte confiável na rota, nunca do body).
--
-- Índices (spec 13 §6.7): os existentes não cobrem won/lost por owner nem a
-- agregação org-wide de conversas por assignee. Parciais mantêm o índice pequeno.
-- EXPLAIN sob role agent/manager (RLS ativa muda o plano) prova ausência de seq
-- scan — no verification de G4-04.
--
-- Idempotente (create index if not exists / create or replace), portável em psql
-- puro (sem BEGIN/COMMIT, sem temp tables).

-- §6.3/§6.4 — leads ganhos/perdidos por owner na janela de closed_at.
create index if not exists idx_crm_leads_org_status_closed_owner
  on public.crm_leads (organization_id, status, closed_at, owner_user_id)
  where closed_at is not null;

-- §6.5/§6.6 — conversas por assignee (org-leading, para a agregação org-wide).
create index if not exists idx_conversations_org_assignee_assigned
  on public.conversations (organization_id, assigned_to_user_id, assigned_at)
  where assigned_to_user_id is not null;

-- Agregação única (funil + performance por atendente) → jsonb. SECURITY INVOKER:
-- a RLS das tabelas define o escopo. stable (só lê). Janela semiaberta [from,to).
create or replace function public.fn_attendant_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  -- §6.3/§6.4: won/lost por owner (janela em closed_at).
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (where status = 'lost') as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  -- §6.5: conversas atendidas por assignee (janela em assigned_at).
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
    group by assigned_to_user_id
  ),
  -- §6.6: tempo até 1ª resposta HUMANA por assignee (janela em t1). Bot excluído
  -- por sent_by_user_id is not null. Descarta conversa iniciada pelo atendente
  -- (t1 <= t0) e sem par inbound/outbound humano.
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fr.first_in is not null
      and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
  )
  select jsonb_build_object(
    -- §6.2: funil por stage (snapshot, sem janela; filtro opcional por owner).
    'funnel', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stage_id', s.id,
          'stage_name', s.name,
          'position', s.position,
          'count', coalesce(l.cnt, 0)
        ) order by s.position, s.name
      )
      from public.crm_stages s
      left join (
        select stage_id, count(*) as cnt
        from public.crm_leads
        where organization_id = p_org
          and status = 'open'
          and (p_owner is null or owner_user_id = p_owner)
        group by stage_id
      ) l on l.stage_id = s.id
      where s.organization_id = p_org
        and s.is_archived = false
    ), '[]'::jsonb),
    -- §6.3–§6.6: uma linha por atendente (RLS já escopou os dados).
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid) from public;
revoke execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid) from anon;
grant execute on function public.fn_attendant_metrics(uuid, timestamptz, timestamptz, uuid)
  to authenticated, service_role;
