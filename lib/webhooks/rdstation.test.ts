import { describe, it, expect } from "vitest";

import { isRdStationPayload, mapRdStationPayload } from "@/lib/webhooks/rdstation";
import { extrairAtribuicaoDoInbound, mapInboundPayload } from "@/lib/webhooks/inbound";
import { isRespondiPayload } from "@/lib/webhooks/respondi";

/**
 * Envelope real do RD Station (RD Station Marketing / CDP "webhook de lead"),
 * SANITIZADO: e-mail/telefone/nome/ids trocados por valores fictícios, mesma
 * ESTRUTURA e mesmos NOMES DE CAMPO do payload de produção observado em
 * 2026-09-08 (checkpoint JBA-RDSTATION-WEBHOOK-DIAGNOSTICO.txt).
 */
function rdEnvelope(overrides?: {
  mobile_phone?: string | null;
  personal_phone?: string | null;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  celular?: string | null;
  eventUuid?: string | null;
  id?: string | null;
  withConversions?: boolean;
}): Record<string, unknown> {
  const o = overrides ?? {};
  const withConversions = o.withConversions ?? true;
  const eventUuid = o.eventUuid === undefined ? "22222222-2222-4222-8222-222222222222" : o.eventUuid;
  const celular = o.celular === undefined ? "+55 (11) 98888-7777" : o.celular;
  const content = {
    event_type: "CONVERSION",
    identificador: "jardim-bela-aurora",
    conversion_identifier: "jardim-bela-aurora",
    conversion_url: "https://viver.example.com.br/jardim-bela-aurora",
    email_lead: o.email === undefined ? "maria.teste@example.com" : o.email,
    Nome: o.name === undefined ? "Maria Teste" : o.name,
    Celular: celular,
    phone_lead: null,
    ...(eventUuid
      ? { __cdp__original_event: { event_uuid: eventUuid, event_batch_uuid: "33333333-3333-4333-8333-333333333333", event_type: "CONVERSION", event_family: "CDP" } }
      : {}),
  };
  const lead: Record<string, unknown> = {
    id: o.id === undefined ? "9999999999" : o.id,
    uuid: "11111111-1111-4111-8111-111111111111",
    name: o.name === undefined ? "Maria Teste" : o.name,
    email: o.email === undefined ? "maria.teste@example.com" : o.email,
    phone: o.phone === undefined ? null : o.phone,
    personal_phone: o.personal_phone === undefined ? null : o.personal_phone,
    mobile_phone: o.mobile_phone === undefined ? "+55 (11) 98888-7777" : o.mobile_phone,
    company: null,
    lead_stage: "Lead",
    public_url: "http://app.rdstation.com.br/leads/public/11111111-1111-4111-8111-111111111111",
    number_conversions: "2",
    custom_fields: {},
    ...(withConversions
      ? { first_conversion: { content }, last_conversion: { content } }
      : {}),
  };
  return { leads: [lead] };
}

/** Payload FLAT que o botão interno "Enviar lead de teste" e Zapier/n8n mandam. */
const FLAT = {
  name: "Fulano Teste",
  email: "fulano@example.com",
  phone: "+55 11 97777-6666",
  utm_source: "instagram",
};

/** Forma mínima de um payload Respondi (não deve ser capturado pelo RD). */
const RESPONDI = {
  form: { form_id: "9FiY9mrO", form_name: "Imobiliárias e Incorporadoras" },
  respondent: {
    respondent_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    answers: { "Qual é o seu nome?": "Cicrano", "Qual é o seu melhor e-mail?": "cicrano@example.com" },
  },
};

