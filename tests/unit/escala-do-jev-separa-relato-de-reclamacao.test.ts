/**
 * A ESCALA DO JEV LIA RELATO COMO RECLAMAÇÃO (issue #2219, ponta 1).
 *
 * ─── O que foi medido ──────────────────────────────────────────────────────
 *
 * Com o Jev decidindo (`climaDoJev === "decidindo"`, ou sem IA de linguagem
 * resolvida), a nota NÃO vem do `SENTIMENT_SYSTEM_PROMPT` — vem de
 * `lib/ai/decisao/clima.ts`, com `score01 = score / teto` (`teto = 4`). O
 * segundo nível era `"cliente insatisfeito ou reclamando"`, que vale 0.25:
 * ABAIXO do `DEFAULT_SENTIMENT_THRESHOLD` (0.3). O caso da #2209 ("Fui
 * bloqueado na Uber") era lido como reclamação e passava para uma pessoa — e o
 * prompt novo do #2216 não alcança este caminho, porque ele só é o insumo da
 * IA de sempre.
 *
 * ─── O que este teste pode e não pode provar ──────────────────────────────
 *
 * O fornecedor é um modelo: não se testa aqui a nota que ele devolve. O que se
 * testa é a RÉGUA que ele recebe — a escala e a instrução, os únicos insumos do
 * desfecho que este repositório controla. A prova é estrutural e anda nas DUAS
 * pontas da issue, cada uma com guarda de vacuidade:
 *
 *   1. o nível do RELATO normaliza para uma nota ACIMA do corte — nenhuma nota
 *      daquele nível aciona a passagem;
 *   2. o nível de INSATISFAÇÃO COM O ATENDIMENTO normaliza ABAIXO do corte —
 *      toda nota dele aciona (o conserto não pode apagar a passagem);
 *   3. a separação é geral: todo nível abaixo do corte fala de atendimento e
 *      NENHUM fala de relato; nenhum nível acima do corte acusa hostilidade.
 *
 * O desfecho no worker (o alerta `ai.sentiment_alert` saindo ou não) está
 * preso em `tests/unit/clima-da-conversa-no-worker.test.ts`, com o Jev
 * decidindo — este arquivo é a régua, aquele é o corte.
 *
 * O worker decide por `decisao.score < threshold`
 * (`workers/ai-sentiment-worker.ts`), por isso a régua daqui usa `<` e não `≤`.
 */
import { describe, expect, it } from "vitest";

import { NIVEIS_DE_CLIMA } from "@/lib/ai/decisao/clima";
import { DEFAULT_SENTIMENT_THRESHOLD } from "@/lib/ai/prompts/sentiment";

/** As âncoras da issue: uma que NÃO pode escalar, uma que DEVE escalar. */
const ANCORAS_DE_RELATO = ["Fui bloqueado na Uber"];
const ANCORAS_DE_INSATISFACAO = ["insatisfeito com o atendimento", "reclamando de demora"];

/** O vocabulário de quem está brigando com o ATENDIMENTO (não com o assunto). */
const HOSTILIDADE = ["hostilidade", "ameaça", "xingamento", "pedido agressivo"];

/** O vocabulário de quem está insatisfeito com quem respondeu. */
const ATENDIMENTO = ["insatisfeito", "irritad", "revoltado", "reclamand", "cobrança fechada", ...HOSTILIDADE];

/** O vocabulário de quem só conta o problema que o trouxe até aqui. */
const RELATO = ["relat", "descrev", "problema que o trouxe"];

const TETO = NIVEIS_DE_CLIMA.length - 1;
/** A mesma normalização de `medirClima`: `score01 = score / (níveis - 1)`. */
const notaDo = (nivel: number) => nivel / TETO;

const queAcionam = () => NIVEIS_DE_CLIMA.map((texto, nivel) => ({ texto, nota: notaDo(nivel) })).filter((n) => n.nota < DEFAULT_SENTIMENT_THRESHOLD);

