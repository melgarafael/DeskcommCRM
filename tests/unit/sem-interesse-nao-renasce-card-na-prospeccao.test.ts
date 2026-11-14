/**
 * QUEM DISSE "NÃO TENHO INTERESSE" NA PROSPECÇÃO NÃO GANHA CARD DE VOLTA NA MESMA CONVERSA.
 *
 * A entrada de mensagem grava a recusa e encerra o negócio da prospecção ANTES de
 * `garantirLeadDaConversa` (`lib/channels/pos-entrada.ts`). Sem a guarda 1d, o card
 * encerrado renasceria na hora: não há mais negócio aberto, então o passo 2 deixaria
 * passar e o card novo nasceria no funil de entrada — o "ok, obrigado" seguinte idem.
 *
 * Fora da conversa de prospecção nada muda: quem recusou ofertas e volta para comprar
 * abre negócio como sempre.
 *
 * ─── SABOTAGEM ─────────────────────────────────────────────────────────────
 * - Tirar o bloco 1d de `nascimento-do-lead.ts`: o primeiro caso fica vermelho.
 * - Trocar a régua da conversa por "qualquer conversa": o segundo caso fica vermelho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/campanhas/origem-do-lead", () => ({
  origemDeCampanhaDaConversa: vi.fn(async () => null),
  marcaDaOrigem: vi.fn(() => ({ source: "campanha", source_metadata: {} })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/contacts/cliente-pela-agenda", () => ({ lerClientePelaAgenda: vi.fn(async () => false) }));

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { consentComSemInteresse } from "@/lib/lgpd/sem-interesse";

interface Cena {
  consent: unknown;
  metadataDaConversa: Record<string, unknown> | null;
  nascimentos: number;
}

function adminFake(c: Cena) {
  const table = (name: string) => {
    const chain: Record<string, unknown> = {};
    const passa = () => chain;
    for (const m of ["select", "eq", "is", "in", "limit", "order", "neq", "not", "gte", "lte"]) chain[m] = passa;
    chain.update = passa;
    chain.maybeSingle = () => {
      if (name === "contacts")
        return Promise.resolve({
          data: {
            is_blocked: false,
            is_personal: false,
            display_name: "Oficina do Zé",
            name: "Oficina do Zé",
            phone_number: "5585999999999",
            source: "prospecting",
            source_metadata: null,
            first_service_at: null,
            tags: [],
            consent: c.consent,
          },
          error: null,
        });
      if (name === "conversations") return Promise.resolve({ data: { metadata: c.metadataDaConversa }, error: null });
      if (name === "organizations") return Promise.resolve({ data: { settings: {} }, error: null });
      if (name === "crm_pipelines") return Promise.resolve({ data: { id: "funil-entrada" }, error: null });
      if (name === "crm_stages") return Promise.resolve({ data: { id: "etapa-1" }, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    chain.then = (resolve: (v: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve);
    return chain;
  };
  return {
    from: (n: string) => table(n),
    rpc: async (fn: string) => {
      if (fn === "fn_nascer_lead_da_conversa") {
        c.nascimentos += 1;
        return { data: "lead-novo", error: null };
      }
      return { data: null, error: null };
    },
  } as never;
}

const RECUSA = consentComSemInteresse({}, { agora: "2026-11-14T12:00:00Z", origem: "conversa_de_prospeccao" });
const DADOS = { organizationId: "org-1", contactId: "contato-1", conversationId: "conv-1", nomeDoContato: "Oficina do Zé" };

let cena: Cena;
beforeEach(() => {
  vi.clearAllMocks();
  cena = { consent: RECUSA, metadataDaConversa: { prospecting_campaign_id: "campanha-1" }, nascimentos: 0 };
});

describe("D3 · o card da prospecção não renasce", () => {
  it("recusa 'sem interesse' + conversa da prospecção → nenhum card", async () => {
    const r = await garantirLeadDaConversa(adminFake(cena), DADOS);
    expect(r).toMatchObject({ criado: false, motivo: "sem_interesse_na_prospeccao" });
    expect(cena.nascimentos).toBe(0);
  });

  it("a mesma recusa numa conversa que NÃO é de prospecção → o card nasce como sempre", async () => {
    cena.metadataDaConversa = { origem: "inbox" };
    const r = await garantirLeadDaConversa(adminFake(cena), DADOS);
    expect(r).toMatchObject({ criado: true });
  });

  it("sem recusa, a conversa da prospecção abre card como sempre (a guarda não alarga)", async () => {
    cena.consent = {};
    const r = await garantirLeadDaConversa(adminFake(cena), DADOS);
    expect(r).toMatchObject({ criado: true });
  });
});
