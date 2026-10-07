/**
 * A TERCEIRA CAMADA DO `before_send` (#2231) — conferir, antes do envio, as
 * afirmações de FATO da resposta contra a evidência consultada no turno.
 *
 * Os três exemplos da tabela da issue, dublados:
 *
 *  - "O check-in é a partir das 12h." (base: 14:00) → VETO em `decidindo`,
 *    com erro de ensino (contradição);
 *  - "Temos sim, piscina aquecida!" (base: sem piscina) → VETO em `decidindo`
 *    (afirmação que não está na base);
 *  - "Aceitamos pets de pequeno porte sem custo." → continua sendo pego pela
 *    F4-02, que roda ANTES (a cadeia para no primeiro veto, e esta camada nem
 *    é avaliada).
 *
 * E a restrição que não se negocia: a guarda de promessa NÃO pode passar a
 * vetar frase neutra verdadeira. "Abre às 8h" só cai se não estiver no
 * material — o prompt da F4-02 continua dizendo que "descrições de
 * horário/empresa" não são promessa, e esta camada é quem conferirá o fato.
 */
import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import {
  LIMIAR_AFIRMACAO,
  LIMIAR_CONTRADICAO,
  LIMIAR_SUPORTE,
  decidirAfirmacoes,
  frasesParaConferir,
  renderVetoDeAfirmacao,
} from "@/lib/agent-engine/guardrails/factual-claim";
import {
  BEFORE_SEND_CHAIN_VERSION,
  BEFORE_SEND_GATES,
  evaluateBeforeSend,
  factualClaimGate,
  runBeforeSend,
  semanticPromiseGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { PROMISE_SEMANTIC_INSTRUCTION } from "@/lib/agent-engine/guardrails/promise/semantic";
import type { EvidenciaComercial } from "@/lib/agent-engine/guardrails/promise/evidencias-comerciais";
import {
  conferirAfirmacoes,
  criarConferidorDeAfirmacoes,
  perguntasDaAfirmacao,
} from "@/lib/ai/decisao/afirmacao-de-fato";
import { TAREFA_DA_AFIRMACAO_DE_FATO } from "@/lib/ai/decisao/tarefas";

const avisos = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);
vi.mock("@/lib/logger", () => ({
  logger: {
    warn: (mensagem: string, ctx: Record<string, unknown>) => avisos.push([mensagem, ctx]),
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_DA_FALHA = "99999999-9999-4999-8999-999999999999";
const CONTATO = "33333333-3333-4333-8333-333333333333";

/** A pousada fictícia da issue: horário de check-in 14h e SEM piscina. */
const EVIDENCIAS: readonly EvidenciaComercial[] = [
  {
    origem: "conhecimento",
    referencia: "faq:checkin",
    titulo: "Check-in e estrutura",
    conteudo: "Check-in a partir das 14:00. A pousada não possui piscina.",
  },
];

interface FalsoBanco {
  inseridas: Record<string, unknown[]>;
  lidas: string[];
  settings: unknown;
}

/** O admin falso: só o que a camada toca — settings e as duas escritas. */
function adminFalso(f: FalsoBanco): SupabaseClient {
  const de = (tabela: string) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.order = () => c;
    c.limit = () => c;
    c.maybeSingle = async () => ({
      data: tabela === "organizations" ? (f.settings === null ? null : { settings: f.settings }) : null,
      error: null,
    });
    c.insert = (linhas: unknown) => {
      const lista = Array.isArray(linhas) ? linhas : [linhas];
      f.inseridas[tabela] = [...(f.inseridas[tabela] ?? []), ...lista];
      return Promise.resolve({ data: null, error: null });
    };
    return c;
  };
  return {
    from: (tabela: string) => {
      f.lidas.push(tabela);
      return de(tabela);
    },
  } as unknown as SupabaseClient;
}

function banco(settings: unknown = { jev: { ligado: false } }): FalsoBanco {
  return { inseridas: {}, lidas: [], settings };
}

/** O dublê do Jev: devolve `noul` para cada pergunta, e guarda os estados. */
function fetchCom(respostas: Record<string, number>) {
  const chamadas: Array<{ state: unknown; questions: string[] }> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const corpo = JSON.parse(String(init?.body)) as {
      state: Record<string, unknown>;
      questions: Record<string, unknown>;
    };
    chamadas.push({ state: corpo.state, questions: Object.keys(corpo.questions) });
    const answers = Object.fromEntries(
      Object.keys(corpo.questions).map((id) => [
        id,
        { type: "noul", noul: respostas[id] ?? 0.5 },
      ]),
    );
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers,
        usage: { input_tokens: 1800, output_tokens: 0 },
      }),
      { status: 200 },
    );
  });
  return { fetchImpl, chamadas };
}

