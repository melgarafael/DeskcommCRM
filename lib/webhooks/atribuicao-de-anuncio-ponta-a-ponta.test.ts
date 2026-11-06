/**
 * PONTA A PONTA da atribuição de anúncio de um lead de FORMULÁRIO — issue #3149,
 * ponta 3.
 *
 * ─── Por que este arquivo existe ─────────────────────────────────────────────
 *
 * Os testes que já existiam medem as peças SEPARADAS: o extrator do payload
 * (`lib/webhooks/elementor.test.ts`), a estampa no contato
 * (`lib/leads/atribuicao-de-anuncio.test.ts`) e o transporte da Meta
 * (`tests/unit/conversoes-meta-pela-pagina.test.ts`). Cada um verde com a costura
 * do meio quebrada — foi exatamente assim que o defeito do #2317/#3149 passou:
 * o mapa do form entregava o clique num campo do card, e o extrator (que só olha
 * `source_metadata`) não via nada.
 *
 * Este arquivo entra pela ROTA (`app/api/v1/webhooks/in/[token]/route.ts`) e vai
 * até `processarConversao` (`lib/conversoes/envio.handler.ts`), guardando os DOIS
 * saltos entre as peças:
 *
 *   SALTO 1 — a rota resolve o contato e chama `estamparAtribuicaoDoContato`,
 *            que grava pela RPC de primeiro toque. O teste lê o `p_metadata`
 *            REALMENTE enviado (nenhuma asserção sobre o que o mapeador devolveu
 *            antes de a rota decidir carimbar).
 *
 *   SALTO 2 — `processarConversao` lê a atribuição DO CONTATO
 *            (`lerAtribuicao`) e o corpo que o transporte monta para a Meta. A
 *            `source_metadata` que alimenta o segundo salto é a que a própria
 *            RPC carimbou no primeiro, e não uma montada à mão aqui: é essa
 *            continuidade que o teste guarda.
 *
 * O que NÃO é medido aqui: a resposta da Meta (o `fetch` é dublê) e a função do
 * banco (a RPC é dublê que armazena o `p_metadata`). A física do fio está em
 * `lib/plataformas-de-anuncio/meta/conversions.ts`, coberta pelos testes dela.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Toda chamada de RPC, com os argumentos — é o SALTO 1 lido do lado de fora. */
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** O contato como a RPC o deixou: é o que o SALTO 2 lê. */
  contato: null as Record<string, unknown> | null,
  /** `rota` = o PostgREST da captação; `conversao` = o da venda fechada. */
  fase: "rota" as "rota" | "conversao",
  /** O que foi inserido, por tabela (o contato nasce no primeiro salto). */
  inseridos: [] as Array<{ tabela: string; valores: Record<string, unknown> }>,
  upserts: [] as Array<{ tabela: string; valores: Record<string, unknown> }>,
  criarLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-1" })),
  registrarCaptacao: vi.fn(async (..._args: unknown[]) => undefined),
}));

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "33333333-3333-3333-3333-333333333333";
const LEAD = "22222222-2222-2222-2222-222222222222";
const TOKEN = "token-do-elementor-0001";
const FBC_DO_FORMULARIO = "fb.1.1750000000000.IwAR-e2e-fbc";
const FBP_DO_FORMULARIO = "fb.1.1750000000000.778899";

const FONTE = {
  id: "fonte-1",
  name: "Formulário do site",
  organization_id: ORG,
  secret_encrypted: null,
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-1",
  field_map: {},
  form_fields: [],
  redirect_to: null,
  is_active: true,
  authorize_ai_on_capture: false,
  update_existing_lead_on_capture: false,
};

/**
 * Envio do Elementor Pro (a ação "Webhook"): colchetes, uma linha por
 * propriedade, e o clique do anúncio como CAMPO do formulário — o formato que o
 * mapeador dedicado lê e o genérico não.
 */
function envioDoElementor(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "form[id]": "57e8a20",
    "form[name]": "form conversao",
    "fields[name][id]": "name",
    "fields[name][type]": "text",
    "fields[name][title]": "Nome",
    "fields[name][value]": "Maria Teste",
    "fields[email][id]": "email",
    "fields[email][type]": "email",
    "fields[email][title]": "E-mail",
    "fields[email][value]": "maria.teste@example.com",
    "fields[Telefone][id]": "Telefone",
    "fields[Telefone][type]": "tel",
    "fields[Telefone][title]": "Telefone",
    "fields[Telefone][value]": "11 98888-7777",
    "fields[fbclid][id]": "fbclid",
    "fields[fbclid][type]": "hidden",
    "fields[fbclid][value]": "IwAR-e2e-1",
    "fields[fbc][id]": "fbc",
    "fields[fbc][type]": "hidden",
    "fields[fbc][value]": FBC_DO_FORMULARIO,
    "fields[fbp][id]": "fbp",
    "fields[fbp][type]": "hidden",
    "fields[fbp][value]": FBP_DO_FORMULARIO,
    "fields[message][id]": "message",
    "fields[message][type]": "textarea",
    "fields[message][title]": "Mensagem",
    "fields[message][value]": "Quero um orçamento",
    ...extra,
  };
}

