/**
 * A23 parte 2 (#4888) — a importação abre ao Atendente e define o dono da carteira.
 * Migration 9431 (apêndice do baseline).
 *
 * Duas provas, no banco de verdade:
 *
 * 1. O Atendente passa a gravar `import_batches` e `import_rows` (piso `agent`), e o
 *    `viewer` continua recusado. O DELETE segue `manager`.
 * 2. `fn_definir_carteira_do_cliente` ganhou UMA exceção para o Atendente, a
 *    importação própria: contato SEM dono, criado por ele com `source = 'import_csv'`,
 *    dono pedido = ele mesmo e origem `importacao`. TODO o resto segue recusado — e é
 *    isso que este arquivo vigia, porque abrir a exceção larga demais devolve o
 *    defeito do #2591 (o Atendente se põe como dono do cliente do colega).
 *
 * Organização própria (`ffffffff-`), longe dos `gov-*` e do `eeeeeeee-` da carteira.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "ffffffff-0000-4000-8000-000000000001";
const ATENDENTE = "ffffffff-1111-4000-8000-000000000001";
const COLEGA = "ffffffff-1111-4000-8000-000000000002";
const GESTOR = "ffffffff-1111-4000-8000-000000000003";
const LEITOR = "ffffffff-1111-4000-8000-000000000004";

const C_DA_IMPORTACAO = "ffffffff-3333-4000-8000-000000000001"; // criado por ele, import_csv, sem dono
const C_DE_OUTRO_ORIGEM = "ffffffff-3333-4000-8000-000000000002"; // criado por ele, mas source manual
const C_DE_OUTRO_AUTOR = "ffffffff-3333-4000-8000-000000000003"; // import_csv, criado pelo colega
const C_COM_DONO = "ffffffff-3333-4000-8000-000000000004"; // import_csv dele, mas já na carteira do colega
const C_DO_GESTOR = "ffffffff-3333-4000-8000-000000000005"; // import_csv do gestor, para o gestor escolher outro dono

/** Grava como `authenticated` (claims do usuário) e devolve o stderr quando recusado. */
function recusa(userId: string, dml: string): string {
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

/** Chama a função como a rota: `service_role`, com o ator explícito. */
function definir(ator: string, dono: string, contato: string, origem = "importacao"): string {
  try {
    sql(`
      set role service_role;
      select public.fn_definir_carteira_do_cliente('${ORG}', '${ator}', '${contato}', '${dono}', '${origem}');
    `);
    return "";
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? "").replace(/\s+/g, " ");
  }
}

function donoDe(contato: string): string {
  return lastLine(sql(`select coalesce(carteira_user_id::text, 'NULL') from public.contacts where id = '${contato}';`));
}

