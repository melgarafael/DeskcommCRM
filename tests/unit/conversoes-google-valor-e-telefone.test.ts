/**
 * A venda sem valor e o telefone criptografado (0436).
 *
 * Modos de falha vigiados: a venda sem valor indo como ZERO (ensina ao Google
 * que a venda não vale nada), a Meta passando a aceitar venda sem valor por
 * tabela, e o telefone saindo em claro ou sem o `+` do E.164.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import { montarEvento } from "@/lib/plataformas-de-anuncio/google/data-manager";
import { telefoneCriptografado, telefoneE164 } from "@/lib/plataformas-de-anuncio/google/telefone";
import type { ConversaoOffline, CredencialDeConversao } from "@/lib/plataformas-de-anuncio/types";

const mocks = vi.hoisted(() => ({
  enviar: vi.fn(),
  admin: vi.fn(),
  atribuicao: vi.fn(),
  credencial: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/conversoes/leitura-da-atribuicao", () => ({ lerAtribuicao: mocks.atribuicao }));
vi.mock("@/lib/plataformas-de-anuncio/credenciais", () => ({ lerCredencial: mocks.credencial }));
vi.mock("@/lib/plataformas-de-anuncio/registry", () => ({
  ehPlataformaConhecida: (p: string) => ["google_ads", "meta_ads"].includes(p),
  transporteDe: () => ({ enviar: mocks.enviar }),
}));

const { conversaoDeVendaHandler } = await import("@/lib/conversoes/envio.handler");

let lead: Record<string, unknown>;
let registros: Record<string, Record<string, unknown>>;
const row: EventRow = {
  id: "e",
  entity_id: "lead",
  entity_kind: "crm_lead",
  organization_id: "org",
  event_type: "lead.won",
  payload: {},
  metadata: {},
  attempts: 0,
  consumed_by: [],
  created_at: "2026-09-27T10:00:00.000Z",
};

function credencialGoogle(modo: "obrigatorio" | "quando_houver" | "nunca") {
  return {
    ok: true,
    credencial: {
      datasetId: "1234567890",
      accessToken: "",
      testEventCode: null,
      google: {
        api: "data_manager",
        refreshToken: "r",
        customerId: "1234567890",
        loginCustomerId: null,
        conversionActionId: "99",
        modoDeValorDaVenda: modo,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registros = {};
  lead = {
    id: "lead",
    status: "won",
    value_cents: null,
    currency: "BRL",
    closed_at: "2026-09-27T09:00:00.000Z",
    contact_id: "contato",
  };
  mocks.enviar.mockResolvedValue({ tipo: "ok" });
  mocks.atribuicao.mockResolvedValue({
    temAtribuicao: true,
    atribuicao: {
      plataforma: "google_ads",
      cliqueDeOrigem: "G1",
      telefone: "5531999998888",
      identificadoresGoogle: { gclid: "G1" },
    },
  });
  mocks.credencial.mockResolvedValue(credencialGoogle("obrigatorio"));
  mocks.admin.mockReturnValue({
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filtros[k] = v;
          return q;
        },
        maybeSingle: async () => ({
          data:
            tabela === "crm_leads"
              ? lead
              : tabela === "ad_conversion_dispatches"
                ? (registros[String(filtros.event_name)] ?? null)
                : null,
          error: null,
        }),
        upsert: async (d: Record<string, unknown>) => {
          registros[String(d.event_name)] = { ...registros[String(d.event_name)], ...d };
          return { error: null };
        },
      };
      return q;
    },
  });
});

describe("venda sem valor no Google", () => {
  it("modo obrigatório (padrão histórico) não envia e registra sem_valor", async () => {
    expect(await conversaoDeVendaHandler.handle(row)).toMatchObject({ detail: "sem_valor" });
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(registros.Purchase).toMatchObject({ status: "skipped", reason: "sem_valor" });
  });
  it("modo quando_houver envia a compra SEM valor — nunca como zero", async () => {
    mocks.credencial.mockResolvedValue(credencialGoogle("quando_houver"));
    expect(await conversaoDeVendaHandler.handle(row)).toMatchObject({ status: "ok" });
    expect(mocks.enviar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ evento: "Purchase", valorCentavos: null }),
    );
    expect(registros.Purchase).toMatchObject({ status: "sent", value_cents: null });
  });
  it("modo quando_houver leva o valor quando existe", async () => {
    mocks.credencial.mockResolvedValue(credencialGoogle("quando_houver"));
    lead.value_cents = 150_00;
    await conversaoDeVendaHandler.handle(row);
    expect(mocks.enviar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ valorCentavos: 150_00 }),
    );
  });
  it("modo nunca envia sem valor mesmo quando o negócio tem valor", async () => {
    mocks.credencial.mockResolvedValue(credencialGoogle("nunca"));
    lead.value_cents = 150_00;
    await conversaoDeVendaHandler.handle(row);
    expect(mocks.enviar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ valorCentavos: null }),
    );
    expect(registros.Purchase).toMatchObject({ status: "sent", value_cents: null });
  });
  it("sem conexão, a venda sem valor continua registrada como sem_valor", async () => {
    mocks.credencial.mockResolvedValue({ ok: false, motivo: "sem_conexao" });
    expect(await conversaoDeVendaHandler.handle(row)).toMatchObject({ detail: "sem_valor" });
  });
  // A decisão da Meta sem valor espera a credencial (#2076: a conversa só é
  // lida quando a venda tem para onde ir). O modo de valor do Google não vale
  // para ela nem quando a credencial o traz.
  it("a Meta segue exigindo valor, mesmo com um modo de valor do Google na credencial", async () => {
    mocks.atribuicao.mockResolvedValue({
      temAtribuicao: true,
      atribuicao: { plataforma: "meta_ads", cliqueDeOrigem: "ctwa", telefone: null },
    });
    mocks.credencial.mockResolvedValue(credencialGoogle("quando_houver"));
    expect(await conversaoDeVendaHandler.handle(row)).toMatchObject({ detail: "sem_valor" });
    expect(mocks.enviar).not.toHaveBeenCalled();
  });
});

describe("telefone criptografado", () => {
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  it("normaliza para E.164 com + antes de criptografar", () => {
    expect(telefoneE164("+55 (31) 99999-8888")).toBe("+5531999998888");
    expect(telefoneCriptografado("5531999998888")).toBe(hash("+5531999998888"));
  });
  it("número impossível não vira identificador", () => {
    expect(telefoneCriptografado("123")).toBeNull();
    expect(telefoneCriptografado(null)).toBeNull();
    expect(telefoneCriptografado("1".repeat(16))).toBeNull();
  });

  const credencial = (enviarTelefone: boolean): CredencialDeConversao => ({
    datasetId: "1234567890",
    accessToken: "",
    testEventCode: null,
    google: {
      api: "data_manager",
      refreshToken: "r",
      customerId: "123-456-7890",
      loginCustomerId: null,
      conversionActionId: "99",
      enviarTelefone,
    },
  });
  const conversao: ConversaoOffline = {
    organizationId: "org",
    leadId: "lead",
    evento: "Purchase",
    eventoId: "lead:Purchase",
    ocorridoEm: new Date("2026-09-27T09:00:00Z"),
    cliqueDeOrigem: "G1",
    identificadoresGoogle: { gclid: "G1" },
    telefone: "5531999998888",
    valorCentavos: null,
    moeda: "BRL",
  };

  it("o Data Manager só leva o telefone quando a organização ligou, sempre em hash HEX", () => {
    const desligado = montarEvento(credencial(false), conversao) as Record<string, unknown>;
    expect(desligado).not.toHaveProperty("encoding");
    expect(JSON.stringify(desligado)).not.toContain("5531999998888");
    expect(JSON.stringify(desligado)).not.toContain("userData");

    const ligado = montarEvento(credencial(true), conversao) as {
      encoding: string;
      events: Array<Record<string, unknown>>;
    };
    expect(ligado.encoding).toBe("HEX");
    expect(ligado.events[0]).toMatchObject({
      adIdentifiers: { gclid: "G1" },
      userData: { userIdentifiers: [{ phoneNumber: hash("+5531999998888") }] },
    });
    expect(JSON.stringify(ligado)).not.toContain("5531999998888");
    expect(ligado.events[0]).not.toHaveProperty("conversionValue");
  });
  it("sem clique, o evento não inventa adIdentifiers", () => {
    const semClique = montarEvento(credencial(true), {
      ...conversao,
      identificadoresGoogle: undefined,
      cliqueDeOrigem: "",
    }) as { events: Array<Record<string, unknown>> };
    expect(semClique.events[0]).not.toHaveProperty("adIdentifiers");
    expect(semClique.events[0]).toHaveProperty("userData");
  });
});