const DEPS = { buscarChave: async () => "chave-de-teste" };

function entrada(estado: "observando" | "decidindo", candidata: string) {
  return {
    organizationId: ORG,
    conversationId: null,
    contactId: CONTATO,
    agentId: null,
    estado,
    candidata,
    lerEvidencias: () => EVIDENCIAS,
  };
}

/** O que a cadeia decide para uma conferência, sem precisar montar a cadeia toda. */
function gateContexto(conferencia: unknown, extra: Record<string, unknown> = {}): GateContext {
  return { body: "", factualClaim: conferencia, ...extra } as unknown as GateContext;
}

describe("frases que saem por regra simples, ANTES da requisição", () => {
  it("saudação e pergunta não viram frase — e a resposta não vai nem para a rede", () => {
    expect(frasesParaConferir("Bom dia! Como posso ajudar?")).toEqual([]);
    expect(frasesParaConferir("Olá, tudo bem?")).toEqual([]);
    expect(frasesParaConferir("Obrigado!")).toEqual([]);
  });

  it("um link é uma frase só (não vira três pedaços pelo ponto do endereço)", () => {
    expect(frasesParaConferir("Veja em https://exemplo.com/a.b.c.")).toEqual([
      "Veja em https://exemplo.com/a.b.c.",
    ]);
    expect(frasesParaConferir("https://pousada.example/reservas")).toEqual([]);
  });

  it("a candidata comum vira frase por frase", () => {
    expect(frasesParaConferir("O check-in é a partir das 12h. Temos sim piscina aquecida!")).toEqual([
      "O check-in é a partir das 12h.",
      "Temos sim piscina aquecida!",
    ]);
  });
});

describe("as perguntas tipadas — uma por frase, três por frase", () => {
  it("claim_i, supported_i e contradicts_i, na ordem das frases", () => {
    const frases = frasesParaConferir("Abrimos às 8h. Temos piscina.");
    const perguntas = perguntasDaAfirmacao(frases);
    expect(Object.keys(perguntas)).toEqual([
      "claim_0",
      "supported_0",
      "contradicts_0",
      "claim_1",
      "supported_1",
      "contradicts_1",
    ]);
    for (const p of Object.values(perguntas)) expect(p.tipo).toBe("noul");
    expect(perguntas["claim_0"]!.instrucao).toContain("Abrimos às 8h.");
    expect(perguntas["supported_0"]!.instrucao).toContain("in any wording or format");
  });

  it("a forma 'in any format' é exigência da issue: '14h' contra '14:00' casaria só com ela", () => {
    const perguntas = perguntasDaAfirmacao(["O check-in é às 12h."]);
    expect(perguntas["supported_0"]!.instrucao).toMatch(/any wording or format/i);
  });
});

