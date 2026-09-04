/**
 * R1 — `triggerHandoff` (o caminho de handoff do CRM: worker de sentimento,
 * tool MCP, worker legado) só passa bot→humano uma conversa que a IA PODERIA
 * estar atendendo agora. Numa conversa que o gate `allowlist` barra — cliente
 * antigo irritado dispara `low_sentiment` —, disparar mandaria "um humano vai te
 * atender" e mexeria no estado de uma conversa que nunca foi da IA.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONV = "44444444-4444-4444-8444-444444444444";
const ORG = "22222222-2222-4222-8222-222222222222";
const CONTACT = "66666666-6666-4666-8666-666666666666";

const avisarLeadDoCrm = vi.fn(async (..._a: unknown[]) => ({ avisado: true }));
const decidir = vi.fn();

vi.mock("@/lib/ai/handoff/aviso-ao-lead", () => ({ avisarLeadDoCrm: (...a: unknown[]) => avisarLeadDoCrm(...a) }));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: (...a: unknown[]) => decidir(...a),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const updates: Array<Record<string, unknown>> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: (p: Record<string, unknown>) => {
        updates.push(p);
        return chain;
      },
      insert: () => chain,
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve({
          data: { id: CONV, organization_id: ORG, contact_id: CONTACT, last_handoff_at: null, last_handoff_reason: null },
          error: null,
        }),
      then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
    };
    return {
      from: () => chain,
      rpc: () => Promise.resolve({ error: null }),
      channel: () => ({ send: () => Promise.resolve(), subscribe: () => ({}) }),
    };
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => false }));

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
});

describe("triggerHandoff · gate de elegibilidade", () => {
  it("gate 'allowlist' + não autorizado (bloqueioPorAllowlist) → NÃO dispara, NÃO avisa, NÃO mexe na conversa", async () => {
    decidir.mockResolvedValue({ permite: false, motivo: "sem_autorizacao", bloqueioPorAllowlist: true });
    const r = await triggerHandoff({ conversationId: CONV, organizationId: ORG, reason: "low_sentiment" });
    expect(r.triggered).toBe(false);
    expect(r.reason).toContain("nao_elegivel");
    expect(avisarLeadDoCrm).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("já duravelmente silenciada (conversa_silenciada) → NÃO re-dispara nem re-avisa", async () => {
    decidir.mockResolvedValue({ permite: false, motivo: "conversa_silenciada", bloqueioPorAllowlist: false });
    const r = await triggerHandoff({ conversationId: CONV, organizationId: ORG, reason: "low_confidence" });
    expect(r.triggered).toBe(false);
    expect(avisarLeadDoCrm).not.toHaveBeenCalled();
  });

  it("erro ao ler elegibilidade → NÃO dispara (fail-closed, o evento re-tenta)", async () => {
    decidir.mockRejectedValue(new Error("db down"));
    const r = await triggerHandoff({ conversationId: CONV, organizationId: ORG, reason: "low_sentiment" });
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe("elegibilidade_indeterminada");
    expect(avisarLeadDoCrm).not.toHaveBeenCalled();
  });

  it("conversa elegível (permite) → segue: avisa o lead", async () => {
    decidir.mockResolvedValue({ permite: true, motivo: "autorizado", bloqueioPorAllowlist: false });
    const r = await triggerHandoff({ conversationId: CONV, organizationId: ORG, reason: "requested_human" });
    expect(avisarLeadDoCrm).toHaveBeenCalledOnce();
    expect(r.triggered).toBe(true);
  });
});
