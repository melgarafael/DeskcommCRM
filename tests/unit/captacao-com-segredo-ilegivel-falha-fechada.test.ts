import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A fonte de captação que TEM segredo de assinatura só deixa entrar o que foi
 * conferido com ele. Quando esta instalação não consegue LER o segredo (chave
 * mestra trocada, dado corrompido), não há como conferir — e a resposta certa é
 * recusar, deixando o motivo na tela "Leads recebidos" para o operador
 * recadastrar a assinatura. Mesma regra de `lib/waha/webhook-auth.ts`.
 *
 * O controle (segredo legível + assinatura certa) mostra que o portão abre
 * quando deve: sem ele, um 401 em tudo também passaria nos outros casos.
 */

const h = vi.hoisted(() => ({
  segredo: null as string | null,
  inseridos: [] as string[],
  decrypt: vi.fn(),
  audit: vi.fn(async () => undefined),
  registrar: vi.fn(async () => undefined),
  criarLead: vi.fn(),
}));

const FONTE = {
  id: "fonte-1",
  name: "Formulário do site",
  organization_id: "org-1",
  secret_encrypted: "\\xc30d0407",
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-1",
  field_map: {},
  redirect_to: null,
  is_active: true,
};

/** Cadeia do PostgREST que aceita qualquer método e resolve vazio — só a fonte é lida de verdade. */
function cadeia(tabela: string): unknown {
  const resultado = { data: tabela === "webhook_sources" ? FONTE : null, error: null };
  const proxy: unknown = new Proxy(() => undefined, {
    get(_alvo, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok(resultado);
      if (prop === "insert") {
        return () => {
          h.inseridos.push(tabela);
          return proxy;
        };
      }
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => cadeia(t), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: h.decrypt }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: h.registrar,
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: h.criarLead }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: async () => undefined }));

import { logger } from "@/lib/logger";
import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const TOKEN = "token-da-fonte-0001";
const SEGREDO = "segredo-da-fonte-com-tamanho-real";
const CORPO = JSON.stringify({ nome: "Dora", email: "dora@example.com" });

async function enviar(assinatura?: string): Promise<Response | Error> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (assinatura) headers["x-deskcomm-signature"] = assinatura;
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, { method: "POST", body: CORPO, headers });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) }).catch((e: Error) => e);
}

const assinar = (segredo: string) => createHmac("sha256", segredo).update(CORPO).digest("hex");

beforeEach(() => {
  h.inseridos.length = 0;
  h.decrypt.mockReset().mockImplementation(async () => h.segredo);
  h.audit.mockClear();
  h.registrar.mockClear();
  h.criarLead.mockReset().mockRejectedValue(new Error("passou do portão"));
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

describe("segredo da fonte que esta instalação não consegue ler", () => {
  for (const [caso, assinatura] of [
    ["sem assinatura", undefined],
    ["com uma assinatura qualquer", assinar(SEGREDO)],
  ] as const) {
    it(`recusa ${caso}: 401, nenhum lead, motivo na tela e aviso no log`, async () => {
      h.segredo = null;
      const res = await enviar(assinatura);

      expect(h.criarLead, "lead criado sem assinatura conferida").not.toHaveBeenCalled();
      expect(h.inseridos, "a requisição passou do portão de assinatura").not.toContain("webhook_events_log");
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(401);
      expect(h.registrar).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ outcome: "recusado", rejectReason: "assinatura_indecifravel" }),
      );
      expect(h.audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "webhook.inbound_invalid_signature", metadata: { reason: "assinatura_indecifravel" } }),
      );
      expect(logger.error).toHaveBeenCalled();
    });
  }
});

describe("controles: com o segredo legível o portão separa certo de errado", () => {
  it("assinatura errada continua `assinatura_invalida`", async () => {
    h.segredo = SEGREDO;
    const res = await enviar(assinar("outro-segredo-qualquer-de-mesmo-porte"));
    expect((res as Response).status).toBe(401);
    expect(h.registrar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rejectReason: "assinatura_invalida" }),
    );
  });

  it("assinatura certa passa do portão", async () => {
    h.segredo = SEGREDO;
    await enviar(assinar(SEGREDO));
    expect(h.inseridos).toContain("webhook_events_log");
    expect(h.registrar).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "recusado", rejectReason: expect.stringMatching(/^assinatura_/) }),
    );
  });
});
