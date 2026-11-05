/**
 * HANDOFF DE UMA CONVERSA NO MODO "IA COM O DONO" (#3967, fatia 1).
 *
 * A regra que este arquivo mede: quando a IA passa para humano numa conversa que
 * JÁ tem dono e está no modo ligado, a conversa NÃO vai para `pending`. `pending`
 * significa "na fila, esperando um atendente" — mandar para lá uma conversa que
 * já é de alguém é tirá-la da visão de quem a acompanha para colocá-la numa fila
 * que não é dela. Nesse modo o handoff é "a IA para e o dono assume": o dono
 * fica, o status fica, o silêncio entra.
 *
 * Os dois lados opostos ficam no mesmo arquivo, porque a mudança é uma exceção e
 * exceção sem o caso geral ao lado é exceção que virou regra:
 *   - sem modo (ou sem dono) → `pending`, exatamente como hoje.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Trocar `...(donoNoModo ? {} : { status: "pending" })` por `status: "pending"`
 *   fixo: o primeiro caso acusa.
 * - Fazer o inverso (nunca mais mandar para `pending`): o segundo e o terceiro
 *   casos acusam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONV = "44444444-4444-4444-8444-444444444444";
const ORG = "22222222-2222-4222-8222-222222222222";
const CONTACT = "66666666-6666-4666-8666-666666666666";
const DONO = "33333333-3333-4333-8333-333333333333";

const updates: Array<Record<string, unknown>> = [];
let linha: Record<string, unknown> = {};

vi.mock("@/lib/ai/handoff/aviso-ao-lead", () => ({ avisarLeadDoCrm: vi.fn(async () => ({ avisado: true })) }));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => ({
    permite: true,
    motivo: "gate_aberto",
    bloqueioPorAllowlist: false,
  })),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
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
      maybeSingle: () => Promise.resolve({ data: linha, error: null }),
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
  linha = {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    last_handoff_at: null,
    last_handoff_reason: null,
    last_outbound_at: null,
    assigned_to_user_id: null,
    metadata: {},
  };
});

const disparar = () =>
  triggerHandoff({ conversationId: CONV, organizationId: ORG, reason: "requested_human", origem: "legado_pedido" });

/** O primeiro UPDATE da linha da conversa — o do Step 1 do orchestrator. */
const updateDaConversa = () => {
  const u = updates[0];
  if (!u) throw new Error("o handoff não escreveu na conversa");
  return u;
};

describe("triggerHandoff · modo 'IA com o dono'", () => {
  it("modo ligado + dono: a conversa NÃO vai para `pending` e o dono não é escrito", async () => {
    linha.assigned_to_user_id = DONO;
    linha.metadata = { ai_com_dono: true };

    const r = await disparar();

    expect(r.triggered).toBe(true);
    const upd = updateDaConversa();
    expect(upd).toBeDefined();
    expect(upd).not.toHaveProperty("status");
    expect(upd).not.toHaveProperty("status_changed_at");
    expect(upd).not.toHaveProperty("assigned_to_user_id");
    expect(upd).not.toHaveProperty("assignee_kind");
    // A IA continua calando: o silêncio durável É o handoff.
    expect(upd.bot_silenced_until).toBe("infinity");
    expect(upd.last_handoff_reason).toBe("requested_human");
  });

  it("LADO OPOSTO: sem o modo, a mesma conversa com dono vai para `pending` (hoje)", async () => {
    linha.assigned_to_user_id = DONO;
    linha.metadata = { handoff_tecnico: { chamado: "T-1" } };

    await disparar();

    const upd = updateDaConversa();
    expect(upd.status).toBe("pending");
    expect(upd.status_changed_at).toBeTruthy();
    expect(upd.assigned_to_user_id).toBeUndefined();
  });

  it("LADO OPOSTO: modo ligado SEM dono não segura a conversa (não há dono a preservar)", async () => {
    linha.assigned_to_user_id = null;
    linha.metadata = { ai_com_dono: true };

    await disparar();

    expect(updateDaConversa().status).toBe("pending");
  });

  it("LADO OPOSTO: `ai_com_dono` com lixo no jsonb não conta como ligado", async () => {
    linha.assigned_to_user_id = DONO;
    linha.metadata = { ai_com_dono: "true" };

    await disparar();

    expect(updateDaConversa().status).toBe("pending");
  });
});
