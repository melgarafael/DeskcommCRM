/**
 * NENHUMA ESCOLHA AUTOMÁTICA PODE CAIR NUM MODELO QUE O PROVEDOR APOSENTOU.
 *
 * Medido em 18/11/2026 com a chave Google real do `.env` (#4925), em
 * `POST /v1beta/models/<id>:generateContent` com `maxOutputTokens: 1`:
 *
 *   gemini-2.0-flash ..... 404 "This model models/gemini-2.0-flash is no longer available"
 *   gemini-2.5-flash ..... 404 "no longer available to new users"
 *   gemini-2.5-flash-lite  404 "no longer available to new users"
 *   gemini-2.5-pro ....... 404 "no longer available to new users"
 *
 * O estrago não é a tela: `ai_models` continua oferecendo os quatro (depreciar
 * linha é SQL), mas eles são os MAIS BARATOS do Google (10/40) — então
 * `escolherModeloEconomico` os escolhia e todo ponto de tier econômico
 * (`checkpoint`, `promise_semantic`, …) tomava 404 em TODO turno, com o
 * fail-open do seam escondendo a causa: o que aparecia era custo e latência.
 *
 * O conserto tem dois lados, e este arquivo prende os dois:
 *   1. `modeloAposentadoNoProvedor` barra o id (exato, com sufixo de data e com
 *      prefixo de roteador) — a lista é FIXTURE, medida, não palpite;
 *   2. o preço continua em `pricing.ts`, porque id aposentado ainda é chamado
 *      por instalação antiga e por roteador, e custo NULL calado é o defeito da
 *      #3013. "Não escolhível" e "não precificável" são coisas diferentes.
 */
import { describe, expect, it } from "vitest";

import { escolherModeloEconomico, type ModeloDoCatalogoEconomico } from "@/lib/ai/pontos/resolver";
import {
  modeloAposentadoNoProvedor,
  modelosAposentadosPeloProvedor,
} from "@/lib/agent-engine/edge/llm/modelos-aposentados";
import { precoDoModelo, temPrecoNoMotor } from "@/lib/agent-engine/edge/llm/pricing";

/** O que o provedor respondeu, id a id, em 18/11/2026 (chave real, maxOutputTokens: 1). */
const MEDICAO = {
  medidaEm: "2026-11-18",
  endpoint: "POST https://generativelanguage.googleapis.com/v1beta/models/<id>:generateContent",
  /** 404 — aposentados. A mensagem vai junto porque é ela que indica o substituto. */
  aposentados: {
    "gemini-2.0-flash": {
      http: 404,
      mensagem:
        "This model models/gemini-2.0-flash is no longer available. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.",
    },
    "gemini-2.5-flash": {
      http: 404,
      mensagem:
        "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.",
    },
    "gemini-2.5-flash-lite": {
      http: 404,
      mensagem:
        "This model models/gemini-2.5-flash-lite is no longer available to new users. Please update your code to use models/gemini-3.5-flash-lite for the latest features and improvements.",
    },
    "gemini-2.5-pro": {
      http: 404,
      mensagem:
        "This model models/gemini-2.5-pro is no longer available to new users. Please update your code to use models/gemini-3.1-pro-preview for the latest features and improvements.",
    },
  } as const,
  /** 200 com `finishReason: MAX_TOKENS` — servidos de fato na medição. */
  servidos: [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
  ] as const,
  /**
   * Sem veredito: 503 "high demand" (3.7/3.8 Flash, gemini-flash-latest) e 429
   * de cota (3.1 Pro, 4 Argon) NÃO são 404 — o modelo existe, a chave é que não
   * foi atendida naquele instante. Não entram nem como servidos nem como mortos.
   */
  semVeredito: [
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-3.1-pro-preview",
    "gemini-4-argon",
    "gemini-flash-latest",
  ] as const,
} as const;

/** O recorte do catálogo que o baseline entrega hoje: os aposentados AINDA estão lá. */
const CATALOGO_DO_BANCO = [
  m("gemini-3.1-pro-preview", 200, 1200),
  m("gemini-3.5-flash", 150, 900),
  m("gemini-3.5-flash-lite", 30, 250),
  m("gemini-3.1-flash-lite", 25, 150),
  m("gemini-2.5-flash-lite", 10, 40),
  m("gemini-2.0-flash", 10, 40),
  m("gemini-2.5-flash", 30, 250),
  m("gemini-2.5-pro", 125, 1000),
];

function m(model_id: string, entrada: number, saida: number): ModeloDoCatalogoEconomico {
  return {
    provider: "google",
    model_id,
    input_price_per_million_cents: entrada,
    output_price_per_million_cents: saida,
    supports_tools: true,
    supports_embedding: false,
  };
}

