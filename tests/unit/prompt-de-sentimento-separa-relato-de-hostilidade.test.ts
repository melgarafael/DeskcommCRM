/**
 * O CLASSIFICADOR DE CLIMA PRESUPUNHA E-COMMERCE E PUNHA "QUEIXA COM PRODUTO/
 * ENTREGA" NA FAIXA QUE ACIONA O HANDOFF (issue #2209).
 *
 * ─── O que foi medido ──────────────────────────────────────────────────────
 *
 * Numa instalação de advocacia, "Fui bloqueado na Uber" — a resposta do lead à
 * pergunta de qualificação, sem irritação nenhuma — foi classificada abaixo do
 * limiar e a conversa passou para humano com o motivo `low_sentiment`. Nesse
 * nicho relatar o problema é o conteúdo NORMAL da conversa; o prompt antigo
 * abria "classificador de sentimento para mensagens de clientes de e-commerce"
 * e colocava "frustração, queixa moderada, decepção com produto/entrega" na
 * faixa 0.2–0.4, que é justamente a que cruza o `DEFAULT_SENTIMENT_THRESHOLD`
 * (0.3).
 *
 * ─── O que este teste pode e não pode provar ───────────────────────────────
 *
 * O classificador é um modelo: não se testa aqui a nota que ele devolve. O que
 * se testa é a RÉGUA que ele recebe — e a régua é o único insumo do desfecho
 * que este repositório controla. A prova é estrutural e anda em quatro
 * direções, cada uma com guarda de vacuidade (as faixas têm de existir e as
 * âncoras têm de estar lá, senão qualquer asserção passaria por não ter o que
 * olhar):
 *
 *   1. nenhuma presunção de nicho no texto;
 *   2. a frase do RELATO ("Fui bloqueado na Uber") está numa faixa cuja nota
 *      mínima já está ACIMA do limiar — ou seja, nenhuma nota daquela faixa
 *      aciona a passagem;
 *   3. a frase HOSTIL está numa faixa cuja nota máxima está ABAIXO do limiar —
 *      toda nota dela aciona a passagem;
 *   4. a separação é geral, não decorativa: TODA faixa que aciona o handoff
 *      fala de hostilidade com o atendimento e NENHUMA fala de relato; nenhuma
 *      faixa acima do limiar acusa hostilidade.
 *
 * O worker decide por `decisao.score < threshold`
 * (`workers/ai-sentiment-worker.ts`), por isso a régua daqui usa `<` e não `≤`.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SENTIMENT_THRESHOLD, SENTIMENT_SYSTEM_PROMPT } from "@/lib/ai/prompts/sentiment";

/** Medidas na issue: uma que NÃO pode cair na passagem, uma que DEVE cair. */
const ANCORAS_DE_RELATO = ["Fui bloqueado na Uber"];
const ANCORAS_DE_HOSTILIDADE = ["isso é um absurdo"];

/** O vocabulário de quem está brigando com o ATENDIMENTO (não com o assunto). */
const HOSTILIDADE = [
  "hostilidade",
  "ameaça",
  "xingamento",
  "pedido agressivo",
  "falar com uma pessoa",
  "cobrança fechada",
];

/** O vocabulário de quem só conta o problema que o trouxe até aqui. */
const RELATO = ["relat", "descrev", "problema que o trouxe"];

/** Presunções de nicho que a issue apontou — nenhuma pode sobrar. */
const PRESUNCOES = ["e-commerce", "produto/entrega", "decepcão com produto"];

interface Faixa {
  de: number;
  ate: number;
  texto: string;
}

function faixas(): Faixa[] {
  return [...SENTIMENT_SYSTEM_PROMPT.matchAll(/^-\s*(\d+\.\d+)–(\d+\.\d+):\s*(.+)$/gm)].map(
    (m) => ({ de: Number(m[1]), ate: Number(m[2]), texto: (m[3] as string).trim() }),
  );
}

function faixaCom(frase: string): Faixa | undefined {
  return faixas().find((f) => f.texto.includes(frase));
}

