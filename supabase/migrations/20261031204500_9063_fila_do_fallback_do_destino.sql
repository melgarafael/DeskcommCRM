-- manifest: **Fila do rodízio no FALLBACK do destino dinâmico da ação "Atribuir a um atendente" (issue #3804).** O modo novo `{ modo: "destino", destinos, fallback }` pode cair no rodízio quando o negócio não tem responsável e o contato não tem dono de carteira. A função do rodízio (#2041) já faz tudo o que esse caso precisa — trava por regra, histórico da vez e UPDATE do dono na mesma transação —, mas ela só achava a fila em `config.fila` do modo `rodizio`. Esta migration ensina a MESMA função a ler também `config.fallback.fila` (quando `config.fallback.modo = 'rodizio'`): nada de um segundo rodízio, um segundo histórico ou uma segunda régua de elegibilidade. `create or replace` com a assinatura de sempre (4 argumentos, `p_event` com default), sem tocar em tabela, coluna ou política; aditiva e idempotente (install e update do `baseline.sql` passam iguais).

-- ============================================================================
-- 9063 — A FILA DO RODÍZIO NO FALLBACK DO DESTINO DINÂMICO (#3804)
--
-- O QUE MUDA, e só isso: a leitura da fila dentro de
-- `fn_automation_rodizio_atribuir`. Antes, `config.fila` e nada mais. Agora,
-- `coalesce(config.fila, config.fallback.fila)` e o WHERE aceita as duas formas.
--
-- POR QUE NA FUNÇÃO, e não na ação: a escolha da pessoa, o registro da vez e o
-- UPDATE do dono do negócio acontecem na MESMA transação, com
-- `pg_advisory_xact_lock` por regra. Fazer o fallback em TypeScript seria abrir
-- um segundo caminho para a mesma decisão — exatamente o "inventar uma terceira
-- régua de dono" que custou a #3479.
--
-- POR QUE `coalesce`: o modo `rodizio` de sempre continua com a fila em
-- `config.fila`; o fallback guarda a dele em `config.fallback.fila`. As duas não
-- convivem na mesma ação (o schema recusa dois rodízios por regra), então a
-- primeira chave presente é A fila.
-- ============================================================================

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

  -- A FILA do rodízio mora em DOIS lugares desde a #3804: no modo `rodizio` de
  -- sempre (`config.fila`) e no `fallback` do destino dinâmico
  -- (`config.fallback.fila`, com `config.fallback.modo = 'rodizio'`). A vez é a
  -- MESMA — um histórico por regra, um `pg_advisory_xact_lock` por regra —, e por
  -- isso as duas formas caem nesta leitura em vez de num rodízio paralelo.
  -- `coalesce` e não dois SELECTs: quando a ação é o modo `rodizio` de sempre, a
  -- fila é a dele; o schema recusa as duas formas na mesma regra (um rodízio por
  -- regra), então não há ambiguidade a resolver aqui.
  select coalesce(a.valor -> 'config' -> 'fila', a.valor -> 'config' -> 'fallback' -> 'fila')
    into v_fila
    from public.automation_rules r
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(r.actions) = 'array' then r.actions else '[]'::jsonb end
         ) with ordinality as a(valor, ordem)
   where r.id = p_rule
     and r.organization_id = p_org
     and a.valor ->> 'type' = 'assign_owner'
     and (a.valor -> 'config' ->> 'modo' = 'rodizio'
          or a.valor -> 'config' -> 'fallback' ->> 'modo' = 'rodizio')
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