/** Os dois predicados que o seam passa — preço e "ainda existe", nessa ordem. */
const economicoDoGoogle = (modeloAtual: string | null) =>
  escolherModeloEconomico(
    CATALOGO_DO_BANCO,
    "google",
    modeloAtual,
    [],
    temPrecoNoMotor,
    modeloAposentadoNoProvedor,
  );

describe("catalogo Google x o que o provedor serve (#4925)", () => {
  it("a lista de aposentados é EXATAMENTE o resultado da medição", () => {
    // Guarda nos dois sentidos: id morto que volta sem medição reprova, e id
    // medido como vivo não pode entrar na lista de bloqueio.
    expect([...modelosAposentadosPeloProvedor()].sort()).toEqual(
      Object.keys(MEDICAO.aposentados).sort(),
    );
    for (const [id, resposta] of Object.entries(MEDICAO.aposentados)) {
      expect(resposta.http, `${id} não foi 404 na medição`).toBe(404);
      expect(MEDICAO.servidos as readonly string[]).not.toContain(id);
      expect(MEDICAO.semVeredito as readonly string[]).not.toContain(id);
    }
  });

  it("casa o id exato, o snapshot com data e o id atrás de roteador", () => {
    // O mesmo modelo aposentado responde 404 com sufixo de data e atrás de
    // OpenRouter/Requesty: barrar só a string literal deixaria os três furos.
    for (const id of Object.keys(MEDICAO.aposentados)) {
      expect(modeloAposentadoNoProvedor(id), id).toBe(true);
      expect(modeloAposentadoNoProvedor(`${id}-20250805`), `${id}-20250805`).toBe(true);
      expect(modeloAposentadoNoProvedor(`google/${id}`), `google/${id}`).toBe(true);
    }
    for (const id of MEDICAO.servidos) {
      expect(modeloAposentadoNoProvedor(id), id).toBe(false);
      expect(modeloAposentadoNoProvedor(`google/${id}`), `google/${id}`).toBe(false);
    }
  });

  it("o preço dos aposentados FICA, para custo legado não virar NULL", () => {
    // Tirar a linha de preço "resolveria" o 404 e criaria o #3013: custo nulo
    // calado, teto de gasto que nunca dispara. Preço e escolha são eixos
    // diferentes, e é o par `temPrecoNoMotor` + `modeloAposentadoNoProvedor` que
    // separa os dois.
    for (const id of Object.keys(MEDICAO.aposentados)) {
      expect(temPrecoNoMotor(id), `${id} perdeu a linha de preço`).toBe(true);
    }
    // E o mesmo vale atrás de roteador — a Requesty vende `google/gemini-2.5-flash`.
    expect(precoDoModelo("google/gemini-2.5-flash")).toBeDefined();
  });

  it("o tier econômico do Google desvia dos aposentados que o banco ainda lista", () => {
    // A instalação de hoje: `ai_models` oferece os quatro mortos e eles são os
    // mais baratos. Sem o barramento, o escolhido seria o 2.0 Flash (10/40).
    const escolhido = economicoDoGoogle("gemini-3.5-flash");
    expect(escolhido).toBe("gemini-3.1-flash-lite");
    expect(MEDICAO.servidos as readonly string[]).toContain(escolhido!);
    expect(temPrecoNoMotor(escolhido!)).toBe(true);
  });

  it("a organização que JÁ está num aposentado é trocada para um vivo", () => {
    // O furo que o filtro separado fecha: se "não aposentado" viajasse dentro do
    // parâmetro de preço, um modelo atual aposentado desligaria o filtro inteiro
    // e a organização em `gemini-2.5-pro` (125/1000) cairia no `gemini-2.0-flash`
    // — trocando um 404 por outro 404, calado.
    for (const atual of Object.keys(MEDICAO.aposentados)) {
      const escolhido = economicoDoGoogle(atual);
      if (escolhido === null) continue; // já é o mais barato: fica, e nada piora
      expect(modeloAposentadoNoProvedor(escolhido), `${atual} -> ${escolhido}`).toBe(false);
    }
    expect(economicoDoGoogle("gemini-2.5-pro")).toBe("gemini-3.1-flash-lite");
  });

  it("o escolhido é o mais barato entre os SERVIDOS, não só o primeiro da ordem", () => {
    const baratos = CATALOGO_DO_BANCO.filter((linha) =>
      (MEDICAO.servidos as readonly string[]).includes(linha.model_id),
    ).sort(
      (a, b) =>
        a.input_price_per_million_cents! - b.input_price_per_million_cents! ||
        a.output_price_per_million_cents! - b.output_price_per_million_cents!,
    );
    expect(baratos[0]!.model_id).toBe(economicoDoGoogle("gemini-3.5-flash"));
    // E o preço é o da tabela oficial, não uma estimativa:
    // aistudio.google.com/docs/pricing (Standard), lido em 18/11/2026.
    expect(precoDoModelo("gemini-3.1-flash-lite")).toMatchObject({
      input: 0.25,
      output: 1.5,
      cacheRead: 0.025,
    });
  });
});
