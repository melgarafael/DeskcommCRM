/**
 * #2415 — o destino de funil/etapa não persistia após salvar e recarregar:
 * o SELECT server-side do editor (o page.tsx que monta o initialState do SSR)
 * não trazia pipeline_id/stage_id. A API de detalhe já trazia; o PUT já
 * gravava; faltava a carga inicial enxergar os campos.
 */
import { describe, expect, it, vi } from "vitest";

const { requireAuthMock, resolveActiveOrgMock, createClientMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("@/lib/ai/classifier-models", () => ({ listClassifierModels: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: vi.fn().mockResolvedValue([]) }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("./_client", () => ({ RouterEditorClient: () => null }));

import RouterEditorPage from "./page";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ROUTER_ID = "55555555-5555-4555-8555-555555555555";

describe("SELECT server-side do editor do roteador (#2415)", () => {
  it("os membros são selecionados com pipeline_id e stage_id", async () => {
    requireAuthMock.mockResolvedValue({ is_platform_admin: true, support: false });
    resolveActiveOrgMock.mockResolvedValue({ orgId: ORG_ID, role: "admin" });

    const selects: Record<string, string> = {};
    const chain = (table: string, result: unknown) => {
      const q = {
        select(cols: string) {
          selects[table] = cols;
          return q;
        },
        eq() {
          return q;
        },
        is() {
          return q;
        },
        order: () => Promise.resolve({ data: result, error: null }),
        maybeSingle: () => Promise.resolve({ data: result, error: null }),
      };
      return q;
    };
    createClientMock.mockReturnValue({
      from: (table: string) => chain(table, table === "ai_routers" ? { id: ROUTER_ID, name: "R" } : []),
    });

    const el = await RouterEditorPage({ params: Promise.resolve({ id: ROUTER_ID }) });
    expect(el).toBeTruthy();
    expect(selects.ai_router_members).toContain("pipeline_id");
    expect(selects.ai_router_members).toContain("stage_id");
  });
});
