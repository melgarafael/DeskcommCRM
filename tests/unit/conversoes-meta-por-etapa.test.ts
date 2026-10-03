/**
 * Eventos de ETAPA para a Meta (migration 0524).
 *
 * Os modos de falha que este arquivo vigia:
 *  - negócio de anúncio da Meta entra na etapa com regra e NADA sai;
 *  - o evento sai com o nome errado (o do livro-razão, `MetaEtapa:<uuid>`, em
 *    vez do padrão da Meta) ou com um valor que não existiu;
 *  - lead do Google, ou orgânico, indo para a conta de anúncios da Meta;
 *  - a mesma etapa enviada duas vezes, ou o histórico despejado ao ligar a regra;
 *  - o reenvio usando a regra de agora em vez do evento que foi registrado;
 *  - o consumidor da venda ou o do Google tratando um evento de etapa da Meta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";
import { conversaoDeEtapaMetaHandler } from "@/lib/conversoes/etapa-meta.handler";
import { conversaoDeQualificacaoHandler } from "@/lib/conversoes/qualificacao.handler";
import { eventoRecomendadoParaMeta } from "@/lib/conversoes/regras-meta";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { transporteMeta } from "@/lib/plataformas-de-anuncio/meta/conversions";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "22222222-2222-2222-2222-222222222222";
const CONTATO = "33333333-3333-3333-3333-333333333333";
const ORCAMENTO = "44444444-4444-4444-8444-444444444444";
const CHAVE = `MetaEtapa:${ORCAMENTO}`;

let tabelas: Record<string, unknown>;
const upserts: Record<string, unknown>[] = [];

/** Banco de mentira com o livro-razão de verdade: o que foi gravado é relido. */
function fakeAdmin() {
  return {
    from(tabela: string) {
      const construtor = {
        select: () => construtor,
        eq: () => construtor,
        neq: () => construtor,
        in: () => construtor,
        order: () => construtor,
        limit: () => construtor,
        maybeSingle: async () => ({ data: tabelas[tabela] ?? null, error: null }),
        upsert: async (valores: Record<string, unknown>) => {
          if (tabela === "ad_conversion_dispatches") {
            upserts.push(valores);
            const antes = tabelas.ad_conversion_dispatches as Record<string, unknown> | null;
            tabelas.ad_conversion_dispatches = { ...(antes ?? {}), ...valores };
          }
          return { error: null };
        },
      };
      return construtor;
    },
    rpc: async () => ({ data: "token-decifrado", error: null }),
  };
}

const daPaginaComUtmMeta = {
  phone_number: "5511988887777",
  source_metadata: { ad_platform: "site", ad_source_id: null, utm_source: "instagram" },
};
const doCliqueParaWhatsApp = {
  phone_number: "5511988887777",
  source_metadata: { ad_platform: "meta_ads", ad_source_id: "ctwa-abc" },
};
const doGoogle = {
  phone_number: "5511988887777",
  source_metadata: {
    ad_platform: "google_ads",
    ad_source_id: "gclid-1",
    ad_raw: { click_identifiers: { gclid: "gclid-1" } },
  },
};

const regra = (extra: Record<string, unknown> = {}) => ({
  id: "r1",
  stage_id: ORCAMENTO,
  event_name: CHAVE,
  meta_event: "InitiateCheckout",
  enabled: true,
  configured_at: "2026-01-01T00:00:00Z",
  ...extra,
});

