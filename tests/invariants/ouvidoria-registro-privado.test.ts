import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { columnExists, countAs, indexExists, sql } from "./gov-helpers";

/**
 * `ouvidoria_manifestacoes` (migration 9030, #3611): a manifestação é PRIVADA.
 *
 * Quatro fatos, cada um com a sua falha muda:
 *
 * 1. **Papel.** Só `admin` (e acima) da própria organização lê. `agent` e
 *    `viewer` recebem ZERO — não `permission denied`, e isso é de propósito: a
 *    policy é de linha, e o PostgREST responde lista vazia. Quem quiser ver a
 *    recusa explícita tem a camada de cima (`app/actions/ouvidoria/ler-manifestacao.ts`,
 *    medida em `app/actions/ouvidoria/ler-manifestacao.test.ts`).
 * 2. **Tenant.** Admin de A não lê a manifestação de B, nos dois sentidos.
 * 3. **Escrita.** `authenticated` não insere, altera nem apaga — o canal grava
 *    com `service_role`, e é o único caminho. Sem isto, o próprio administrador
 *    "corrigiria" o texto de uma manifestação pelo PostgREST, e a trilha não
 *    saberia.
 * 4. **Protocolo.** Único POR ORGANIZAÇÃO (o número é da empresa, não da
 *    instalação) e com forma fechada — protocolo digitado à mão é recusado pelo
 *    CHECK, não só ignorado pela aplicação.
 *
 * A tabela está em `PROVA_PROPRIA` de `rls-completude-varredura.test.ts`: o seed
 * de `rls-isolation.test.ts` é `agent`, e aqui o controle positivo exige `admin`
 * — o caso passaria por ACERTO lá, que é o motivo escrito naquela lista.
 */
const orgA = randomUUID();
const orgB = randomUUID();
const adminA = randomUUID();
const agentA = randomUUID();
const viewerA = randomUUID();
const adminB = randomUUID();
const contatoA = randomUUID();
const manA = randomUUID();
const manB = randomUUID();
const PROTOCOLO_A = "OUV-20261028-AAAABBBB";
const PROTOCOLO_B = "OUV-20261028-AAAABBBB";

beforeAll(() => {
  sql(`insert into auth.users (id, email) values
      ('${adminA}', 'ouv-admin-a@invariant.test'),
      ('${agentA}', 'ouv-agent-a@invariant.test'),
      ('${viewerA}', 'ouv-viewer-a@invariant.test'),
      ('${adminB}', 'ouv-admin-b@invariant.test');`);
  sql(`insert into organizations (id, slug, legal_name, display_name) values
      ('${orgA}', 'ouv-${orgA}', 'Ouvidoria A', 'Ouv A'),
      ('${orgB}', 'ouv-${orgB}', 'Ouvidoria B', 'Ouv B');
    insert into user_organizations (user_id, organization_id, role, accepted_at) values
      ('${adminA}', '${orgA}', 'admin', now()),
      ('${agentA}', '${orgA}', 'agent', now()),
      ('${viewerA}', '${orgA}', 'viewer', now()),
      ('${adminB}', '${orgB}', 'admin', now());
    insert into contacts (id, organization_id, display_name)
      values ('${contatoA}', '${orgA}', 'Quem reclamou');`);
  // O MESMO protocolo nas duas organizações: é o caso que prova que a
  // unicidade é por empresa, e não por instalação.
  sql(`insert into ouvidoria_manifestacoes
      (id, organization_id, protocolo, canal, texto, contact_id)
      values
      ('${manA}', '${orgA}', '${PROTOCOLO_A}', 'whatsapp', 'Relato privado da empresa A.', '${contatoA}'),
      ('${manB}', '${orgB}', '${PROTOCOLO_B}', 'telefone', 'Relato privado da empresa B.', null);`);
});

