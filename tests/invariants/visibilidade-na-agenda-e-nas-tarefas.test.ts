import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

/**
 * A AGENDA E AS TAREFAS RESPEITAM `visibility_mode` — E A OPÇÃO DA #978 MANDA.
 *
 * ═══ O defeito (issue #2902, baseline 1.80.0) ═══════════════════════════════
 *
 * `conversations` (migration 0035) e `crm_leads` (0036) já recortavam o papel
 * `agent` pelo responsável. A agenda e as tarefas ficaram de fora:
 * `calendar_appointments_select` e `crm_tasks_select` liberavam a LEITURA a
 * qualquer membro da organização, e `calendar_appointments_write` /
 * `crm_tasks_write` liberavam a ESCRITA a qualquer papel `agent`+ sem olhar o
 * responsável. O desfecho, nas palavras de quem abriu a issue: o atendente vê os
 * compromissos pessoais do dono e as tarefas de carteira da colega — e consegue
 * editar e excluir o que não é dele.
 *
 * ═══ A colisão declarada, e o lado que venceu (medido, não suposto) ═════════
 *
 * `fn_colegas_podem_mexer_na_agenda(p_org)` (migration 0343, issue #978) é uma
 * OPÇÃO POR ORGANIZAÇÃO, **ligada por ausência**: o COALESCE da chave com `true`
 * faz a chave inexistente valer como ligada. E o caminho de RPC da agenda
 * (`fn_appointment_change` → `fn_appointment_change_core`, linha do
 * `appointment_do_colega`) já consulta essa opção ANTES de recusar o compromisso
 * alheio. Sem consultá-la também nas policies, a RLS passaria a recusar o que o
 * RPC permite — a rota devolveria `internal_error` num caminho que o produto
 * declara válido.
 *
 * Por isso as QUATRO policies consultam a opção
 * (`or public.fn_colegas_podem_mexer_na_agenda(organization_id)`), e este
 * arquivo mede OS DOIS lados:
 *
 *   · chave AUSENTE ou LIGADA (o padrão, e o estado de toda organização que
 *     nunca mexeu nela) — o `agent` vê e mexe na agenda e nas tarefas da equipe
 *     da própria organização, como antes desta migration;
 *   · chave em FALSO — aí a régua por responsável da #2902 aperta: o `agent` vê e
 *     escreve só o que é dele (mais a fila, em `own_and_unassigned`).
 *
 * O `or` mora DENTRO da conjunção de pertencimento, e não é estilo:
 * `fn_colegas_podem_mexer_na_agenda` lê a configuração da organização DA LINHA e
 * não olha quem pergunta — devolveria verdadeiro para um não-membro (e até para
 * uma organização que não existe, por causa do COALESCE), e a policy passaria a
 * servir leitura entre empresas. O caso "o agent de OUTRA organização continua
 * lendo zero" fecha essa porta.
 *
 * ═══ Por que um teste de BANCO, e não um teste de rota ══════════════════════
 *
 * As duas tabelas são servidas pelo PostgREST com a anon key (que vai no bundle
 * do browser) + o JWT do usuário. `requireRole()` na rota Next não é a única
 * porta, e uma regra que exista só lá é uma regra que existe em uma das duas
 * portas. Aqui quem responde é o banco: `set role authenticated` + o
 * `request.jwt.claims` do usuário, o mesmo caminho que a produção usa.
 *
 * ═══ A escada, e o que cada caso prende ═════════════════════════════════════
 *
 * Espelho de `gov-5c` (leads) para as duas tabelas que ficaram de fora. O
 * `agent` vê/escreve o que é dele (+ o que não tem dono, no default
 * `own_and_unassigned`); `viewer`, `manager` e `admin` seguem org-wide — o
 * `viewer` LENDO tudo, e é por isso que o caso dele existe aqui: sem ele, a
 * "correção" natural de uma policy quebrada seria barrar o viewer também, e o
 * gate de escrita viraria gate de acesso (o mesmo cuidado que
 * `tests/invariants/agenda-rls.test.ts` toma).
 *
 * As fixtures são LOCAIS e por id (namespace `e2902…`, hex de propósito) —
 * nunca contagens por organização, porque os arquivos de invariante rodam em
 * paralelo e o `GOV_ORG` é compartilhado com os `gov-*.test.ts`. Os modos
 * restritivos vivem em organizações DEDICADAS (`OFF_ORG`, `OWN_ORG`), como em
 * `gov-5`.
 *
 * Sem PII (LGPD): títulos sintéticos, nenhum telefone/nome de pessoa real.
 */

