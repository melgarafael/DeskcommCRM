import { describe, expect, it } from "vitest";

import { RETRATO_VELHO_APOS_MS, retratoDoHostVelho } from "./retrato";

/**
 * #3488 — A RÉGUA DA IDADE DO RETRATO.
 *
 * `system_version` é o último retrato que o heartbeat conseguiu gravar. Com
 * `latest_version` vazio, `compare_failed` falso e `has_known_release`
 * verdadeiro ele é, ao mesmo tempo, o estado de "conferi agora" e o de "parei
 * de conferir há horas" — e era assim que a tela afirmava "É a mais recente"
 * com quatro horas de silêncio (medido em produção em 26/10).
 *
 * O número tem de respeitar dois vizinhos, e é por isso que os casos de borda
 * estão aqui e não na tela:
 *
 *   - ABAIXO dele, o silêncio é normal: o agente bate a cada 5 min, e durante
 *     uma atualização o app responde `maintenance` e o heartbeat NÃO grava (8
 *     ocorrências no log da instalação que abriu a issue). Uma régua curta
 *     piscaria "não sei" a cada atualização normal.
 *   - ACIMA dele, nenhum silêncio legítimo explica a falta de notícia — e a
 *     válvula antiga (`agent_online`, 24h) só abriria um dia depois.
 */
describe("retratoDoHostVelho — a idade do retrato do host (#3488)", () => {
  const AGORA = new Date("2026-10-26T19:00:00.000Z");
  const haMinutos = (min: number) => new Date(AGORA.getTime() - min * 60 * 1000).toISOString();

  it("batida de 5 min atrás (o intervalo normal do agente): retrato fresco", () => {
    expect(retratoDoHostVelho(haMinutos(5), AGORA)).toBe(false);
  });

  it("atualização em curso (app em `maintenance`, ~10 min sem gravar): ainda fresco — não pisca 'não sei'", () => {
    expect(retratoDoHostVelho(haMinutos(10), AGORA)).toBe(false);
  });

  it("no limite exato, ainda fresco — a régua é 'mais velho que', não 'a partir de'", () => {
    expect(retratoDoHostVelho(new Date(AGORA.getTime() - RETRATO_VELHO_APOS_MS).toISOString(), AGORA)).toBe(false);
  });

  it("um milissegundo além do limite: velho", () => {
    expect(
      retratoDoHostVelho(new Date(AGORA.getTime() - RETRATO_VELHO_APOS_MS - 1).toISOString(), AGORA),
    ).toBe(true);
  });

  it("⭐ o caso da issue: 4h15 de silêncio e a v1.90.0 publicada no meio — retrato velho", () => {
    // 11h45 (última gravação) → 16h00 (operador abrindo a tela, hora local −03).
    expect(retratoDoHostVelho("2026-10-26T14:45:02.000Z", new Date("2026-10-26T19:00:00.000Z"))).toBe(true);
  });

  it("24h de silêncio: também velho (aqui `agent_online` já derrubou, mas a régua não depende dele)", () => {
    expect(retratoDoHostVelho(haMinutos(25 * 60), AGORA)).toBe(true);
  });

  it("nunca ouvimos o host (nulo, ausente ou data inválida): nada a afirmar, e o retrato conta como velho", () => {
    expect(retratoDoHostVelho(null, AGORA)).toBe(true);
    expect(retratoDoHostVelho(undefined, AGORA)).toBe(true);
    expect(retratoDoHostVelho("", AGORA)).toBe(true);
    expect(retratoDoHostVelho("não é uma data", AGORA)).toBe(true);
  });

  it("o número é folgado para a batida de 5 min e curto perto das 24h da válvula antiga", () => {
    // Guarda contra alguém "consertar" a régua com 1 batida (5 min) ou com o
    // valor da válvula antiga (24h): os dois extremos são o defeito.
    expect(RETRATO_VELHO_APOS_MS).toBeGreaterThan(5 * 60 * 1000);
    expect(RETRATO_VELHO_APOS_MS).toBeLessThan(24 * 60 * 60 * 1000);
    expect(RETRATO_VELHO_APOS_MS).toBe(30 * 60 * 1000);
  });
});