describe("isRdStationPayload — detecção estrita", () => {
  it("reconhece o envelope leads[] com conversões", () => {
    expect(isRdStationPayload(rdEnvelope())).toBe(true);
  });

  it("reconhece leads[] sem conversões mas com id + identidade", () => {
    expect(isRdStationPayload(rdEnvelope({ withConversions: false }))).toBe(true);
  });

  it("aceita leads como STRING JSON válida (defensivo)", () => {
    const env = rdEnvelope();
    const asString = { leads: JSON.stringify(env.leads) };
    expect(isRdStationPayload(asString)).toBe(true);
  });

  it("string JSON inválida em leads → false (cai no genérico)", () => {
    expect(isRdStationPayload({ leads: "[{unterminated" })).toBe(false);
  });

  it("payload FLAT não é RD", () => {
    expect(isRdStationPayload(FLAT)).toBe(false);
  });

  it("payload Respondi não é RD", () => {
    expect(isRdStationPayload(RESPONDI)).toBe(false);
  });

  it("leads vazio / ausente / não-array → false", () => {
    expect(isRdStationPayload({ leads: [] })).toBe(false);
    expect(isRdStationPayload({ leads: null })).toBe(false);
    expect(isRdStationPayload({})).toBe(false);
    expect(isRdStationPayload({ leads: [{}] })).toBe(false); // objeto sem marcador RD
  });
});

describe("mapRdStationPayload — extração de identidade", () => {
  it("RD real com name + email + mobile_phone: extrai os três", () => {
    const m = mapRdStationPayload(rdEnvelope());
    expect(m.name).toBe("Maria Teste");
    expect(m.email).toBe("maria.teste@example.com");
    expect(m.phone).toBe("+5511988887777"); // mobile_phone normalizado (11 já tem o 9)
  });

  it("prioriza mobile_phone > personal_phone > Celular > phone", () => {
    const m = mapRdStationPayload(
      rdEnvelope({ mobile_phone: "+55 11 98888-0001", personal_phone: "+55 11 98888-0002", phone: "+55 11 3333-0003", celular: "+55 11 98888-0004" }),
    );
    expect(m.phone).toBe("+5511988880001");
  });

  it("mobile_phone ausente → cai para personal_phone", () => {
    const m = mapRdStationPayload(rdEnvelope({ mobile_phone: null, personal_phone: "+55 11 98888-0002" }));
    expect(m.phone).toBe("+5511988880002");
  });

  it("mobile_phone e personal_phone ausentes → cai para Celular da conversão", () => {
    const m = mapRdStationPayload(rdEnvelope({ mobile_phone: null, personal_phone: null, celular: "+55 11 98888-0009" }));
    expect(m.phone).toBe("+5511988880009");
  });

  it("RD com nome + email e SEM telefone em lugar nenhum: phone null, nome/email OK", () => {
    const m = mapRdStationPayload(rdEnvelope({ mobile_phone: null, personal_phone: null, phone: null, celular: null }));
    expect(m.name).toBe("Maria Teste");
    expect(m.email).toBe("maria.teste@example.com");
    expect(m.phone).toBeNull();
    // regra da rota: !name && !phone && !email → 400. Aqui name+email presentes → segue e cria lead.
    expect(!m.name && !m.phone && !m.email).toBe(false);
  });

  it("RD sem identidade nenhuma: name/phone/email todos null (rota rejeita com 400)", () => {
    const m = mapRdStationPayload(rdEnvelope({ name: null, email: null, mobile_phone: null, personal_phone: null, phone: null, celular: null }));
    expect(m.name).toBeNull();
    expect(m.email).toBeNull();
    expect(m.phone).toBeNull();
    expect(!m.name && !m.phone && !m.email).toBe(true);
  });

  it("name/email caem para os rótulos da conversão quando o topo não traz", () => {
    const env = rdEnvelope({ name: null, email: null });
    // repõe só na conversão
    const lead = (env.leads as Record<string, unknown>[])[0]!;
    (lead.last_conversion as { content: Record<string, unknown> }).content.Nome = "Nome Da Conversao";
    (lead.last_conversion as { content: Record<string, unknown> }).content.email_lead = "conv@example.com";
    const m = mapRdStationPayload(env);
    expect(m.name).toBe("Nome Da Conversao");
    expect(m.email).toBe("conv@example.com");
  });

  it("metadados seguros preservados; blobs NÃO", () => {
    const m = mapRdStationPayload(rdEnvelope());
    expect(m.custom_fields.rd_lead_id).toBe("9999999999");
    expect(m.custom_fields.rd_lead_stage).toBe("Lead");
    expect(m.custom_fields.rd_conversion_identifier).toBe("jardim-bela-aurora");
    expect(m.custom_fields.rd_event_uuid).toBe("22222222-2222-4222-8222-222222222222");
    expect(m.custom_fields).not.toHaveProperty("traffic_source");
    expect(m.custom_fields).not.toHaveProperty("user_agent");
    expect(m.source_metadata).toEqual({});
  });
});

