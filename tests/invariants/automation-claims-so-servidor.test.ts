import { describe, expect, it } from "vitest";

import { countAs, GOV_AGENT_A, sql } from "./gov-helpers";

/**
 * `automation_rule_contact_claims` (migration 0740, issue #3267) é EXCLUSIVA DO
 * SERVIDOR — é a trava da corrida do dreno: o worker que consegue inserir é quem
 * executa a automação, e o outro recebe lista vazia.
 *
 * ─── Por que este arquivo existe ─────────────────────────────────────────────
 *
 * A tabela nasceu tenant-aware (`organization_id not null`), e a varredura de
 * completude exige prova comportamental para TABELA NOVA — nem TABLES nem
 * "dívida conhecida" resolvem. Ela NÃO entra em TABLES porque o usuário do
 * teste (`agent` da org) não tem SELECT: o controle positivo de lá falharia por
 * ACERTO (é o mesmo motivo de `prospecting_settings` e
 * `lgpd_marcas_de_apagamento`).
 *
 * A prova aqui é a de "tabela do servidor": RLS de pé e NENHUM papel de
 * navegador (`anon`/`authenticated`) com privilégio — nem da própria
 * organização. Ninguém lê pela API, nem cross-tenant nem localmente; quem
 * trafega é o servidor (`service_role`), que é o único que precisa enxergar as
 * duas organizações para drenar.
 */
const TABELA = "public.automation_rule_contact_claims";

describe("claims da automação: só o servidor passa", () => {
  it("RLS ligada e nenhuma policy — sem policy, ninguém do navegador passa", () => {
    expect(
      sql(`select relrowsecurity from pg_class where oid = '${TABELA}'::regclass`),
    ).toBe("t");
    expect(
      sql(
        `select count(*) from pg_policies where schemaname = 'public' and tablename = 'automation_rule_contact_claims'`,
      ),
    ).toBe("0");
  });

  it("anon e authenticated ficam SEM privilégio, service_role fica com", () => {
    expect(
      sql(
        `select bool_and(not has_table_privilege(r, '${TABELA}', 'select'))
         from unnest(array['anon','authenticated']) r`,
      ),
    ).toBe("t");
    expect(
      sql(`select has_table_privilege('service_role', '${TABELA}', 'select')`),
    ).toBe("t");
    expect(
      sql(`select has_table_privilege('service_role', '${TABELA}', 'insert')`),
    ).toBe("t");
  });

  it("authenticated JWT da própria org também é recusado (não é só cross-tenant)", () => {
    expect(() =>
      countAs(
        GOV_AGENT_A,
        `select count(*) from ${TABELA} where organization_id = 'cccccccc-0000-4000-8000-000000000001';`,
      ),
    ).toThrow();
  });
});
