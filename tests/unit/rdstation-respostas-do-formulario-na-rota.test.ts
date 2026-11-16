import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * As respostas do formulário do RD Station chegam ao card PELA ROTA, com o
 * `field_map` e a tipagem (`form_fields`) da fonte — a mesma régua de um envio
 * plano para a mesma fonte.
 *
 * O defeito: a rota fazia `mapped = rdStationMapped ?? … ?? mapInboundPayload(…)`,
 * e o mapeador do RD só devolvia identidade e `rd_*`. As respostas ficavam no
 * envelope (`leads[0].last_conversion.content`), a tipagem lia o corpo de topo
 * (onde só há `leads`) e o card nascia sem os dados do formulário.
 *
 * O controle de cada caso é o envio PLANO com as mesmas respostas: o que os
 * casos afirmam é que o envelope rende o MESMO card, não um card qualquer.
 */

const h = vi.hoisted(() => ({
  registrar: vi.fn(async (..._args: unknown[]) => undefined),
  criarLead: vi.fn(async (..._args: unknown[]) => ({ id: "lead-novo" })),
}));

const FONTE = {
  id: "fonte-1",
  name: "Formulário da página",
  organization_id: "org-1",
  secret_encrypted: null,
  default_pipeline_id: "pipe-1",
  default_stage_id: "stage-1",
  field_map: { email: ["E-mail corporativo"] },
  form_fields: [
    { key: "cf_orcamento", label: "Orçamento disponível", type: "currency", required: false },
    { key: "cf_unidades", label: "Unidades", type: "number", required: false },
  ],
  redirect_to: null,
  is_active: true,
  authorize_ai_on_capture: false,
  update_existing_lead_on_capture: false,
  reuse_open_lead_on_capture: false,
};

/** Cadeia do PostgREST que aceita qualquer método e resolve vazio — só a fonte é lida de verdade. */
function cadeia(tabela: string): unknown {
  const resultado = { data: tabela === "webhook_sources" ? FONTE : null, error: null };
  const proxy: unknown = new Proxy(() => undefined, {
    get(_alvo, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok(resultado);
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => cadeia(t), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: h.registrar,
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: h.criarLead }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: async () => undefined }));

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

const TOKEN = "token-da-fonte-rd-0001";
const EVENTO = "44444444-4444-4444-8444-444444444444";

/** As respostas do formulário — fictícias. */
const RESPOSTAS = {
  cf_orcamento: "R$ 150.000,00",
  cf_unidades: "2",
  "Cidade/Estado preferido": "Cidade Exemplo / UF",
  "Aceito a política de privacidade": "true",
  "E-mail corporativo": "contato@example.com",
  utm_source: "facebook",
};

/** O envelope do RD com as respostas na última conversão e o ruído técnico de sempre. */
function envelope(respostas: Record<string, unknown>, extraDaConversao: Record<string, unknown> = {}) {
  const content = {
    event_type: "CONVERSION",
    identificador: "pagina-exemplo",
    conversion_identifier: "pagina-exemplo",
    conversion_url: "https://pagina.example.com/form",
    token_rdstation: "tok-ficticio-0001",
    traffic_source: "google",
    user_agent: "Mozilla/5.0 (ficticio)",
    email_lead: "ana.teste@example.com",
    Nome: "Ana Teste",
    Celular: "+55 (11) 98888-1234",
    __cdp__original_event: { event_uuid: EVENTO, event_type: "CONVERSION" },
    ...respostas,
    ...extraDaConversao,
  };
  return {
    leads: [
      {
        id: "7777777777",
        uuid: "55555555-5555-4555-8555-555555555555",
        name: "Ana Teste",
        email: "ana.teste@example.com",
        mobile_phone: "+55 (11) 98888-1234",
        lead_stage: "Lead",
        custom_fields: {},
        first_conversion: { content },
        last_conversion: { content },
      },
    ],
  };
}

/** O mesmo formulário, mandado plano (o caminho genérico). */
function plano(respostas: Record<string, unknown>) {
  return { nome: "Ana Teste", telefone: "+55 (11) 98888-1234", ...respostas };
}

