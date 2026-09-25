/**
 * PATCH de `config` grava SÓ as chaves que o cliente mandou (#1631).
 *
 * No Zod 4, `.partial()` mantém o `.default()` de cada campo: o schema do PATCH
 * devolvia os dez campos de `config` preenchidos, e a junção da rota
 * (`{ ...AGENT_CONFIG_DEFAULTS, ...atual, ...patch.config }`) sobrescrevia a
 * config inteira. O cartão "Comandos pelo celular" manda uma chave só — e ligar
 * o interruptor regravava temperatura e RAG com os defaults. Medido pelo revisor:
 * {rag_top_k:8, rag_similarity_threshold:0.3, temperature:0.9} virava 5/0.4/0.4.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { agentPatchSchema } from "@/lib/ai/guardrails-schema";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "55555555-5555-4555-8555-555555555555";

let gravado: Record<string, unknown> | null;

function agente(config: Record<string, unknown>) {
  return {
    id: AGENT,
    organization_id: ORG,
    name: "Tobias",
    description: null,
    model: "anthropic/claude-sonnet-4-6",
    system_prompt: "Você é o Tobias, atendente da loja.",
    is_active: true,
    is_default: true,
    kind: "rag_bot",
    priority: 0,
    published_version_id: null,
    archived_at: null,
    config,
    guardrails: [],
    active_kb_version_id: null,
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
  };
}

function admin(linha: Record<string, unknown>) {
  const q = (op: "select" | "update", patch?: Record<string, unknown>) => {
    const enc = {
      select: () => enc,
      eq: () => enc,
      is: () => enc,
      maybeSingle: async () => ({ data: linha, error: null }),
      single: async () => {
        if (op === "update") {
          gravado = patch ?? {};
          return { data: { ...linha, ...patch }, error: null };
        }
        return { data: linha, error: null };
      },
    };
    return enc;
  };
  return {
    from: () => ({
      select: () => q("select"),
      update: (patch: Record<string, unknown>) => q("update", patch),
    }),
  };
}

async function patch(corpo: Record<string, unknown>, linha: Record<string, unknown>) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG, name: "Org", role: "admin" as const },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue(admin(linha) as never);
  const { PATCH } = await import("@/app/api/v1/ai/agents/[id]/route");
  const req = new NextRequest(`http://localhost/api/v1/ai/agents/${AGENT}`, {
    method: "PATCH",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  const res = await PATCH(req, { params: Promise.resolve({ id: AGENT }) } as never);
  return res.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  gravado = null;
});

describe("PATCH /api/v1/ai/agents/:id — config parcial não regrava o que não veio", () => {
  it("ligar os comandos do celular mantém temperatura e RAG ajustados", async () => {
    const status = await patch(
      { config: { aceita_comandos_celular: true } },
      agente({ rag_top_k: 8, rag_similarity_threshold: 0.3, temperature: 0.9 }),
    );
    expect(status).toBe(200);
    expect(gravado?.config).toMatchObject({
      aceita_comandos_celular: true,
      rag_top_k: 8,
      rag_similarity_threshold: 0.3,
      temperature: 0.9,
    });
  });

  it("ajustar o RAG não desliga os comandos do celular", async () => {
    const status = await patch(
      { config: { rag_top_k: 10 } },
      agente({ aceita_comandos_celular: true }),
    );
    expect(status).toBe(200);
    expect(gravado?.config).toMatchObject({ rag_top_k: 10, aceita_comandos_celular: true });
  });

  it("o schema do PATCH não inventa chave: config vazio sai vazio", () => {
    // Reprova campo novo de `agentConfigSchema` com `.default()` que não entrar
    // em `agentConfigPatchSchema` — o mesmo defeito voltaria só para ele.
    expect(agentPatchSchema.parse({ config: {} }).config).toEqual({});
  });
});
