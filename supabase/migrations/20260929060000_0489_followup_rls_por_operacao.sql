-- 0489 — RLS POR OPERAÇÃO em followup_enrollments e followup_flow_pointers (issue #1913)
--
-- ── A causa ──────────────────────────────────────────────────────────────────────────────────
-- As duas tabelas nasceram (0054) com UMA policy `for all`, USING = membro da organização e
-- sem papel mínimo. O baseline dá GRANT ALL a `authenticated`, e o PostgREST fala com o JWT
-- da sessão direto, sem rota nenhuma (ver 0150). Então qualquer membro — `viewer` inclusive —
-- apagava ou reescrevia uma inscrição de follow-up, ou o próprio fluxo, com a anon key e o
-- JWT dele, sem passar pela rota nem pelo audit. Apagar a inscrição (ou o fluxo, que
-- cascateia para ela) leva junto a trilha em `followup_enrollment_events` e os turnos
-- `followup_turn` em `job_queue`.
--
-- Até aqui a guarda `fn_followup_generation_write` tropeçava nessa cascata quando havia turno
-- gerado e devolvia 42501 — por acidente, não por desenho. O PR #1912 faz a guarda deixar
-- passar DELETE em cascata (`pg_trigger_depth() > 1`), e aí o buraco abre inteiro. Esta
-- migration fecha a causa antes: a sessão só faz o que uma ROTA faz.
--
-- ── A régua: as rotas ────────────────────────────────────────────────────────────────────────
--   SELECT  membro da organização (GETs de /ai/followups/* e /ai/followup-flows/* são `viewer`)
--   INSERT  `manager` — POST /ai/followups/enrollments, POST /ai/followup-flows, from-model,
--           duplicate
--   UPDATE  `manager` — cancel/pause/resume/skip/snooze da inscrição; PATCH, disable e
--           rollback do fluxo
--   DELETE  `manager` — DELETE /ai/followup-flows/[id] (apaga as inscrições e o fluxo)
-- Nenhuma rota escreve nestas tabelas com papel abaixo de `manager` pela sessão: o resto
-- (motor, gatilhos, worker, MCP, automações) usa `service_role`, que não passa por RLS, e as
-- funções SQL que escrevem aqui são todas `security definer`. A anonimização de LGPD escreve
-- pela sessão, mas exige `admin` — que passa. Cascata de FK (apagar contato ou organização)
-- não é avaliada por RLS: continua funcionando para quem pode apagar o contato.
--
-- Molde: 0464 (propostas) e 0480 (honorários). SELECT sem o bypass de plataforma — o
-- comportamento de leitura não muda aqui. Nenhuma função nova.
--
-- Reaplicável: `drop policy if exists` + `create policy`. O apêndice do baseline é idêntico.

drop policy if exists tenant_isolation_followup_enrollments_all on public.followup_enrollments;

drop policy if exists followup_enrollments_select on public.followup_enrollments;
create policy followup_enrollments_select on public.followup_enrollments
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists followup_enrollments_insert on public.followup_enrollments;
create policy followup_enrollments_insert on public.followup_enrollments
  for insert
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'));

drop policy if exists followup_enrollments_update on public.followup_enrollments;
create policy followup_enrollments_update on public.followup_enrollments
  for update
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'));

drop policy if exists followup_enrollments_delete on public.followup_enrollments;
create policy followup_enrollments_delete on public.followup_enrollments
  for delete
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager'));

drop policy if exists tenant_isolation_followup_flow_pointers_all on public.followup_flow_pointers;

drop policy if exists followup_flow_pointers_select on public.followup_flow_pointers;
create policy followup_flow_pointers_select on public.followup_flow_pointers
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists followup_flow_pointers_insert on public.followup_flow_pointers;
create policy followup_flow_pointers_insert on public.followup_flow_pointers
  for insert
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'));

drop policy if exists followup_flow_pointers_update on public.followup_flow_pointers;
create policy followup_flow_pointers_update on public.followup_flow_pointers
  for update
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'manager'));

drop policy if exists followup_flow_pointers_delete on public.followup_flow_pointers;
create policy followup_flow_pointers_delete on public.followup_flow_pointers
  for delete
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager'));
