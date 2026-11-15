import { describe, expect, it } from "vitest";

import { recusaRegistrada } from "@/lib/lgpd/recusa-registrada";
import {
  campanhaDeProspeccaoDaConversa,
  consentComSemInteresse,
  consentSemASemInteresse,
  ehRecusaSemInteresse,
  JANELA_SEM_CARD_DEPOIS_DA_RECUSA_MS,
  lerRecusaSemInteresse,
  motivoDePerdaSemInteresse,
  recusaSemInteresseRecente,
  situacaoDaRecusaDeOfertas,
} from "@/lib/lgpd/sem-interesse";
import { deriveLgpdFromContact } from "@/lib/agent-engine/guardrails/lgpd/legal-basis";

const AGORA = "2026-11-14T12:00:00.000Z";

describe("consentComSemInteresse", () => {
  it("grava a recusa no formato que recusaRegistrada lê, sem apagar as outras finalidades", () => {
    const novo = consentComSemInteresse(
      { transactional: { granted: true }, legitimate_interest: { ref: "LIA-1" } },
      { agora: AGORA, origem: "ficha" },
    );
    expect(novo).not.toBeNull();
    expect(recusaRegistrada(novo)).toBe(true);
    expect(ehRecusaSemInteresse(novo)).toBe(true);
    expect(novo).toMatchObject({
      transactional: { granted: true },
      legitimate_interest: { ref: "LIA-1" },
      marketing: { granted: false, declined_at: AGORA, motivo: "sem_interesse", origem: "ficha", anterior: null },
    });
  });

  it("o consentimento de marketing que existia deixa de contar como base legal, e fica guardado para desfazer", () => {
    const antes = { marketing: { granted_at: "2026-01-01T00:00:00Z" } };
    const novo = consentComSemInteresse(antes, { agora: AGORA, origem: "conversa_de_prospeccao" });
    const lgpd = deriveLgpdFromContact({ consent: novo, source: "prospecting" } as never, true);
    expect(lgpd.legalBasis.consentGranted).toBe(false);
    expect((novo?.marketing as Record<string, unknown>).anterior).toEqual(antes.marketing);
  });

  it.each([
    ["declined_at da captação", { marketing: { declined_at: "2026-02-01T00:00:00Z" } }],
    ["granted:false da ficha", { marketing: { granted: false } }],
  ])("não reescreve uma recusa que já existe (%s)", (_r, consent) => {
    expect(consentComSemInteresse(consent, { agora: AGORA, origem: "ficha" })).toBeNull();
  });

  it("tolera consent nulo ou malformado", () => {
    expect(recusaRegistrada(consentComSemInteresse(null, { agora: AGORA, origem: "ficha" }))).toBe(true);
    expect(recusaRegistrada(consentComSemInteresse([], { agora: AGORA, origem: "ficha" }))).toBe(true);
  });
});

describe("consentSemASemInteresse (desfazer)", () => {
  it("devolve o marketing de antes da recusa", () => {
    const antes = { marketing: { granted_at: "2026-01-01T00:00:00Z" }, profiling: { granted: true } };
    const comRecusa = consentComSemInteresse(antes, { agora: AGORA, origem: "ficha" });
    expect(consentSemASemInteresse(comRecusa)).toEqual(antes);
  });

  it("sem marketing antes, a ausência volta a ser ausência", () => {
    const comRecusa = consentComSemInteresse({ profiling: { granted: true } }, { agora: AGORA, origem: "ficha" });
    const desfeito = consentSemASemInteresse(comRecusa);
    expect(desfeito).toEqual({ profiling: { granted: true } });
    expect(recusaRegistrada(desfeito)).toBe(false);
  });

  it("não desfaz a revogação que veio de outro lugar", () => {
    expect(consentSemASemInteresse({ marketing: { declined_at: "2026-02-01T00:00:00Z" } })).toBeNull();
    expect(consentSemASemInteresse({ marketing: { granted: false } })).toBeNull();
    expect(consentSemASemInteresse({})).toBeNull();
  });
});

