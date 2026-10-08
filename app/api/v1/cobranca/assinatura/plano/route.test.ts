import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ papel: vi.fn(), trocar: vi.fn(), audit: vi.fn(), taxaOk: true }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.papel }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: h.taxaOk }) }));
vi.mock("@/lib/cobranca/troca", () => ({ trocarPlanoDaOrg: h.trocar }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));

import { POST } from "./route";

const ORG = "13131313-0000-4000-8000-000000000001";
const PLANO = "13131313-0000-4000-8000-0000000000aa";
const trocar = (corpo: unknown) =>
  POST(new NextRequest("http://localhost/api/v1/cobranca/assinatura/plano", { method: "POST", body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  vi.clearAllMocks();
  h.taxaOk = true;
  h.papel.mockResolvedValue({ ok: true, user: { id: "admin-1" }, org: { orgId: ORG } });
});

describe("trocar de plano pela empresa", () => {
  it("acima de 10 por minuto da mesma empresa: 429 e a troca nem começa", async () => {
    h.taxaOk = false;
    expect((await trocar({ plano_id: PLANO })).status).toBe(429);
    expect(h.trocar).not.toHaveBeenCalled();
  });

  it("⭐ agenda para a próxima cobrança paga, diz a partir de quando, e audita com quem clicou", async () => {
    h.trocar.mockResolvedValue({ ok: true, changed: true, quando: "agendado", planoId: "atual", planoAgendadoId: PLANO, valeAPartirDe: "2026-11-01T00:00:00.000Z", de: "atual" });
    expect((await (await trocar({ plano_id: PLANO })).json()).data).toEqual({
      changed: true, quando: "agendado", plano_id: "atual", plano_agendado_id: PLANO, vale_a_partir_de: "2026-11-01T00:00:00.000Z",
    });
    expect(h.trocar).toHaveBeenCalledWith({}, ORG, PLANO);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.plano_trocado", actorUserId: "admin-1", organizationId: ORG, metadata: { de: "atual", para: PLANO, quando: "agendado" } }));
  });

  it("a recusa chega com o código e o que remover", async () => {
    h.trocar.mockResolvedValue({ ok: false, status: 409, code: "plan_limit_reached", message: "O uso atual não cabe no plano escolhido.", details: { excedente: { assentos: 2 } } });
    const res = await trocar({ plano_id: PLANO });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "plan_limit_reached", details: { excedente: { assentos: 2 } } });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("corpo sem plano: 400", async () => {
    expect((await trocar({})).status).toBe(400);
    expect(h.trocar).not.toHaveBeenCalled();
  });
});
