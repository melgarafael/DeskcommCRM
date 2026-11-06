import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { countAs, sql } from "./gov-helpers";

/**
 * `importacoes_de_historico` (0724, #999): membro da organização lê a própria;
 * membro de OUTRA organização não lê; ninguém além do `service_role` escreve; e
 * só uma importação `rodando` por número.
 */
const orgA = randomUUID(), orgB = randomUUID();
const sessA = randomUUID(), sessB = randomUUID();
const membroA = randomUUID(), membroB = randomUUID();
const impA = randomUUID(), impB = randomUUID();

beforeAll(() => {
  sql(`insert into auth.users (id, email) values ('${membroA}', 'imp-a@invariant.test'), ('${membroB}', 'imp-b@invariant.test');`);
  for (const [org, sess, membro, imp] of [
    [orgA, sessA, membroA, impA],
    [orgB, sessB, membroB, impB],
  ] as const) {
    sql(`insert into organizations (id, slug, legal_name, display_name) values ('${org}', '${org}', 'Imp', 'Imp');
      insert into user_organizations (user_id, organization_id, role, accepted_at) values ('${membro}', '${org}', 'admin', now());
      insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values ('${sess}', '${org}', '${sess}', '\\x00');
      insert into importacoes_de_historico (id, organization_id, channel_session_id, status, dias) values ('${imp}', '${org}', '${sess}', 'rodando', 30);`);
  }
});

describe("importacoes_de_historico: RLS e unicidade", () => {
  it("membro lê a importação da própria organização e não a da outra", () => {
    expect(countAs(membroA, `select count(*) from importacoes_de_historico where id = '${impA}';`)).toBe(1);
    expect(countAs(membroA, `select count(*) from importacoes_de_historico where id = '${impB}';`)).toBe(0);
    expect(countAs(membroB, `select count(*) from importacoes_de_historico where id = '${impA}';`)).toBe(0);
    expect(countAs(membroB, `select count(*) from importacoes_de_historico where id = '${impB}';`)).toBe(1);
  });

  it("escrita só pelo service_role: authenticated e anon não inserem, atualizam nem apagam", () => {
    expect(
      sql(`select has_table_privilege('authenticated','public.importacoes_de_historico','insert'),
        has_table_privilege('authenticated','public.importacoes_de_historico','update'),
        has_table_privilege('authenticated','public.importacoes_de_historico','delete'),
        has_table_privilege('anon','public.importacoes_de_historico','select'),
        has_table_privilege('service_role','public.importacoes_de_historico','insert'),
        has_table_privilege('service_role','public.importacoes_de_historico','update');`),
    ).toBe("f|f|f|f|t|t");
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${membroA}"}', false);
        update importacoes_de_historico set status = 'cancelada' where id = '${impA}';`),
    ).toThrow(/permission denied/);
  });

  it("uma só importação rodando por número; as encerradas não contam", () => {
    expect(() =>
      sql(`insert into importacoes_de_historico (organization_id, channel_session_id, status, dias) values ('${orgA}', '${sessA}', 'rodando', 90);`),
    ).toThrow(/importacoes_de_historico_uma_rodando_idx/);
    expect(
      sql(`begin;
        insert into importacoes_de_historico (organization_id, channel_session_id, status, dias) values ('${orgA}', '${sessA}', 'concluida', 90), ('${orgA}', '${sessA}', 'erro', 365);
        select count(*) from importacoes_de_historico where channel_session_id = '${sessA}';
        rollback;`).split("\n"),
    ).toContain("3");
  });

  it("os quatro períodos da tela são aceitos, 180 inclusive (0725)", () => {
    expect(
      sql(`begin;
        insert into importacoes_de_historico (organization_id, channel_session_id, status, dias)
          values ('${orgA}', '${sessA}', 'previa', 30), ('${orgA}', '${sessA}', 'previa', 90),
                 ('${orgA}', '${sessA}', 'previa', 180), ('${orgA}', '${sessA}', 'previa', 365);
        select count(*) from importacoes_de_historico where channel_session_id = '${sessA}' and status = 'previa';
        rollback;`).split("\n"),
    ).toContain("4");
  });

  it("dias e status fora do combinado são recusados", () => {
    expect(() =>
      sql(`insert into importacoes_de_historico (organization_id, channel_session_id, status, dias) values ('${orgA}', '${sessA}', 'previa', 60);`),
    ).toThrow(/check constraint/);
    expect(() =>
      sql(`insert into importacoes_de_historico (organization_id, channel_session_id, status, dias) values ('${orgA}', '${sessA}', 'pausada', 30);`),
    ).toThrow(/check constraint/);
  });
});
