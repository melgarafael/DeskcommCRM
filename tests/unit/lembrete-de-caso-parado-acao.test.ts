/**
 * A action que grava a cadência do lembrete de caso parado (migration 0766).
 *
 * O que ela garante, e o que cada caso mede:
 *   · só quem administra grava (o `agent` recebe `forbidden_role` sem client);
 *   · a faixa é a das CHECK do banco (1..168 h, 1..10 avisos), e campo a mais
 *     é recusado — erro cru do Postgres não é resposta para a tela;
 *   · a organização da escrita é a da SESSÃO, e a mudança fica na trilha.
 *
 * O MFA é medido junto das outras actions de empresa, em
 * `acoes-da-empresa-pedem-o-codigo.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  papel: "admin" as string,
  updates: [] as Array<{ patch: Record<string, unknown>; filtros: Array<[string, unknown]> }>,
  auditou: vi.fn(async (_: Record<string, unknown>) => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/audit", () => ({ audit: h.auditou }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    is_platform_admin: false,
    platform_admin_scope: null,
    support: null,
  }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: h.papel }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      expect(tabela).toBe("organizations");
      return {
        update: (patch: Record<string, unknown>) => {
          const registro = { patch, filtros: [] as Array<[string, unknown]> };
          h.updates.push(registro);
          return {
            eq: async (col: string, val: unknown) => {
              registro.filtros.push([col, val]);
              return { error: null };
            },
          };
        },
      };
    },
  }),
}));

import { atualizarLembreteDeCasoParado } from "@/app/actions/settings/atualizarLembreteDeCasoParado";

beforeEach(() => {
  h.papel = "admin";
  h.updates = [];
  h.auditou.mockClear();
});

describe("atualizarLembreteDeCasoParado", () => {
  it("grava as três colunas na organização da sessão e deixa a trilha", async () => {
    const r = await atualizarLembreteDeCasoParado({ ligado: false, intervaloHoras: 4, teto: 5 });

    expect(r).toEqual({ ok: true });
    expect(h.updates).toEqual([
      {
        patch: { lembrete_caso_ligado: false, lembrete_caso_intervalo_horas: 4, lembrete_caso_teto: 5 },
        filtros: [["id", ORG]],
      },
    ]);
    expect(h.auditou).toHaveBeenCalledTimes(1);
    expect(h.auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "ai.lembrete_de_caso_configurado",
      organizationId: ORG,
      resourceId: ORG,
    });
  });

  it("quem não administra recebe forbidden_role e nada é gravado", async () => {
    h.papel = "agent";
    expect(await atualizarLembreteDeCasoParado({ ligado: true, intervaloHoras: 24, teto: 3 })).toEqual({
      ok: false,
      error: "forbidden_role",
    });
    expect(h.updates).toHaveLength(0);
    expect(h.auditou).not.toHaveBeenCalled();
  });

  it.each([
    ["intervalo zero", { ligado: true, intervaloHoras: 0, teto: 3 }],
    ["intervalo acima de uma semana", { ligado: true, intervaloHoras: 169, teto: 3 }],
    ["intervalo fracionado", { ligado: true, intervaloHoras: 1.5, teto: 3 }],
    ["teto zero", { ligado: true, intervaloHoras: 24, teto: 0 }],
    ["teto acima de dez", { ligado: true, intervaloHoras: 24, teto: 11 }],
    ["campo a mais", { ligado: true, intervaloHoras: 24, teto: 3, organization_id: "outra" }],
  ])("%s é validation_failed, sem gravar", async (_nome, entrada) => {
    expect(await atualizarLembreteDeCasoParado(entrada as never)).toEqual({
      ok: false,
      error: "validation_failed",
    });
    expect(h.updates).toHaveLength(0);
  });
});
