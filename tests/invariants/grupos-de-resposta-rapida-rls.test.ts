/**
 * GRUPOS DE RESPOSTAS RÁPIDAS (migration 0808, #3245) — O PAPEL, NÃO SÓ A
 * ORGANIZAÇÃO.
 *
 * O recorte do recurso é "grupo é estrutura COMPARTILHADA": qualquer membro da
 * organização LÊ (o atendente precisa ver as etapas para vincular a própria
 * resposta), e só `manager+` ESCREVE (criar, renomear, reordenar, apagar muda a
 * organização de todo mundo). Uma policy `for all` só-tenancy passaria num
 * gate de catálogo e deixaria o `agent` apagar o grupo da equipe — este arquivo
 * mede o COMPORTAMENTO com o JWT de cada papel da organização semeada.
 *
 * O que fica provado, um caso por afirmação:
 *
 *   - leitura: viewer/agent/manager/admin leem o grupo da própria organização;
 *     ninguém lê o da outra (contagem cruzada nos dois sentidos, com uma linha
 *     REAL semeada na outra organização e um controle de que ela existe);
 *   - escrita: agent e viewer NÃO criam, NÃO renomeiam e NÃO apagam; manager
 *     cria, renomeia e apaga (controle positivo — senão a policy seria um
 *     deny-all que passa por "seguro");
 *   - `anon` não tem privilégio NENHUM: select, insert, update e delete dão
 *     `permission denied` — não é RLS filtrando, é GRANT ausente;
 *   - o GRANT explícito a `authenticated` existe (o corte de 30/10, #3140
 *     tira o privilégio herdado de tabela nova em `public`; esta tabela o
 *     declara no corpo da migration);
 *   - a FK COMPOSTA recusa resposta apontando para grupo de OUTRA organização;
 *   - apagar o grupo devolve as respostas à lista plana (`on delete set null
 *     (grupo_id)`) e NÃO apaga resposta nenhuma — a compatibilidade que a issue
 *     exige: quem apaga o grupo volta a ver a lista de hoje.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  columnExists,
  countAs,
  seedGov,
  sql,
  tableExists,
  writeCountAs,
} from "./gov-helpers";

/** A outra organização — existe só para a contagem cruzada. Namespace `dddd`. */
const ORG_B = "dddddddd-0000-4000-8000-000000000001";
const GRUPO_A = "dddddddd-1111-4000-8000-000000000001";
const GRUPO_A_LIVRE = "dddddddd-1111-4000-8000-000000000002";
const GRUPO_B = "dddddddd-1111-4000-8000-000000000003";
const RESPOSTA_A = "dddddddd-2222-4000-8000-000000000001";