describe("decisão em código, pelo MÁXIMO das frases e nunca pela média", () => {
  const respostas = (valores: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(valores).map(([id, noul]) => [id, { tipo: "noul" as const, noul }]),
    );

  it("contradicts acima do corte veta; claim alto com supported baixo veta", () => {
    expect(
      decidirAfirmacoes(["A."], respostas({ claim_0: 0.9, supported_0: 0.9, contradicts_0: 0.95 }))
        .veredito,
    ).toBe("contradiz");
    expect(
      decidirAfirmacoes(["A."], respostas({ claim_0: 0.95, supported_0: 0.05, contradicts_0: 0.1 }))
        .veredito,
    ).toBe("nao_esta_na_base");
  });

  it("nos cortes exatos ninguém veta — '>' e '<' da issue", () => {
    expect(LIMIAR_AFIRMACAO).toBe(0.7);
    expect(LIMIAR_SUPORTE).toBe(0.3);
    expect(LIMIAR_CONTRADICAO).toBe(0.7);
    expect(
      decidirAfirmacoes(["A."], respostas({ claim_0: 0.7, supported_0: 0.3, contradicts_0: 0.7 }))
        .veredito,
    ).toBe("passa");
  });

  it("uma frase ruim veta a candidata inteira — o máximo, não a média", () => {
    const frases = ["Está tudo certo.", "Temos sim piscina aquecida!"];
    const veredito = decidirAfirmacoes(
      frases,
      respostas({
        claim_0: 0.9,
        supported_0: 0.9,
        contradicts_0: 0.05,
        claim_1: 0.95,
        supported_1: 0.05,
        contradicts_1: 0.1,
      }),
    );
    expect(veredito.veredito).toBe("nao_esta_na_base");
    expect(veredito.frase).toBe("Temos sim piscina aquecida!");
  });

  it("afirmação baixa (slogan, saudação que sobrou) passa", () => {
    expect(
      decidirAfirmacoes(
        ["Nosso atendimento é rápido."],
        respostas({ claim_0: 0.2, supported_0: 0.4, contradicts_0: 0.05 }),
      ).veredito,
    ).toBe("passa");
  });

  it("resposta fora de probabilidade é ilegível, nunca um veto", () => {
    expect(
      decidirAfirmacoes(["A."], { claim_0: { tipo: "choice", escolha: "x", probabilidades: {}, confianca: 1 } })
        .ilegivel,
    ).toBe(true);
  });
});

describe("os três exemplos da tabela, dublados", () => {
  it("check-in 12h com base 14h → veto com erro de ensino, em decidindo", async () => {
    const f = fetchCom({ claim_0: 0.9, supported_0: 0.1, contradicts_0: 0.95 });
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("decidindo", "O check-in é a partir das 12h."),
      { ...DEPS, fetchImpl: f.fetchImpl },
    );
    expect(r.veredito).toBe("contradiz");
    expect(r.estado).toBe("decidindo");
    const veredito = factualClaimGate.evaluate(gateContexto(r));
    expect(veredito.pass).toBe(false);
    if (veredito.pass) throw new Error("devia vetar");
    expect(veredito.code).toBe("factual_claim_contradicted");
    expect(veredito.reason).toContain("12h");
  });

  it("piscina aquecida sem piscina na base → veto por afirmação fora da base", async () => {
    const f = fetchCom({ claim_0: 0.95, supported_0: 0.05, contradicts_0: 0.1 });
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("decidindo", "Temos sim, piscina aquecida!"),
      { ...DEPS, fetchImpl: f.fetchImpl },
    );
    expect(r.veredito).toBe("nao_esta_na_base");
    const veredito = factualClaimGate.evaluate(gateContexto(r));
    expect(veredito.pass).toBe(false);
    if (veredito.pass) throw new Error("devia vetar");
    expect(veredito.code).toBe("factual_claim_unsupported");
  });

  it("o terceiro exemplo continua sendo da F4-02: ela veta antes e esta camada nem avalia", async () => {
    const f = fetchCom({ claim_0: 0.8, supported_0: 0.05, contradicts_0: 0.05 });
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("decidindo", "Aceitamos pets de pequeno porte sem custo."),
      { ...DEPS, fetchImpl: f.fetchImpl },
    );
    const cadeia = evaluateBeforeSend(
      gateContexto(r, {
        semanticPromise: { isPromise: true, suspectPhrase: "sem custo", prometeuRetornoHumano: false, retornoSoDoAssistente: false },
      }),
      [semanticPromiseGate, factualClaimGate],
    );
    expect(cadeia.veto?.gate).toBe("semantic_promise");
    // O primeiro veto da cadeia é o da F4-02: esta camada nem é a que barra.
    expect(
      cadeia.trace.filter((t) => t.verdict === "veto").map((t) => t.gate)[0],
    ).toBe("semantic_promise");
  });
});

