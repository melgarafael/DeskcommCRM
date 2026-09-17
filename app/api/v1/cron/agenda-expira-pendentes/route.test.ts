/**
 * O pedido que ninguém decidiu solta o horário — e só ele.
 *
 * O que este arquivo protege, em ordem de gravidade:
 *
 * 1. Cancelar um compromisso CONFIRMADO seria o pior desfecho possível desta
 *    rota: cliente com horário marcado perde o horário sozinho, sem ninguém
 *    saber. Por isso a guarda aparece duas vezes (na leitura e no UPDATE) e
 *    tem teste nas duas.
 * 2. O prazo é POR ORGANIZAÇÃO. Um corte único no SQL seria mais simples e
 *    aplicaria o prazo errado a metade dos tenants.
 * 3. Rodada sem efeito não audita (lei do CLAUDE.md).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG_RAPIDA = "11111111-1111-4111-8111-111111111111";
const ORG_LENTA = "22222222-2222-4222-8222-222222222222";

const hAtras = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** Captura o que o UPDATE recebeu, incluindo os filtros encadeados. */
function admin(pendentes: Array<Record<string, unknown>>, capturado: Record<string, unknown>) {
  return {
    from(tabela: string) {
      if (tabela === "organizations") {
        return {
          select: () => ({
            in: async () => ({
              data: [
                { id: ORG_RAPIDA, settings: { agenda: { confirmation_delay_minutes: 10, unknown_protection_minutes: 1440, pending_expires_after_minutes: 60 } } },
                // Sem o campo: cai no default de 1440 (24h).
                { id: ORG_LENTA, settings: { agenda: { confirmation_delay_minutes: 10, unknown_protection_minutes: 1440 } } },
              ],
            }),
          }),
        };
      }
      // calendar_appointments
      return {
        select: () => ({
          eq: (col: string, val: string) => {
            capturado.selectEq = { col, val };
            return {
              order: () => ({ limit: async () => ({ data: pendentes, error: null }) }),
            };
          },
        }),
        update: (patch: Record<string, unknown>) => {
          capturado.patch = patch;
          return {
            in: (_c: string, ids: string[]) => {
              capturado.ids = ids;
              return {
                eq: (col: string, val: string) => {
                  capturado.updateEq = { col, val };
                  return {
                    select: async () => ({ data: ids.map((id) => ({ id })), error: null }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function req() {
  return new NextRequest("http://localhost/x", {
    headers: { authorization: "Bearer segredo" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("agenda-expira-pendentes", () => {
  it("expira o que passou do prazo DAQUELA organização, e mantém o resto", async () => {
    const capturado: Record<string, unknown> = {};
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [
          // 2h de vida numa org com prazo de 1h → expira.
          { id: "a", organization_id: ORG_RAPIDA, created_at: hAtras(2), starts_at: hAtras(-48) },
          // 2h de vida numa org com prazo de 24h (default) → fica.
          { id: "b", organization_id: ORG_LENTA, created_at: hAtras(2), starts_at: hAtras(-48) },
          // 30h de vida na org lenta → expira.
          { id: "c", organization_id: ORG_LENTA, created_at: hAtras(30), starts_at: hAtras(-48) },
        ],
        capturado,
      ) as never,
    );

    const { POST } = await import("./route");
    const body = (await (await POST(req())).json()) as { data: Record<string, number> };

    expect(body.data).toMatchObject({ examinados: 3, expirados: 2, mantidos: 1 });
    expect(capturado.ids).toEqual(["a", "c"]);
  });

  it("a leitura pede só pendentes, e o UPDATE repete a guarda", async () => {
    const capturado: Record<string, unknown> = {};
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [{ id: "a", organization_id: ORG_RAPIDA, created_at: hAtras(5), starts_at: hAtras(-48) }],
        capturado,
      ) as never,
    );

    const { POST } = await import("./route");
    await POST(req());

    // Se alguém confirmar entre a leitura e a escrita, o UPDATE não alcança a
    // linha. Sem este `.eq` o compromisso recém-confirmado seria cancelado.
    expect(capturado.selectEq).toEqual({ col: "status", val: "pending" });
    expect(capturado.updateEq).toEqual({ col: "status", val: "pending" });
    expect((capturado.patch as Record<string, string>).status).toBe("cancelled");
  });

  it("rodada que não expirou nada NÃO audita", async () => {
    const capturado: Record<string, unknown> = {};
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [{ id: "b", organization_id: ORG_LENTA, created_at: hAtras(1), starts_at: hAtras(-48) }],
        capturado,
      ) as never,
    );

    const { POST } = await import("./route");
    const body = (await (await POST(req())).json()) as { data: Record<string, number> };

    expect(body.data.expirados).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("rodada que expirou audita", async () => {
    const capturado: Record<string, unknown> = {};
    vi.mocked(createAdminClient).mockReturnValue(
      admin(
        [{ id: "a", organization_id: ORG_RAPIDA, created_at: hAtras(9), starts_at: hAtras(-48) }],
        capturado,
      ) as never,
    );

    const { POST } = await import("./route");
    await POST(req());

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agenda.pendente_expirado" }),
    );
  });

  it("sem o segredo, 403 — e não lê nada", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin([], {}) as never);
    const { POST } = await import("./route");
    const res = await POST(new NextRequest("http://localhost/x"));
    expect(res.status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
