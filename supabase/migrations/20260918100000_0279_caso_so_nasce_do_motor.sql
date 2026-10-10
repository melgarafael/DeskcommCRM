-- ════════════════════════════════════════════════════════════════════════════
-- 0279 — O caso só nasce do motor.
--
-- Três tabelas nasceram graváveis por QUALQUER membro, pelas DUAS origens:
--   (A) o GRANT: `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO
--       "authenticated"` (supabase/baseline.sql:4727) vale para toda tabela
--       criada DEPOIS dele — e as três são de apêndice, criadas depois;
--   (B) a POLICY: `for all` / `for insert` sem papel mínimo.
--
-- Tratar só uma deixa o furo aberto: o revoke sozinho não sobrevive a um grant
-- futuro, e a policy sozinha faz o UPDATE casar 0 linhas e o PostgREST devolver
-- SUCESSO. As duas, na mesma migration.
--
-- Para reconferir as origens sem acreditar nesta prosa:
--   grep -n 'ALTER DEFAULT PRIVILEGES .* ON TABLES TO "authenticated"' supabase/baseline.sql
--   grep -nE 'policy .*(agent_cases|agent_case_events|cae_insert)' supabase/baseline.sql
--
-- ── O que se pagaria ────────────────────────────────────────────────────────
-- `agent_cases` guarda o título, o resumo e o bloqueio que a IA escreveu sobre
-- o atendimento de uma pessoa — o texto que a equipe lê para decidir. Um
-- `viewer` da própria organização escrevia essa linha falando direto com o
-- PostgREST, com o JWT dele. E um INSERT forjado em
-- `conversation_assignment_events` faz o histórico de dono da conversa dizer
-- que alguém assumiu um atendimento que ninguém assumiu.
--
-- ── Nenhum caminho legítimo escreve por `authenticated` (censo medido) ──────
--   · agent_cases / agent_case_events → `pg.Pool` em
--     lib/agent-engine/agent/human-cases.ts (inserts em :183, :193, :247, :297,
--     :324, :352, :383, :432; `db: pg.Pool` em :166, :236), e o admin client
--     (service role) em app/api/v1/cron/case-stale-watcher/route.ts:77,:156.
--   · conversation_assignment_events → o INSERT é feito DENTRO de
--     public.fn_conversation_assign, que é `security definer` e executa com o
--     privilégio do DONO. É por ela que passam as rotas de claim, transfer e
--     release (app/api/v1/conversations/[id]/{claim,release,transfer}/route.ts),
--     todas com o client de SESSÃO — e é por isso que elas continuam
--     funcionando depois deste revoke (controle positivo do invariante).
--   · o reset da "Zona de perigo" (lib/settings/apagar-dados-operacionais.ts)
--     apaga `conversations`; as três tabelas somem por CASCADE, que roda como o
--     dono da tabela e não como quem apagou.
-- Refeito por: rg -n "agent_cases|agent_case_events|conversation_assignment_events" app lib hooks components workers scripts
--
-- SELECT continua aberto nas três: a tela, o MCP e o motor leem.
-- Vigiado por tests/invariants/caso-so-nasce-do-motor.test.ts.
-- ════════════════════════════════════════════════════════════════════════════

-- ── agent_cases ─────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate on public.agent_cases from authenticated, anon;
drop policy if exists tenant_isolation_agent_cases_all    on public.agent_cases;
drop policy if exists tenant_isolation_agent_cases_select on public.agent_cases;
create policy tenant_isolation_agent_cases_select on public.agent_cases
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

-- ── agent_case_events ───────────────────────────────────────────────────────
revoke insert, update, delete, truncate on public.agent_case_events from authenticated, anon;
drop policy if exists tenant_isolation_agent_case_events_insert on public.agent_case_events;
-- A policy de SELECT (`tenant_isolation_agent_case_events_select`) fica como está.

-- ── conversation_assignment_events ──────────────────────────────────────────
revoke insert, update, delete, truncate on public.conversation_assignment_events
  from authenticated, anon;
drop policy if exists cae_insert on public.conversation_assignment_events;
-- `cae_select` (que desde a 0173 herda o escopo da conversa) fica como está.