describe("a guarda de promessa não muda — frase neutra verdadeira continua passando", () => {
  it("o prompt da F4-02 segue dizendo que descrição de horário/empresa NÃO é promessa", () => {
    expect(PROMISE_SEMANTIC_INSTRUCTION).toContain("descrições de horário/empresa");
  });

  it("'abrimos às 8h' não é promessa para a F4-02", () => {
    const veredito = semanticPromiseGate.evaluate(
      gateContexto(null, {
        body: "Abrimos às 8h.",
        semanticPromise: { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: false, retornoSoDoAssistente: false },
      }),
    );
    expect(veredito.pass).toBe(true);
  });

  it("'abrimos às 8h' na base → esta camada passa; fora da base → esta camada veta", async () => {
    const naBase = await conferirAfirmacoes(
      adminFalso(banco()),
      {
        ...entrada("decidindo", "Abrimos às 8h."),
        lerEvidencias: () => [
          { origem: "conhecimento", referencia: "faq:1", titulo: "Horário", conteudo: "Abre das 8h às 18h." },
        ],
      },
      { ...DEPS, fetchImpl: fetchCom({ claim_0: 0.9, supported_0: 0.95, contradicts_0: 0.02 }).fetchImpl },
    );
    expect(naBase.veredito).toBe("passa");
    expect(factualClaimGate.evaluate(gateContexto(naBase)).pass).toBe(true);

    const foradaBase = await conferirAfirmacoes(
      adminFalso(banco()),
      {
        ...entrada("decidindo", "Abrimos às 8h."),
        lerEvidencias: () => [
          { origem: "conhecimento", referencia: "faq:1", titulo: "Horário", conteudo: "Abre das 9h às 17h." },
        ],
      },
      { ...DEPS, fetchImpl: fetchCom({ claim_0: 0.9, supported_0: 0.05, contradicts_0: 0.6 }).fetchImpl },
    );
    expect(foradaBase.veredito).toBe("nao_esta_na_base");
    expect(factualClaimGate.evaluate(gateContexto(foradaBase)).pass).toBe(false);
  });
});

describe("controles da issue: sem veto onde não há afirmação", () => {
  it("'Bom dia! Como posso ajudar?' não gera requisição nenhuma", async () => {
    const f = fetchCom({});
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("decidindo", "Bom dia! Como posso ajudar?"),
      { ...DEPS, fetchImpl: f.fetchImpl },
    );
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(r.veredito).toBe("nao_conferido");
    expect(r.motivo).toBe("sem_frases");
    expect(factualClaimGate.evaluate(gateContexto(r))).toEqual({
      pass: true,
      skipped: "nao_conferido",
    });
  });

  it("'Nosso atendimento é rápido' não gera veto (claim baixo)", async () => {
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("decidindo", "Nosso atendimento é rápido."),
      { ...DEPS, fetchImpl: fetchCom({ claim_0: 0.2, supported_0: 0.4, contradicts_0: 0.05 }).fetchImpl },
    );
    expect(r.veredito).toBe("passa");
    expect(factualClaimGate.evaluate(gateContexto(r)).pass).toBe(true);
  });
});

describe("uma única requisição por turno", () => {
  it("a segunda candidata do mesmo turno não vai mais para a rede", async () => {
    const f = fetchCom({ claim_0: 0.1, supported_0: 0.1, contradicts_0: 0.1 });
    const conferir = criarConferidorDeAfirmacoes(
      adminFalso(banco({ jev: { ligado: true, aceite: { em: "2026-09-01T00:00:00.000Z", por: ORG } } })),
      {
        organizationId: ORG,
        conversationId: null,
        contactId: CONTATO,
        agentId: null,
        lerEvidencias: () => EVIDENCIAS,
      },
      { ...DEPS, fetchImpl: f.fetchImpl },
    );
    const primeira = await conferir("Abrimos às 8h.");
    const segunda = await conferir("Temos sim piscina aquecida!");
    expect(primeira.pediu).toBe(true);
    expect(segunda.pediu).toBe(false);
    expect(segunda.motivo).toBe("outra_por_turno");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(factualClaimGate.evaluate(gateContexto(segunda))).toEqual({
      pass: true,
      skipped: "nao_conferido",
    });
  });
});

