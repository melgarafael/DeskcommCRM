/**
 * As regras do envio de conversões — as que quebram calado se ninguém vigiar.
 *
 * Cada bloco aqui existe por um modo de falha concreto, não por cobertura:
 * silêncio no kanban, venda contada duas vezes, evento velho aceito como novo, e
 * o nome do transporte vazando para dentro da feature.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { conversaoDeVendaHandler } from "@/lib/conversoes/envio.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { INTERNOS, transporteMeta } from "@/lib/plataformas-de-anuncio/meta/conversions";
import { PLATAFORMAS, transporteDe } from "@/lib/plataformas-de-anuncio/registry";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "22222222-2222-2222-2222-222222222222";
const CONTATO = "33333333-3333-3333-3333-333333333333";

interface Tabelas {
  crm_leads?: unknown;
  contacts?: unknown;
  ad_platform_connections?: unknown;
  ad_conversion_dispatches?: unknown;
}

/** Registra o que foi gravado, para o teste poder afirmar sobre o livro-razão. */
const upserts: { tabela: string; valores: Record<string, unknown> }[] = [];

function fakeAdmin(tabelas: Tabelas) {
  return {
    from(tabela: string) {
      const construtor = {
        select: () => construtor,
        eq: () => construtor,
        neq: () => construtor,
        order: () => construtor,
        limit: () => construtor,
        maybeSingle: async () => ({
          data: (tabelas as Record<string, unknown>)[tabela] ?? null,
          error: null,
        }),
        upsert: async (valores: Record<string, unknown>) => {
          upserts.push({ tabela, valores });
          return { error: null };
        },
      };
      return construtor;
    },
    rpc: async () => ({ data: "token-decifrado", error: null }),
  };
}

const leadGanho = {
  id: LEAD,
  status: "won",
  value_cents: 250_00,
  currency: "BRL",
  closed_at: new Date().toISOString(),
  contact_id: CONTATO,
};

const contatoComAnuncio = {
  phone_number: "+55 (11) 98888-7777",
  source_metadata: { ad_platform: "meta_ads", ad_source_id: "CLIQUE_ABC" },
};

const conexaoAtiva = {
  dataset_id: "123456789012345",
  access_token_encrypted: "\\xdeadbeef",
  test_event_code: null,
  enabled: true,
};

function evento(tipo: string, payload: Record<string, unknown> = {}): EventRow {
  return {
    id: "evt",
    organization_id: ORG,
    event_type: tipo,
    entity_kind: "crm_lead",
    entity_id: LEAD,
    payload,
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  upserts.length = 0;
  vi.restoreAllMocks();
});

describe("as duas portas do fechamento", () => {
  it("escuta lead.won E lead.stage_changed", () => {
    // Plugar só em `lead.won` perderia toda venda fechada por arrasto no kanban
    // e por mover em lote — que emitem `lead.stage_changed`.
    expect(conversaoDeVendaHandler.events).toContain("lead.won");
    expect(conversaoDeVendaHandler.events).toContain("lead.stage_changed");
  });

  it("reporta a venda mesmo quando o payload NÃO traz status (o caso do bulk)", async () => {
    // `/leads/bulk` faz `.select(\"id\")` e nunca re-lê a linha, então o `status`
    // que o `/move` publica não existe ali. Um handler que confiasse no payload
    // funcionaria numa porta e falharia calado na outra.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: leadGanho,
        contacts: contatoComAnuncio,
        ad_platform_connections: conexaoAtiva,
      }) as never,
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const r = await conversaoDeVendaHandler.handle(evento("lead.stage_changed"));

    expect(r.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(upserts.at(-1)?.valores.status).toBe("sent");
  });

  it("sai barato quando a etapa mudou e o negócio não fechou", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ crm_leads: { ...leadGanho, status: "open" } }) as never,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const r = await conversaoDeVendaHandler.handle(evento("lead.stage_changed"));

    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("nao_e_ganho");
    // A maioria esmagadora das mudanças de etapa cai aqui: não pode nem falar
    // com a rede nem sujar o livro-razão.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });
});

