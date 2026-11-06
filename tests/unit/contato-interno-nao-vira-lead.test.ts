/**
 * #2353 — CONTATO INTERNO NÃO VIRA CARD, mas segue normal na Inbox.
 *
 * ═══ O defeito ═══
 *
 * No mesmo número escrevem clientes E gente que nunca vai ser negócio (equipe,
 * sócio, família, fornecedor). Toda primeira mensagem criava card no funil de
 * entrada, e o único motivo para não criar era `contato_bloqueado` — que é
 * opt-out e também corta o ENVIO, então não serve para quem a gente continua
 * atendendo.
 *
 * ═══ O que este arquivo mede ═══
 *
 *   1. contato com uma tag da lista interna NÃO vira card, e o motivo sai como
 *      `contato_interno` (registrado como os outros — silêncio não distingue
 *      "não devia nascer" de "falhou");
 *   2. a recusa é DIFERENTE do bloqueio: nada em `contacts` é escrito (não liga
 *      `is_blocked`), então a conversa segue normal na Inbox e o envio manual
 *      segue funcionando;
 *   3. regressões: contato SEM a tag segue nascendo o card; tag fora da lista
 *      não é interna; organização sem lista não marca ninguém.
 *
 * Prova chamando `garantirLeadDaConversa` de verdade, com o admin client
 * dublado — a regra que está sob teste é a função de produção, não uma cópia.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// A origem de campanha não importa aqui: `null` mantém o caminho no funil de
// entrada, que é o caso da issue.
vi.mock("@/lib/campanhas/origem-do-lead", () => ({
  origemDeCampanhaDaConversa: vi.fn(async () => null),
  marcaDaOrigem: vi.fn(() => ({ source: "campanha", source_metadata: {} })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/contacts/cliente-pela-agenda", () => ({
  lerClientePelaAgenda: vi.fn(async () => false),
}));

import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

const ORG = "org-1";

const CONTATO_BASE = {
  is_blocked: false,
  is_personal: false,
  display_name: "Fulano",
  name: "Fulano",
  phone_number: "5511999999999",
  source: null,
  source_metadata: null,
  first_service_at: null,
};

interface Cena {
  tags: string[] | null;
  /** `organizations.settings` cru. */
  settings: unknown;
  leadAberto?: boolean;
  /** Escritas em `contacts` — o que a recusa NÃO pode fazer. */
  contactWrites: Record<string, unknown>[];
  /** Chamadas a `fn_nascer_lead_da_conversa`. */
  nascimentos: number;
}

function adminFake(c: Cena) {
  const table = (name: string) => {
    const chain: Record<string, unknown> = {};
    const passa = () => chain;
    chain.select = passa;
    chain.eq = passa;
    chain.is = passa;
    chain.limit = passa;
    chain.order = passa;
    chain.update = (p: Record<string, unknown>) => {
      if (name === "contacts") c.contactWrites.push(p);
      return chain;
    };
    chain.maybeSingle = () => {
      if (name === "contacts") return Promise.resolve({ data: { ...CONTATO_BASE, tags: c.tags }, error: null });
      if (name === "organizations") return Promise.resolve({ data: { settings: c.settings }, error: null });
      if (name === "crm_leads")
        return Promise.resolve({ data: c.leadAberto ? { id: "lead-aberto" } : null, error: null });
      if (name === "crm_pipelines") return Promise.resolve({ data: { id: "funil-entrada" }, error: null });
      if (name === "crm_stages") return Promise.resolve({ data: { id: "etapa-1" }, error: null });
      return Promise.resolve({ data: null, error: null });
    };
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

function novaCena(parcial: Partial<Cena> = {}): Cena {
  return { tags: null, settings: { crm: { internal_contact_tags: ["interno", "equipe", "familia"] } }, contactWrites: [], nascimentos: 0, ...parcial };
}

const DADOS = {
  organizationId: ORG,
  contactId: "contato-1",
  conversationId: "conv-1",
  nomeDoContato: "Fulano",
};

beforeEach(() => vi.clearAllMocks());

describe("#2353 · contato com tag interna não vira card", () => {
  it("tag interna na lista da organização → NÃO nasce card, motivo 'contato_interno'", async () => {
    const c = novaCena({ tags: ["interno"] });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: false, motivo: "contato_interno" });
    // Nada de card: a RPC de nascimento não é chamada.
    expect(c.nascimentos).toBe(0);
  });

  it("a recusa é DIFERENTE do bloqueio: nenhuma escrita em `contacts` (não liga is_blocked)", async () => {
    const c = novaCena({ tags: ["familia"] });
    await garantirLeadDaConversa(adminFake(c), DADOS);

    // É aqui que o caso se separa do opt-out: bloquear também cortaria o envio;
    // marcar como interno não toca o contato, então a Inbox e o envio manual
    // seguem funcionando.
    expect(c.contactWrites).toHaveLength(0);
  });

  it("normaliza os dois lados: ' Interno ' casa com 'interno'", async () => {
    const c = novaCena({ tags: [" Interno "] });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);
    expect(r).toMatchObject({ criado: false, motivo: "contato_interno" });
  });

  it("qualquer uma das tags da lista basta (equipe, familia, ...)", async () => {
    for (const tag of ["equipe", "familia"]) {
      const c = novaCena({ tags: ["cliente", tag] });
      const r = await garantirLeadDaConversa(adminFake(c), DADOS);
      expect(r).toMatchObject({ criado: false, motivo: "contato_interno" });
    }
  });
});

describe("#2353 · regressões — quem NÃO é interno segue igual", () => {
  it("contato SEM tag → o card nasce no funil de entrada", async () => {
    const c = novaCena({ tags: [] });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: true, leadId: "lead-novo", pipelineId: "funil-entrada" });
    expect(c.nascimentos).toBe(1);
  });

  it("tag que NÃO está na lista interna (vip) não impede o card", async () => {
    const c = novaCena({ tags: ["vip"] });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);
    expect(r).toMatchObject({ criado: true });
  });

  it("organização SEM a lista configurada → ninguém é interno", async () => {
    const c = novaCena({ tags: ["interno"], settings: {} });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);
    expect(r).toMatchObject({ criado: true });
  });
});