// ─── GOV_ORG: o default (`own_and_unassigned`) e a opção AUSENTE (ligada) ─────
const APPT_A = "e2902001-0000-4000-8000-000000000001"; // dono = agent A
const APPT_B = "e2902001-0000-4000-8000-000000000002"; // dono = agent B
/** Reservado ao probe de DELETE: se a RLS falhar, ele é apagado — e mais nada. */
const APPT_B_APAGAR = "e2902001-0000-4000-8000-000000000003";
const APPT_NULO = "e2902001-0000-4000-8000-000000000004"; // dono = null (fila)

const TASK_A = "e2902002-0000-4000-8000-000000000001"; // resp. e criador = agent A
const TASK_B = "e2902002-0000-4000-8000-000000000002"; // resp. e criador = agent B
const TASK_B_APAGAR = "e2902002-0000-4000-8000-000000000003";
const TASK_NULO = "e2902002-0000-4000-8000-000000000004"; // sem responsável nem criador

/** A organização de OUTRA empresa, para o caso de leitura entre organizações. */
const OUTRA_ORG = "e2904000-0000-4000-8000-000000000001";
const APPT_OUTRA_ORG = "e2904001-0000-4000-8000-000000000001";

// ─── OFF_ORG: default (`own_and_unassigned`) + opção da #978 DESLIGADA ───────
const OFF_ORG = "e2903500-0000-4000-8000-000000000001";
const APPT_B_OFF = "e2903501-0000-4000-8000-000000000001"; // dono = agent B
const APPT_B_OFF_APAGAR = "e2903501-0000-4000-8000-000000000002";
const APPT_NULO_OFF = "e2903501-0000-4000-8000-000000000003"; // dono = null
const TASK_B_OFF = "e2903502-0000-4000-8000-000000000001"; // resp./criador = agent B
const TASK_B_OFF_APAGAR = "e2903502-0000-4000-8000-000000000002";
const TASK_NULO_OFF = "e2903502-0000-4000-8000-000000000003"; // sem responsável

// ─── OWN_ORG: `visibility_mode = 'own'` + opção da #978 DESLIGADA ────────────
const OWN_ORG = "e2903000-0000-4000-8000-000000000001";
const APPT_B_OWN = "e2903001-0000-4000-8000-000000000001"; // dono = agent B
const APPT_B_OWN_APAGAR = "e2903001-0000-4000-8000-000000000002";
const APPT_NULO_OWN = "e2903001-0000-4000-8000-000000000003"; // dono = null
const TASK_B_OWN = "e2903002-0000-4000-8000-000000000001"; // resp./criador = agent B
const TASK_B_OWN_APAGAR = "e2903002-0000-4000-8000-000000000002";
/** A tarefa SEM responsável que o agent A escreveu — `created_by` é o que a mantém viva. */
const TASK_DO_AUTO_OWN = "e2903002-0000-4000-8000-000000000003";