function base(contato: unknown) {
  tabelas = {
    meta_ads_conversion_rules: regra(),
    ad_conversion_dispatches: null,
    crm_stages: { id: ORCAMENTO },
    crm_leads: {
      id: LEAD,
      status: "open",
      value_cents: 900_00,
      currency: "BRL",
      closed_at: null,
      contact_id: CONTATO,
    },
    contacts: contato,
    ad_platform_connections: {
      dataset_id: "123456789012345",
      access_token_encrypted: "\\xdeadbeef",
      test_event_code: null,
      enabled: true,
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(fakeAdmin() as never);
}

function mudouDeEtapa(extra: Partial<EventRow> = {}): EventRow {
  return {
    id: "evt",
    organization_id: ORG,
    event_type: "lead.stage_changed",
    entity_kind: "crm_lead",
    entity_id: LEAD,
    payload: { to_stage_id: ORCAMENTO },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
    ...extra,
  };
}

const reenvio = (): EventRow =>
  mudouDeEtapa({ event_type: "ad_conversion.retry_requested", payload: { event_name: CHAVE } });

interface EventoEnviado {
  event_name: string;
  event_id: string;
  action_source: string;
  user_data: { ctwa_clid?: string; ph?: string[] };
  custom_data?: unknown;
}

function enviados(spy: ReturnType<typeof vi.spyOn>): EventoEnviado[] {
  return (spy.mock.calls as unknown[][]).map(
    (c) => (JSON.parse(String((c[1] as RequestInit).body)) as { data: EventoEnviado[] }).data[0]!,
  );
}

const aceito = () =>
  vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response('{"events_received":1}', { status: 200 }));

beforeEach(() => {
  upserts.length = 0;
  vi.restoreAllMocks();
});

describe("negócio de anúncio da Meta entra numa etapa com regra", () => {
  it("vindo da página: o evento padrão sai pelo telefone, sem valor, e fica registrado", async () => {
    base(daPaginaComUtmMeta);
    const spy = aceito();

    const r = await conversaoDeEtapaMetaHandler.handle(mudouDeEtapa());

    expect(r).toMatchObject({ consumer_key: "conversoes.etapa_meta", status: "ok" });
    const [evento] = enviados(spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(evento?.event_name).toBe("InitiateCheckout");
    expect(evento?.event_id).toBe(`${LEAD}:${CHAVE}`);
    expect(evento?.action_source).toBe("system_generated");
    expect(evento?.user_data.ph).toHaveLength(1);
    // O negócio tem valor (900), mas etapa não é venda: nada de receita.
    expect(evento?.custom_data).toBeUndefined();
    expect(tabelas.ad_conversion_dispatches).toMatchObject({
      event_name: CHAVE,
      platform: "meta_ads",
      status: "sent",
      meta_event_name: "InitiateCheckout",
      value_cents: null,
    });
  });

  it("vindo do clique-para-WhatsApp: sai como conversa, com o clique", async () => {
    base(doCliqueParaWhatsApp);
    tabelas.meta_ads_conversion_rules = regra({ meta_event: "LeadSubmitted" });
    const spy = aceito();

    await conversaoDeEtapaMetaHandler.handle(mudouDeEtapa());

    const [evento] = enviados(spy);
    expect(evento?.event_name).toBe("LeadSubmitted");
    expect(evento?.action_source).toBe("business_messaging");
    expect(evento?.user_data.ctwa_clid).toBe("ctwa-abc");
  });

  it("sair e voltar à etapa não envia de novo", async () => {
    base(daPaginaComUtmMeta);
    const spy = aceito();

    await conversaoDeEtapaMetaHandler.handle(mudouDeEtapa());
    const r = await conversaoDeEtapaMetaHandler.handle(mudouDeEtapa());

    expect(r.detail).toBe("ja_enviada");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("o que não pode sair", () => {
  it("lead do Google não vai para a Meta, e não deixa linha", async () => {
    base(doGoogle);
    const spy = vi.spyOn(globalThis, "fetch");

    const r = await conversaoDeEtapaMetaHandler.handle(mudouDeEtapa());

    expect(r.detail).toBe("etapa_sem_origem_meta");
    expect(spy).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });

  it("movimento anterior a ligar a regra não é despejado", async () => {
    base(daPaginaComUtmMeta);
    tabelas.meta_ads_conversion_rules = regra({ configured_at: new Date().toISOString() });
    const spy = vi.spyOn(globalThis, "fetch");

    const r = await conversaoDeEtapaMetaHandler.handle(
      mudouDeEtapa({ created_at: "2026-01-02T00:00:00Z" }),
    );

    expect(r.detail).toBe("anterior_a_configuracao");
    expect(spy).not.toHaveBeenCalled();
  });

  it("regra desligada, ou etapa sem regra, fica quieta", async () => {
    base(daPaginaComUtmMeta);
    tabelas.meta_ads_conversion_rules = regra({ enabled: false });
    expect((await conversaoDeEtapaMetaHandler.handle(mudouDeEtapa())).detail).toBe(
      "etapa_sem_regra_meta",
    );
    tabelas.meta_ads_conversion_rules = null;
    expect((await conversaoDeEtapaMetaHandler.handle(mudouDeEtapa())).detail).toBe(
      "etapa_sem_regra_meta",
    );
  });

  it("etapa fechada (ganho/perda) não manda evento de etapa", async () => {
    base(daPaginaComUtmMeta);
    tabelas.crm_stages = null;
    const spy = vi.spyOn(globalThis, "fetch");

    const r = await conversaoDeEtapaMetaHandler.handle(mudouDeEtapa());

    expect(r.detail).toBe("etapa_invalida");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("o reenvio usa o retrato, não a regra de agora", () => {
  it("regra trocada depois do registro: sai o evento registrado", async () => {
    base(daPaginaComUtmMeta);
    tabelas.meta_ads_conversion_rules = regra({ meta_event: "QualifiedLead" });
    tabelas.ad_conversion_dispatches = {
      status: "error",
      platform: "meta_ads",
      event_name: CHAVE,
      event_occurred_at: new Date().toISOString(),
      meta_event_name: "LeadSubmitted",
    };
    const spy = aceito();

    const r = await conversaoDeEtapaMetaHandler.handle(reenvio());

    expect(r.status).toBe("ok");
    expect(enviados(spy)[0]?.event_name).toBe("LeadSubmitted");
  });

  it("os outros consumidores não tratam o evento de etapa da Meta", async () => {
    base(daPaginaComUtmMeta);
    const spy = vi.spyOn(globalThis, "fetch");

    expect((await conversaoDeVendaHandler.handle(reenvio())).detail).toBe("outro_evento");
    expect((await conversaoDeQualificacaoHandler.handle(reenvio())).detail).toBe("outro_evento");
    // E a mudança de etapa de negócio aberto não é venda.
    expect((await conversaoDeVendaHandler.handle(mudouDeEtapa())).detail).toBe("nao_e_ganho");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("o transporte", () => {
  const conversao = {
    organizationId: ORG,
    leadId: LEAD,
    eventoId: `${LEAD}:${CHAVE}`,
    ocorridoEm: new Date(),
    cliqueDeOrigem: "",
    telefone: "5511988887777",
    moeda: "BRL",
  };
  const credencial = { datasetId: "1", accessToken: "t", testEventCode: null };

  it("evento de etapa sem o nome da Meta é recusado sem ir à rede", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await transporteMeta.enviar(credencial, {
      ...conversao,
      evento: CHAVE,
      valorCentavos: null,
    });
    expect(r.tipo).toBe("permanente");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a compra continua exigindo valor", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await transporteMeta.enviar(credencial, {
      ...conversao,
      evento: "Purchase",
      eventoId: `${LEAD}:Purchase`,
      valorCentavos: null,
      eventoNaPlataforma: "InitiateCheckout",
    });
    expect(r.tipo).toBe("permanente");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("o recomendado da tela", () => {
  it.each([
    ["ORÇAMENTO ENVIADO", "InitiateCheckout"],
    ["Proposta", "InitiateCheckout"],
    ["VISITA AGENDADA", "LeadSubmitted"],
    ["Lead qualificado", "QualifiedLead"],
    ["COMPROU", null],
    ["Novo contato", null],
  ])("%s → %s", (nome, esperado) => {
    expect(eventoRecomendadoParaMeta(nome)).toBe(esperado);
  });
});
