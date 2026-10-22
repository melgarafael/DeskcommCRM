import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildContactConsentGrant,
  buildContactConsentDenial,
  isRespondiPayload,
  mapRespondiPayload,
  respondiLeadTitle,
  type RespondiPayload,
} from "@/lib/webhooks/respondi";
import { extrairAtribuicaoDoInbound, mapInboundPayload } from "@/lib/webhooks/inbound";

/**
 * Fixture sanitizada, mesma FORMA do payload real capturado de
 * `webhook_events_log` em produção (2026-08-25) — nome/telefone/e-mail/
 * empresa trocados por dado fictício. Ver PROMPT_AUDITORIA_ORQUESTRACAO.md.
 */
const FIXTURE = JSON.parse(
  readFileSync("tests/fixtures/webhooks/respondi-imobiliario.json", "utf8"),
) as RespondiPayload;

describe("isRespondiPayload", () => {
  it("reconhece a forma real do Respondi", () => {
    expect(isRespondiPayload(FIXTURE)).toBe(true);
  });
  it("payload genérico (form HTML/Zapier) não é confundido com Respondi", () => {
    expect(isRespondiPayload({ nome: "Ana", telefone: "11998765432" })).toBe(false);
  });
  it("respondent sem answers não é Respondi (evita falso positivo)", () => {
    expect(isRespondiPayload({ form: {}, respondent: { status: "completed" } })).toBe(false);
  });
  it("form ou respondent como string não é Respondi", () => {
    expect(isRespondiPayload({ form: "x", respondent: { answers: {} } })).toBe(false);
  });
  it("payload vazio/nulo não quebra", () => {
    expect(isRespondiPayload({})).toBe(false);
    expect(isRespondiPayload(null)).toBe(false);
    expect(isRespondiPayload("string")).toBe(false);
  });
});