beforeAll(() => {
  seedGov(); // GOV_ORG (default own_and_unassigned, opção ausente) + agentes A/B, manager, viewer

  sql(`
    insert into public.calendar_appointments
      (id, organization_id, title, starts_at, ends_at, owner_user_id, status)
    values
      ('${APPT_A}',        '${GOV_ORG}', 'Compromisso do agent A', now() + interval '2 days', now() + interval '2 days 30 minutes', '${GOV_AGENT_A}', 'confirmed'),
      ('${APPT_B}',        '${GOV_ORG}', 'Compromisso do agent B', now() + interval '3 days', now() + interval '3 days 30 minutes', '${GOV_AGENT_B}', 'confirmed'),
      ('${APPT_B_APAGAR}', '${GOV_ORG}', 'Compromisso do agent B (probe de DELETE)', now() + interval '4 days', now() + interval '4 days 30 minutes', '${GOV_AGENT_B}', 'confirmed'),
      ('${APPT_NULO}',     '${GOV_ORG}', 'Compromisso sem dono (fila)', now() + interval '5 days', now() + interval '5 days 30 minutes', null, 'confirmed')
      on conflict (id) do nothing;

    insert into public.crm_tasks (id, organization_id, title, status, assigned_to, created_by)
    values
      ('${TASK_A}',        '${GOV_ORG}', 'Tarefa do agent A', 'pending', '${GOV_AGENT_A}', '${GOV_AGENT_A}'),
      ('${TASK_B}',        '${GOV_ORG}', 'Tarefa do agent B', 'pending', '${GOV_AGENT_B}', '${GOV_AGENT_B}'),
      ('${TASK_B_APAGAR}', '${GOV_ORG}', 'Tarefa do agent B (probe de DELETE)', 'pending', '${GOV_AGENT_B}', '${GOV_AGENT_B}'),
      ('${TASK_NULO}',     '${GOV_ORG}', 'Tarefa sem responsável (fila)', 'pending', null, null)
      on conflict (id) do nothing;

    -- ─── As organizações de teste, isoladas de propósito: mexer nas settings do
    -- GOV_ORG mediria outro produto e sujaria os arquivos vizinhos que
    -- compartilham a fixture. Cada modo restritivo mora na sua.

    -- A OUTRA empresa (o caso de leitura entre organizações, abaixo). A opção
    -- dela fica AUSENTE de propósito: é a organização em que o
    -- o fn_colegas_podem_mexer_na_agenda devolve verdadeiro, e é exatamente aí
    -- que um or solto na policy de SELECT abriria a leitura entre empresas.
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'inv-2902-outra', 'Invariante 2902 Outra', 'Inv 2902 Outra')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${GOV_AGENT_B}', '${OUTRA_ORG}', 'agent', now())
      on conflict do nothing;
    insert into public.calendar_appointments
      (id, organization_id, title, starts_at, ends_at, owner_user_id, status)
    values
      ('${APPT_OUTRA_ORG}', '${OUTRA_ORG}', 'Compromisso de outra empresa', now() + interval '11 days', now() + interval '11 days 30 minutes', '${GOV_AGENT_B}', 'confirmed')
      on conflict (id) do nothing;

    -- Opção da #978 em FALSO, no modo default: é aqui que a régua da #2902
    -- aperta (o outro lado da colisão declarada).
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${OFF_ORG}', 'inv-2902-off', 'Invariante 2902 Off', 'Inv 2902 Off',
              jsonb_build_object('colegas_podem_mexer_na_agenda', false))
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GOV_AGENT_A}', '${OFF_ORG}', 'agent',   now()),
      ('${GOV_AGENT_B}', '${OFF_ORG}', 'agent',   now()),
      ('${GOV_MANAGER}', '${OFF_ORG}', 'manager', now()),
      ('${GOV_VIEWER}',  '${OFF_ORG}', 'viewer',  now())
      on conflict do nothing;

    insert into public.calendar_appointments
      (id, organization_id, title, starts_at, ends_at, owner_user_id, status)
    values
      ('${APPT_B_OFF}',        '${OFF_ORG}', 'Compromisso do agent B (opção desligada)', now() + interval '6 days', now() + interval '6 days 30 minutes', '${GOV_AGENT_B}', 'confirmed'),
      ('${APPT_B_OFF_APAGAR}', '${OFF_ORG}', 'Compromisso do agent B (probe de DELETE, opção desligada)', now() + interval '7 days', now() + interval '7 days 30 minutes', '${GOV_AGENT_B}', 'confirmed'),
      ('${APPT_NULO_OFF}',     '${OFF_ORG}', 'Compromisso sem dono (opção desligada)', now() + interval '8 days', now() + interval '8 days 30 minutes', null, 'confirmed')
      on conflict (id) do nothing;

    insert into public.crm_tasks (id, organization_id, title, status, assigned_to, created_by)
    values
      ('${TASK_B_OFF}',        '${OFF_ORG}', 'Tarefa do agent B (opção desligada)', 'pending', '${GOV_AGENT_B}', '${GOV_AGENT_B}'),
      ('${TASK_B_OFF_APAGAR}', '${OFF_ORG}', 'Tarefa do agent B (probe de DELETE, opção desligada)', 'pending', '${GOV_AGENT_B}', '${GOV_AGENT_B}'),
      ('${TASK_NULO_OFF}',     '${OFF_ORG}', 'Tarefa sem responsável (opção desligada)', 'pending', null, null)
      on conflict (id) do nothing;

    -- Modo "Só os seus" COM a opção desligada: o recorte mais estreito que
    -- existe — nem a fila entra.
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${OWN_ORG}', 'inv-2902-own', 'Invariante 2902 Own', 'Inv 2902 Own',
              jsonb_build_object('visibility_mode', 'own', 'colegas_podem_mexer_na_agenda', false))
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GOV_AGENT_A}', '${OWN_ORG}', 'agent',   now()),
      ('${GOV_AGENT_B}', '${OWN_ORG}', 'agent',   now()),
      ('${GOV_MANAGER}', '${OWN_ORG}', 'manager', now())
      on conflict do nothing;

    insert into public.calendar_appointments
      (id, organization_id, title, starts_at, ends_at, owner_user_id, status)
    values
      ('${APPT_B_OWN}',        '${OWN_ORG}', 'Compromisso do agent B (modo own)', now() + interval '9 days', now() + interval '9 days 30 minutes', '${GOV_AGENT_B}', 'confirmed'),
      ('${APPT_B_OWN_APAGAR}', '${OWN_ORG}', 'Compromisso do agent B (probe de DELETE, modo own)', now() + interval '10 days', now() + interval '10 days 30 minutes', '${GOV_AGENT_B}', 'confirmed'),
      ('${APPT_NULO_OWN}',     '${OWN_ORG}', 'Compromisso sem dono (modo own)', now() + interval '11 days', now() + interval '11 days 30 minutes', null, 'confirmed')
      on conflict (id) do nothing;

    insert into public.crm_tasks (id, organization_id, title, status, assigned_to, created_by)
    values
      ('${TASK_B_OWN}',        '${OWN_ORG}', 'Tarefa do agent B (modo own)', 'pending', '${GOV_AGENT_B}', '${GOV_AGENT_B}'),
      ('${TASK_B_OWN_APAGAR}', '${OWN_ORG}', 'Tarefa do agent B (probe de DELETE, modo own)', 'pending', '${GOV_AGENT_B}', '${GOV_AGENT_B}'),
      ('${TASK_DO_AUTO_OWN}',  '${OWN_ORG}', 'Tarefa sem responsável do agent A', 'pending', null, '${GOV_AGENT_A}')
      on conflict (id) do nothing;
  `);
});