describe("guardas do instrumento — sem isto qualquer asserção passaria sem olhar nada", () => {
  it("a escala existe, tem os cinco níveis e a normalização bate com o worker", () => {
    expect(NIVEIS_DE_CLIMA).toHaveLength(5);
    expect(notaDo(0)).toBe(0);
    expect(notaDo(TETO)).toBe(1);
    // O teto É o `NIVEIS_DE_CLIMA.length - 1` de `medirClima`: um nível a mais
    // sem mexer aqui mudaria a nota de toda mensagem em silêncio.
    expect(TETO).toBe(NIVEIS_DE_CLIMA.length - 1);
  });

  it("as âncoras medida estão na escala, cada uma no seu nível", () => {
    for (const frase of ANCORAS_DE_RELATO) {
      expect(
        NIVEIS_DE_CLIMA.some((n) => n.includes(frase)),
        `a âncora de relato não está em nenhum nível: ${frase}`,
      ).toBe(true);
    }
    for (const frase of ANCORAS_DE_INSATISFACAO) {
      expect(
        NIVEIS_DE_CLIMA.some((n) => n.toLowerCase().includes(frase)),
        `a âncora de insatisfação não está em nenhum nível: ${frase}`,
      ).toBe(true);
    }
  });

  it("o corte fica ENTRE o nível de insatisfação e o de relato (senão nada distingue)", () => {
    expect(DEFAULT_SENTIMENT_THRESHOLD).toBeGreaterThan(notaDo(1));
    expect(DEFAULT_SENTIMENT_THRESHOLD).toBeLessThan(notaDo(2));
  });
});

describe("a escala do Jev separa o relato do problema da insatisfação com o atendimento", () => {
  it("o nível do RELATO do problema fica ACIMA do corte — nenhuma nota dele aciona", () => {
    const nivel = NIVEIS_DE_CLIMA.findIndex((texto) => texto.includes(ANCORAS_DE_RELATO[0] as string));
    expect(nivel, "a âncora de relato sumiu da escala").toBeGreaterThanOrEqual(0);
    expect(
      notaDo(nivel),
      `o nível de relato vale ${notaDo(nivel)} e o corte é ${DEFAULT_SENTIMENT_THRESHOLD}: o Jev continuaria lendo relatar como reclamar e passando o lead para uma pessoa`,
    ).toBeGreaterThanOrEqual(DEFAULT_SENTIMENT_THRESHOLD);
  });

  it("o nível de INSATISFAÇÃO com o atendimento fica ABAIXO do corte — toda nota dele aciona", () => {
    // Guarda do outro lado do conserto: apagar a passagem por insatisfação
    // (empurrando tudo para o neutro) reprovaria aqui.
    const nivel = NIVEIS_DE_CLIMA.findIndex((texto) => texto.toLowerCase().includes(ANCORAS_DE_INSATISFACAO[0] as string));
    expect(nivel, "a âncora de insatisfação sumiu da escala").toBeGreaterThanOrEqual(0);
    expect(
      notaDo(nivel),
      `o nível de insatisfação vale ${notaDo(nivel)} e o corte é ${DEFAULT_SENTIMENT_THRESHOLD}: um cliente brigar com o atendimento e a conversa seguir automática`,
    ).toBeLessThan(DEFAULT_SENTIMENT_THRESHOLD);
  });

  it("todo nível que aciona fala do ATENDIMENTO e nenhum fala de relato", () => {
    const acionam = queAcionam();
    expect(acionam.length, "nenhum nível ficou inteiro abaixo do corte").toBeGreaterThan(0);
    for (const { texto, nota } of acionam) {
      expect(
        ATENDIMENTO.some((marca) => texto.toLowerCase().includes(marca)),
        `o nível ${nota} aciona a passagem sem nomear insatisfação com o atendimento: ${texto}`,
      ).toBe(true);
      for (const marca of RELATO) {
        expect(
          texto.includes(marca),
          `o nível ${nota} aciona a passagem por RELATAR o problema: ${texto}`,
        ).toBe(false);
      }
    }
  });

  it("nenhum nível acima do corte acusa hostilidade com quem responde", () => {
    const acima = NIVEIS_DE_CLIMA.map((texto, nivel) => ({ texto, nota: notaDo(nivel) })).filter(
      (n) => n.nota >= DEFAULT_SENTIMENT_THRESHOLD,
    );
    expect(acima.length, "a escala não tem nível neutro nem positivo").toBeGreaterThan(0);
    for (const { texto, nota } of acima) {
      for (const marca of HOSTILIDADE) {
        expect(
          texto.includes(marca),
          `o nível ${nota} (acima do corte) acusa hostilidade: ${texto}`,
        ).toBe(false);
      }
    }
  });
});
