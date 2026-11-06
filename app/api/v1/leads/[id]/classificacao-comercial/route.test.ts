/**
 * #4191 — a ROTA da classificação: quem pode, o que é recusado e o envelope.
 *
 * O serviço tem teste próprio; aqui se mede a porta: piso de papel, corpo
 * validado, organização vinda do cookie (nunca do corpo), 404 para negócio
 * fora da RLS e o formato de resposta que a ficha consome.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  classificaNegocioComoNaoComercial,
  reverteClassificacaoNaoComercial,
} from "@/lib/leads/classificacao-comercial";

import { DELETE, POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/leads/classificacao-comercial", () => ({
  classificaNegocioComoNaoComercial: vi.fn(),
  reverteClassificacaoNaoComercial: vi.fn(),
}));

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

const ctx = { params: Promise.resolve({ id: LEAD }) };

function requisicao(corpo?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/leads/" + LEAD + "/classificacao-comercial", {
    method: "POST",
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt" },
    org: { orgId: ORG },
  } as never);
  vi.mocked(classificaNegocioComoNaoComercial).mockReset();
  vi.mocked(reverteClassificacaoNaoComercial).mockReset();
});

describe("#4191 — POST classificar como não comercial", () => {
  it("classifica com o motivo do corpo e a organização do cookie", async () => {
    vi.mocked(classificaNegocioComoNaoComercial).mockResolvedValue({
      ok: true,
      jaEstava: false,
      lead: { id: LEAD, nao_comercial_motivo: "golpe" },
    });

    const res = await POST(requisicao({ motivo: "golpe" }), ctx);
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data).toMatchObject({
      lead_id: LEAD,
      classificacao: "nao_comercial",
      ja_estava: false,
    });
    expect(classificaNegocioComoNaoComercial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, leadId: LEAD, motivo: "golpe", actorUserId: USER }),
    );
  });

  it("corpo sem motivo é 422 e não chama o serviço", async () => {
    const res = await POST(requisicao({}), ctx);
    expect(res.status).toBe(422);
    expect(classificaNegocioComoNaoComercial).not.toHaveBeenCalled();
  });

  it("papel sem permissão é recusado antes de qualquer leitura", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response("forbidden", { status: 403 }),
    } as never);
    const res = await POST(requisicao({ motivo: "golpe" }), ctx);
    expect(res.status).toBe(403);
    expect(classificaNegocioComoNaoComercial).not.toHaveBeenCalled();
  });

  it("recusa do serviço vira o status dela (409 do conflito, 404 do negócio fora da RLS)", async () => {
    vi.mocked(classificaNegocioComoNaoComercial).mockResolvedValueOnce({
      ok: false,
      codigo: "classificacao_conflitante",
      mensagem: "já classificado",
      httpStatus: 409,
    });
    const conflito = await POST(requisicao({ motivo: "golpe" }), ctx);
    expect(conflito.status).toBe(409);

    vi.mocked(classificaNegocioComoNaoComercial).mockResolvedValueOnce({
      ok: false,
      codigo: "not_found",
      mensagem: "Negócio não encontrado.",
      httpStatus: 404,
    });
    const ausente = await POST(requisicao({ motivo: "golpe" }), ctx);
    expect(ausente.status).toBe(404);
  });

  it("a operação repetida responde 200 com ja_estava (idempotência visível)", async () => {
    vi.mocked(classificaNegocioComoNaoComercial).mockResolvedValue({
      ok: true,
      jaEstava: true,
      lead: { id: LEAD },
    });
    const res = await POST(requisicao({ motivo: "golpe" }), ctx);
    expect((await res.json()).data).toMatchObject({ ja_estava: true });
  });
});

describe("#4191 — DELETE reverter", () => {
  it("devolve o negócio ao comercial", async () => {
    vi.mocked(reverteClassificacaoNaoComercial).mockResolvedValue({
      ok: true,
      jaEstava: false,
      lead: { id: LEAD, nao_comercial_em: null },
    });
    const res = await DELETE(requisicao(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ lead_id: LEAD, classificacao: "comercial" });
    expect(reverteClassificacaoNaoComercial).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, leadId: LEAD }),
    );
  });

  it("papel sem permissão não reverte", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response("forbidden", { status: 403 }),
    } as never);
    const res = await DELETE(requisicao(), ctx);
    expect(res.status).toBe(403);
    expect(reverteClassificacaoNaoComercial).not.toHaveBeenCalled();
  });
});