describe("mapRdStationPayload — idempotência (externalId)", () => {
  it("usa rdstation:evt:<event_uuid> quando há event_uuid", () => {
    const m = mapRdStationPayload(rdEnvelope({ eventUuid: "abc1234a-0000-4000-8000-000000000000" }));
    expect(m.externalId).toBe("rdstation:evt:abc1234a-0000-4000-8000-000000000000");
  });

  it("fallback rdstation:lead:<id> quando não há event_uuid", () => {
    const m = mapRdStationPayload(rdEnvelope({ eventUuid: null, withConversions: false, id: "5035951450" }));
    expect(m.externalId).toBe("rdstation:lead:5035951450");
  });

  it("o MESMO evento reenviado produz a MESMA externalId (dedup determinística)", () => {
    const a = mapRdStationPayload(rdEnvelope({ eventUuid: "dedupe00-0000-4000-8000-000000000000" }));
    const b = mapRdStationPayload(rdEnvelope({ eventUuid: "dedupe00-0000-4000-8000-000000000000" }));
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId).toBe("rdstation:evt:dedupe00-0000-4000-8000-000000000000");
  });

  it("sem event_uuid e sem id → externalId null (comportamento genérico, sem dedup)", () => {
    const m = mapRdStationPayload(rdEnvelope({ eventUuid: null, withConversions: false, id: null }));
    expect(m.externalId).toBeNull();
  });
});

describe("telefone observado em produção: +55 (32) 9922-8971", () => {
  it("normalizePhoneBR (via mapRdStationPayload) → forma canônica de CRM", () => {
    const m = mapRdStationPayload(rdEnvelope({ mobile_phone: "+55 (32) 9922-8971" }));
    // canonicalPhoneBR injeta o 9º dígito no celular BR (regra do produto).
    expect(m.phone).toBe("+5532999228971");
  });
});

describe("compatibilidade — o genérico e o Respondi seguem intactos", () => {
  it("FLAT continua mapeando pelo genérico exatamente como antes", () => {
    const g = mapInboundPayload(FLAT, {});
    expect(g.name).toBe("Fulano Teste");
    expect(g.email).toBe("fulano@example.com");
    expect(g.phone).toBe("+5511977776666");
  });

  it("Respondi continua sendo Respondi e NÃO é RD", () => {
    expect(isRespondiPayload(RESPONDI)).toBe(true);
    expect(isRdStationPayload(RESPONDI)).toBe(false);
  });

  it("RD NÃO é Respondi", () => {
    expect(isRespondiPayload(rdEnvelope())).toBe(false);
  });
});

/**
 * Issue #3149, ponta 1: o envelope do RD tem três lugares para um campo do
 * formulário, e um formulário montado num anúncio manda o clique em qualquer um
 * deles. Sem ler os três, o lead entra sem atribuição e a falha é silenciosa.
 */
describe("chaves de anúncio do envelope do RD Station", () => {
  /** O clique no item do lead ou na conversão, onde o RD de verdade costuma pôr. */
  function envelopeComAnuncio(chave: string, valor: string, onde: "lead" | "conversao") {
    const env = rdEnvelope();
    const lead = (env.leads as Array<Record<string, unknown>>)[0]!;
    if (onde === "lead") {
      lead[chave] = valor;
    } else {
      const ultima = lead.last_conversion as { content: Record<string, unknown> };
      ultima.content[chave] = valor;
    }
    return env;
  }

  it.each(["lead", "conversao"] as const)(
    "o `fbclid` que veio no %s vira atribuição, não campo do card",
    (onde) => {
      const m = mapRdStationPayload(envelopeComAnuncio("fbclid", "IwAR1abc", onde));
      expect(m.source_metadata.fbclid).toBe("IwAR1abc");
      expect(m.custom_fields.fbclid).toBeUndefined();

      const atribuicao = extrairAtribuicaoDoInbound(m.source_metadata);
      expect(atribuicao?.plataforma).toBe("meta_ads");
      expect(atribuicao?.sourceId).toBe("IwAR1abc");
    },
  );

  it("CONTROLE: envelope sem chave de anúncio não inventa atribuição", () => {
    const m = mapRdStationPayload(rdEnvelope());
    expect(m.source_metadata).toEqual({});
    expect(extrairAtribuicaoDoInbound(m.source_metadata)).toBeNull();
  });
});