async function enviar(corpo: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/v1/webhooks/in/${TOKEN}`, {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
  return (await POST(req, { params: Promise.resolve({ token: TOKEN }) })) as Response;
}

/** O corpo que a rota mandou criar no último `createLeadHandler`. */
function cardCriado(): {
  custom_fields: Record<string, unknown>;
  source_metadata: Record<string, unknown>;
  external_id?: string;
  title: string;
} {
  const chamada = h.criarLead.mock.calls.at(-1);
  expect(chamada, "a rota não criou o card").toBeDefined();
  return chamada![2] as never;
}

beforeEach(() => {
  h.registrar.mockClear();
  h.criarLead.mockClear();
});

describe("respostas do formulário do RD Station chegam ao card", () => {
  it("o envelope rende o MESMO card que o envio plano: campos, tipagem e field_map", async () => {
    expect((await enviar(plano(RESPOSTAS))).status).toBe(200);
    const doPlano = cardCriado();

    expect((await enviar(envelope(RESPOSTAS))).status).toBe(200);
    const doRd = cardCriado();

    const semRd = Object.fromEntries(
      Object.entries(doRd.custom_fields).filter(([k]) => !k.startsWith("rd_")),
    );
    expect(semRd).toEqual(doPlano.custom_fields);
    // a tipagem da fonte valeu: moeda BRL e número viraram número
    expect(doRd.custom_fields.cf_orcamento).toBe(150000);
    expect(doRd.custom_fields.cf_unidades).toBe(2);
    expect(doRd.custom_fields["Cidade/Estado preferido"]).toBe("Cidade Exemplo / UF");
    expect(doRd.custom_fields["Aceito a política de privacidade"]).toBe("true");
    // o field_map consumiu o alias, como no plano
    expect(doRd.custom_fields).not.toHaveProperty("E-mail corporativo");
    // utm foi para a origem, como no plano
    expect(doRd.source_metadata.utm_source).toBe("facebook");
  });

  it("as chaves técnicas do RD não entram no card", async () => {
    await enviar(envelope(RESPOSTAS));
    const card = cardCriado();
    for (const chave of [
      "token_rdstation",
      "traffic_source",
      "user_agent",
      "identificador",
      "conversion_url",
      "event_type",
      "email_lead",
      "Nome",
      "Celular",
      "__cdp__original_event",
    ]) {
      expect(card.custom_fields, chave).not.toHaveProperty(chave);
    }
  });

  it("identidade e idempotência intactas: título do RD e external_id rdstation:evt", async () => {
    await enviar(envelope(RESPOSTAS));
    const card = cardCriado();
    expect(card.title).toBe("Ana Teste");
    expect(card.external_id).toBe(`rdstation:evt:${EVENTO}`);
    expect(card.custom_fields.rd_event_uuid).toBe(EVENTO);
  });

  it("anúncio intacto: o fbclid da conversão vai para a origem, não para o card", async () => {
    await enviar(envelope(RESPOSTAS, { fbclid: "IwAR-ficticio" }));
    const card = cardCriado();
    expect(card.source_metadata.fbclid).toBe("IwAR-ficticio");
    expect(card.custom_fields).not.toHaveProperty("fbclid");
  });

  it("resposta numérica inválida no envelope é recusada como no plano (422)", async () => {
    const resPlano = await enviar(plano({ cf_unidades: "12x" }));
    const resRd = await enviar(envelope({ cf_unidades: "12x" }));
    expect(resPlano.status).toBe(422);
    expect(resRd.status).toBe(422);
    expect(h.criarLead).not.toHaveBeenCalled();
    expect(h.registrar).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "recusado", rejectReason: "campo_numerico_invalido" }),
    );
  });

  it("o histórico de captação leva as respostas do envelope", async () => {
    await enviar(envelope(RESPOSTAS));
    const criado = h.registrar.mock.calls.find(
      (c) => (c[1] as { outcome?: string }).outcome === "criado",
    );
    expect(criado, "captação criada não registrada").toBeDefined();
    const fields = (criado![1] as { fields: Record<string, unknown> }).fields;
    expect(fields["Cidade/Estado preferido"]).toBe("Cidade Exemplo / UF");
    expect(fields.cf_orcamento).toBe(150000);
    expect(fields).not.toHaveProperty("token_rdstation");
  });
});
