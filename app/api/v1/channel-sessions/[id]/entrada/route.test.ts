import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const ETAPA = "44444444-4444-4444-8444-444444444444";

function request(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL}/entrada`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ id: CANAL }) };

/** Banco de mentira: responde por tabela e registra filtros e o update. */
function banco(responde: (tabela: string, filtros: Record<string, unknown>) => unknown) {
  const updates: Array<{ valor: unknown; filtros: Record<string, unknown> }> = [];
  const db = {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let valor: unknown = undefined;
      const b: Record<string, unknown> = {
        select: () => b,
        is: () => b,
        update: (v: unknown) => ((valor = v), b),
        eq: (c: string, v: unknown) => ((filtros[c] = v), b),
        maybeSingle: async () => {
          if (valor !== undefined) {
            updates.push({ valor, filtros: { ...filtros } });
            return { data: { id: CANAL, ...(valor as object) }, error: null };
          }
          return { data: responde(tabela, filtros), error: null };
        },
      };
      return b;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(db as never);
  return updates;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "55555555-5555-4555-8555-555555555555" },
    org: { orgId: ORG, role: "admin" },
  } as Awaited<ReturnType<typeof requireRole>>);
});

describe("PATCH …/channel-sessions/[id]/entrada", () => {
  it("grava funil e etapa da MESMA organização e audita", async () => {
    const updates = banco((t) => {
      if (t === "channel_sessions") return { entry_pipeline_id: null, entry_stage_id: null };
      if (t === "crm_pipelines") return { id: FUNIL };
      if (t === "crm_stages") return { id: ETAPA };
      return null;
    });
    const res = await PATCH(request({ pipeline_id: FUNIL, stage_id: ETAPA }), ctx);
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.valor).toEqual({ entry_pipeline_id: FUNIL, entry_stage_id: ETAPA });
    expect(updates[0]?.filtros.organization_id).toBe(ORG);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.entry_pipeline_changed", organizationId: ORG, resourceId: CANAL }),
    );
  });

  it("recusa funil que não é da organização (ou está arquivado) sem gravar nada", async () => {
    const updates = banco((t) => (t === "channel_sessions" ? { entry_pipeline_id: null, entry_stage_id: null } : null));
    const res = await PATCH(request({ pipeline_id: FUNIL }), ctx);
    expect(res.status).toBe(422);
    expect(updates).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("recusa etapa que não é aberta deste funil", async () => {
    const updates = banco((t) => {
      if (t === "channel_sessions") return { entry_pipeline_id: null, entry_stage_id: null };
      if (t === "crm_pipelines") return { id: FUNIL };
      return null;
    });
    const res = await PATCH(request({ pipeline_id: FUNIL, stage_id: ETAPA }), ctx);
    expect(res.status).toBe(422);
    expect(updates).toHaveLength(0);
  });

  it("pipeline_id nulo volta ao funil padrão e limpa a etapa", async () => {
    const updates = banco((t) => (t === "channel_sessions" ? { entry_pipeline_id: FUNIL, entry_stage_id: ETAPA } : null));
    const res = await PATCH(request({ pipeline_id: null, stage_id: ETAPA }), ctx);
    expect(res.status).toBe(200);
    expect(updates[0]?.valor).toEqual({ entry_pipeline_id: null, entry_stage_id: null });
  });

  it("recusa corpo inválido antes de tocar no banco", async () => {
    const res = await PATCH(request({ pipeline_id: "x" }), ctx);
    expect(res.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