describe("motivoDePerdaSemInteresse", () => {
  it.each([
    [["Preço", "Não tem interesse"], "Não tem interesse"],
    [[{ label: "Sem interesse", categoria: "cliente" }], "Sem interesse"],
    [["NÃO TENHO INTERESSE!"], "NÃO TENHO INTERESSE!"],
    [["Preço", "Concorrente"], "other"],
    [[], "other"],
  ])("lost_reasons %j → %s", (lista, esperado) => {
    expect(motivoDePerdaSemInteresse({ lost_reasons: lista })).toBe(esperado);
  });

  it("funil sem settings cai em 'other'", () => {
    expect(motivoDePerdaSemInteresse(null)).toBe("other");
    expect(motivoDePerdaSemInteresse({})).toBe("other");
  });
});

describe("campanhaDeProspeccaoDaConversa", () => {
  it("só a conversa com prospecting_campaign_id é de prospecção", () => {
    expect(campanhaDeProspeccaoDaConversa({ prospecting_campaign_id: "c-1" })).toBe("c-1");
    expect(campanhaDeProspeccaoDaConversa({ prospecting_campaign_id: "" })).toBeNull();
    expect(campanhaDeProspeccaoDaConversa({ prospecting_campaign_id: 7 })).toBeNull();
    expect(campanhaDeProspeccaoDaConversa({})).toBeNull();
    expect(campanhaDeProspeccaoDaConversa(null)).toBeNull();
  });
});

describe("lerRecusaSemInteresse — o leitor da forma gravada", () => {
  it("devolve a data e a origem da recusa gravada por aqui", () => {
    const consent = consentComSemInteresse({}, { agora: AGORA, origem: "conversa_de_prospeccao" });
    expect(lerRecusaSemInteresse(consent)).toEqual({ declinedAt: AGORA, origem: "conversa_de_prospeccao" });
  });

  it("a recusa que veio da captação não é a 'sem interesse'", () => {
    expect(lerRecusaSemInteresse({ marketing: { granted: false, declined_at: AGORA } })).toBeNull();
    expect(lerRecusaSemInteresse({})).toBeNull();
    expect(lerRecusaSemInteresse(null)).toBeNull();
  });

  it("data ilegível vira null, e a origem desconhecida vira 'ficha'", () => {
    const consent = { marketing: { granted: false, declined_at: "ontem", motivo: "sem_interesse", origem: "x" } };
    expect(lerRecusaSemInteresse(consent)).toEqual({ declinedAt: null, origem: "ficha" });
  });
});

describe("situacaoDaRecusaDeOfertas — o que o painel da conversa recebe", () => {
  it("separa a recusa 'sem interesse', a recusa de outra origem e a ausência", () => {
    const semInteresse = consentComSemInteresse({}, { agora: AGORA, origem: "ficha" });
    expect(situacaoDaRecusaDeOfertas(semInteresse)).toBe("sem_interesse");
    // As duas grafias da recusa de outra origem (captação e ficha), a mesma régua das guardas.
    expect(situacaoDaRecusaDeOfertas({ marketing: { declined_at: AGORA } })).toBe("outra");
    expect(situacaoDaRecusaDeOfertas({ marketing: { granted: false } })).toBe("outra");
    expect(situacaoDaRecusaDeOfertas({ marketing: { granted: true } })).toBeNull();
    expect(situacaoDaRecusaDeOfertas({})).toBeNull();
    expect(situacaoDaRecusaDeOfertas(null)).toBeNull();
  });
});

describe("recusaSemInteresseRecente — a janela da despedida", () => {
  const agora = Date.parse(AGORA);
  const consentDe = (msAtras: number) =>
    consentComSemInteresse({}, { agora: new Date(agora - msAtras).toISOString(), origem: "conversa_de_prospeccao" });

  it("dentro da janela, sim; passada a janela, não", () => {
    expect(recusaSemInteresseRecente(consentDe(60 * 1000), agora)).toBe(true);
    expect(recusaSemInteresseRecente(consentDe(JANELA_SEM_CARD_DEPOIS_DA_RECUSA_MS - 1000), agora)).toBe(true);
    expect(recusaSemInteresseRecente(consentDe(JANELA_SEM_CARD_DEPOIS_DA_RECUSA_MS), agora)).toBe(false);
    expect(recusaSemInteresseRecente(consentDe(20 * 24 * 60 * 60 * 1000), agora)).toBe(false);
  });

  it("sem recusa, ou com data ilegível, não trava", () => {
    expect(recusaSemInteresseRecente({}, agora)).toBe(false);
    expect(
      recusaSemInteresseRecente({ marketing: { granted: false, declined_at: "x", motivo: "sem_interesse" } }, agora),
    ).toBe(false);
  });
});