/**
 * As RESPOSTAS do formulário no envelope. Antes só a identidade e os `rd_*`
 * chegavam ao card; o resto do conteúdo da conversão se perdia. A régua destes
 * casos é o envio PLANO para a mesma fonte: o envelope tem de render o mesmo
 * card que o genérico renderia com as mesmas respostas no topo do corpo.
 */
describe("respostas do formulário do envelope do RD", () => {
  /** Envelope com respostas fictícias na última conversão (e o resto que o RD manda junto). */
  function envelopeComRespostas(
    respostas: Record<string, unknown>,
    extras?: { primeira?: Record<string, unknown>; fichaDoLead?: Record<string, unknown> },
  ) {
    const env = rdEnvelope();
    const lead = (env.leads as Array<Record<string, unknown>>)[0]!;
    const base = (lead.last_conversion as { content: Record<string, unknown> }).content;
    lead.last_conversion = {
      content: {
        ...base,
        token_rdstation: "tok-ficticio-0001",
        traffic_source: "google",
        traffic_medium: "cpc",
        user_agent: "Mozilla/5.0 (ficticio)",
        client_tracking_id: "ct-0001",
        privacy_data: { browser: "x" },
        legal_bases: [{ category: "communications", type: "consent" }],
        ...respostas,
      },
    };
    lead.first_conversion = { content: { ...base, ...(extras?.primeira ?? {}) } };
    if (extras?.fichaDoLead) lead.custom_fields = extras.fichaDoLead;
    return env;
  }

  /** As respostas que o mesmo formulário mandaria num envio plano. */
  const RESPOSTAS = {
    "Orçamento Disponível": "R$ 150.000,00",
    "Cidade/Estado preferido": "Cidade Exemplo / UF",
    cf_produto_de_interesse: "Produto Exemplo",
    "Aceito a política de privacidade": "true",
    utm_source: "facebook",
  };

  it("as respostas chegam ao card com a chave original (acentos e espaços inclusive)", () => {
    const m = mapRdStationPayload(envelopeComRespostas(RESPOSTAS));
    expect(m.custom_fields["Orçamento Disponível"]).toBe("R$ 150.000,00");
    expect(m.custom_fields["Cidade/Estado preferido"]).toBe("Cidade Exemplo / UF");
    expect(m.custom_fields.cf_produto_de_interesse).toBe("Produto Exemplo");
    expect(m.custom_fields["Aceito a política de privacidade"]).toBe("true");
    // e os metadados do RD seguem lá
    expect(m.custom_fields.rd_lead_id).toBe("9999999999");
  });

  it("as chaves técnicas do RD, as de identidade e os blocos aninhados NÃO viram campo", () => {
    const m = mapRdStationPayload(envelopeComRespostas(RESPOSTAS));
    for (const chave of [
      "token_rdstation",
      "traffic_source",
      "traffic_medium",
      "user_agent",
      "client_tracking_id",
      "identificador",
      "conversion_identifier",
      "conversion_url",
      "event_type",
      "email_lead",
      "Nome",
      "Celular",
      "phone_lead",
      "__cdp__original_event",
      "privacy_data",
      "legal_bases",
    ]) {
      expect(m.custom_fields, chave).not.toHaveProperty(chave);
    }
    expect(m.camposDoFormulario).not.toHaveProperty("token_rdstation");
    expect(m.camposDoFormulario).not.toHaveProperty("__cdp__original_event");
  });

  it("é o MESMO card de um envio plano com as mesmas respostas, com e sem field_map", () => {
    for (const fieldMap of [{}, { email: ["E-mail corporativo"] }]) {
      const rd = mapRdStationPayload(
        envelopeComRespostas({ ...RESPOSTAS, "E-mail corporativo": "contato@example.com" }),
        fieldMap,
      );
      const plano = mapInboundPayload(
        { ...RESPOSTAS, "E-mail corporativo": "contato@example.com" },
        fieldMap,
      );
      const semRd = Object.fromEntries(
        Object.entries(rd.custom_fields).filter(([k]) => !k.startsWith("rd_")),
      );
      expect(semRd).toEqual(plano.custom_fields);
      expect(rd.source_metadata).toEqual(plano.source_metadata);
    }
  });

  it("o field_map da fonte consome a chave como no genérico, sem trocar a identidade do RD", () => {
    const m = mapRdStationPayload(
      envelopeComRespostas({ "E-mail corporativo": "outro@example.com" }),
      { email: ["E-mail corporativo"] },
    );
    expect(m.custom_fields).not.toHaveProperty("E-mail corporativo");
    expect(m.email).toBe("maria.teste@example.com");
    expect(m.name).toBe("Maria Teste");
    expect(m.phone).toBe("+5511988887777");
  });

  it("última conversão sobrepõe a primeira, que sobrepõe a ficha do lead; vazio não apaga", () => {
    const m = mapRdStationPayload(
      envelopeComRespostas(
        { cf_faixa: "nova", cf_observacao: "" },
        {
          primeira: { cf_faixa: "antiga", cf_observacao: "da primeira", cf_so_na_primeira: "sim" },
          fichaDoLead: { cf_faixa: "da ficha", cf_so_na_ficha: "sim" },
        },
      ),
    );
    expect(m.custom_fields.cf_faixa).toBe("nova");
    expect(m.custom_fields.cf_observacao).toBe("da primeira");
    expect(m.custom_fields.cf_so_na_primeira).toBe("sim");
    expect(m.custom_fields.cf_so_na_ficha).toBe("sim");
  });

  it("os `rd_*` vencem um campo do formulário de mesmo nome", () => {
    const m = mapRdStationPayload(envelopeComRespostas({ rd_lead_id: "forjado" }));
    expect(m.custom_fields.rd_lead_id).toBe("9999999999");
  });

  it("idempotência intacta: a externalId não depende das respostas", () => {
    const a = mapRdStationPayload(envelopeComRespostas(RESPOSTAS));
    const b = mapRdStationPayload(rdEnvelope());
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId).toBe("rdstation:evt:22222222-2222-4222-8222-222222222222");
  });

  it("atribuição intacta: o anúncio segue a régua do envelope; a ficha do lead não decide clique", () => {
    const m = mapRdStationPayload(
      envelopeComRespostas({ ...RESPOSTAS, fbclid: "IwAR-conv" }, { fichaDoLead: { gclid: "G-ficha" } }),
    );
    expect(m.source_metadata.fbclid).toBe("IwAR-conv");
    expect(m.source_metadata.gclid).toBeUndefined();
    expect(m.source_metadata.utm_source).toBe("facebook");
    expect(m.custom_fields.fbclid).toBeUndefined();
    expect(m.custom_fields.gclid).toBeUndefined();
    expect(m.custom_fields.utm_source).toBeUndefined();
    expect(extrairAtribuicaoDoInbound(m.source_metadata)?.sourceId).toBe("IwAR-conv");
  });

  it("reservados do contrato genérico (`external_id`, `stage`) não viram campo", () => {
    const m = mapRdStationPayload(envelopeComRespostas({ external_id: "x-1", stage: "Ganho" }));
    expect(m.custom_fields).not.toHaveProperty("external_id");
    expect(m.custom_fields).not.toHaveProperty("stage");
    expect(m.externalId).toBe("rdstation:evt:22222222-2222-4222-8222-222222222222");
  });

  it("CONTROLE: o envelope sem respostas continua rendendo só os `rd_*`", () => {
    const m = mapRdStationPayload(rdEnvelope());
    expect(Object.keys(m.custom_fields).every((k) => k.startsWith("rd_"))).toBe(true);
    expect(m.camposDoFormulario).toEqual({});
  });
});