const CONEXAO_ATIVA = {
  dataset_id: "123456789012345",
  access_token_encrypted: "\\xdeadbeef",
  test_event_code: null,
  enabled: true,
};

const LEAD_GANHO = {
  id: LEAD,
  status: "won",
  value_cents: 497_00,
  currency: "BRL",
  closed_at: new Date().toISOString(),
  contact_id: CONTATO,
};

/** Uma resposta por tabela, no formato do PostgREST. */
function resposta(tabela: string): { data: unknown; error: unknown } {
  const inseriu = (t: string) => h.inseridos.some((i) => i.tabela === t);
  if (tabela === "webhook_sources") return { data: FONTE, error: null };
  if (tabela === "contacts") {
    if (h.fase === "conversao") return { data: h.contato, error: null };
    // Na captação: o contato que JÁ existia é `null` (ninguém antes); depois do
    // INSERT, o id que o banco devolveu.
    return inseriu("contacts") ? { data: { id: CONTATO }, error: null } : { data: null, error: null };
  }
  if (tabela === "crm_leads") return { data: LEAD_GANHO, error: null };
  if (tabela === "ad_platform_connections") return { data: CONEXAO_ATIVA, error: null };
  return { data: null, error: null };
}

/**
 * A cadeia do PostgREST: todo método devolve a MESMA cadeia e o valor sai no
 * `await` — menos `insert`/`upsert`, que registram o que foi escrito (é como o
 * teste sabe que o contato nasceu antes de a RPC carimbar).
 */
function cadeia(tabela: string): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    get(_alvo, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok(resposta(tabela));
      if (prop === "insert") {
        return (valores: Record<string, unknown>) => {
          h.inseridos.push({ tabela, valores });
          return proxy;
        };
      }
      if (prop === "upsert") {
        return (valores: Record<string, unknown>) => {
          h.upserts.push({ tabela, valores });
          return proxy;
        };
      }
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => cadeia(tabela),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpc.push({ fn, args });
      if (fn === "fn_estampar_atribuicao_de_anuncio") {
        // O banco faz o merge do `p_metadata` em `contacts.source_metadata`
        // (primeiro toque). O dublê guarda O QUE A RPC RECEBEU: é o salto que
        // este arquivo mede, sem reinterpretar o payload por fora.
        h.contato = {
          phone_number: "+5511988887777",
          source_metadata: args.p_metadata as Record<string, unknown>,
        };
        return { data: null, error: null };
      }
      // Decifra do token da conexão de anúncios.
      return { data: "token-decifrado", error: null };
    },
  }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: async () => undefined }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefoneComNome: async () => null,
}));
vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: h.registrarCaptacao,
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: h.criarLead,
  updateLeadHandler: vi.fn(async () => ({ id: "lead-1" })),
  moveLeadHandler: vi.fn(async () => ({ id: "lead-1" })),
}));
vi.mock("@/lib/conversoes/valor-da-conversa", () => ({ lerValorDaConversa: vi.fn() }));
vi.mock("@/lib/channels/conversao-pelo-canal", () => ({ canalQueReportaConversao: vi.fn(async () => null) }));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";
import { processarConversao } from "@/lib/conversoes/envio.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

/** O POST cru na rota, como a ferramenta de fora faz. */
function capturar(corpo: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
}

/** A venda fechada daquele contato, como o worker de conversões a vê. */
function eventoDeVenda(): EventRow {
  return {
    id: "evt-1",
    organization_id: ORG,
    event_type: "lead.won",
    entity_kind: "crm_lead",
    entity_id: LEAD,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
  };
}

/** O evento que saiu para a Meta, já desembrulhado. */
function eventoEnviado(spy: ReturnType<typeof vi.spyOn>) {
  const init = spy.mock.calls[0]?.[1] as RequestInit;
  return (
    JSON.parse(String(init.body)) as {
      data: Array<{
        action_source: string;
        messaging_channel?: string;
        user_data: { ctwa_clid?: string; ph?: string[]; fbc?: string; fbp?: string };
        custom_data?: { value: number; currency: string };
      }>;
    }
  ).data[0]!;
}

const chamadasDeEstampa = () =>
  h.rpc.filter((c) => c.fn === "fn_estampar_atribuicao_de_anuncio");

beforeEach(() => {
  h.rpc.length = 0;
  h.contato = null;
  h.fase = "rota";
  h.inseridos.length = 0;
  h.upserts.length = 0;
  h.criarLead.mockClear();
  h.registrarCaptacao.mockClear();
  vi.restoreAllMocks();
});

