-- 0164 — `conversation_assignment_events` (histórico de "Assumir"/transferir/
-- liberar conversa) passa a respeitar `visibility_mode`, não só o tenant.
--
-- Achado ao comparar com o changelog do upstream (DeskcommCRM 1.5.0): atendente
-- com visibilidade restrita (`organizations.settings.visibility_mode = 'own'`)
-- via `fn_can_view_lead` (migration 0036/0042) enxergava histórico de
-- transferência de conversas que não são suas. A policy `cae_select` (migration
-- 0031) é "org-flat": só filtra `organization_id`, sem considerar dono. Não há
-- rota GET pública que liste a tabela hoje — mas a RLS sozinha não fecha o
-- vazamento se algum client autenticado consultar a tabela diretamente
-- (PostgREST expõe toda tabela com RLS habilitada por padrão).
--
-- Fix: mesma forma que `crm_lead_activities` (migration 0042) — junta com o
-- estado ATUAL da conversa (`conversations.assigned_to_user_id`) e reusa
-- `fn_can_view_lead`, que já resolve platform admin / role manager+ / dono /
-- `visibility_mode`. Evento antigo de uma conversa hoje reatribuída ao próprio
-- usuário continua visível (é o comportamento do lead-activities também: a
-- visibilidade segue o dono ATUAL, não o ator de cada linha histórica).
--
-- `cae_insert` fica como está: toda escrita real passa por
-- `fn_conversation_assign` (SECURITY DEFINER, bypassa RLS); a policy de INSERT
-- é defesa em profundidade para um caminho direto hipotético, não o achado
-- desta migration.

-- Mesmo idioma de `crm_lead_activities_select` (0042): EXISTS no pai, sem
-- checagem de org redundante — `fn_can_view_lead` já devolve `false` para
-- quem não é membro (`fn_user_role_in_org(p_org) is null`) e `true` para
-- platform admin, então repetir os dois aqui só duplicaria a fonte da verdade.
drop policy if exists cae_select on public.conversation_assignment_events;
create policy cae_select on public.conversation_assignment_events
  for select using (
    exists (
      select 1
        from public.conversations c
       where c.id = conversation_assignment_events.conversation_id
         and public.fn_can_view_lead(c.organization_id, c.assigned_to_user_id)
    )
  );
