/**
 * O PACOTE NÃO PROMETE UMA ESCOLHA QUE O TETO IMPEDE (issue #162).
 *
 * ## O defeito
 *
 * A regra deliberada de `selecao-por-pacote.ts` é que **capacidade `critico`
 * nunca entra por pacote** — o humano tem de marcar à mão, e a tela diz isso
 * ("o pacote não liga por você"). O teto de 20 (`TETO_TOOLS_POR_AGENTE`) existe
 * por outro motivo, também escrito: prompt com capacidade demais degrada a
 * escolha do modelo.
 *
 * As duas regras se cancelavam. Ligar "Atender" traz 16 automáticas; somadas ao
 * que já estivesse ligado, o teto era atingido — e aí o checkbox da crítica
 * ficava `disabled`. O pacote prometia uma escolha que o produto não permitia
 * fazer, e o único sinal era um checkbox morto com `opacity-60`.
 *
 * Achado ao trazer as specs do épico IA 360 para o CI (issue #63): a spec que
 * cobre exatamente essa jornada reprovava por timeout de clique. Ela não rodava
 * em gate nenhum desde que foi escrita, e o catálogo cresceu no meio.
 *
 * ## O que se guarda
 *
 * A CONTA, não a mensagem: quantas vagas ligar um pacote realmente exige. Sem
 * as críticas nessa conta, o pacote cabe "por pouco" e a crítica morre.
 */
import { describe, expect, it } from "vitest";

import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";
import {
  TETO_TOOLS_POR_AGENTE,
  capacidadesAutomaticasDoPacote,
  capacidadesCriticasDoPacote,
  ligarPacote,
  vagasExigidasPeloPacote,
} from "@/lib/mcp/tools/selecao-por-pacote";

const CATALOGO = TOOL_CATALOG.map((t) => ({
  name: t.name,
  risco: t.risco,
  pacotes: t.pacotes,
}));

/** Pacotes que realmente têm crítica — os únicos onde a reserva muda algo. */
const COM_CRITICA = [...new Set(CATALOGO.flatMap((c) => c.pacotes as string[]))].filter(
  (p) => capacidadesCriticasDoPacote(CATALOGO as never, p as never).length > 0,
);

describe("ligar pacote reserva a vaga das próprias críticas", () => {
  it("existem pacotes com crítica (guarda de vacuidade)", () => {
    // Sem isto, um catálogo que perdesse o conceito de `critico` faria os casos
    // abaixo passarem por ausência de dado — verde sobre nada.
    expect(COM_CRITICA.length).toBeGreaterThan(0);
  });

  it.each(COM_CRITICA)("%s: a conta inclui as críticas, não só as automáticas", (pacote) => {
    const auto = capacidadesAutomaticasDoPacote(CATALOGO as never, pacote as never);
    const crit = capacidadesCriticasDoPacote(CATALOGO as never, pacote as never);

    const soAutomaticas = ligarPacote([], CATALOGO as never, pacote as never).length;
    const exigido = vagasExigidasPeloPacote([], CATALOGO as never, pacote as never);

    expect(soAutomaticas).toBe(auto.length);
    expect(
      exigido,
      "sem as críticas na conta, o pacote cabe 'por pouco' e a crítica dele nasce com o checkbox morto",
    ).toBe(auto.length + crit.length);
  });

  it("o que já está ligado entra na conta", () => {
    const pacote = COM_CRITICA[0]!;
    const fora = CATALOGO.find((c) => !(c.pacotes as string[]).includes(pacote))!;
    const semNada = vagasExigidasPeloPacote([], CATALOGO as never, pacote as never);
    const comUma = vagasExigidasPeloPacote([fora.name], CATALOGO as never, pacote as never);
    expect(comUma).toBe(semNada + 1);
  });

  it("capacidade do pacote já ligada não é contada duas vezes", () => {
    const pacote = COM_CRITICA[0]!;
    const jaLigada = capacidadesAutomaticasDoPacote(CATALOGO as never, pacote as never)[0]!;
    expect(vagasExigidasPeloPacote([jaLigada], CATALOGO as never, pacote as never)).toBe(
      vagasExigidasPeloPacote([], CATALOGO as never, pacote as never),
    );
  });

  it("nenhum pacote sozinho estoura o teto (senão a reserva o tornaria inatingível)", () => {
    // Se um pacote exigisse mais que o teto por si só, reservar apenas trocaria
    // "crítica morta" por "pacote que nunca liga". Medido em 2026-09-04: o maior
    // é 18 (organizar 14+4; atender é 17 = 16+1) contra teto 20. Este caso é o
    // alarme para quem acrescentar capacidade ao catálogo sem olhar o teto.
    for (const pacote of COM_CRITICA) {
      expect(
        vagasExigidasPeloPacote([], CATALOGO as never, pacote as never),
        `o pacote ${pacote} sozinho já não cabe em ${TETO_TOOLS_POR_AGENTE} — reservar não resolve, o teto é que precisa de decisão`,
      ).toBeLessThanOrEqual(TETO_TOOLS_POR_AGENTE);
    }
  });
});
