/**
 * POST /api/v1/contacts/[id]/phones/[phoneId]/primary — "Tornar principal" (Spec 31, B2, item 6).
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Trocar um dos três ids na chamada da RPC (ex.: `p_extra: id`): o caso
 *   "chama a RPC com os três ids" cai.
 * - Tratar `P0002` como 500: o caso "P0002 → 404" cai.
 * - Fazer a troca por update direto em vez da RPC: o caso da RPC cai.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const EXTRA = "55555555-5555-4555-8555-555555555555";

function fakeSupabase(resposta: { error?: { code?: string; message: string } | null }) {
  const chamadas: Array<{ nome: string; args: unknown }> = [];
  const cliente = {
    rpc: (nome: string, args: unknown) => {
      chamadas.push({ nome, args });
      return Promise.resolve({ data: null, error: resposta.error ?? null });
    },
  };
  return { cliente, chamadas };
}

function req() {
  return new NextRequest("http://localhost/x", { method: "POST" });
}

const CONTEXTO = { params: Promise.resolve({ id: CONTATO, phoneId: EXTRA }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
});

describe("POST /api/v1/contacts/[id]/phones/[phoneId]/primary", () => {
  it("chama fn_tornar_telefone_principal com organização, ficha e extra, e audita a troca", async () => {
    const { cliente, chamadas } = fakeSupabase({ error: null });
    vi.mocked(createClient).mockResolvedValue(cliente as never);
    const { POST } = await import("./route");

    const res = await POST(req(), CONTEXTO);

    expect(res.status).toBe(200);
    expect(chamadas).toEqual([
      {
        nome: "fn_tornar_telefone_principal",
        args: { p_org: ORG, p_contato: CONTATO, p_extra: EXTRA },
      },
    ]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.primary_phone_changed", resourceId: CONTATO }),
    );
  });

  it("P0002 da função (extra que não é desta ficha) → 404, e sem audit", async () => {
    const { cliente } = fakeSupabase({
      error: { code: "P0002", message: "telefone_extra_indisponivel" },
    });
    vi.mocked(createClient).mockResolvedValue(cliente as never);
    const { POST } = await import("./route");

    const res = await POST(req(), CONTEXTO);

    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