describe("catraca: tarefa desligada ou sem credencial é zero requisição e zero linha", () => {
  it("sem Jev ligado na organização: nada sai e nada é gravado", async () => {
    const f = fetchCom({});
    const b = banco(null);
    const conferir = criarConferidorDeAfirmacoes(
      adminFalso(b),
      {
        organizationId: ORG,
        conversationId: null,
        contactId: CONTATO,
        agentId: null,
        lerEvidencias: () => EVIDENCIAS,
      },
      { ...DEPS, fetchImpl: f.fetchImpl },
    );
    const r = await conferir("Temos sim piscina aquecida!");
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(b.inseridas.llm_calls).toBeUndefined();
    expect(b.inseridas.jev_observacoes).toBeUndefined();
    expect(r.motivo).toBe("desligada");
    expect(factualClaimGate.evaluate(gateContexto(r)).pass).toBe(true);
  });

  it("sem credencial: o Jev nem é chamado e llm_calls fica sem linha", async () => {
    const f = fetchCom({});
    const b = banco();
    const r = await conferirAfirmacoes(
      adminFalso(b),
      entrada("decidindo", "Temos sim piscina aquecida!"),
      { buscarChave: async () => null, fetchImpl: f.fetchImpl },
    );
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(b.inseridas.llm_calls).toBeUndefined();
    expect(r.motivo).toBe("sem_credencial");
    expect(factualClaimGate.evaluate(gateContexto(r)).pass).toBe(true);
  });
});

describe("falha do provedor: a mensagem segue como hoje", () => {
  it("429 → não conferido, disjuntor avisado e linha em llm_calls com error_code", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "60" },
        }),
    );
    const b = banco();
    const r = await conferirAfirmacoes(
      adminFalso(b),
      { ...entrada("decidindo", "Temos sim piscina aquecida!"), organizationId: ORG_DA_FALHA },
      { buscarChave: async () => "chave-de-teste", fetchImpl },
    );
    expect(r.veredito).toBe("nao_conferido");
    expect(r.motivo).toBe("falha");
    expect(factualClaimGate.evaluate(gateContexto(r)).pass).toBe(true);
    const linha = (b.inseridas.llm_calls ?? [])[0] as Record<string, unknown>;
    expect(linha.error_code).toBe("jev_limite_de_taxa");
    expect(linha.status).toBe("erro");
  });
});

describe("o estado que sai para o Jev", () => {
  it("é { frases, evidencias } — só as evidências deste turno, sem nada da conversa", async () => {
    const f = fetchCom({ claim_0: 0.1, supported_0: 0.1, contradicts_0: 0.1 });
    await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("decidindo", "Abrimos às 8h."),
      { ...DEPS, fetchImpl: f.fetchImpl },
    );
    expect(f.chamadas).toHaveLength(1);
    const estado = f.chamadas[0]!.state as Record<string, unknown>;
    expect(Object.keys(estado).sort()).toEqual(["evidencias", "frases"]);
    expect(estado.evidencias).toEqual(EVIDENCIAS);
    expect(JSON.stringify(estado)).not.toContain(CONTATO);
    expect(JSON.stringify(estado)).not.toContain(ORG);
  });

  it("sem evidência consultada no turno a camada não roda — grava 'não conferido'", async () => {
    const f = fetchCom({});
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      { ...entrada("decidindo", "Abrimos às 8h."), lerEvidencias: () => [] },
      { ...DEPS, fetchImpl: f.fetchImpl },
    );
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(r.veredito).toBe("nao_conferido");
    expect(r.motivo).toBe("sem_evidencia");
  });
});

describe("a forma da cadeia", () => {
  it("factual_claim roda DEPOIS da F4-01 e da F4-02, e a versão acompanha", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("factual_claim")).toBe(nomes.indexOf("semantic_promise") + 1);
    expect(nomes.indexOf("factual_claim")).toBeGreaterThan(nomes.indexOf("promise"));
    expect(BEFORE_SEND_CHAIN_VERSION).toBe(9);
  });
});

describe("a tarefa do seam", () => {
  it("é nova, de mensagem, e SÓ OBSERVA nesta versão ('Deixar decidir' só depois)", () => {
    expect(TAREFA_DA_AFIRMACAO_DE_FATO).toMatchObject({
      id: "afirmacao_de_fato",
      primitiva: "noul",
      alcance: "mensagem",
      familia: "novo",
    });
    expect(TAREFA_DA_AFIRMACAO_DE_FATO.soObserva).toBeTruthy();
    expect(TAREFA_DA_AFIRMACAO_DE_FATO.ponto).toBe("afirmacao_de_fato");
  });
});