describe("mapRespondiPayload — o bug real (payload aninhado)", () => {
  it("nome/telefone/e-mail saem de dentro de respondent.answers, não do topo", () => {
    const m = mapRespondiPayload(FIXTURE);
    expect(m.name).toBe("Maria Exemplo");
    expect(m.phone).toBe("+5515988887777"); // "55 15988887777" normalizado
    expect(m.email).toBe("maria.exemplo@example.com");
  });

  it("o mapeador GENÉRICO, no mesmo payload, não acha nada (é o bug medido em produção)", () => {
    const generico = mapInboundPayload(FIXTURE as unknown as Record<string, unknown>);
    expect(generico.name).toBeNull();
    expect(generico.phone).toBeNull();
    expect(generico.email).toBeNull();
  });

  it("mapeia os campos de negócio pedidos pro custom_fields", () => {
    const m = mapRespondiPayload(FIXTURE);
    expect(m.custom_fields).toMatchObject({
      company_name: "Exemplo Incorporadora",
      instagram_or_site: "@exemploincorporadora",
      city_state: "Sorocaba - SP",
      segment: "Incorporadora",
      role: "Diretor(a) ou gestor(a)",
      monthly_revenue_range: "De R$ 30 mil a R$ 50 mil",
      current_marketing_structure: "Fazemos internamente, mas sem processo definido",
      current_marketing_investment: "De R$ 5 mil a R$ 10 mil",
      viable_investment_range: "De R$ 4 mil a R$ 7 mil por mês",
      commercial_challenge: "Aumentar a conversão da equipe comercial",
      start_timeline: "Mais adiante",
      respondi_score: "55",
      respondi_status: "completed",
      respondi_form_id: "9FiY9mrO",
      respondi_form_name: "Imobiliárias e Incorporadoras",
      respondi_respondent_id: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("identificador do envio vira external_id prefixado (idempotência)", () => {
    const m = mapRespondiPayload(FIXTURE);
    expect(m.externalId).toBe("respondi:00000000-0000-4000-8000-000000000001");
  });

  it("consentimento concedido: detecta via legaltext estrutural, não via texto em PT", () => {
    const m = mapRespondiPayload(FIXTURE);
    expect(m.consent).toMatchObject({ granted: true, detectedVia: "legaltext" });
    expect(m.custom_fields.consent_marketing_status).toBe("granted");
  });

  it("título do card prioriza empresa + contato", () => {
    const m = mapRespondiPayload(FIXTURE);
    expect(respondiLeadTitle(m)).toBe("Exemplo Incorporadora — Maria Exemplo");
  });
});

describe("mapRespondiPayload — campos ausentes (Respondi não manda tudo sempre)", () => {
  const semEmpresaNemUtm: RespondiPayload = {
    form: { form_id: "abc123", form_name: "Form sem empresa" },
    respondent: {
      status: "completed",
      score: 10,
      answers: {
        "Qual é o seu nome?": "João Sozinho",
        "Qual é o melhor WhatsApp para falarmos sobre essa análise?": "55 11988887777",
      },
      raw_answers: [],
      respondent_id: "resp-sem-empresa-1",
    },
  };

  it("sem nome de empresa: título cai pro nome da pessoa, nunca um rótulo genérico fixo", () => {
    const m = mapRespondiPayload(semEmpresaNemUtm);
    expect(m.companyName).toBeNull();
    expect(respondiLeadTitle(m)).toBe("João Sozinho");
  });

  it("sem sinal de consentimento nenhum: recusa por padrão, nunca concessão por omissão", () => {
    const m = mapRespondiPayload(semEmpresaNemUtm);
    expect(m.consent).toMatchObject({ granted: false, detectedVia: "not_found", rawAnswer: null });
  });

  it("pergunta nova, sem alias conhecido, não é descartada — vira custom_field derivado", () => {
    const payload: RespondiPayload = {
      form: { form_id: "novo", form_name: "Form com pergunta nova" },
      respondent: {
        status: "completed",
        answers: {
          "Qual é o seu nome?": "Ana Nova",
          "Uma pergunta que ainda não existia quando este código foi escrito?": "resposta X",
        },
        respondent_id: "resp-pergunta-nova",
      },
    };
    const m = mapRespondiPayload(payload);
    const derivedKey = Object.keys(m.custom_fields).find((k) => k.startsWith("respondi_q_"));
    expect(derivedKey).toBeDefined();
    expect(derivedKey).toMatch(/^respondi_q_uma_pergunta_que_ainda_nao_existia/);
    expect(m.custom_fields[derivedKey!]).toBe("resposta X");
  });

  it("respondent_id ausente: external_id null (não idempotente, mas não quebra)", () => {
    const payload: RespondiPayload = {
      form: { form_id: "x" },
      respondent: { answers: { "Qual é o seu nome?": "Sem ID" } },
    };
    const m = mapRespondiPayload(payload);
    expect(m.externalId).toBeNull();
  });
});

describe("mapRespondiPayload — consentimento recusado (decisão 10: nunca vira concessão)", () => {
  it("legaltext com resposta negativa: granted=false, mas a resposta crua fica registrada", () => {
    const payload: RespondiPayload = {
      form: { form_id: "f1" },
      respondent: {
        answers: { "Qual é o seu nome?": "Recusou Silva" },
        raw_answers: [
          {
            answer: "no",
            question: { question_id: "x1", question_type: "legaltext", question_title: "Autorização de contato" },
          },
        ],
        respondent_id: "resp-recusa-1",
      },
    };
    const m = mapRespondiPayload(payload);
    expect(m.consent).toMatchObject({ granted: false, detectedVia: "legaltext", rawAnswer: "no" });
    expect(m.custom_fields.consent_marketing_status).toBe("declined");
  });

  it("fallback por texto em PT quando não há raw_answers (form antigo/sem essa coluna)", () => {
    const payload: RespondiPayload = {
      form: { form_id: "f1" },
      respondent: {
        answers: {
          "Qual é o seu nome?": "Aceitou Sem Raw",
          "Autorização de contato": "Aceito",
        },
      },
    };
    const m = mapRespondiPayload(payload);
    expect(m.consent).toMatchObject({ granted: true, detectedVia: "text_label" });
  });
});

describe("buildContactConsentGrant", () => {
  it("preenche marketing e deixa transactional/profiling explicitamente nulos", () => {
    const grant = buildContactConsentGrant("form-123");
    expect(grant.marketing.source).toBe("webhook:respondi");
    expect(grant.marketing.version).toBe("form-123");
    expect(grant.marketing.granted_at).toBeTruthy();
    expect(grant.transactional).toEqual({ granted_at: null, source: null, version: null });
    expect(grant.profiling).toEqual({ granted_at: null, source: null, version: null });
  });
});

describe("buildContactConsentDenial", () => {
  it("carimba declined_at e mantém granted_at null", () => {
    const recusa = buildContactConsentDenial("form-123");
    expect(recusa.marketing.declined_at).toBeTruthy();
    expect(recusa.marketing.granted_at).toBeNull();
    expect(recusa.marketing.source).toBe("webhook:respondi");
    expect(recusa.marketing.version).toBe("form-123");
    expect(recusa.transactional).toEqual({ granted_at: null, source: null, version: null });
    expect(recusa.profiling).toEqual({ granted_at: null, source: null, version: null });
  });

  /**
   * A razão de a chave existir, escrita como asserção e não como comentário: o
   * DEFAULT de `contacts.consent` no baseline é `{marketing: {granted_at: null,
   * source: null, version: null}, …}`. Sem `declined_at`, a recusa fica com a
   * MESMA forma do contato que nunca respondeu nada — e a guarda de automação
   * não teria como separar os dois.
   */
  it("difere do DEFAULT da coluna — que é onde mora o contato que nunca respondeu", () => {
    const defaultDaColuna = {
      marketing: { granted_at: null, source: null, version: null },
      transactional: { granted_at: null, source: null, version: null },
      profiling: { granted_at: null, source: null, version: null },
    };
    const recusa = buildContactConsentDenial(null);
    expect(recusa).not.toEqual(defaultDaColuna);
    // e a diferença é EXATAMENTE a chave nova, não um efeito colateral
    const { declined_at, ...marketingSemCarimbo } = recusa.marketing;
    expect(declined_at).toBeTruthy();
    expect({ ...recusa, marketing: { ...marketingSemCarimbo, source: null, version: null } }).toEqual(
      defaultDaColuna,
    );
  });
});

/**
 * Issue #3149, ponta 1: o Respondi não tem campo nativo para o clique, então o
 * formulário de um anúncio pergunta `fbclid`/`gclid` como qualquer outra pergunta
 * — e a resposta era gravada como campo do card (`respondi_q_fbclid`), sem
 * chegar nunca à atribuição do contato.
 */
describe("chaves de anúncio do Respondi", () => {
  const comPergunta = (titulo: string, valor: string): RespondiPayload => ({
    ...FIXTURE,
    respondent: {
      ...FIXTURE.respondent,
      answers: { ...FIXTURE.respondent.answers, [titulo]: valor },
    },
  });

  it("a pergunta `fbclid` vira atribuição, não campo do card", () => {
    const m = mapRespondiPayload(comPergunta("fbclid", "IwAR1abc"));
    expect(m.source_metadata.fbclid).toBe("IwAR1abc");
    expect(m.custom_fields.respondi_q_fbclid).toBeUndefined();

    const atribuicao = extrairAtribuicaoDoInbound(m.source_metadata);
    expect(atribuicao?.plataforma).toBe("meta_ads");
    expect(atribuicao?.sourceId).toBe("IwAR1abc");
  });

  it("CONTROLE: formulário sem pergunta de anúncio não inventa atribuição", () => {
    const m = mapRespondiPayload(FIXTURE);
    expect(extrairAtribuicaoDoInbound(m.source_metadata)).toBeNull();
  });
});
