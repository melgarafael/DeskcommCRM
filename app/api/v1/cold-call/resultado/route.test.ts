import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import { requireRole } from "@/lib/auth/require-role";
import { MOTIVOS_DE_PERDA_DO_COLD_CALL } from "@/lib/cold-call/regras";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

/**
 * POST /api/v1/cold-call/resultado (#3933). Quem pediu para não ser incomodado não recebe
 * ligação — a regra de `app/api/v1/voice/calls/route.ts`, com os mesmos códigos. Sem ligação,
 * não há resultado de ligação: a rota recusa e não move o lead. "Tirado da fila" passa, porque
 * é o gesto certo para esse contato.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

function banco(contato: Record<string, boolean>) {
  const linhas: Record<string, unknown> = {
    crm_leads: {
      id: LEAD,
      pipeline_id: "funil",
      stage_id: "etapa-fila",
      contact_id: "contato",
      crm_pipelines: { settings: { cold_call: { ativo: true, roteiro: "" }, lost_reasons: [...MOTIVOS_DE_PERDA_DO_COLD_CALL] } },
    },
    contacts: { is_blocked: false, is_personal: false, is_anonymized: false, ...contato },
    crm_stages: { id: "etapa-nao-atendeu" },
  };
  return {
    from: (tabela: string) => {
      const consulta = {
        select: () => consulta,
        eq: () => consulta,
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
      };
      return consulta;
    },
  };
}

async function registrar(resultado: string, contato: Record<string, boolean> = {}) {
  vi.mocked(createClient).mockResolvedValue(banco(contato) as never);
  const resposta = await POST(
    new NextRequest("http://localhost/api/v1/cold-call/resultado", {
      method: "POST",
      body: JSON.stringify({ lead_id: LEAD, resultado }),
      headers: { "content-type": "application/json" },
    }),
  );
  return { status: resposta.status, corpo: (await resposta.json()) as { error?: { code: string } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moduloLigado).mockResolvedValue(true);
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "u", idioma: "pt-BR" } } as never);
});

describe("quem não recebe ligação não ganha resultado de ligação", () => {
  const casos: Array<{ estado: Record<string, boolean>; status: number; code: string }> = [
    { estado: { is_blocked: true }, status: 403, code: "forbidden" },
    { estado: { is_personal: true }, status: 403, code: "forbidden" },
    { estado: { is_anonymized: true }, status: 422, code: "contact_anonymized" },
  ];
  for (const { estado, status, code } of casos) {
    it(`${Object.keys(estado)[0]}: ${status} ${code}, e o lead não se move`, async () => {
      const r = await registrar("nao_atendeu", estado);
      expect(r.status).toBe(status);
      expect(r.corpo.error?.code).toBe(code);
      expect(moveLeadHandler).not.toHaveBeenCalled();
      expect(emitLeadActivity).not.toHaveBeenCalled();
    });
  }

  it("tirar da fila passa, mesmo bloqueado", async () => {
    const r = await registrar("removido", { is_blocked: true });
    expect(r.status).toBe(200);
    expect(encerraDemanda).toHaveBeenCalledTimes(1);
  });

  it("controle: contato comum registra e move", async () => {
    const r = await registrar("nao_atendeu");
    expect(r.status).toBe(200);
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
  });
});

describe("o módulo desligado", () => {
  it("responde 404 e não move nada", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    const r = await registrar("nao_atendeu");
    expect(r.status).toBe(404);
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });
});
