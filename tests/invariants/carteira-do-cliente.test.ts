/**
 * #2591 — Carteira do cliente no BANCO: dono por contato, escrita do servidor e
 * negócio novo que nasce com o dono (sem quebrar o rodízio).
 *
 * Este arquivo é a prova do lado que `tests/unit/carteira-do-cliente.test.ts`
 * não alcança: a migration 0622 (apêndice do baseline, aplicada pelo
 * `scripts/test-db.sh`).
 *
 * ─── O que se mede, e por quê ───────────────────────────────────────────────
 *
 * 1. A coluna existe E a SESSÃO não grava: a policy de escrita de `contacts` é
 *    `tenant_isolation_contacts_write`, FOR ALL cega a papel (é por isso que a
 *    issue dizia que um Atendente se põe como dono pela REST). Se o gatilho
 *    42501 não estiver lá, esta prova falha com a gravação passando.
 * 2. Só `manager`+ chama a porta; dono `viewer`/revogado não conta.
 * 3. O negócio novo SEM dono nasce com o dono do contato — e o que já veio com
 *    dono não muda, e sem carteira nada muda (é o rodízio de sempre).
 * 4. Dono que virou `viewer` ou que saiu da equipe deixa de contar (regra 5).
 * 5. Definir carteira adota, na mesma transação, os negócios abertos SEM dono.
 *
 * Organização própria (namespace `eeeeeeee-`) para não encostar em
 * `GOV_ORG` dos gov-*.test.ts, que rodam em paralelo no mesmo banco.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { columnExists, lastLine, sql } from "./gov-helpers";

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const AGENTE_A = "eeeeeeee-1111-4000-8000-000000000001"; // o vendedor dono
const AGENTE_B = "eeeeeeee-1111-4000-8000-000000000002"; // quem atende
const GESTOR = "eeeeeeee-1111-4000-8000-000000000003"; // manager (único que grava)
const SOMENTE_LEITURA = "eeeeeeee-1111-4000-8000-000000000004"; // viewer: não conta
const SAIU_DA_EQUIPE = "eeeeeeee-1111-4000-8000-000000000005"; // agent revogado
const PIPELINE = "eeeeeeee-5555-4000-8000-000000000001";
const ETAPA = "eeeeeeee-5555-4000-8000-000000000002";

const CONTATO_SEM_CARTEIRA = "eeeeeeee-3333-4000-8000-000000000001";
const CONTATO_DA_CARTEIRA = "eeeeeeee-3333-4000-8000-000000000002";

/** Roda um DML como `authenticated` (claims do usuário) e devolve o stderr quando recusado. */
function recusaGravacao(userId: string, dml: string): string {
  try {
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${dml};
    `);
    return "";
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
  }
}

/**
 * Chama a RPC como a rota chama: `service_role` (o único com EXECUTE), com o
 * ator explícito; devolve o stderr quando a função recusa.
 */
function chamaRpc(userId: string, dono: string, contato: string): string {
  try {
    sql(`
      set role service_role;
      select public.fn_definir_carteira_do_cliente('${ORG}', '${userId}', '${contato}', '${dono}', 'manual');
    `);
    return "";
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
  }
}

/** Quem é o dono gravado? `'NULL'` quando nulo (psql imprime linha vazia). */
function donoDe(contato: string): string {
  const out = sql(`select coalesce(carteira_user_id::text, 'NULL') from public.contacts where id = '${contato}';`);
  return lastLine(out);
}

/** Insere um negócio SEM dono e devolve o dono que o banco acabou gravando. */
function nasceNegocioSemDono(contato: string | null): string {
  const id = randomUUID();
  sql(`
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
      values ('${id}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'negocio de carteira', ${contato ? `'${contato}'` : "null"});
  `);
  return lastLine(sql(`select coalesce(owner_user_id::text, 'NULL') from public.crm_leads where id = '${id}';`));
}

/** Insere um negócio já com dono e devolve o dono gravado. */
function nasceNegocioComDono(contato: string, dono: string): string {
  const id = randomUUID();
  sql(`
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id, owner_user_id, owner_kind)
      values ('${id}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'negocio com dono', '${contato}', '${dono}', 'user');
  `);
  return lastLine(sql(`select coalesce(owner_user_id::text, 'NULL') from public.crm_leads where id = '${id}';`));
}

function carteiraDe(contato: string, dono: string): void {
  // Grava pelo SERVIDOR (postgres): é o estado de um dono já definido, que é
  // como os testes de papel daqui em diante começam.
  sql(`
    update public.contacts
       set carteira_user_id = '${dono}', carteira_origem = 'manual', carteira_definida_em = now()
     where id = '${contato}';
  `);
}

describe("carteira do cliente (#2591) — dono por contato, aviso e negócio novo", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values
        ('${AGENTE_A}', 'carteira-a@invariant.test'),
        ('${AGENTE_B}', 'carteira-b@invariant.test'),
        ('${GESTOR}', 'carteira-m@invariant.test'),
        ('${SOMENTE_LEITURA}', 'carteira-v@invariant.test'),
        ('${SAIU_DA_EQUIPE}', 'carteira-r@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'carteira-inv', 'Carteira Invariant Org', 'Carteira Inv')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${AGENTE_A}', '${ORG}', 'agent', now()),
        ('${AGENTE_B}', '${ORG}', 'agent', now()),
        ('${GESTOR}', '${ORG}', 'manager', now()),
        ('${SOMENTE_LEITURA}', '${ORG}', 'viewer', now()),
        ('${SAIU_DA_EQUIPE}', '${ORG}', 'agent', now())
      on conflict (user_id, organization_id) do nothing;
      -- Reexecução não pode herdar papel/estado dos testes anteriores.
      update public.user_organizations set role = 'agent', revoked_at = null
        where organization_id = '${ORG}' and user_id in ('${AGENTE_A}', '${AGENTE_B}', '${SAIU_DA_EQUIPE}');
      update public.user_organizations set role = 'viewer', revoked_at = null
        where organization_id = '${ORG}' and user_id = '${SOMENTE_LEITURA}';
      update public.user_organizations set role = 'manager', revoked_at = null
        where organization_id = '${ORG}' and user_id = '${GESTOR}';
      insert into public.contacts (id, organization_id, display_name) values
        ('${CONTATO_SEM_CARTEIRA}', '${ORG}', 'Contato Sem Carteira'),
        ('${CONTATO_DA_CARTEIRA}', '${ORG}', 'Contato Da Carteira')
      on conflict (id) do nothing;
      update public.contacts
         set carteira_user_id = null, carteira_origem = null, carteira_definida_em = null
       where organization_id = '${ORG}';
      insert into public.crm_pipelines (id, organization_id, name, slug)
        values ('${PIPELINE}', '${ORG}', 'Carteira Invariant', 'carteira-inv')
        on conflict (id) do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${ETAPA}', '${ORG}', '${PIPELINE}', 'Novo', 'novo', 9000)
        on conflict (id) do nothing;
    `);
  });

  afterAll(() => {
    sql(`
      delete from public.crm_leads where organization_id = '${ORG}';
      delete from public.user_organizations where organization_id = '${ORG}';
      delete from public.crm_stages where organization_id = '${ORG}';
      delete from public.crm_pipelines where organization_id = '${ORG}';
      delete from public.contacts where organization_id = '${ORG}';
      delete from public.organizations where id = '${ORG}';
      delete from auth.users where id in
        ('${AGENTE_A}', '${AGENTE_B}', '${GESTOR}', '${SOMENTE_LEITURA}', '${SAIU_DA_EQUIPE}');
    `);
  });

  it("a coluna do dono existe e a SESSÃO autenticada não consegue se dar carteira", () => {
    expect(columnExists("contacts", "carteira_user_id")).toBe(true);
    expect(columnExists("contacts", "carteira_origem")).toBe(true);
    expect(columnExists("contacts", "carteira_definida_em")).toBe(true);

    // O defeito da issue: a policy de escrita de contacts é cega a papel.
    // Sem o gatilho 42501, o Atendente grava a própria carteira e leva o
    // negócio seguinte. O stderr tem de ser o DO GATILHO, não RLS (RLS aqui
    // deixa passar: membership-only).
    const aoAtualizar = recusaGravacao(
      AGENTE_A,
      `update public.contacts set carteira_user_id = '${AGENTE_A}' where id = '${CONTATO_DA_CARTEIRA}'`,
    );
    expect(aoAtualizar).toContain("contacts_carteira_so_pelo_servidor");

    const aoInserir = recusaGravacao(
      AGENTE_A,
      `insert into public.contacts (id, organization_id, display_name, carteira_user_id)
         values ('${randomUUID()}', '${ORG}', 'Tenta Se Dar Carteira', '${AGENTE_A}')`,
    );
    expect(aoInserir).toContain("contacts_carteira_so_pelo_servidor");

    // E não é "não passou por causa de outra coisa": sem mexer no dono, a
    // mesma política deixa a gravação normal acontecer.
    const normal = recusaGravacao(
      AGENTE_A,
      `update public.contacts set display_name = 'Contato Da Carteira' where id = '${CONTATO_DA_CARTEIRA}'`,
    );
    expect(normal).toBe("");
    expect(donoDe(CONTATO_DA_CARTEIRA)).toBe("NULL");
  });

  it("só manager+ define a carteira, e dono que não conta é recusado", () => {
    // Atendente não é dono da carteira do colega pela porta.
    const atendente = chamaRpc(AGENTE_A, AGENTE_A, CONTATO_DA_CARTEIRA);
    expect(atendente).toContain("carteira_permissao_negada");
    expect(donoDe(CONTATO_DA_CARTEIRA)).toBe("NULL");

    // Gestor sim — e a gravação é do servidor, não da sessão.
    expect(chamaRpc(GESTOR, AGENTE_A, CONTATO_DA_CARTEIRA)).toBe("");
    expect(donoDe(CONTATO_DA_CARTEIRA)).toBe(AGENTE_A);

    // `viewer` não conta como dono (regra 5).
    const somenteLeitura = chamaRpc(GESTOR, SOMENTE_LEITURA, CONTATO_SEM_CARTEIRA);
    expect(somenteLeitura).toContain("carteira_dono_invalido");
    expect(donoDe(CONTATO_SEM_CARTEIRA)).toBe("NULL");

    // Membro revogado não conta.
    sql(`update public.user_organizations set revoked_at = now()
           where organization_id = '${ORG}' and user_id = '${SAIU_DA_EQUIPE}';`);
    const revogado = chamaRpc(GESTOR, SAIU_DA_EQUIPE, CONTATO_SEM_CARTEIRA);
    expect(revogado).toContain("carteira_dono_invalido");
    expect(donoDe(CONTATO_SEM_CARTEIRA)).toBe("NULL");
    sql(`update public.user_organizations set revoked_at = null
           where organization_id = '${ORG}' and user_id = '${SAIU_DA_EQUIPE}';`);
  });

  it("o negócio novo sem dono nasce com o dono do contato; o resto continua como sempre", () => {
    carteiraDe(CONTATO_DA_CARTEIRA, AGENTE_A);

    // (a) O alvo: negócio SEM dono para o contato da carteira → nasce com o dono.
    expect(nasceNegocioSemDono(CONTATO_DA_CARTEIRA)).toBe(AGENTE_A);

    // (b) Contato SEM carteira → nada muda: é o rodízio de hoje que decide.
    expect(nasceNegocioSemDono(CONTATO_SEM_CARTEIRA)).toBe("NULL");

    // (c) Sem contato (lead órfão) → nada muda.
    expect(nasceNegocioSemDono(null)).toBe("NULL");

    // (d) Negócio que já tem dono não muda por causa de uma carteira.
    expect(nasceNegocioComDono(CONTATO_DA_CARTEIRA, AGENTE_B)).toBe(AGENTE_B);
  });

  it("dono que virou viewer ou que saiu da equipe não conta mais", () => {
    // (a) O dono deixa de ser dono na MESMA transação em que vira viewer.
    carteiraDe(CONTATO_DA_CARTEIRA, SOMENTE_LEITURA);
    expect(nasceNegocioSemDono(CONTATO_DA_CARTEIRA)).toBe("NULL");

    // (b) Saiu da equipe (revogado) → a carteira não entrega o negócio.
    carteiraDe(CONTATO_DA_CARTEIRA, SAIU_DA_EQUIPE);
    sql(`update public.user_organizations set revoked_at = now()
           where organization_id = '${ORG}' and user_id = '${SAIU_DA_EQUIPE}';`);
    expect(nasceNegocioSemDono(CONTATO_DA_CARTEIRA)).toBe("NULL");
    sql(`update public.user_organizations set revoked_at = null
           where organization_id = '${ORG}' and user_id = '${SAIU_DA_EQUIPE}';`);

    // De volta ao dono que conta, para o teste seguinte não herdar sujeira.
    carteiraDe(CONTATO_DA_CARTEIRA, AGENTE_A);
  });

  it("definir a carteira adota, na mesma transação, os negócios abertos SEM dono", () => {
    // O cliente é do A desde sempre, mas só agora virou carteira: os negócios
    // abertos sem dono passam para ele; os que já têm dono ficam.
    sql(`update public.contacts
           set carteira_user_id = null, carteira_origem = null, carteira_definida_em = null
         where id = '${CONTATO_DA_CARTEIRA}';`);

    const abertoSemDono = randomUUID();
    const abertoComDono = randomUUID();
    sql(`
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
        values ('${abertoSemDono}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'aberto sem dono', '${CONTATO_DA_CARTEIRA}'),
               ('${abertoComDono}', '${ORG}', '${PIPELINE}', '${ETAPA}', 'aberto com dono', '${CONTATO_DA_CARTEIRA}');
      update public.crm_leads set owner_user_id = '${AGENTE_B}', owner_kind = 'user'
        where id = '${abertoComDono}';
    `);

    expect(chamaRpc(GESTOR, AGENTE_A, CONTATO_DA_CARTEIRA)).toBe("");
    expect(donoDe(CONTATO_DA_CARTEIRA)).toBe(AGENTE_A);
    expect(lastLine(sql(`select owner_user_id from public.crm_leads where id = '${abertoSemDono}';`))).toBe(AGENTE_A);
    // O negócio com dono não muda (ninguém perde carteira por causa de uma carteira).
    expect(lastLine(sql(`select owner_user_id from public.crm_leads where id = '${abertoComDono}';`))).toBe(AGENTE_B);
  });
});