describe("agenda — a opção da #978 ligada por ausência (o padrão): os colegas veem e mexem na agenda da equipe", () => {
  it("agent A VÊ o compromisso do agent B — a opção ligada entrega a agenda da equipe", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.calendar_appointments where id = '${APPT_B}';`),
    ).toBe(1);
  });

  it("agent A vê o próprio compromisso (controle positivo)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.calendar_appointments where id = '${APPT_A}';`),
    ).toBe(1);
  });

  it("agent A vê o compromisso SEM dono no default (é a mesma fila das conversas)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.calendar_appointments where id = '${APPT_NULO}';`),
    ).toBe(1);
  });

  it("agent A NÃO vê o compromisso de OUTRA organização (o `or` não cruza empresa)", () => {
    // A organização de lá tem a opção AUSENTE — o `fn_colegas_podem_mexer_na_agenda`
    // devolve verdadeiro. Se o `or` não estivesse dentro da conjunção de
    // pertencimento, este caso seria 1 e a policy estaria servindo leitura entre
    // empresas. É o caso que prende a colocação do `or`.
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.calendar_appointments where id = '${APPT_OUTRA_ORG}';`,
      ),
    ).toBe(0);
  });

  it("manager vê os compromissos dos dois atendentes (org-wide, preservado)", () => {
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.calendar_appointments where id in ('${APPT_A}', '${APPT_B}');`,
      ),
    ).toBe(2);
  });

  it("viewer LÊ a agenda da equipe — o gate é de escrita, não de acesso", () => {
    // Sem este caso, uma policy que barrasse o viewer em tudo passaria no caso
    // acima e quebraria o produto: quem tem acesso de leitura precisa ver a
    // agenda. É o mesmo par que `agenda-rls.test.ts` prende para a conexão.
    expect(
      countAs(
        GOV_VIEWER,
        `select count(*) from public.calendar_appointments where id in ('${APPT_A}', '${APPT_B}');`,
      ),
    ).toBe(2);
  });

  it("agent A EDITA o próprio compromisso (o trabalho dele não quebra)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.calendar_appointments set title = 'Compromisso do agent A (editado)' where id = '${APPT_A}'`,
      ),
    ).toBe(1);
  });

  it("agent A EDITA o compromisso do agent B — é o que a #978 decidiu e a RPC já permitia", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.calendar_appointments set title = 'remarcado pelo agent A' where id = '${APPT_B}'`,
      ),
    ).toBe(1);
  });

  it("agent A APAGA o compromisso do agent B (a opção é sobre a agenda inteira, não só sobre editar)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `delete from public.calendar_appointments where id = '${APPT_B_APAGAR}'`),
    ).toBe(1);
  });

  it("agent A edita o compromisso SEM dono no default (puxa a fila)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.calendar_appointments set title = 'Compromisso da fila (assumido)' where id = '${APPT_NULO}'`,
      ),
    ).toBe(1);
  });

  it("agent A CRIA compromisso próprio", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id)
           values ('${GOV_ORG}', 'Compromisso novo do agent A', now() + interval '12 days', now() + interval '12 days 30 minutes', '${GOV_AGENT_A}')`,
      ),
    ).toBe(1);
  });

  it("agent A CRIA compromisso em nome de um colega — o que a rota sempre prometeu com a opção ligada", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id)
           values ('${GOV_ORG}', 'Compromisso do agent A na agenda do B', now() + interval '13 days', now() + interval '13 days 30 minutes', '${GOV_AGENT_B}')`,
      ),
    ).toBe(1);
  });

  it("manager EDITA o compromisso de um atendente (org-wide write, preservado)", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.calendar_appointments set title = 'Compromisso do agent B (remarcado pelo manager)' where id = '${APPT_B}'`,
      ),
    ).toBe(1);
  });
});

describe("tarefas — a opção da #978 ligada por ausência (o padrão): os colegas veem e mexem nas tarefas da equipe", () => {
  it("agent A VÊ a tarefa do agent B", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_tasks where id = '${TASK_B}';`)).toBe(1);
  });

  it("agent A vê a própria tarefa (controle positivo)", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_tasks where id = '${TASK_A}';`)).toBe(1);
  });

  it("agent A vê a tarefa SEM responsável no default (é a fila do time)", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_tasks where id = '${TASK_NULO}';`)).toBe(1);
  });

  it("manager vê as tarefas dos dois atendentes (org-wide, preservado)", () => {
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.crm_tasks where id in ('${TASK_A}', '${TASK_B}');`),
    ).toBe(2);
  });

  it("viewer LÊ as tarefas da equipe — é o que a casa declarou para a 0210", () => {
    expect(
      countAs(GOV_VIEWER, `select count(*) from public.crm_tasks where id in ('${TASK_A}', '${TASK_B}');`),
    ).toBe(2);
  });

  it("agent A EDITA a própria tarefa", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.crm_tasks set status = 'in_progress' where id = '${TASK_A}'`),
    ).toBe(1);
  });

  it("agent A EDITA a tarefa do agent B (a opção ligada cobre as duas telas)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.crm_tasks set title = 'revisada pelo agent A' where id = '${TASK_B}'`),
    ).toBe(1);
  });

  it("agent A APAGA a tarefa do agent B", () => {
    expect(writeCountAs(GOV_AGENT_A, `delete from public.crm_tasks where id = '${TASK_B_APAGAR}'`)).toBe(1);
  });

  it("agent A edita a tarefa SEM responsável no default (puxa a fila)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.crm_tasks set assigned_to = '${GOV_AGENT_A}' where id = '${TASK_NULO}'`),
    ).toBe(1);
  });

  it("agent A CRIA a própria tarefa", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_tasks (organization_id, title, assigned_to, created_by)
           values ('${GOV_ORG}', 'Tarefa nova do agent A', '${GOV_AGENT_A}', '${GOV_AGENT_A}')`,
      ),
    ).toBe(1);
  });

  it("agent A ENTREGA uma tarefa a um colega (a tela oferece a equipe no responsável)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_tasks (organization_id, title, assigned_to, created_by)
           values ('${GOV_ORG}', 'Tarefa que o agent A entrega ao agent B', '${GOV_AGENT_B}', '${GOV_AGENT_A}')`,
      ),
    ).toBe(1);
  });

  it("manager EDITA a tarefa de um atendente (org-wide write, preservado)", () => {
    expect(
      writeCountAs(GOV_MANAGER, `update public.crm_tasks set title = 'Tarefa do agent B (revisada)' where id = '${TASK_B}'`),
    ).toBe(1);
  });
});

