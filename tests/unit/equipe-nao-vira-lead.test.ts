/**
 * #3534 — CONTATO DA EQUIPE NÃO VIRA CARD, E A IA CONTINUA ATENDENDO.
 *
 * A lista da equipe (`settings.crm.team_contact_tags`) é separada da lista
 * interna de propósito: as duas recusam o card no funil (o sócio que testa o
 * agente não é oportunidade de captação), mas só a interna veta a IA. Este
 * arquivo prende a parte do FUNIL — e deixa escrito que o atendimento não é
 * tocado: nada em `contacts` é escrito, então a conversa segue na Inbox.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
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
  display_name: "Sócio",
  name: "Sócio",
  phone_number: "5511999999999",
  source: null,
  source_metadata: null,
  first_service_at: null,
};

interface Cena {
  tags: string[] | null;
  settings: unknown;
  contactWrites: Record<string, unknown>[];
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
      if (name === "contacts")
        return Promise.resolve({ data: { ...CONTATO_BASE, tags: c.tags }, error: null });
      if (name === "organizations")
        return Promise.resolve({ data: { settings: c.settings }, error: null });
      if (name === "crm_leads") return Promise.resolve({ data: null, error: null });
      if (name === "crm_pipelines")
        return Promise.resolve({ data: { id: "funil-entrada" }, error: null });
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
  return {
    tags: null,
    settings: { crm: { internal_contact_tags: ["interno"], team_contact_tags: ["socio"] } },
    contactWrites: [],
    nascimentos: 0,
    ...parcial,
  };
}

const DADOS = {
  organizationId: ORG,
  contactId: "contato-1",
  conversationId: "conv-1",
  nomeDoContato: "Sócio",
};

beforeEach(() => vi.clearAllMocks());

describe("#3534 · contato da equipe não vira card", () => {
  it("tag da equipe na lista → NÃO nasce card, motivo 'contato_da_equipe'", async () => {
    const c = novaCena({ tags: ["socio"] });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(r).toMatchObject({ criado: false, motivo: "contato_da_equipe" });
    expect(c.nascimentos).toBe(0);
  });

  it("a recusa NÃO toca o contato: a conversa segue na Inbox e a IA segue atendendo", async () => {
    const c = novaCena({ tags: ["socio"] });
    await garantirLeadDaConversa(adminFake(c), DADOS);

    expect(c.contactWrites).toHaveLength(0);
  });

  it("a lista interna continua vencendo com o motivo dela (as duas coexistem)", async () => {
    const c = novaCena({ tags: ["interno", "socio"] });
    const r = await garantirLeadDaConversa(adminFake(c), DADOS);
    expect(r).toMatchObject({ criado: false, motivo: "contato_interno" });
  });

  it("regressões: tag fora das duas listas nasce card; sem a lista da equipe, 'socio' nasce", async () => {
    const fora = novaCena({ tags: ["vip"] });
    expect(await garantirLeadDaConversa(adminFake(fora), DADOS)).toMatchObject({ criado: true });

    const semLista = novaCena({ tags: ["socio"], settings: { crm: { internal_contact_tags: [] } } });
    expect(await garantirLeadDaConversa(adminFake(semLista), DADOS)).toMatchObject({ criado: true });
  });
});
