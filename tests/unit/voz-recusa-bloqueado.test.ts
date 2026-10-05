/**
 * A recusada de bloqueado na tela SIP e no histórico.
 *
 * - `GET /api/v1/calls` lê `end_reason` mas não o expõe: a recusada
 *   (`ended` + `contact_blocked`) sai como `canceled` ("Cancelada", rótulo
 *   existente mais próximo de recusa), nunca "Concluída";
 * - `GET /api/v1/voice/calls/history` já devolve `end_reason` por linha: a
 *   recusada aparece nela com `contact_blocked`.
 *
 * SABOTAGEM (prova no CI, sem rodar nada local): remover o case
 * `contact_blocked` em `mapStatusParaApi` = recusada volta a `completed`
 * (casos 1 e 2 vermelhos).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { mapStatusParaApi } from "@/app/api/v1/calls/route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";

function linhaRecusada() {
  return {
    id: "chamada-recusada",
    direction: "inbound",
    status: "ended",
    end_reason: "contact_blocked",
    peer_phone: "+5532984793302",
    handled_by: null,
    started_at: new Date().toISOString(),
    answered_at: null,
    ended_at: new Date().toISOString(),
    duration_ms: null,
    transcript: null,
  };
}

/** Cadeia `from().select().eq().eq().order().limit()` que resolve a lista. */
function dubleLista(linhas: Array<Record<string, unknown>>) {
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    cadeia[m] = () => cadeia;
  }
  cadeia.then = (ok: (r: unknown) => unknown) =>
    ok({ data: linhas, error: null });
  return { from: () => cadeia };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "manager" },
  } as never);
});

describe("mapStatusParaApi", () => {
  it('caso 1 — recusada de bloqueado vira canceled, não completed', () => {
    expect(mapStatusParaApi("ended", "contact_blocked")).toBe("canceled");
  });

  it("caso 2 — controle: os demais mapeamentos não mudam", () => {
    expect(mapStatusParaApi("ended", null)).toBe("completed");
    expect(mapStatusParaApi("ended", "timeout")).toBe("no_answer");
    expect(mapStatusParaApi("connected", null)).toBe("in_progress");
    expect(mapStatusParaApi("ringing", null)).toBe("ringing");
  });
});

describe("GET /api/v1/calls", () => {
  it("a recusada sai como Cancelada e sem end_reason (contrato intacto)", async () => {
    vi.mocked(createClient).mockResolvedValue(dubleLista([linhaRecusada()]) as never);
    const { GET } = await import("@/app/api/v1/calls/route");
    const res = await GET(new Request("http://x/api/v1/calls") as never);
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(corpo.data).toHaveLength(1);
    expect(corpo.data[0]).toMatchObject({ status: "canceled" });
    expect(corpo.data[0]).not.toHaveProperty("end_reason");
  });
});