-- ── emit_event: reservar os eventos de caso ─────────────────────────────────
-- ⚠️ O CORPO ABAIXO É O VIGENTE, DERIVADO — não redigitado. A definição que vale
--    é a de MAIOR número de linha no baseline (há cinco lá, e a última vence):
--      grep -nEi 'create (or replace )?function ("public"\.|public\.)?"?emit_event"?' supabase/baseline.sql | tail -1
--    Copiar a errada reintroduz comportamento revogado — foi o que a 0224 fez
--    com `fn_service_event_origin` (ver o cabeçalho de
--    tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts). A ÚNICA
--    mudança em relação ao corpo vigente é a lista de tipos reservados.
--
--    A reserva SOZINHA não fecha nada: ela só barra quem tem `auth.uid()`, e
--    quem fecha a forja da LINHA é o revoke acima. As duas na mesma migration.
-- Estende o produtor permitido mantendo a origem imutável da 0223.
CREATE OR REPLACE FUNCTION public.emit_event(p_event_type text, p_entity_kind text, p_entity_id uuid, p_payload jsonb DEFAULT '{}'::jsonb, p_metadata jsonb DEFAULT '{}'::jsonb, p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_contact uuid;
  v_origin jsonb;
begin
  -- message.received nasce somente do INSERT inbound interno. Um chamador
  -- público não pode reapresentar uma mensagem existente como evento novo.
  -- `ai.case_opened`/`ai.case_closed` entram pela mesma razão (0279): o caso é
  -- do motor, e um evento de caso forjado por login move o funil e acorda o
  -- agente em nome de uma decisão que ninguém tomou.
  if auth.uid() is not null and p_event_type in (
    'message.received','appointment.outcome_confirmed',
    'ai.case_opened','ai.case_closed'
  ) then
    raise exception 'reserved_message_received' using errcode='42501';
  end if;
  -- Estes campos autorizam efeitos operacionais; não são payload público.
  if auth.uid() is not null and (
    coalesce(p_payload,'{}'::jsonb) ?| array['service_origin','service_boundary']
    or coalesce(p_metadata,'{}'::jsonb) ?| array['service_origin','service_boundary']
  ) then raise exception 'reserved_service_origin' using errcode='42501'; end if;
  v_org_id := coalesce(p_organization_id, (public.fn_support_context()->>'organization_id')::uuid);
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  if auth.uid() is not null
     and not public.fn_role_at_least(v_org_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'emit_event: caller must be an active member of the organization';
  end if;

  if not public.fn_support_write_allowed(v_org_id) then raise exception 'support_readonly' using errcode='42501'; end if;

  -- A ORIGEM E RESERVADA AO SERVIDOR — ENTAO O SERVIDOR TEM DE ESCREVE-LA.
  --
  -- O bloco acima recusa `service_origin` vindo de chamador autenticado (42501,
  -- e com razao: e o campo que AUTORIZA efeito operacional, nao payload
  -- publico). So que ninguem o escrevia no lugar dele. Efeito medido: quem move
  -- o negocio pela IA carimba a origem no servidor (`agent-stage-sync`,
  -- `appointment-stage-move`, `handoff-stage-move`) e o follow-up nasce; quem
  -- move PELO QUADRO — o operador, pela rota HTTP autenticada — emitia um
  -- evento SEM origem, `fn_service_event_origin` caia no `service_stale` final
  -- (40001), `serviceForEvent` engolia como `stale_origin` e o follow-up nunca
  -- nascia. Sem erro em lugar nenhum: o gatilho de etapa era inalcancavel pelo
  -- caminho que o produto oferece na tela.
  --
  -- O retrato e tirado AQUI, no instante da emissao, que e exatamente a
  -- semantica de procedencia que a 0223 quer: "quando este evento nasceu, o
  -- atendimento estava assim". A resolucao do contato repete a mesma regra de
  -- `fn_service_event_origin` — se ela nao souber resolver o tipo, nao ha o que
  -- carimbar e o evento segue sem origem, como antes.
  if not (coalesce(p_payload,'{}'::jsonb) ? 'service_origin')
     and not (coalesce(p_metadata,'{}'::jsonb) ? 'service_origin') then
    if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added') and p_entity_kind='crm_lead' then
      select contact_id into v_contact from public.crm_leads where organization_id=v_org_id and id=p_entity_id;
    elsif p_event_type='contact.tag_added' and p_entity_kind='contact' then
      select id into v_contact from public.contacts where organization_id=v_org_id and id=p_entity_id;
    end if;
    if v_contact is not null
       and exists(select 1 from public.contacts
                   where organization_id=v_org_id and id=v_contact
                     and not is_anonymized and is_merged_into is null) then
      v_origin := jsonb_build_object('kind','command',
        'observed', public.fn_service_observe_command(v_org_id, v_contact));
    end if;
  end if;

  insert into public.event_log
    (organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values
    (v_org_id, p_event_type, p_entity_kind, p_entity_id,
     coalesce(p_payload, '{}'::jsonb)
       || case when v_origin is null then '{}'::jsonb else jsonb_build_object('service_origin', v_origin) end,
     coalesce(p_metadata, '{}'::jsonb)
       || jsonb_build_object('emitted_at', extract(epoch from now())))
  returning id into v_event_id;

  return v_event_id;
end $function$;
-- A mensagem fica com o nome herdado (`reserved_message_received`): renomeá-la é
-- mudança de contrato observável, e NÃO MEDIMOS se alguém a trata por nome.

-- ── travas do suporte, depois de toda mudança de privilégio (migration 0274) ─
-- As três tabelas passam a ser server-only, e o ramo server-only da função
-- derruba as `support_write_*` que elas tinham. Escrever `drop policy` à mão
-- aqui seria a segunda representação da mesma regra.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