describe("importação: o Atendente importa e é dono do que importa (9431)", () => {
  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values
        ('${ATENDENTE}', 'imp-a@invariant.test'), ('${COLEGA}', 'imp-c@invariant.test'),
        ('${GESTOR}', 'imp-g@invariant.test'), ('${LEITOR}', 'imp-l@invariant.test')
      on conflict (id) do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG}', 'importacao-9431', 'Importacao 9431', 'Importacao 9431')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
        ('${ATENDENTE}', '${ORG}', 'agent', now()), ('${COLEGA}', '${ORG}', 'agent', now()),
        ('${GESTOR}', '${ORG}', 'manager', now()), ('${LEITOR}', '${ORG}', 'viewer', now())
      on conflict (user_id, organization_id) do nothing;
      insert into public.contacts (id, organization_id, display_name, source, created_by_user_id) values
        ('${C_DA_IMPORTACAO}', '${ORG}', 'Da importação', 'import_csv', '${ATENDENTE}'),
        ('${C_DE_OUTRO_ORIGEM}', '${ORG}', 'Cadastro manual', 'manual', '${ATENDENTE}'),
        ('${C_DE_OUTRO_AUTOR}', '${ORG}', 'Importado pelo colega', 'import_csv', '${COLEGA}'),
        ('${C_COM_DONO}', '${ORG}', 'Já tem dono', 'import_csv', '${ATENDENTE}'),
        ('${C_DO_GESTOR}', '${ORG}', 'Do gestor', 'import_csv', '${GESTOR}')
      on conflict (id) do nothing;
      update public.contacts set carteira_user_id = '${COLEGA}', carteira_origem = 'manual', carteira_definida_em = now()
        where id = '${C_COM_DONO}';
    `);
  });

  afterAll(() => {
    sql(`
      delete from public.import_rows where organization_id = '${ORG}';
      delete from public.import_batches where organization_id = '${ORG}';
      delete from public.contacts where organization_id = '${ORG}';
      delete from public.user_organizations where organization_id = '${ORG}';
      delete from public.organizations where id = '${ORG}';
      delete from auth.users where id in ('${ATENDENTE}', '${COLEGA}', '${GESTOR}', '${LEITOR}');
    `);
  });

  describe("permissão de gravar o lote (piso agent)", () => {
    const lote = (id: string) =>
      `insert into public.import_batches (id, organization_id, filename, created_by) values ('${id}', '${ORG}', 'a.csv', '${ATENDENTE}')`;

    it("o Atendente grava o lote e as linhas", () => {
      expect(recusa(ATENDENTE, lote("ffffffff-9999-4000-8000-000000000001"))).toBe("");
      expect(
        recusa(
          ATENDENTE,
          `insert into public.import_rows (organization_id, batch_id, row_number) values ('${ORG}', 'ffffffff-9999-4000-8000-000000000001', 1)`,
        ),
      ).toBe("");
      expect(
        recusa(ATENDENTE, `update public.import_batches set status = 'processing' where id = 'ffffffff-9999-4000-8000-000000000001'`),
      ).toBe("");
    });

    it("o Atendente muda o andamento do PRÓPRIO lote, mas não a identidade dele (trigger)", () => {
      const id = "ffffffff-9999-4000-8000-000000000001";
      expect(recusa(ATENDENTE, `update public.import_batches set status = 'completed', successful_rows = 3 where id = '${id}'`)).toBe("");
      for (const [coluna, valor] of [
        ["filename", "'outro.csv'"],
        ["created_by", `'${COLEGA}'`],
        ["kind", "'contacts'"],
        ["created_at", "now() - interval '1 year'"],
      ]) {
        expect(recusa(ATENDENTE, `update public.import_batches set ${coluna} = ${valor} where id = '${id}'`)).toMatch(
          /colunas_do_lote_sao_do_sistema/,
        );
      }
    });

    it("o Atendente NÃO atualiza o lote do colega (o gerente atualiza)", () => {
      const doColega = "ffffffff-9999-4000-8000-000000000003";
      sql(
        `insert into public.import_batches (id, organization_id, filename, created_by) values ('${doColega}', '${ORG}', 'colega.csv', '${COLEGA}') on conflict (id) do nothing;`,
      );
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${ATENDENTE}"}', false);
        update public.import_batches set status = 'failed' where id = '${doColega}';
      `);
      // A policy não deixa a linha visível para o UPDATE: zero linhas mudam, sem erro.
      expect(lastLine(sql(`select status from public.import_batches where id = '${doColega}';`))).toBe("pending");
      expect(recusa(GESTOR, `update public.import_batches set status = 'completed' where id = '${doColega}'`)).toBe("");
      expect(lastLine(sql(`select status from public.import_batches where id = '${doColega}';`))).toBe("completed");
    });

    it("o Atendente NÃO atualiza as linhas do lote do colega", () => {
      const doColega = "ffffffff-9999-4000-8000-000000000003";
      sql(
        `insert into public.import_rows (organization_id, batch_id, row_number) values ('${ORG}', '${doColega}', 1) on conflict do nothing;`,
      );
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${ATENDENTE}"}', false);
        update public.import_rows set status = 'failed' where batch_id = '${doColega}';
      `);
      expect(lastLine(sql(`select status from public.import_rows where batch_id = '${doColega}' and row_number = 1;`))).toBe("pending");
    });

    it("o Atendente NÃO insere linha no lote do colega (o gerente insere)", () => {
      const doColega = "ffffffff-9999-4000-8000-000000000003";
      sql(
        `insert into public.import_batches (id, organization_id, filename, created_by) values ('${doColega}', '${ORG}', 'colega.csv', '${COLEGA}') on conflict (id) do nothing;`,
      );
      const linha = (n: number) =>
        `insert into public.import_rows (organization_id, batch_id, row_number) values ('${ORG}', '${doColega}', ${n})`;
      expect(recusa(ATENDENTE, linha(901))).toMatch(/row-level security/i);
      expect(recusa(GESTOR, linha(902))).toBe("");
      expect(
        Number(lastLine(sql(`select count(*) from public.import_rows where batch_id = '${doColega}' and row_number = 901;`))),
      ).toBe(0);
    });

    it("o lote nasce com o PRÓPRIO autor: `created_by` de outra pessoa ou nulo é recusado na sessão", () => {
      const novo = (id: string, autor: string) =>
        `insert into public.import_batches (id, organization_id, filename, created_by) values ('${id}', '${ORG}', 'forjado.csv', ${autor})`;
      expect(recusa(ATENDENTE, novo("ffffffff-9999-4000-8000-000000000011", `'${COLEGA}'`))).toMatch(/row-level security/i);
      expect(recusa(ATENDENTE, novo("ffffffff-9999-4000-8000-000000000012", "null"))).toMatch(/row-level security/i);
      expect(recusa(ATENDENTE, novo("ffffffff-9999-4000-8000-000000000013", `'${ATENDENTE}'`))).toBe("");
    });

    it("o leitor (viewer) continua recusado", () => {
      expect(recusa(LEITOR, lote("ffffffff-9999-4000-8000-000000000002"))).toMatch(/row-level security/i);
    });

    it("excluir o lote segue sendo do gerente", () => {
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${ATENDENTE}"}', false);
        delete from public.import_batches where id = 'ffffffff-9999-4000-8000-000000000001';
      `);
      // O DELETE do Atendente não apaga nada (a política exige manager).
      expect(
        Number(lastLine(sql(`select count(*) from public.import_batches where id = 'ffffffff-9999-4000-8000-000000000001';`))),
      ).toBe(1);
      expect(recusa(GESTOR, `delete from public.import_batches where id = 'ffffffff-9999-4000-8000-000000000001'`)).toBe("");
    });
  });

  describe("a posse do Atendente na importação própria", () => {
    it("contato que ele criou na importação, sem dono, dono = ele mesmo: passa", () => {
      expect(definir(ATENDENTE, ATENDENTE, C_DA_IMPORTACAO)).toBe("");
      expect(donoDe(C_DA_IMPORTACAO)).toBe(ATENDENTE);
      expect(lastLine(sql(`select carteira_origem from public.contacts where id = '${C_DA_IMPORTACAO}';`))).toBe("importacao");
    });

    it("pedir OUTRO dono (o colega) é recusado", () => {
      expect(definir(ATENDENTE, COLEGA, C_DE_OUTRO_AUTOR)).toMatch(/carteira_fora_da_posse/);
      expect(donoDe(C_DE_OUTRO_AUTOR)).toBe("NULL");
    });

    it("contato de outra origem (cadastro manual) segue fora da posse, mesmo criado por ele", () => {
      expect(definir(ATENDENTE, ATENDENTE, C_DE_OUTRO_ORIGEM)).toMatch(/carteira_fora_da_posse/);
      expect(donoDe(C_DE_OUTRO_ORIGEM)).toBe("NULL");
    });

    it("contato importado pelo colega não vira dele", () => {
      expect(definir(ATENDENTE, ATENDENTE, C_DE_OUTRO_AUTOR)).toMatch(/carteira_fora_da_posse/);
      expect(donoDe(C_DE_OUTRO_AUTOR)).toBe("NULL");
    });

    it("contato que já está na carteira do colega NÃO é tirado dele (a regra do #2591)", () => {
      expect(definir(ATENDENTE, ATENDENTE, C_COM_DONO)).toMatch(/carteira_/);
      expect(donoDe(C_COM_DONO)).toBe(COLEGA);
    });

    it("a exceção é só da origem `importacao`: com `manual` o mesmo contato é recusado", () => {
      sql(`update public.contacts set carteira_user_id = null, carteira_origem = null, carteira_definida_em = null where id = '${C_DA_IMPORTACAO}';`);
      expect(definir(ATENDENTE, ATENDENTE, C_DA_IMPORTACAO, "manual")).toMatch(/carteira_fora_da_posse/);
      expect(donoDe(C_DA_IMPORTACAO)).toBe("NULL");
    });

    it("o gerente escolhe qualquer membro ativo como dono", () => {
      expect(definir(GESTOR, COLEGA, C_DO_GESTOR)).toBe("");
      expect(donoDe(C_DO_GESTOR)).toBe(COLEGA);
    });
  });
});
