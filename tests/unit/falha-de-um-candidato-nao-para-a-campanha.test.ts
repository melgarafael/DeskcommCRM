import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { ProspectingError } from "@/lib/prospecting/provider";

/**
 * UM CANDIDATO RUIM NÃO PARA A LISTA INTEIRA.
 *
 * ## O defeito (issue #1312)
 *
 * Qualquer exceção ao enviar para UM candidato mudava o status da CAMPANHA para
 * `paused`. Um número inválido numa lista de mil, um contato que virou bloqueado
 * entre a busca e o envio, uma instabilidade de um segundo no provedor — todos
 * paravam a campanha, e ela só voltava se alguém abrisse a tela e retomasse à
 * mão.
 *
 * É o oposto do que a casa faz em todo lugar: item ruim marca o ITEM, não a
 * fila.
 *
 * ## O critério, e por que não é uma lista de mensagens
 *
 * A separação é por NATUREZA da falha, carregada no próprio erro:
 *
 *   `campanha`  vale para TODOS os candidatos (canal desconectado, agente sem
 *               versão publicada, configuração inválida) — o próximo daria o
 *               mesmo erro, então pausar é certo;
 *   `candidato` vale só para aquele (destino incompleto, abordagem cancelada).
 *
 * Classificar por texto da mensagem seria frágil: uma frase reescrita mudaria o
 * comportamento sem ninguém perceber.
 *
 * ## O sentido do erro no desconhecido
 *
 * O padrão é `campanha` — falhar FECHADO. Um erro que ninguém classificou pode
 * ser sistêmico, e marcar o candidato e seguir faria a fila repetir a mesma
 * falha mil vezes, com mil linhas de erro e nenhuma pausa. Pausar uma campanha
 * que podia continuar custa uma retomada manual; não pausar uma que devia parar
 * custa a lista inteira.
 */

const WORKER = path.resolve(__dirname, "../../lib/prospecting/worker.ts");

describe("o escopo viaja no erro, não na mensagem", () => {
  it("o padrão é `campanha` — desconhecido falha FECHADO", () => {
    expect(new ProspectingError("qualquer coisa").escopo).toBe("campanha");
    expect(new ProspectingError("com status", 409).escopo).toBe("campanha");
  });

  it("e `candidato` é sempre declarado de propósito", () => {
    expect(new ProspectingError("só este", 422, "candidato").escopo).toBe("candidato");
  });
});

describe("o worker trata os dois casos de forma diferente", () => {
  const fonte = fs.readFileSync(WORKER, "utf8");

  it("decide pelo ESCOPO, não pelo texto da mensagem", () => {
    expect(fonte).toMatch(/error instanceof ProspectingError && error\.escopo === "candidato"/);
  });

  it("falha do candidato marca o CANDIDATO, e não a campanha", () => {
    const i = fonte.indexOf("if (doCandidato) {");
    expect(i, "o ramo do candidato sumiu").toBeGreaterThan(-1);
    const ramo = fonte.slice(i, fonte.indexOf("} else {", i));
    expect(ramo).toMatch(/update prospecting_candidates set status='failed'/);
    expect(
      /update prospecting_campaigns set status='paused'/.test(ramo),
      "o ramo do candidato voltou a pausar a campanha",
    ).toBe(false);
  });

  it("falha da campanha continua pausando — o conserto não pode ter tirado isso", () => {
    // O outro lado. Sem este caso, "não pausa nunca" passaria verde, e aí a
    // campanha com canal desconectado tentaria para sempre.
    const i = fonte.indexOf("} else {", fonte.indexOf("if (doCandidato) {"));
    const ramo = fonte.slice(i, fonte.indexOf("}", fonte.indexOf("prospecting_campaigns set status='paused'", i)));
    expect(ramo).toMatch(/update prospecting_campaigns set status='paused'/);
  });

  it("a falha do candidato deixa rastro, com a campanha e a causa", () => {
    // Seguir em silêncio trocaria "campanha parada sem explicação" por
    // "candidatos sumindo sem explicação" — mesmo problema, mais difícil de ver.
    const i = fonte.indexOf('logger.warn("[prospecting] candidato falhou');
    expect(i, "a falha do candidato não loga nada").toBeGreaterThan(-1);
    const bloco = fonte.slice(i, fonte.indexOf("});", i) + 3);
    expect(bloco).toMatch(/organization_id:/);
    expect(bloco).toMatch(/campaign_id:/);
    expect(bloco).toMatch(/error:/);
  });
});

describe("quais falhas foram classificadas como do candidato", () => {
  const fonte = fs.readFileSync(WORKER, "utf8");

  it("destino incompleto é do candidato — o próximo pode ter destino", () => {
    const i = fonte.indexOf("Destino da abordagem incompleto");
    expect(i).toBeGreaterThan(-1);
    expect(fonte.slice(i, i + 200)).toMatch(/"candidato"/);
  });

  it("a IA não produzir texto é do candidato — é sobre ESTES dados", () => {
    const i = fonte.indexOf("A IA não produziu uma abordagem");
    expect(i).toBeGreaterThan(-1);
    expect(fonte.slice(i, i + 200)).toMatch(/"candidato"/);
  });

  it("canal indisponível e agente sem versão continuam da CAMPANHA", () => {
    // Estes valem para todos os candidatos: tentar o próximo daria o mesmo erro.
    for (const frase of ["Conexão de saída indisponível", "Agente pausado ou sem versão publicada"]) {
      const i = fonte.indexOf(frase);
      expect(i, `não achei "${frase}"`).toBeGreaterThan(-1);
      expect(
        /"candidato"/.test(fonte.slice(i, i + 200)),
        `"${frase}" foi classificada como falha do candidato, e ela vale para todos`,
      ).toBe(false);
    }
  });
});
