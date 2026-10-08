import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pergunta numérica configurada na fonte (#2553): a captação converte a
 * resposta antes de criar o negócio. "R$ 1.250,00" vira o número 1250 no campo
 * personalizado; uma resposta que não é número é recusada com 422, sem lead, e
 * o motivo `campo_numerico_invalido` fica na tela "Leads recebidos".
 *
 * O controle (resposta válida) prova que o portão abre: sem ele, um 422 em tudo
 * também passaria no caso da recusa.
 */

const h = vi.hoisted(() => ({
  registrar: vi.fn(async () => undefined),
  criarLead: vi.fn(),
}));

const FONTE = {
  id: "fonte-1",
  name: "Formulário do site",
  organization_id: "org-1",
  secret_encrypted: null,
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-1",
  field_map: {},
  form_fields: [
    { key: "quantidade", label: "Quantidade", type: "number", required: false },
    { key: "faturamento", label: "Faturamento", type: "currency", required: false },
  ],
  redirect_to: null,
  is_active: true,
  authorize_ai_on_capture: false,
};

/** Cadeia do PostgREST que aceita qualquer método e resolve vazio — só a fonte é lida de verdade. */
function cadeia(tabela: string): unknown {
  const resultado = { data: tabela === "webhook_sources" ? FONTE : null, error: null };
  const proxy: unknown = new Proxy(() => undefined, {
    get(_alvo, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok(resultado);
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => cadeia(t), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: h.registrar,
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: h.criarLead }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: async () => undefined }));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const TOKEN = "token-da-fonte-0001";

async function enviar(corpo: Record<string, unknown>): Promise<Response | Error> {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) }).catch((e: Error) => e);
}

beforeEach(() => {
  h.registrar.mockClear();
  h.criarLead.mockReset().mockRejectedValue(new Error("chegou à criação do negócio"));
});

describe("pergunta numérica configurada na fonte de formulário", () => {
  it("resposta que não é número: 422, nenhum negócio e o motivo na tela", async () => {
    const res = await enviar({ nome: "Dora", telefone: "+5511999990000", quantidade: "12x" });

    expect(h.criarLead, "negócio criado com número inválido").not.toHaveBeenCalled();
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(422);
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "recusado", rejectReason: "campo_numerico_invalido" }),
    );
  });

  it("controle: número e moeda BRL válidos chegam ao negócio já convertidos", async () => {
    await enviar({ nome: "Dora", telefone: "+5511999990000", quantidade: "3", faturamento: "R$ 1.250,00" });

    expect(h.registrar).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rejectReason: "campo_numerico_invalido" }),
    );
    expect(h.criarLead).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        custom_fields: expect.objectContaining({ quantidade: 3, faturamento: 1250 }),
      }),
      expect.anything(),
    );
  });
});