describe("guardas do instrumento — sem isto qualquer asserção passaria sem olhar nada", () => {
  it("as cinco faixas da régua existem e cobrem 0 a 1", () => {
    const f = faixas();
    expect(f, "a régua sumiu do prompt — o parser não achou nenhuma faixa").toHaveLength(5);
    expect(f[0]?.de).toBe(0);
    expect(f[4]?.ate).toBe(1);
  });

  it("as âncoras medida estão no prompt", () => {
    for (const frase of [...ANCORAS_DE_RELATO, ...ANCORAS_DE_HOSTILIDADE]) {
      expect(faixaCom(frase), `a frase âncora não está em nenhuma faixa: ${frase}`).toBeDefined();
    }
  });

  it("o limiar de fato corta a régua no meio (senão os casos não distinguem nada)", () => {
    // Entre a âncora de relato (>= 0.4) e a de hostilidade (<= 0.2) tem de
    // haver espaço para o 0.3 — senão as duas pontas cairiam do mesmo lado.
    expect(DEFAULT_SENTIMENT_THRESHOLD).toBeGreaterThan(0.2);
    expect(DEFAULT_SENTIMENT_THRESHOLD).toBeLessThan(0.4);
  });
});

describe("a régua mede hostilidade com o atendimento, não o assunto da mensagem", () => {
  it("nenhuma presunção de nicho sobra no prompt", () => {
    for (const presuncao of PRESUNCOES) {
      expect(
        SENTIMENT_SYSTEM_PROMPT.includes(presuncao),
        `o prompt ainda presume um nicho: ${presuncao}`,
      ).toBe(false);
    }
    // E ele precisa dizer do que se trata: atendimento de quem conversa com a
    // equipe, em qualquer nicho.
    expect(SENTIMENT_SYSTEM_PROMPT).toContain("atendimento");
  });

  it("a frase do relato está numa faixa que NÃO aciona a passagem", () => {
    const faixa = faixaCom(ANCORAS_DE_RELATO[0] as string);
    expect(faixa).toBeDefined();
    expect(
      (faixa as Faixa).de,
      `a nota mínima da faixa de "${ANCORAS_DE_RELATO[0]}" é ${faixa?.de}, e o limiar é ${DEFAULT_SENTIMENT_THRESHOLD}: qualquer nota dela aciona a passagem para humano`,
    ).toBeGreaterThan(DEFAULT_SENTIMENT_THRESHOLD);
  });

  it("a frase hostil está numa faixa que ACIONA a passagem", () => {
    const faixa = faixaCom(ANCORAS_DE_HOSTILIDADE[0] as string);
    expect(faixa).toBeDefined();
    expect(
      (faixa as Faixa).ate,
      `a nota máxima da faixa hostil é ${faixa?.ate}, e o limiar é ${DEFAULT_SENTIMENT_THRESHOLD}: o worker só passa para humano quando score < limiar`,
    ).toBeLessThan(DEFAULT_SENTIMENT_THRESHOLD);
  });

  it("toda faixa que aciona a passagem fala de hostilidade e nenhuma fala de relato", () => {
    const queAcionam = faixas().filter((f) => f.ate <= DEFAULT_SENTIMENT_THRESHOLD);
    expect(queAcionam.length, "nenhuma faixa fica inteira abaixo do limiar").toBeGreaterThan(0);
    for (const faixa of queAcionam) {
      expect(
        HOSTILIDADE.some((marca) => faixa.texto.includes(marca)),
        `faixa ${faixa.de}–${faixa.ate} aciona a passagem sem nomear hostilidade: ${faixa.texto}`,
      ).toBe(true);
      for (const marca of RELATO) {
        expect(
          faixa.texto.includes(marca),
          `faixa ${faixa.de}–${faixa.ate} aciona a passagem por RELATAR o problema: ${faixa.texto}`,
        ).toBe(false);
      }
    }
  });

  it("nenhuma faixa acima do limiar acusa hostilidade", () => {
    const acima = faixas().filter((f) => f.de >= DEFAULT_SENTIMENT_THRESHOLD);
    expect(acima.length, "a régua não tem faixa neutra nem positiva").toBeGreaterThan(0);
    for (const faixa of acima) {
      for (const marca of HOSTILIDADE) {
        expect(
          faixa.texto.includes(marca),
          `faixa ${faixa.de}–${faixa.ate} (acima do limiar) acusa hostilidade: ${faixa.texto}`,
        ).toBe(false);
      }
    }
  });
});