describe("agenda e tarefas — opção da #978 DESLIGADA (default `own_and_unassigned`): a régua da #2902 aperta", () => {
  it("⭐ agent A NÃO vê o compromisso do agent B (o defeito da #2902, fechado com a opção em falso)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.calendar_appointments where id = '${APPT_B_OFF}';`),
    ).toBe(0);
  });

  it("⭐ agent A NÃO edita o compromisso do agent B (0 linhas)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.calendar_appointments set title = 'invadido pelo agent A' where id = '${APPT_B_OFF}'`,
      ),
    ).toBe(0);
  });

  it("⭐ agent A NÃO apaga o compromisso do agent B (0 linhas)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `delete from public.calendar_appointments where id = '${APPT_B_OFF_APAGAR}'`),
    ).toBe(0);
  });

  it("agent A NÃO cria compromisso em nome de um colega (o `with check` recusa)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id)
           values ('${OFF_ORG}', 'Compromisso do agent A na agenda do B', now() + interval '14 days', now() + interval '14 days 30 minutes', '${GOV_AGENT_B}')`,
      ),
    ).toBe(0);
  });

  it("agent A vê o próprio compromisso (controle positivo do modo restritivo)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.calendar_appointments (organization_id, title, starts_at, ends_at, owner_user_id)
           values ('${OFF_ORG}', 'Compromisso novo do agent A (opção desligada)', now() + interval '15 days', now() + interval '15 days 30 minutes', '${GOV_AGENT_A}')`,
      ),
    ).toBe(1);
  });

  it("agent A vê e edita o compromisso SEM dono (a fila de `own_and_unassigned` sobrevive)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.calendar_appointments where id = '${APPT_NULO_OFF}';`),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.calendar_appointments set title = 'Compromisso da fila (assumido, opção desligada)' where id = '${APPT_NULO_OFF}'`,
      ),
    ).toBe(1);
  });

  it("⭐ agent A NÃO vê a tarefa do agent B", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_tasks where id = '${TASK_B_OFF}';`)).toBe(0);
  });

  it("⭐ agent A NÃO edita a tarefa do agent B (0 linhas)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.crm_tasks set title = 'invadida pelo agent A' where id = '${TASK_B_OFF}'`),
    ).toBe(0);
  });

  it("⭐ agent A NÃO apaga a tarefa do agent B (0 linhas)", () => {
    expect(writeCountAs(GOV_AGENT_A, `delete from public.crm_tasks where id = '${TASK_B_OFF_APAGAR}'`)).toBe(0);
  });

  it("agent A vê e assume a tarefa SEM responsável (a fila do time, preservada)", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_tasks where id = '${TASK_NULO_OFF}';`)).toBe(1);
    expect(
      writeCountAs(GOV_AGENT_A, `update public.crm_tasks set assigned_to = '${GOV_AGENT_A}' where id = '${TASK_NULO_OFF}'`),
    ).toBe(1);
  });

  it("agent A ENTREGA uma tarefa a um colega mesmo com a opção desligada (entregar não é editar o do outro)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_tasks (organization_id, title, assigned_to, created_by)
           values ('${OFF_ORG}', 'Tarefa que o agent A entrega ao agent B (opção desligada)', '${GOV_AGENT_B}', '${GOV_AGENT_A}')`,
      ),
    ).toBe(1);
  });

  it("manager vê e edita o compromisso e a tarefa do atendente (a escada para em manager+)", () => {
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.calendar_appointments where id = '${APPT_B_OFF}';`),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.calendar_appointments set title = 'remarcado pelo manager (opção desligada)' where id = '${APPT_B_OFF}'`,
      ),
    ).toBe(1);
    expect(countAs(GOV_MANAGER, `select count(*) from public.crm_tasks where id = '${TASK_B_OFF}';`)).toBe(1);
  });

  it("viewer LÊ a agenda e as tarefas da equipe mesmo com a opção desligada (o gate é de escrita)", () => {
    expect(
      countAs(GOV_VIEWER, `select count(*) from public.calendar_appointments where id = '${APPT_B_OFF}';`),
    ).toBe(1);
    expect(countAs(GOV_VIEWER, `select count(*) from public.crm_tasks where id = '${TASK_B_OFF}';`)).toBe(1);
  });
});