describe("nada da candidata vaza para log ou para a linha de observação", () => {
  it("a observação grava só rótulos", async () => {
    const b = banco();
    await conferirAfirmacoes(
      adminFalso(b),
      entrada("decidindo", "Temos sim, piscina aquecida!"),
      { ...DEPS, fetchImpl: fetchCom({ claim_0: 0.95, supported_0: 0.05, contradicts_0: 0.1 }).fetchImpl },
    );
    const observacao = (b.inseridas.jev_observacoes ?? [])[0] as Record<string, unknown>;
    expect(observacao.tarefa).toBe("afirmacao_de_fato");
    expect(JSON.stringify(observacao)).not.toContain("piscina");
    expect(avisos.every(([, ctx]) => !JSON.stringify(ctx).includes("piscina"))).toBe(true);
  });

  it("o veto devolve a frase AO MODELO e nunca ao trace", async () => {
    const frase = "Temos sim, piscina aquecida!";
    const motivo = renderVetoDeAfirmacao("nao_esta_na_base", frase);
    expect(motivo).toContain(frase);
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("decidindo", frase),
      { ...DEPS, fetchImpl: fetchCom({ claim_0: 0.95, supported_0: 0.05, contradicts_0: 0.1 }).fetchImpl },
    );
    const veredito = factualClaimGate.evaluate(gateContexto(r));
    expect(veredito.pass).toBe(false);
    if (veredito.pass) throw new Error("devia vetar");
    expect(veredito.detail).toBeDefined();
    expect(JSON.stringify(veredito.detail)).not.toContain("piscina");
  });
});

describe("o estado da tarefa decide se o veredito veta", () => {
  // A tarefa nasce em observação: um `contradiz` só é anotado em
  // jev_observacoes e a mensagem segue. Só `decidindo` veta.
  const contradiz = { claim_0: 0.9, supported_0: 0.1, contradicts_0: 0.95 };

  it("observando: um 'contradiz' PASSA — só anota", async () => {
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("observando", "O check-in é a partir das 12h."),
      { ...DEPS, fetchImpl: fetchCom(contradiz).fetchImpl },
    );
    expect(r.veredito).toBe("contradiz");
    expect(r.estado).toBe("observando");
    expect(factualClaimGate.evaluate(gateContexto(r)).pass).toBe(true);
  });

  it("decidindo: o mesmo 'contradiz' VETA", async () => {
    const r = await conferirAfirmacoes(
      adminFalso(banco()),
      entrada("decidindo", "O check-in é a partir das 12h."),
      { ...DEPS, fetchImpl: fetchCom(contradiz).fetchImpl },
    );
    expect(r.estado).toBe("decidindo");
    expect(factualClaimGate.evaluate(gateContexto(r)).pass).toBe(false);
  });
});

describe("a conferência roda FORA da transação do envio (#2121)", () => {
  // Ela grava llm_calls por OUTRA conexão do pool. Dentro da transação, com o
  // pg_advisory_xact_lock do número na mão, fechava o mesmo ciclo de esperas
  // que o #2121 tirou da F4-02 (#2363). Mesma régua de posição de
  // promessa-semantica-fora-do-lock.test.ts: a ORDEM dos eventos num pool fingido.
  function poolFalso(eventos: string[]): pg.Pool {
    const client = {
      query: vi.fn(async (sql: string) => {
        const s = String(sql).toLowerCase().trim();
        if (s.includes("pg_advisory_xact_lock")) eventos.push("lock");
        if (s === "begin") eventos.push("begin");
        if (s === "commit") eventos.push("commit");
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    return {
      connect: vi.fn(async () => {
        eventos.push("connect");
        return client;
      }),
      query: vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] }),
    } as unknown as pg.Pool;
  }

  it("quando o Jev é chamado, nenhuma conexão foi tomada e nenhum lock está em posse", async () => {
    const eventos: string[] = [];
    const r = await runBeforeSend({
      pool: poolFalso(eventos),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body: "O check-in é a partir das 12h.",
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: new Date("2026-09-17T12:00:00.000Z"),
      rng: () => 0,
      sleep: async () => {},
      gates: [],
      send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
      conferirAfirmacoes: async () => {
        eventos.push("conferiu");
        return null;
      },
    });
    expect(r.status).toBe("sent");
    expect(eventos).toEqual(["conferiu", "connect", "begin", "lock", "commit"]);
  });
});
