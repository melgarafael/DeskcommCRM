import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/escalacao/retomada", () => ({ devolverAtendimentoAoAgente: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "44444444-4444-4444-8444-444444444444";

/**
 * "Devolver ao automático" num contato "sempre atendimento humano" (#2379).
 * `retomada.ts` recusa ANTES de qualquer escrita; a rota não pode responder
 * "Atendimento devolvido, mas…", que afirma uma devolução que não aconteceu.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o ramo `contato_sempre_humano`: o caso do 409 acusa (cai no 500
 *   "Atendimento devolvido…").
 * - Tirar o ramo `contact_state_unreadable`: o caso "nada foi alterado" acusa.
 */

const chamar = () =>
  POST(new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/reactivate-bot`, { method: "POST" }), {
    params: Promise.resolve({ id: CONVERSA }),
  });

const recusa = (erro: string) =>
  vi.mocked(devolverAtendimentoAoAgente).mockResolvedValue({ ok: false, erro } as Awaited<
    ReturnType<typeof devolverAtendimentoAoAgente>
  >);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ORG, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as Awaited<ReturnType<typeof requireRole>>);
  // A rota lê o dono da conversa antes de devolver (#3436): aqui a conversa não
  // tem dono, então a regra de dono não interfere nos casos de #2379.
  vi.mocked(createClient).mockResolvedValue(conversaSemDono() as Awaited<ReturnType<typeof createClient>>);
});

/** O único pedaço do client que a rota usa antes de chamar a regra: o dono. */
function conversaSemDono(): Awaited<ReturnType<typeof createClient>> {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = () => b;
  b.maybeSingle = async () => ({ data: { id: CONVERSA, assigned_to_user_id: null }, error: null });
  return { from: () => b } as unknown as Awaited<ReturnType<typeof createClient>>;
}

describe("reactivate-bot — contato 'sempre atendimento humano' (#2379)", () => {
  it("contato marcado: 409 que diz o que fazer, nunca 'Atendimento devolvido'", async () => {
    recusa("contato_sempre_humano");
    const res = await chamar();
    const corpo = await res.json();
    expect(res.status).toBe(409);
    expect(corpo.error.code).toBe("state_conflict");
    expect(corpo.error.message).toContain("remova a marca na ficha do contato");
    expect(corpo.error.message).not.toContain("Atendimento devolvido");
  });

  it("leitura do contato falhou: 500 dizendo que nada foi alterado", async () => {
    recusa("contact_state_unreadable");
    const res = await chamar();
    const corpo = await res.json();
    expect(res.status).toBe(500);
    expect(corpo.error.message).toContain("nada foi alterado");
    expect(corpo.error.message).not.toContain("Atendimento devolvido");
  });

  it("controle: falha do sinal de retomada segue dizendo que a devolução aconteceu", async () => {
    recusa("resume_signal_failed");
    const res = await chamar();
    const corpo = await res.json();
    expect(res.status).toBe(500);
    expect(corpo.error.message).toContain("Atendimento devolvido");
  });
});