describe("o clique do anúncio do formulário chega à venda — pela rota e pela conversão", () => {
  it("SALTO 1: o envio do Elementor com `fbclid` é carimbado no contato pela RPC de primeiro toque", async () => {
    const r = await capturar(envioDoElementor());

    expect(r.status).toBe(200);
    const estampas = chamadasDeEstampa();
    expect(estampas).toHaveLength(1);
    const meta = estampas[0]!.args.p_metadata as Record<string, unknown>;
    expect(estampas[0]!.args.p_org).toBe(ORG);
    expect(estampas[0]!.args.p_contact).toBe(CONTATO);
    expect(meta.ad_platform).toBe("meta_ads");
    expect(meta.ad_source_id).toBe("IwAR-e2e-1");
    // A marca da captura na PÁGINA: é ela que faz o transporte sair
    // `system_generated` com `fbc`/`fbp`, e não `business_messaging`.
    expect(meta.ad_click_source).toBe("site");
    expect(meta.fbc).toBe(FBC_DO_FORMULARIO);
    expect(meta.fbp).toBe(FBP_DO_FORMULARIO);
    // O clique do anúncio NÃO virou campo do card.
    expect(h.inseridos.find((i) => i.tabela === "contacts")!.valores.source_metadata).toMatchObject({
      fbclid: "IwAR-e2e-1",
    });
  });

  it("SALTO 2: a venda daquele contato sai para a Meta com o `fbc`/`fbp` que a rota carimbou", async () => {
    await capturar(envioDoElementor());
    h.fase = "conversao";
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"events_received":1}', { status: 200 }));

    const r = await processarConversao(eventoDeVenda());

    expect(r.status).toBe("ok");
    const ev = eventoEnviado(spy);
    expect(ev.action_source).toBe("system_generated");
    expect(ev.user_data.fbc).toBe(FBC_DO_FORMULARIO);
    expect(ev.user_data.fbp).toBe(FBP_DO_FORMULARIO);
    expect(ev.user_data.ctwa_clid).toBeUndefined();
    expect(h.upserts.at(-1)?.valores.status).toBe("sent");
  });

  it("CONTROLE: o mesmo envio SEM chave de anúncio não carimba nada", async () => {
    const semAnuncio = envioDoElementor();
    delete semAnuncio["fields[fbclid][id]"];
    delete semAnuncio["fields[fbclid][type]"];
    delete semAnuncio["fields[fbclid][value]"];
    delete semAnuncio["fields[fbc][id]"];
    delete semAnuncio["fields[fbc][type]"];
    delete semAnuncio["fields[fbc][value]"];
    delete semAnuncio["fields[fbp][id]"];
    delete semAnuncio["fields[fbp][type]"];
    delete semAnuncio["fields[fbp][value]"];

    const r = await capturar(semAnuncio);

    expect(r.status).toBe(200);
    expect(chamadasDeEstampa()).toHaveLength(0);
    const contato = h.inseridos.find((i) => i.tabela === "contacts")!.valores.source_metadata as Record<
      string,
      unknown
    >;
    expect(contato.fbclid).toBeUndefined();
  });

  it("CONTROLE: sem telefone, sem clique e sem `fbc`/`fbp`, a venda é recusada com a frase de sempre", async () => {
    h.fase = "conversao";
    // Contato de PÁGINA sem nenhuma identidade: só a marca de que veio do site.
    h.contato = { phone_number: null, source_metadata: { ad_platform: "site", ad_click_source: "site" } };
    const spy = vi.spyOn(globalThis, "fetch");

    const r = await processarConversao(eventoDeVenda());

    const linha = h.upserts.at(-1)?.valores;
    expect(linha?.status).toBe("error");
    expect(linha?.reason).toBe("recusado_pela_plataforma");
    expect(String(linha?.detail)).toBe(
      "Sem o clique do anúncio e sem telefone no contato, a Meta não tem como reconhecer o cliente.",
    );
    expect(spy).not.toHaveBeenCalled();
    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("recusado_pela_plataforma");
  });

  it("o lead que perdeu o telefone ainda fecha a venda: o `fbc` carimbado é a identidade", async () => {
    await capturar(envioDoElementor());
    h.fase = "conversao";
    // O MESMO `source_metadata` que a rota carimbou, na linha sem telefone — o
    // caso que a issue #3149 descreve: sem `ph` para reforçar, o que identifica a
    // venda é o `fbc`/`fbp`.
    h.contato = { ...(h.contato as object), phone_number: null };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"events_received":1}', { status: 200 }));

    const r = await processarConversao(eventoDeVenda());

    expect(r.status).toBe("ok");
    const ev = eventoEnviado(spy);
    expect(ev.action_source).toBe("system_generated");
    expect(ev.user_data.fbc).toBe(FBC_DO_FORMULARIO);
    expect(ev.user_data.fbp).toBe(FBP_DO_FORMULARIO);
    expect(ev.user_data.ph).toBeUndefined();
    expect(ev.custom_data).toEqual({ value: 497, currency: "BRL" });
  });
});
