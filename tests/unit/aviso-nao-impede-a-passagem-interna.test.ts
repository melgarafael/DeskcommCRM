/**
 * O AVISO CALADO NÃO CALA A PASSAGEM (#4797).
 *
 * A guarda 3 do emissor (`aviso-so-com-mensagem-nova.test.ts`) impede que a
 * frase saia para quem já foi respondido. O risco de um conserto assim é o
 * oposto do defeito: a passagem para humano — o CASO na Central, o silêncio da
 * IA, o carimbo em `last_handoff_at` — passar a depender do aviso. Não pode: o
 * autor do #4797 pediu que a passagem SEM mensagem nova "continue acontecendo
 * por dentro (caso, Central)".
 *
 * É o desenho do orquestrador que garante isso: o Step 0 (`avisarLeadDoCrm`)
 * devolve um DESFECHO, não um veredito — nada nele é `throw`, e a recusa não
 * interrompe o Step 1 em diante. Este arquivo mede essa promessa no único lugar
 * em que ela pode ser quebrada: o código do orquestrador.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *
 * - Trocar o `const aviso = ... : await avisarLeadDoCrm(...)` por um `return`
 *   quando `aviso.avisado === false` → este caso acusa: a conversa fica como
 *   estava e o item da Central nunca nasce.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONV = "44444444-4444-4444-8444-444444444444";
const ORG = "22222222-2222-4222-8222-222222222222";
const CONTACT = "66666666-6666-4666-8666-666666666666";

type Escrita = { tabela: string; tipo: "insert" | "update"; payload: Record<string, unknown> };

let escritas: Escrita[] = [];
let linha: Record<string, unknown> = {};

const avisar = vi.fn(async () => ({ avisado: false, porque: "sem_mensagem_nova_do_cliente" }));

vi.mock("@/lib/ai/handoff/aviso-ao-lead", () => ({ avisarLeadDoCrm: (...a: unknown[]) => avisar(...(a as [])) }));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => ({
    permite: true,
    motivo: "gate_aberto",
    bloqueioPorAllowlist: false,
  })),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabela = (nome: string): any => {
      const chain: any = {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          escritas.push({ tabela: nome, tipo: "update", payload: p });
          return chain;
        },
        insert: (p: Record<string, unknown>) => {
          escritas.push({ tabela: nome, tipo: "insert", payload: p });
          return chain;
        },
        delete: () => chain,
        eq: () => chain,
        gt: () => chain,
        order: () => chain,
        limit: () => chain,
        // A conversa existe; o item aberto da Central NÃO — é o caso de hoje, e
        // é o que faz o Step 6 INSERIR o aviso em vez de enriquecer um antigo.
        maybeSingle: () => Promise.resolve({ data: nome === "conversations" ? linha : null, error: null }),
        single: () => Promise.resolve({ data: {}, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
      };
      return chain;
    };
    return {
      from: (nome: string) => tabela(nome),
      rpc: () => Promise.resolve({ error: null }),
      channel: () => ({ send: () => Promise.resolve(), subscribe: () => ({}) }),
    };
  },
}));

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";

beforeEach(() => {
  vi.clearAllMocks();
  escritas = [];
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

describe("(e) passagem interna sem aviso ao cliente", () => {
  it("o aviso recusado não impede silêncio, status e caso na Central", async () => {
    const r = await triggerHandoff({
      conversationId: CONV,
      organizationId: ORG,
      reason: "low_confidence",
      origem: "legado_confianca",
    });

    // A passagem ACONTECEU — e o desfecho do aviso vai junto, para quem lê o
    // registro saber que o cliente não foi avisado (e por quê).
    expect(r.triggered).toBe(true);
    expect(r.aviso).toEqual({ avisado: false, porque: "sem_mensagem_nova_do_cliente" });
    expect(avisar).toHaveBeenCalledTimes(1);

    // Step 1 — a IA cala e a conversa vai para a fila.
    const daConversa = escritas.find((e) => e.tabela === "conversations" && e.tipo === "update");
    expect(daConversa).toBeDefined();
    expect(daConversa?.payload).toMatchObject({
      status: "pending",
      bot_silenced_until: "infinity",
      last_handoff_reason: "low_confidence",
    });
    expect(typeof daConversa?.payload.last_handoff_at).toBe("string");

    // A LINHA DE FATO da passagem, mesmo sem aviso.
    const passagem = escritas.find((e) => e.tabela === "passagens_de_atendimento");
    expect(passagem?.tipo).toBe("insert");

    // Step 6 — o caso que a Central mostra para uma pessoa assumir.
    const caso = escritas.find((e) => e.tabela === "agent_inbox_items" && e.tipo === "insert");
    expect(caso).toBeDefined();
    expect(caso?.payload).toMatchObject({
      organization_id: ORG,
      kind: "handoff",
      ref_kind: "conversation",
      ref_id: CONV,
    });
  });
});