const contar = (where: string) => `select count(*) from public.message_template_groups where ${where};`;

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'gov-inv-b', 'Gov Invariant Org B', 'Gov Inv B')
      on conflict do nothing;

    insert into public.message_template_groups (id, organization_id, name, ordem)
      values
        ('${GRUPO_A}',      '${GOV_ORG}', 'Atendimento inicial', 1000),
        ('${GRUPO_A_LIVRE}','${GOV_ORG}', 'Objeção',             2000),
        ('${GRUPO_B}',      '${ORG_B}',   'Grupo do vizinho',    1000)
      on conflict (id) do nothing;

    insert into public.message_templates (id, organization_id, title, body, grupo_id, ordem)
      values ('${RESPOSTA_A}', '${GOV_ORG}', 'Prazo de entrega', 'Chega em 5 dias.', '${GRUPO_A}', 1000)
      on conflict (id) do nothing;
  `);
});

describe("0808 — message_template_groups: forma do schema", () => {
  it("a tabela e a coluna do vínculo existem", () => {
    expect(tableExists("message_template_groups")).toBe(true);
    expect(columnExists("message_templates", "grupo_id")).toBe(true);
  });

  it("o vínculo é FK COMPOSTA com `on delete set null (grupo_id)`", () => {
    const definicao = sql(`
      select pg_get_constraintdef(oid)
        from pg_constraint
       where conname = 'message_templates_grupo_fkey';
    `);
    expect(definicao).toContain("FOREIGN KEY (organization_id, grupo_id)");
    expect(definicao).toContain("message_template_groups(organization_id, id)");
    // A lista de colunas do SET NULL é o que impede o DELETE de tentar anular
    // `organization_id` (NOT NULL) junto com o grupo.
    expect(definicao).toContain("ON DELETE SET NULL (grupo_id)");
  });

  it("o GRANT explícito a `authenticated` está no catálogo — e `anon` não tem nenhum", () => {
    const privilegios = (papel: string) =>
      sql(`
        select string_agg(p, ',' order by p) from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p
         where has_table_privilege('${papel}', 'public.message_template_groups', p);
      `);
    expect(privilegios("authenticated")).toBe("DELETE,INSERT,SELECT,UPDATE");
    expect(privilegios("anon")).toBe("");
  });
});

describe("0808 — message_template_groups: leitura por papel", () => {
  it("CONTROLE POSITIVO: viewer, agent, manager e admin leem o grupo da própria organização", () => {
    for (const usuario of [GOV_VIEWER, GOV_AGENT_A, GOV_MANAGER, GOV_ADMIN]) {
      expect(countAs(usuario, contar(`organization_id = '${GOV_ORG}'`))).toBe(2);
    }
  });

  it("nenhum membro de A lê o grupo de B — nem admin", () => {
    for (const usuario of [GOV_AGENT_A, GOV_ADMIN]) {
      expect(countAs(usuario, contar(`organization_id = '${ORG_B}'`))).toBe(0);
    }
  });

  it("a linha do vizinho EXISTE (o zero acima é isolamento, não tabela vazia)", () => {
    expect(sql(contar(`organization_id = '${ORG_B}'`))).toBe("1");
  });

  it("`anon` não lê: permission denied, não lista vazia", () => {
    expect(() => sql(`set role anon; select count(*) from public.message_template_groups;`)).toThrow(
      /permission denied/,
    );
  });
});

describe("0808 — message_template_groups: escrita por papel", () => {
  const criar = (nome: string) =>
    `insert into public.message_template_groups (organization_id, name, ordem)
       values ('${GOV_ORG}', '${nome}', 9000)`;

  it("agent NÃO cria grupo", () => {
    expect(writeCountAs(GOV_AGENT_A, criar("Grupo do agent"))).toBe(0);
  });

  it("viewer NÃO cria grupo", () => {
    expect(writeCountAs(GOV_VIEWER, criar("Grupo do viewer"))).toBe(0);
  });

  it("agent NÃO renomeia grupo da equipe", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.message_template_groups set name = 'tomado' where id = '${GRUPO_A_LIVRE}'`,
      ),
    ).toBe(0);
    expect(sql(`select name from public.message_template_groups where id = '${GRUPO_A_LIVRE}';`)).toBe(
      "Objeção",
    );
  });

  it("agent NÃO apaga grupo da equipe", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `delete from public.message_template_groups where id = '${GRUPO_A_LIVRE}'`),
    ).toBe(0);
    expect(sql(contar(`id = '${GRUPO_A_LIVRE}'`))).toBe("1");
  });

  it("CONTROLE POSITIVO: manager cria, renomeia e apaga", () => {
    expect(writeCountAs(GOV_MANAGER, criar("Grupo do manager"))).toBe(1);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.message_template_groups set name = 'Objeções' where id = '${GRUPO_A_LIVRE}'`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(GOV_MANAGER, `delete from public.message_template_groups where id = '${GRUPO_A_LIVRE}'`),
    ).toBe(1);
  });

  it("`anon` não escreve: permission denied no INSERT", () => {
    expect(() =>
      sql(`set role anon; ${criar("Grupo anônimo")};`),
    ).toThrow(/permission denied/);
  });
});

describe("0808 — o vínculo com a resposta rápida", () => {
  it("a FK composta RECUSA resposta de A apontando para grupo de B", () => {
    expect(() =>
      sql(`
        insert into public.message_templates (organization_id, title, body, grupo_id)
          values ('${GOV_ORG}', 'Forjada', 'x', '${GRUPO_B}');
      `),
    ).toThrow(/message_templates_grupo_fkey|violates foreign key/);
  });

  it("apagar o grupo devolve a resposta à lista plana — e NÃO apaga a resposta", () => {
    // O grupo tem uma resposta vinculada (RESPOSTA_A). O DELETE é do manager.
    expect(
      writeCountAs(GOV_MANAGER, `delete from public.message_template_groups where id = '${GRUPO_A}'`),
    ).toBe(1);
    expect(sql(`select grupo_id::text from public.message_templates where id = '${RESPOSTA_A}';`)).toBe(
      "",
    );
    expect(sql(`select count(*) from public.message_templates where id = '${RESPOSTA_A}';`)).toBe("1");
  });
});
