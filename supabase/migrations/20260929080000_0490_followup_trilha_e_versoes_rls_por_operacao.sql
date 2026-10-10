-- 0490 — RLS POR OPERAÇÃO em followup_enrollment_events e followup_flow_versions (issue #1915)
--
-- ── A causa ──────────────────────────────────────────────────────────────────────────────────
-- Continuação da 0489 (#1913/#1914), que fez isto em `followup_enrollments` e
-- `followup_flow_pointers`. As duas tabelas vizinhas nasceram (0054) com a mesma policy
-- `for all`, USING = membro da organização e sem papel mínimo. Pelo PostgREST — o JWT da
-- sessão fala com ele direto, sem rota nenhuma (ver 0150) — qualquer membro, `viewer`
-- inclusive, apagava ou reescrevia a TRILHA de uma inscrição (`followup_enrollment_events`:
-- o que foi enviado, pulado, cancelado) e as versões publicadas de um fluxo
-- (`followup_flow_versions`, base do rollback). Nenhuma das duas cascateia para turnos; o
-- dano é a integridade do histórico.
--
-- ── A régua: quem escreve pela SESSÃO ────────────────────────────────────────────────────────
-- followup_enrollment_events
--   SELECT  membro — GET /ai/followups/enrollments/[id] lê a trilha com `viewer`
--   INSERT  `manager` — cancel/pause/resume/skip/snooze da inscrição gravam o evento manual
--           pela sessão, e todas exigem `requireRole("manager")`
--   UPDATE  nenhuma policy — nenhuma rota altera evento pela sessão
--   DELETE  nenhuma policy — nenhuma rota apaga evento pela sessão
-- followup_flow_versions
--   SELECT  membro — GET /ai/followup-flows/[id] e /contacts/[id]/roteiros são `viewer`
--   INSERT  nenhuma policy — a versão nasce só por `fn_publish_followup_flow_version`
--           (`security definer`, chamada com `service_role` pela rota de publicar)
--   UPDATE  nenhuma policy — nenhuma escrita pela sessão
--   DELETE  `manager` — DELETE /ai/followup-flows/[id] apaga as versões pela sessão
--
-- Sem policy = recusa para `authenticated`: a trilha fica append-only para a equipe e só o
-- motor (`service_role`, o pool do worker, as funções `security definer`) a reescreve. A
-- cascata de FK (apagar contato, inscrição, fluxo ou organização) não é avaliada por RLS:
-- continua levando a trilha e as versões junto, para quem pode apagar a origem.
--
-- Molde: 0489. SELECT sem o bypass de plataforma — a leitura não muda. Nenhuma função nova.
-- Reaplicável: `drop policy if exists` + `create policy`. O apêndice do baseline é idêntico.

drop policy if exists tenant_isolation_followup_enrollment_events_all on public.followup_enrollment_events;

drop policy if exists followup_enrollment_events_select on public.followup_enrollment_events;
create policy followup_enrollment_events_select on public.followup_enrollment_events
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists followup_enrollment_events_insert on public.followup_enrollment_events;
create policy followup_enrollment_events_insert on public.followup_enrollment_events
  for insert
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'));

drop policy if exists tenant_isolation_followup_flow_versions_all on public.followup_flow_versions;

drop policy if exists followup_flow_versions_select on public.followup_flow_versions;
create policy followup_flow_versions_select on public.followup_flow_versions
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists followup_flow_versions_delete on public.followup_flow_versions;
create policy followup_flow_versions_delete on public.followup_flow_versions
  for delete
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager'));