describe("ouvidoria_manifestacoes: leitura por papel e por organização", () => {
  it("admin lê a manifestação da própria organização e NÃO a da outra", () => {
    expect(countAs(adminA, `select count(*) from ouvidoria_manifestacoes where id = '${manA}';`)).toBe(1);
    expect(countAs(adminA, `select count(*) from ouvidoria_manifestacoes where id = '${manB}';`)).toBe(0);
    expect(countAs(adminB, `select count(*) from ouvidoria_manifestacoes where id = '${manA}';`)).toBe(0);
    expect(countAs(adminB, `select count(*) from ouvidoria_manifestacoes where id = '${manB}';`)).toBe(1);
  });

  it("agent e viewer da MESMA organização não leem nada", () => {
    for (const usuario of [agentA, viewerA]) {
      expect(countAs(usuario, `select count(*) from ouvidoria_manifestacoes;`)).toBe(0);
    }
  });

  it("nenhuma linha escapa sem filtro: a tabela inteira vista pelo admin de A é só a de A", () => {
    expect(countAs(adminA, `select count(*) from ouvidoria_manifestacoes;`)).toBe(1);
  });
});

describe("ouvidoria_manifestacoes: escrita só pelo service_role", () => {
  it("authenticated não tem insert/update/delete; anon não lê; service_role tem", () => {
    expect(
      sql(`select has_table_privilege('authenticated','public.ouvidoria_manifestacoes','insert'),
        has_table_privilege('authenticated','public.ouvidoria_manifestacoes','update'),
        has_table_privilege('authenticated','public.ouvidoria_manifestacoes','delete'),
        has_table_privilege('anon','public.ouvidoria_manifestacoes','select'),
        has_table_privilege('service_role','public.ouvidoria_manifestacoes','insert'),
        has_table_privilege('service_role','public.ouvidoria_manifestacoes','update');`),
      // O `select` de `authenticated` existe de propósito (é a leitura da tela);
      // o de `service_role`, também.
    ).toBe("f|f|f|f|t|t");
    expect(sql(`select has_table_privilege('authenticated','public.ouvidoria_manifestacoes','select');`)).toBe("t");
  });

  it("o admin da organização NÃO consegue alterar nem apagar pelo PostgREST", () => {
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${adminA}"}', false);
        update ouvidoria_manifestacoes set texto = 'reescrito' where id = '${manA}';`),
    ).toThrow(/permission denied/);
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${adminA}"}', false);
        delete from ouvidoria_manifestacoes where id = '${manA}';`),
    ).toThrow(/permission denied/);
    // Nada mudou.
    expect(sql(`select texto from ouvidoria_manifestacoes where id = '${manA}';`)).toBe("Relato privado da empresa A.");
  });

  it("o service_role grava: é o caminho do canal", () => {
    const nova = randomUUID();
    sql(`set role service_role;
      insert into ouvidoria_manifestacoes (id, organization_id, protocolo, canal, texto)
        values ('${nova}', '${orgA}', 'OUV-20261028-CCCCDDDD', 'web', 'Relato gravado pelo canal.');
      reset role;`);
    expect(sql(`select count(*) from ouvidoria_manifestacoes where id = '${nova}';`)).toBe("1");
    sql(`delete from ouvidoria_manifestacoes where id = '${nova}';`);
  });
});

