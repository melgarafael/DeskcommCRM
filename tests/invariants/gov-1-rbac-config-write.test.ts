import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_PIPELINE,
  GOV_STAGE,
  GOV_VIEWER,
  countAs,
  seedGov,
  writeCountAs,
} from "./gov-helpers";

/**
 * Eixo 1 — RBAC em tabelas de config (G2-03, migration 0030).
 * spec 13 §4.1: crm_pipelines/crm_stages write manager+; conversations write
 * agent+ (viewer read-only). SELECT permanece org-flat — os controles de
 * leitura abaixo garantem que a migration NÃO estreitou visibilidade
 * (escopo own/unassigned é G4-01, fora daqui).
 */

beforeAll(() => {
  seedGov();
});

describe("eixo 1 — RBAC de escrita em config (migration 0030)", () => {
  it("manager ESCREVE config de pipeline (spec 13 §4: manager+)", () => {
    const updated = writeCountAs(
      GOV_MANAGER,
      `update public.crm_pipelines set name = name where id = '${GOV_PIPELINE}'`,
    );
    expect(updated).toBe(1);
  });

  it("agent NÃO escreve em crm_stages (config de pipeline, spec 13 §4 nota 4)", () => {
    const updated = writeCountAs(
      GOV_AGENT_A,
      `update public.crm_stages set name = name where id = '${GOV_STAGE}'`,
    );
    expect(updated).toBe(0);
  });

  it("manager ESCREVE em crm_stages", () => {
    const updated = writeCountAs(
      GOV_MANAGER,
      `update public.crm_stages set name = name where id = '${GOV_STAGE}'`,
    );
    expect(updated).toBe(1);
  });

  it("agent continua escrevendo em conversations (controle positivo do write agent+)", () => {
    const updated = writeCountAs(
      GOV_AGENT_A,
      `update public.conversations set status = status where id = '${GOV_CONV_UNASSIGNED}'`,
    );
    expect(updated).toBe(1);
  });

  it("viewer NÃO faz UPDATE em conversations (complementa o probe de INSERT do gov-1)", () => {
    const updated = writeCountAs(
      GOV_VIEWER,
      `update public.conversations set status = status where id = '${GOV_CONV_UNASSIGNED}'`,
    );
    expect(updated).toBe(0);
  });

  it("SELECT continua org-flat: viewer e agent leem pipelines, stages e conversations", () => {
    for (const userId of [GOV_VIEWER, GOV_AGENT_A]) {
      expect(
        countAs(userId, `select count(*) from public.crm_pipelines where id = '${GOV_PIPELINE}';`),
      ).toBe(1);
      expect(
        countAs(userId, `select count(*) from public.crm_stages where id = '${GOV_STAGE}';`),
      ).toBe(1);
      expect(
        countAs(
          userId,
          `select count(*) from public.conversations where id = '${GOV_CONV_UNASSIGNED}';`,
        ),
      ).toBe(1);
    }
  });
});