describe("agenda e tarefas — organização em visibility_mode = 'own' e opção desligada (só os seus)", () => {
  it("⭐ agent A NÃO vê o compromisso do agent B (nem da mesma equipe)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.calendar_appointments where id = '${APPT_B_OWN}';`),
    ).toBe(0);
  });

  it("⭐ agent A NÃO vê o compromisso SEM dono (em 'own' a fila não conta)", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.calendar_appointments where id = '${APPT_NULO_OWN}';`),
    ).toBe(0);
  });

  it("⭐ agent A NÃO edita o compromisso do agent B (0 linhas)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.calendar_appointments set title = 'invadido' where id = '${APPT_B_OWN}'`,
      ),
    ).toBe(0);
  });

  it("⭐ agent A NÃO apaga o compromisso do agent B (0 linhas)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `delete from public.calendar_appointments where id = '${APPT_B_OWN_APAGAR}'`),
    ).toBe(0);
  });

  it("manager da org em 'own' vê o compromisso do atendente (a escada para em manager+)", () => {
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.calendar_appointments where id = '${APPT_B_OWN}';`),
    ).toBe(1);
  });

  it("⭐ agent A NÃO vê a tarefa do agent B", () => {
    expect(countAs(GOV_AGENT_A, `select count(*) from public.crm_tasks where id = '${TASK_B_OWN}';`)).toBe(0);
  });

  it("⭐ agent A NÃO edita a tarefa do agent B (0 linhas)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.crm_tasks set title = 'invadida' where id = '${TASK_B_OWN}'`,
      ),
    ).toBe(0);
  });

  it("⭐ agent A NÃO apaga a tarefa do agent B (0 linhas)", () => {
    expect(writeCountAs(GOV_AGENT_A, `delete from public.crm_tasks where id = '${TASK_B_OWN_APAGAR}'`)).toBe(0);
  });

  it("agent A vê a PRÓPRIA tarefa sem responsável — o criador é o que a mantém viva em 'own'", () => {
    // Sem o `created_by` na régua, a tarefa que nasce da tela sem responsável
    // (o estado INICIAL de `FormularioDeTarefa.tsx` é "Ninguém") ficaria
    // invisível para quem a escreveu — e o INSERT dela seria recusado.
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.crm_tasks where id = '${TASK_DO_AUTO_OWN}';`),
    ).toBe(1);
  });

  it("agent A CRIA tarefa sem responsável em 'own' (o formulário não vira 500)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_tasks (organization_id, title, assigned_to, created_by)
           values ('${OWN_ORG}', 'Tarefa sem responsável em own', null, '${GOV_AGENT_A}')`,
      ),
    ).toBe(1);
  });

  it("manager da org em 'own' vê a tarefa do atendente", () => {
    expect(countAs(GOV_MANAGER, `select count(*) from public.crm_tasks where id = '${TASK_B_OWN}';`)).toBe(1);
  });
});
