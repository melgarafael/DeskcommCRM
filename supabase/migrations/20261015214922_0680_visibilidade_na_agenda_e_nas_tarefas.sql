-- manifest: agenda e tarefas passam a respeitar organizations.settings.visibility_mode — o agent vê e escreve só o que é dele, manager+ segue org-wide (#2902)
--
-- ─── O defeito, medido (issue #2902, baseline 1.80.0) ───────────────────────
--
-- Numa organização em `visibility_mode = 'own'` ("Só os seus"), `conversations`
-- (migration 0035) e `crm_leads` (0036) já recortam o papel `agent` pelo
-- responsável. A agenda e as tarefas ficaram de fora das duas ondas:
--
--   · `calendar_appointments_select` e `crm_tasks_select` liberavam a LEITURA a
--     qualquer membro da organização (`organization_id in (select
--     public.fn_user_org_ids())`);
--   · `calendar_appointments_write` e `crm_tasks_write` liberavam a ESCRITA a
--     qualquer papel `agent`+ SEM OLHAR O RESPONSÁVEL.
--
-- O desfecho, nas palavras de quem abriu a #2902: o atendente vê os
-- compromissos pessoais do dono e as tarefas de carteira da colega — e consegue
-- editar e excluir o que não é dele.
--
-- ─── Por que o conserto é de RLS, e não de rota ─────────────────────────────
--
-- As duas tabelas são servidas pelo PostgREST com a anon key (que vai no bundle
-- do browser) + o JWT do usuário. `requireRole()` na rota Next não é a única
-- porta: qualquer aba com a key e o token do atendente fala direto com
-- `/rest/v1/calendar_appointments`. Uma regra que só exista na rota é uma regra
-- que existe em uma das duas portas.
--
-- ─── O conserto: o MESMO eixo das duas irmãs ────────────────────────────────
--
-- `fn_can_view_appointment` espelha `fn_can_view_conversation` (0035) e
-- `fn_can_view_lead` (0036), com a mesma escada: plataforma tudo; não-membro
-- nada; viewer/manager/admin org-wide; o dono o que é dele; e o resto quem
-- decide é `organizations.settings.visibility_mode` — `all` = tudo,
-- `own_and_unassigned` = o dono MAIS o que não tem dono, `own` = só o dono. O
-- default continua `own_and_unassigned` (G1-06a), igual às conversas e aos
-- negócios.
--
-- `fn_can_view_task` é o mesmo eixo sobre `crm_tasks`, com UMA diferença
-- medida: além do responsável (`assigned_to`), o CRIADOR (`created_by`) também
-- enxerga a própria tarefa. Isso preserva dois contratos que a tela e a rota já
-- declaram, e que um recorte só-por-responsável quebraria:
--
--   · a tarefa SEM responsável. `FormularioDeTarefa.tsx` grava
--     `assigned_to: null` quando o campo fica em "Ninguém" — e é o estado
--     INICIAL do formulário de criação (`responsavelInicial = responsavelPadrao
--     ?? NINGUEM`), enquanto `POST /api/v1/tasks` aceita a falta de propósito
--     (contrato declarado em
--     `tests/unit/tarefas-responsavel-da-mesma-equipe.test.ts`: "sem
--     responsável, a equipe nem é consultada"). Recortando só por
--     responsável, numa organização em `own` o `with check` barraria esse insert
--     — 500 na cara de quem escreveu o combinado — e, se passasse, a linha
--     ficaria invisível até para o autor, porque `own` não abre nada sem dono.
--   · entregar a tarefa a um colega. A tela oferece a EQUIPE INTEIRA no campo
--     de responsável (`useAssignableMembers`) e a rota confere que o membro é da
--     organização (`lib/tarefas/responsavel.ts`). Com o criador enxergando o que
--     criou, o agent continua podendo ENTREGAR trabalho a um colega — o que a
--     #2902 pede é parar de EDITAR e EXCLUIR o que o outro escreveu, e isso é o
--     que fica barrado (tarefa de B, criada por B: o agent A não lê, não edita,
--     não apaga).
--
-- Em `own_and_unassigned` o comportamento da fila (tarefa sem responsável
-- visível a todo `agent`) fica intacto.
--
-- ─── O que muda, e o que NÃO muda ───────────────────────────────────────────
--
--   · Painel de agenda (a rota e o realtime, que herda a policy de SELECT): o
--     `agent` passa a ver a PRÓPRIA agenda; `viewer`, `manager` e `admin`
--     seguem vendo a equipe inteira — o `viewer` continua lendo tudo, como
--     `tests/invariants/agenda-rls.test.ts` exige.
--   · Rota de tarefas (POST/PATCH/DELETE) e o selo do quadro do funil: mesmo
--     recorte, pelo responsável. É o mesmo escopo que o kanban de negócios já
--     aplica hoje com os cards.
--   · ⚠️ Os dois recortes acima valem para quem DESLIGOU a opção da #978: com a
--     chave ausente ou ligada — o padrão, e o estado de toda organização que
--     nunca mexeu nela — as quatro policies seguem entregando a equipe inteira
--     ao `agent`+. É a COLISÃO DECLARADA logo abaixo, e ela está RESOLVIDA a
--     favor da opção, porque o caminho de RPC da agenda (`fn_appointment_change`)
--     já a honrava e a RLS recusava o que o RPC permitia.
--   · Quem escreve por `service_role` NÃO muda nada: o motor de follow-up
--     (`lib/followup/engine.ts`), a ação de automação `create_task`
--     (`ctx.admin`), o aviso ao dono (`lib/carteira/aviso-ao-dono.ts`) e a
--     exportação LGPD (`lib/lgpd/export-collector.ts`) passam por
--     `createAdminClient()` e BYPASSAM RLS.
--   · ⚠️ COLISÃO DECLARADA — `fn_colegas_podem_mexer_na_agenda` (#978) — E
--     RESOLVIDA A FAVOR DA OPÇÃO. A #978 decidiu que "o Atendente marca/mexe na
--     agenda do colega" é uma OPÇÃO POR ORGANIZAÇÃO, LIGADA POR PADRÃO. O eixo
--     desta migration é mais restritivo que essa opção, e deixá-lo vencer calado
--     revogaria uma decisão que a organização já tinha tomado — e criaria uma
--     incoerência medida: o caminho de RPC da agenda (`fn_appointment_change`,
--     `fn_appointment_change_core`) JÁ consulta a opção e recusa o compromisso do
--     colega só com ela desligada; a RLS recusava o que o RPC permitia, e a rota
--     HTTP devolvia `internal_error` num caminho que o produto declara válido.
--     Por isso as QUATRO policies abaixo consultam a opção, e é isto que elas
--     medem:
--
--       · chave AUSENTE ou LIGADA (o padrão, e o estado de toda organização que
--         nunca mexeu nela): `fn_colegas_podem_mexer_na_agenda` devolve verdadeiro
--         — o COALESCE da chave com `true` — e o comportamento é o de antes desta
--         migration: o `agent` vê e mexe na agenda e nas tarefas da equipe da
--         própria organização;
--       · chave em FALSO: aí sim a régua por responsável da #2902 aperta, e o
--         `agent` vê e escreve só o que é dele (mais a fila, em
--         `own_and_unassigned`). É a restrição que a issue pede, e ela está
--         medida em
--         `tests/invariants/visibilidade-na-agenda-e-nas-tarefas.test.ts`, nos
--         dois lados.
--
--     O `or` entra DENTRO da conjunção de pertencimento nas policies de leitura
--     (`organization_id in (select public.fn_user_org_ids()) and
--     fn_colegas_podem_mexer_na_agenda(organization_id)`) e dentro do grupo de
--     papel nas de escrita. Isso não é estilo: `fn_colegas_podem_mexer_na_agenda`
--     lê a configuração da organização DA LINHA e não olha quem pergunta — solto
--     numa policy de SELECT, ele devolveria verdadeiro também para quem não é
--     membro (inclusive para organização que não existe, por causa do COALESCE),
--     e a policy passaria a servir leitura entre empresas.
--
-- ─── Por que as policies de escrita mantêm o NOME e o FOR ALL ───────────────
--
-- Os nomes `calendar_appointments_write` e `crm_tasks_write` são cobrados pelo
-- catálogo de `tests/invariants/platform-admin-full-so-escreve.test.ts`
-- (policy viva com `fn_is_platform_admin_full` dentro, e sem a função pura), e
-- os corpos abaixo conservam isso.
--
-- FOR ALL, e não por-comando como nas 0035/0036: o `using` de um FOR ALL
-- também governa o SELECT (policies são OR-adas), e aqui ele é SUBCONJUNTO do
-- que a policy de leitura concede — o recorte por papel é o mesmo (`agent`+ com
-- o mesmo `fn_can_view_*`), então a OR não alarga leitura nenhuma. O `viewer`
-- segue barrado na escrita pelo piso `agent`.
--
-- Idempotente (`create or replace`, `drop policy if exists`): o `update.sh`
-- reaplica o baseline inteiro sobre um banco que já tem tudo.

create or replace function public.fn_can_view_appointment(
  p_org uuid,
  p_owner_user_id uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true
    when p_owner_user_id = auth.uid() then true
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_owner_user_id is null
         else false
       end
  end;
$$;

revoke all on function public.fn_can_view_appointment(uuid, uuid) from public;
revoke execute on function public.fn_can_view_appointment(uuid, uuid) from anon;
grant execute on function public.fn_can_view_appointment(uuid, uuid)
  to authenticated, service_role;

create or replace function public.fn_can_view_task(
  p_org uuid,
  p_assigned_to uuid,
  p_created_by uuid
) returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when public.fn_is_platform_admin() then true
    when public.fn_user_role_in_org(p_org) is null then false
    when public.fn_user_role_in_org(p_org) in ('viewer','manager','admin') then true
    when p_assigned_to = auth.uid() then true
    when p_created_by = auth.uid() then true
    else case coalesce(
           (select settings->>'visibility_mode' from public.organizations where id = p_org),
           'own_and_unassigned')
         when 'all' then true
         when 'own_and_unassigned' then p_assigned_to is null
         else false
       end
  end;
$$;

revoke all on function public.fn_can_view_task(uuid, uuid, uuid) from public;
revoke execute on function public.fn_can_view_task(uuid, uuid, uuid) from anon;
grant execute on function public.fn_can_view_task(uuid, uuid, uuid)
  to authenticated, service_role;

-- ─── calendar_appointments: leitura e escrita pelo dono do compromisso ──────

drop policy if exists calendar_appointments_select on public.calendar_appointments;
create policy calendar_appointments_select on public.calendar_appointments
  for select using (
    public.fn_can_view_appointment(organization_id, owner_user_id)
    -- A OPÇÃO da #978, dentro do pertencimento (ver COLISÃO DECLARADA acima):
    -- com ela ligada ou ausente o colega da MESMA organização continua lendo a
    -- agenda da equipe; com ela em falso só o que `fn_can_view_appointment`
    -- concede.
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_colegas_podem_mexer_na_agenda(organization_id))
  );

drop policy if exists calendar_appointments_write on public.calendar_appointments;
create policy calendar_appointments_write on public.calendar_appointments
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_appointment(organization_id, owner_user_id)
             or public.fn_colegas_podem_mexer_na_agenda(organization_id)))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_appointment(organization_id, owner_user_id)
             or public.fn_colegas_podem_mexer_na_agenda(organization_id)))
  );

-- ─── crm_tasks: leitura e escrita pelo responsável (e por quem criou) ───────

drop policy if exists crm_tasks_select on public.crm_tasks;
create policy crm_tasks_select on public.crm_tasks
  for select using (
    public.fn_can_view_task(organization_id, assigned_to, created_by)
    -- Mesma opção, mesma colocação da irmã da agenda: o recorte por responsável
    -- da #2902 entra na leitura das tarefas quando a organização desliga a chave.
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_colegas_podem_mexer_na_agenda(organization_id))
  );

drop policy if exists crm_tasks_write on public.crm_tasks;
create policy crm_tasks_write on public.crm_tasks
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_task(organization_id, assigned_to, created_by)
             or public.fn_colegas_podem_mexer_na_agenda(organization_id)))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent')
        and (public.fn_role_at_least(organization_id, 'manager')
             or public.fn_can_view_task(organization_id, assigned_to, created_by)
             or public.fn_colegas_podem_mexer_na_agenda(organization_id)))
  );