describe("ouvidoria_manifestacoes: protocolo, forma e ciclo do contato", () => {
  it("o protocolo é único POR ORGANIZAÇÃO — a mesma empresa não repete, empresas diferentes sim", () => {
    // A mesma organização: o índice único barra.
    expect(() =>
      sql(`insert into ouvidoria_manifestacoes (organization_id, protocolo, canal, texto)
        values ('${orgA}', '${PROTOCOLO_A}', 'web', 'Protocolo repetido na mesma empresa.');`),
    ).toThrow(/ouvidoria_manifestacoes_protocolo_org_idx/);
    // Já o mesmo número em OUTRA organização entrou no seed — a prova é a linha de B.
    expect(sql(`select count(*) from ouvidoria_manifestacoes where protocolo = '${PROTOCOLO_A}';`)).toBe("2");
  });

  it("protocolo fora da forma do servidor é recusado pelo CHECK", () => {
    for (const inventado of ["OUV-123", "12345", "OUV-20261028-zzzzzzzz", "' OR 1=1 --"]) {
      expect(() =>
        sql(`insert into ouvidoria_manifestacoes (organization_id, protocolo, canal, texto)
          values ('${orgA}', $prot$${inventado}$prot$, 'web', 'Protocolo digitado à mão.');`),
      ).toThrow(/check constraint/);
    }
  });

  it("canal e status fora do conjunto são recusados; nasce `recebida`", () => {
    expect(() =>
      sql(`insert into ouvidoria_manifestacoes (organization_id, protocolo, canal, texto)
        values ('${orgA}', 'OUV-20261028-EEEEFFFF', 'pombo-correio', 'Canal inventado.');`),
    ).toThrow(/check constraint/);
    expect(() =>
      sql(`insert into ouvidoria_manifestacoes (organization_id, protocolo, canal, texto, status)
        values ('${orgA}', 'OUV-20261028-EEEEFFFF', 'web', 'Status inventado.', 'arquivada');`),
    ).toThrow(/check constraint/);
    expect(sql(`select status from ouvidoria_manifestacoes where id = '${manA}';`)).toBe("recebida");
  });

  it("texto vazio é recusado (manifestação sem relato não é manifestação)", () => {
    expect(() =>
      sql(`insert into ouvidoria_manifestacoes (organization_id, protocolo, canal, texto)
        values ('${orgA}', 'OUV-20261028-EEEEFFFF', 'web', '   ');`),
    ).toThrow(/check constraint/);
  });

  it("apagar o contato NÃO apaga a manifestação: o protocolo sobrevive (set null)", () => {
    expect(sql(`select contact_id is not null from ouvidoria_manifestacoes where id = '${manA}';`)).toBe("t");
    sql(`delete from contacts where id = '${contatoA}';`);
    expect(sql(`select contact_id is null from ouvidoria_manifestacoes where id = '${manA}';`)).toBe("t");
    expect(sql(`select count(*) from ouvidoria_manifestacoes where id = '${manA}';`)).toBe("1");
  });
});

describe("ouvidoria_manifestacoes: a forma da tabela depois do corte de 30/10", () => {
  it("RLS ligada, índices no lugar e o comentário da coluna aplicado", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.ouvidoria_manifestacoes'::regclass;`)).toBe("t");
    expect(indexExists("ouvidoria_manifestacoes_protocolo_org_idx")).toBe(true);
    expect(indexExists("ouvidoria_manifestacoes_org_created_idx")).toBe(true);
    expect(columnExists("ouvidoria_manifestacoes", "protocolo")).toBe(true);
    expect(
      sql(`select coalesce(col_description('public.ouvidoria_manifestacoes'::regclass, attnum) <> '', false)
        from pg_attribute
        where attrelid = 'public.ouvidoria_manifestacoes'::regclass and attname = 'protocolo';`),
    ).toBe("t");
  });

  it("nenhuma coluna, FK ou gatilho leva a manifestação ao funil", () => {
    // O controle central da issue, medido no BANCO: se alguém acrescentar um
    // `lead_id` (ou uma FK para `crm_leads`) numa fatia futura, este caso cai.
    expect(
      sql(`select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'ouvidoria_manifestacoes'
          and column_name in ('lead_id', 'pipeline_id', 'stage_id');`),
    ).toBe("0");
    expect(
      sql(`select count(*) from pg_constraint
        where conrelid = 'public.ouvidoria_manifestacoes'::regclass and confrelid = 'public.crm_leads'::regclass;`),
    ).toBe("0");
    expect(
      sql(`select count(*) from pg_trigger
        where tgrelid = 'public.ouvidoria_manifestacoes'::regclass and not tgisinternal;`),
    ).toBe("0");
  });
});