describe("a mesma venda nunca é contada duas vezes", () => {
  it("não reenvia o que já consta como enviado", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: leadGanho,
        ad_conversion_dispatches: { status: "sent" },
        contacts: contatoComAnuncio,
        ad_platform_connections: conexaoAtiva,
      }) as never,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const r = await conversaoDeVendaHandler.handle(evento("lead.won"));

    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("ja_enviada");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("o id de deduplicação é determinístico", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: leadGanho,
        contacts: contatoComAnuncio,
        ad_platform_connections: conexaoAtiva,
      }) as never,
    );
    let corpoEnviado = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      corpoEnviado = String((init as RequestInit).body);
      return new Response("{}", { status: 200 });
    });

    await conversaoDeVendaHandler.handle(evento("lead.won"));

    // Segunda camada de defesa: se o envio escapar duas vezes daqui, a
    // plataforma ainda descarta a cópia pelo par (event_id, event_name).
    expect(JSON.parse(corpoEnviado).data[0].event_id).toBe(`${LEAD}:Purchase`);
  });
});

describe("o que vira pendência visível na tela", () => {
  it("venda ganha sem valor não é enviada — e é registrada", async () => {
    // `crm_leads.value_cents` é nullable e nada obriga a preenchê-lo no
    // fechamento. Mandar 0 seria ACEITO e ensinaria ao otimizador que a venda
    // não vale nada — pior que não mandar, porque não tem sintoma.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: { ...leadGanho, value_cents: null },
        contacts: contatoComAnuncio,
        ad_platform_connections: conexaoAtiva,
      }) as never,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const r = await conversaoDeVendaHandler.handle(evento("lead.won"));

    expect(r.detail).toBe("sem_valor");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upserts.at(-1)?.valores).toMatchObject({ status: "skipped", reason: "sem_valor" });
  });

  it("lead orgânico NÃO vira linha no livro-razão", async () => {
    // Não havia nada a reportar. Gravar aqui encheria a tela de ruído e faria
    // ninguém ler a lista de pendências duas vezes. O veredito ainda volta no
    // HandlerResult, que o drain persiste no event_log.
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: leadGanho,
        contacts: { phone_number: "+5511988887777", source_metadata: {} },
      }) as never,
    );

    const r = await conversaoDeVendaHandler.handle(evento("lead.won"));

    expect(r.detail).toBe("sem_atribuicao");
    expect(upserts).toHaveLength(0);
  });

  it("falta de conexão vira pendência, não silêncio", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({ crm_leads: leadGanho, contacts: contatoComAnuncio }) as never,
    );

    const r = await conversaoDeVendaHandler.handle(evento("lead.won"));

    expect(r.detail).toBe("sem_conexao");
    expect(upserts.at(-1)?.valores).toMatchObject({ status: "skipped", reason: "sem_conexao" });
  });
});

describe("a física da falha decide o tratamento", () => {
  it("5xx vira retry, não erro", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: leadGanho,
        contacts: contatoComAnuncio,
        ad_platform_connections: conexaoAtiva,
      }) as never,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ops", { status: 503 }));

    const r = await conversaoDeVendaHandler.handle(evento("lead.won"));

    expect(r.status).toBe("retry");
    expect(r.retry_at).toBeTruthy();
    // Instabilidade que se resolve sozinha não pode virar alarme na tela.
    expect(upserts).toHaveLength(0);
  });

  it("recusa por credencial vira erro registrado, não retry infinito", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: leadGanho,
        contacts: contatoComAnuncio,
        ad_platform_connections: conexaoAtiva,
      }) as never,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 190, message: "token inválido" } }), {
        status: 400,
      }),
    );

    const r = await conversaoDeVendaHandler.handle(evento("lead.won"));

    expect(r.status).toBe("error");
    expect(upserts.at(-1)?.valores).toMatchObject({
      status: "error",
      reason: "recusado_pela_plataforma",
    });
  });

  it("throttle é 4xx e MESMO ASSIM é transitório", () => {
    // Tratar todo 4xx como permanente faria o sistema desistir de uma venda por
    // causa de um pico de tráfego.
    expect(INTERNOS.classifica4xx(613, "calls").tipo).toBe("transitorio");
    expect(INTERNOS.classifica4xx(190, "token").tipo).toBe("permanente");
  });
});

