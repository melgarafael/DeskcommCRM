import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_CONTACT_PROBE,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  writeCountAs,
} from "./gov-helpers";

/**
 * Migration 0169 — `contacts` tinha RLS de tenant e nenhuma checagem de PAPEL.
 *
 * Mesma classe de falha que a 0150 já corrigiu para canais/config de IA
 * (tests/invariants/rbac-config-ia-canais.test.ts). `contacts` é o dado mais
 * crítico do produto: antes desta migration, `viewer` (somente-leitura por
 * doutrina, spec 13 §4) lia/gravava/apagava qualquer contato do tenant direto
 * pelo PostgREST, sem passar por `requireRole`.
 *
 * Cada caso vem em par: o papel de baixo é barrado E o papel de cima passa.
 */

beforeAll(() => {
  seedGov();
});

describe("0169 — escrita de contacts exige agent+", () => {
  it("viewer NÃO altera o nome de um contato", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `update public.contacts set display_name = 'SEQUESTRADO' where id = '${GOV_CONTACT_PROBE}'`,
      ),
    ).toBe(0);
  });

  it("viewer NÃO apaga um contato", () => {
    expect(
      writeCountAs(GOV_VIEWER, `delete from public.contacts where id = '${GOV_CONTACT_PROBE}'`),
    ).toBe(0);
  });

  it("viewer NÃO cria contato novo", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `insert into public.contacts (organization_id, display_name)
           values ('${GOV_ORG}', 'Criado pelo viewer')`,
      ),
    ).toBe(0);
  });

  it("CONTROLE POSITIVO: agent altera o nome de um contato", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.contacts set display_name = 'RENOMEADO PELO AGENT' where id = '${GOV_CONTACT_PROBE}'`,
      ),
    ).toBe(1);
  });

  it("CONTROLE POSITIVO: admin apaga e recria o contato de teste", () => {
    expect(
      writeCountAs(GOV_ADMIN, `delete from public.contacts where id = '${GOV_CONTACT_PROBE}'`),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_ADMIN,
        `insert into public.contacts (id, organization_id, display_name)
           values ('${GOV_CONTACT_PROBE}', '${GOV_ORG}', 'Gov Invariant Contact Probe')`,
      ),
    ).toBe(1);
  });

  it("CONTROLE POSITIVO: viewer continua LENDO contatos (senão a tela quebra)", () => {
    expect(
      countAs(GOV_VIEWER, `select count(*) from public.contacts where id = '${GOV_CONTACT_PROBE}';`),
    ).toBe(1);
  });
});
