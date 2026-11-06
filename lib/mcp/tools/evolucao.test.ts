/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpContext } from "../types";
import { crmGetOrgMemory, crmSaveOrgMemory } from "./evolucao";

/**
 * #2369 — a memória da org com prazo, vista pela ferramenta da IA.
 *
 * A leitura é o que mais importa: se `crm_get_org_memory` continuar devolvendo a
 * anotação vencida, o agente repete a programação da semana passada mesmo com a
 * coluna existindo. E "vencida" é decidida no fuso da organização, como no
 * turno — às 23h de domingo em São Paulo ainda é domingo.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";

interface Chamadas {
  select: string[];
  or: string[];
  insert: Record<string, unknown> | null;
}

function mundoDaMemoria(opts: { timezone?: string | null; linhas?: unknown[] } = {}) {
  const chamadas: Chamadas = { select: [], or: [], insert: null };

  const supabase: any = {
    from(table: string) {
      if (table === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { timezone: opts.timezone ?? null }, error: null }),
            }),
          }),
        };
      }
      if (table !== "org_memory_entries") throw new Error(`tabela inesperada: ${table}`);
      const b: any = {
        select(cols: string) {
          chamadas.select.push(cols);
          return b;
        },
        insert(payload: Record<string, unknown>) {
          chamadas.insert = payload;
          return b;
        },
        eq() {
          return b;
        },
        or(expr: string) {
          chamadas.or.push(expr);
          return b;
        },
        order() {
          return b;
        },
        limit() {
          return Promise.resolve({ data: opts.linhas ?? [], error: null });
        },
        single() {
          return Promise.resolve({
            data: { id: "e1", title: "Programação", status: "active", created_at: "2026-10-26T10:00:00Z", valid_until: "2026-11-01" },
            error: null,
          });
        },
      };
      return b;
    },
  };

  const ctx = { organizationId: ORG_ID, supabase } as unknown as McpContext;
  return { ctx, chamadas };
}

beforeEach(() => {
  vi.useFakeTimers();
  // 02:00 UTC de 27/10 = 23:00 de 26/10 em São Paulo. Ler UTC aqui devolveria
  // 27/10 e derrubaria a programação de domingo três horas antes da hora.
  vi.setSystemTime(new Date("2026-10-27T02:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("crm_get_org_memory e o prazo do aprendizado", () => {
  it("filtra pela data de HOJE no fuso da organização, não em UTC", async () => {
    const { ctx, chamadas } = mundoDaMemoria({ timezone: "America/Sao_Paulo" });

    await crmGetOrgMemory.handler({ limite: 20 }, ctx);

    expect(chamadas.or).toEqual(["valid_until.is.null,valid_until.gte.2026-10-26"]);
  });

  it("organização sem fuso configurado cai no padrão do produto", async () => {
    const { ctx, chamadas } = mundoDaMemoria({ timezone: null });

    await crmGetOrgMemory.handler({ limite: 20 }, ctx);

    expect(chamadas.or).toEqual(["valid_until.is.null,valid_until.gte.2026-10-26"]);
  });

  it("traz a data para o agente saber até quando a anotação vale", async () => {
    const { ctx, chamadas } = mundoDaMemoria({ linhas: [] });

    await crmGetOrgMemory.handler({ limite: 20 }, ctx);

    expect(chamadas.select[0]).toContain("valid_until");
  });
});

describe("crm_save_org_memory e o prazo do aprendizado", () => {
  it("grava o prazo quando a IA informa o último dia", async () => {
    const { ctx, chamadas } = mundoDaMemoria();

    await crmSaveOrgMemory.handler(
      { titulo: "Programação da semana", corpo: "Sexta: Fulano. Sábado: Beltrano.", valido_ate: "2026-11-01" },
      ctx,
    );

    expect(chamadas.insert).toMatchObject({ valid_until: "2026-11-01", source: "agent", status: "active" });
  });

  it("sem prazo, grava null — o comportamento de antes continua igual", async () => {
    const { ctx, chamadas } = mundoDaMemoria();

    await crmSaveOrgMemory.handler({ titulo: "Regra da casa", corpo: "Nunca prometa desconto sem confirmar." }, ctx);

    expect(chamadas.insert).toHaveProperty("valid_until", null);
  });
});