describe("o transporte", () => {
  it("recusa evento mais velho que o teto da plataforma", async () => {
    // O `event_time` é o `closed_at` real. Um backlog de drain maior que 7 dias
    // não vira "atrasado", vira PERDIDO — e precisa dizer isso, não tentar.
    const oitoDias = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const r = await transporteMeta.enviar(
      { datasetId: "1", accessToken: "t", testEventCode: null },
      {
        organizationId: ORG,
        leadId: LEAD,
        evento: "Purchase",
        eventoId: `${LEAD}:Purchase`,
        ocorridoEm: oitoDias,
        cliqueDeOrigem: "CLIQUE",
        telefone: "5511988887777",
        valorCentavos: 100,
        moeda: "BRL",
      },
    );

    expect(r.tipo).toBe("permanente");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hasheia o telefone e nunca manda o número em claro", async () => {
    let corpo = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      corpo = String((init as RequestInit).body);
      return new Response("{}", { status: 200 });
    });

    await transporteMeta.enviar(
      { datasetId: "1", accessToken: "t", testEventCode: null },
      {
        organizationId: ORG,
        leadId: LEAD,
        evento: "Purchase",
        eventoId: "x",
        ocorridoEm: new Date(),
        cliqueDeOrigem: "CLIQUE",
        telefone: "5511988887777",
        valorCentavos: 25_000,
        moeda: "BRL",
      },
    );

    expect(corpo).not.toContain("5511988887777");
    expect(JSON.parse(corpo).data[0].user_data.ph[0]).toBe(INTERNOS.hash("5511988887777"));
    // `business_messaging` é o que aceita o clique como identidade. Declarar
    // `website` passaria no envio e a conversão não seria atribuída ao anúncio.
    expect(JSON.parse(corpo).data[0].action_source).toBe("business_messaging");
    // Segundos, não milissegundos: em ms o evento cai a ~55 mil anos no futuro
    // e a resposta ainda é 200.
    expect(JSON.parse(corpo).data[0].event_time).toBeLessThan(1e11);
    expect(JSON.parse(corpo).data[0].custom_data.value).toBe(250);
  });
});

describe("a matriz de plataformas é exaustiva", () => {
  it("toda plataforma do vocabulário tem linha no registro", () => {
    // Plataforma sem linha devolveria `undefined` e o chamador trataria como bug.
    for (const p of PLATAFORMAS) expect(transporteDe(p)).not.toBeUndefined();
  });

  it("google_ads está DECLARADO sem transporte, e o handler o registra", async () => {
    // A ausência é anterior a este módulo: sem extrator de `gclid` não há clique
    // capturado para reportar. Declarada, vira `skipped` legível; omitida, viraria
    // exceção em runtime.
    expect(transporteDe("google_ads")).toBeNull();

    vi.mocked(createAdminClient).mockReturnValue(
      fakeAdmin({
        crm_leads: leadGanho,
        contacts: {
          phone_number: "+5511988887777",
          source_metadata: { ad_platform: "google_ads", ad_source_id: "GCLID_X" },
        },
      }) as never,
    );

    const r = await conversaoDeVendaHandler.handle(evento("lead.won"));

    expect(r.detail).toBe("plataforma_sem_transporte");
    expect(upserts.at(-1)?.valores).toMatchObject({ reason: "plataforma_sem_transporte" });
  });
});
