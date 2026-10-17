-- manifest: **Rodízio de atendentes na ação "Atribuir a um atendente" das Automações (issue #2041, substitui o PR #2269 de @hamiltonviana).** A ação `assign_owner` ganha o modo `{ modo: "rodizio", fila: [{ user_id, pausado }] }`. Quem escolhe a pessoa da vez é a função nova `fn_automation_rodizio_atribuir(p_org, p_rule, p_lead, p_event)`: numa transação só, ela trava por regra (`pg_advisory_xact_lock`), lê a fila da própria regra em `automation_rules`, escolhe o próximo elegível (na fila, não pausado, membro não revogado, não `viewer`), grava a linha no histórico append-only `automation_rodizio_atribuicoes` e faz o UPDATE do dono em `crm_leads` — o UPDATE é o que emite `lead.assigned` (o push). O histórico guarda o `event_id` com índice único por (organização, regra, evento): o mesmo evento reprocessado (worker derrubado antes de marcar o consumo) devolve a mesma pessoa e não anda a fila. Leitura do histórico por organização; escrita só pela função (`service_role`). Aditiva e idempotente; apêndice igual no `baseline.sql`.
-- ============================================================================
-- 0692 — RODÍZIO DE ATENDENTES NA AÇÃO "ATRIBUIR A UM ATENDENTE" (#2041)
--
-- O lead de formulário nasce SEM conversa, então o rodízio de conversas
-- (`channel_routing_policies`) nunca chega até ele. O diagnóstico, a trava e o
-- histórico são do PR #2269 (@hamiltonviana); o que mudou é ONDE o rodízio
-- mora: em vez de grupos, regras e um gatilho próprios em `crm_leads`, ele é um
-- modo da ação que já existe nas Automações — a tela, a auditoria da regra e a
-- aba Atividade já vêm prontas.
--
-- POR QUE UMA FUNÇÃO SÓ. A ação chama por RPC, e cada RPC é uma transação: a
-- trava solta no fim da chamada. Se a função só escolhesse e o registro de quem
-- foi a vez ficasse no TypeScript, dois `lead.created` simultâneos leriam o
-- mesmo "último" e iriam para a mesma pessoa. Então trava, escolha, registro e
-- UPDATE do dono acontecem aqui dentro, na mesma transação.
--
-- A FILA VEM DA REGRA, não de quem chama: a função lê `automation_rules.actions`
-- pelo `p_rule` DENTRO de `p_org`. Uma regra tem no máximo um rodízio, e só
-- como ação direta (o schema recusa o resto), então a fila é a do primeiro
-- `assign_owner` em modo rodízio da lista.
--
-- "QUEM FOI O ÚLTIMO" É CALCULADO do histórico: a linha mais nova da regra. A
-- posição (1 = primeiro da fila) fica NO histórico, então tirar da fila quem
-- recebeu por último não faz o rodízio recomeçar do início. Atribuição manual
-- no meio não desloca o rodízio: só entra no histórico o que o rodízio decidiu.
--
-- ELEGÍVEL = está na fila, não está pausado, é membro da organização com
-- `revoked_at is null` e papel agent/manager/admin — a mesma régua da ação
-- `assign_owner` no modo fixo e de `fn_conversation_assign`.
--
-- O PUSH. O dono entra por UPDATE, que passa por `trg_emit_event_on_lead_change`
-- e emite `lead.assigned`. Mesmo raciocínio do #2269.
--
-- `user_id` do histórico não tem FK de propósito: é o registro de uma decisão
-- passada, e apagar a pessoa não pode reescrever o ponteiro do rodízio.
-- `lead_id` vira nulo quando o lead é apagado pelo mesmo motivo.
-- ============================================================================

create table if not exists public.automation_rodizio_atribuicoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  rule_id uuid not null references public.automation_rules (id) on delete cascade,
  lead_id uuid references public.crm_leads (id) on delete set null,
  user_id uuid not null,
  member_position integer not null check (member_position >= 1),
  -- clock_timestamp() e não now(): now() é o início da TRANSAÇÃO, igual para
  -- duas atribuições na mesma, e o "último" da regra sai desta ordenação.
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists automation_rodizio_atribuicoes_ultimo_da_regra_idx
  on public.automation_rodizio_atribuicoes (rule_id, created_at desc, id desc);
create index if not exists automation_rodizio_atribuicoes_org_idx
  on public.automation_rodizio_atribuicoes (organization_id, created_at desc);

-- O MESMO EVENTO NÃO ANDA A FILA DUAS VEZES. O dreno marca o evento como
-- consumido só DEPOIS de os handlers voltarem (`lib/event-log/drain.ts`): um
-- worker derrubado entre esta função e essa marca deixa o evento `processing`,
-- e o reaper o devolve à fila em 10 min — a regra roda de novo. Sem a chave
-- do evento, a segunda volta andava uma casa e trocava o dono. Sem FK para
-- `event_log` pelo mesmo motivo de `user_id`: a retenção apaga eventos, e o
-- histórico do rodízio não pode perder a linha por isso.
alter table public.automation_rodizio_atribuicoes add column if not exists event_id uuid;
create unique index if not exists automation_rodizio_atribuicoes_um_por_evento_idx
  on public.automation_rodizio_atribuicoes (organization_id, rule_id, event_id)
  where event_id is not null;

alter table public.automation_rodizio_atribuicoes enable row level security;

-- Leitura por quem é da organização; ninguém grava pela API (só a função).
drop policy if exists tenant_isolation_automation_rodizio_atribuicoes_select on public.automation_rodizio_atribuicoes;
create policy tenant_isolation_automation_rodizio_atribuicoes_select on public.automation_rodizio_atribuicoes
  for select using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

revoke all on public.automation_rodizio_atribuicoes from anon, authenticated;
grant select on public.automation_rodizio_atribuicoes to authenticated;
grant all on public.automation_rodizio_atribuicoes to service_role;

comment on table public.automation_rodizio_atribuicoes is
  'Histórico append-only do rodízio da ação assign_owner (#2041): quem recebeu cada lead e em que posição da fila. O próximo da regra é calculado da linha mais nova. Escrito só por fn_automation_rodizio_atribuir.';

-- A assinatura ganhou `p_event`; a de três argumentos sairia ambígua ao lado.
drop function if exists public.fn_automation_rodizio_atribuir(uuid, uuid, uuid);

create or replace function public.fn_automation_rodizio_atribuir(p_org uuid, p_rule uuid, p_lead uuid, p_event uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_fila jsonb;
  v_ultima integer;
  v_ultimo_user uuid;
  v_corte integer;
  v_user uuid;
  v_posicao integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('automation_rodizio:' || p_rule::text, 2041));

  -- Reexecução do MESMO evento: devolve a decisão já tomada, sem linha nova e
  -- sem andar a fila. Não regrava o dono: a linha e o UPDATE commitaram juntos,
  -- então a linha existir prova que o dono foi gravado — regravar só desfaria
  -- uma troca manual feita depois e dispararia outro `lead.assigned`.
  if p_event is not null then
    select h.user_id, h.member_position
      into v_user, v_posicao
      from public.automation_rodizio_atribuicoes h
     where h.organization_id = p_org and h.rule_id = p_rule and h.event_id = p_event;
    if found then
      return jsonb_build_object('user_id', v_user, 'posicao', v_posicao);
    end if;
  end if;

  select a.valor -> 'config' -> 'fila'
    into v_fila
    from public.automation_rules r
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(r.actions) = 'array' then r.actions else '[]'::jsonb end
         ) with ordinality as a(valor, ordem)
   where r.id = p_rule
     and r.organization_id = p_org
     and a.valor ->> 'type' = 'assign_owner'
     and a.valor -> 'config' ->> 'modo' = 'rodizio'
   order by a.ordem
   limit 1;

  if v_fila is null or jsonb_typeof(v_fila) <> 'array' then
    return jsonb_build_object('motivo', 'sem_rodizio');
  end if;
  if jsonb_array_length(v_fila) = 0 then
    return jsonb_build_object('motivo', 'fila_vazia');
  end if;
  if not exists (select 1 from public.crm_leads l where l.id = p_lead and l.organization_id = p_org) then
    return jsonb_build_object('motivo', 'lead_nao_encontrado');
  end if;

  select h.member_position, h.user_id
    into v_ultima, v_ultimo_user
    from public.automation_rodizio_atribuicoes h
   where h.rule_id = p_rule and h.organization_id = p_org
   order by h.created_at desc, h.id desc
   limit 1;

  -- O corte é a posição ATUAL de quem recebeu por último. Se essa pessoa saiu
  -- da fila, quem vinha depois dela desceu uma casa: o corte é a posição
  -- gravada menos um, e o rodízio segue em quem vinha depois, sem recomeçar.
  select f.ordem::integer
    into v_corte
    from jsonb_array_elements(v_fila) with ordinality as f(valor, ordem)
   where f.valor ->> 'user_id' = v_ultimo_user::text
   order by f.ordem
   limit 1;
  v_corte := coalesce(v_corte, v_ultima - 1);

  select uo.user_id, f.ordem::integer
    into v_user, v_posicao
    from jsonb_array_elements(v_fila) with ordinality as f(valor, ordem)
    join public.user_organizations uo
      on uo.user_id = (f.valor ->> 'user_id')::uuid
     and uo.organization_id = p_org
     and uo.revoked_at is null
     and uo.role in ('agent', 'manager', 'admin')
   where f.valor -> 'pausado' is distinct from 'true'::jsonb
   order by case when v_corte is null or f.ordem > v_corte then 0 else 1 end, f.ordem
   limit 1;

  if v_user is null then
    return jsonb_build_object('motivo', 'ninguem_disponivel');
  end if;

  insert into public.automation_rodizio_atribuicoes (organization_id, rule_id, lead_id, user_id, member_position, event_id)
  values (p_org, p_rule, p_lead, v_user, v_posicao, p_event);

  update public.crm_leads
     set owner_user_id = v_user,
         owner_agent_id = null,
         owner_kind = 'user',
         assigned_at = now(),
         updated_at = now()
   where id = p_lead
     and organization_id = p_org;

  return jsonb_build_object('user_id', v_user, 'posicao', v_posicao);
end;
$function$;

revoke all on function public.fn_automation_rodizio_atribuir(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_automation_rodizio_atribuir(uuid, uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';
