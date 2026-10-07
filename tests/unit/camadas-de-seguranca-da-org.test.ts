/**
 * A ESCOLHA DA ORGANIZAÇÃO VENCE O AMBIENTE — E "NÃO ESCOLHEU" NÃO É "DESLIGADO".
 *
 * ## O que estava errado
 *
 * As duas verificações que consultam um modelo (e custam por mensagem) eram
 * decididas por variável de ambiente do worker, montadas uma vez no boot: iguais
 * para todas as organizações da instalação, e alcançáveis só por quem edita o
 * `.env` da VPS e reinicia o contêiner. A tela do agente não tinha como oferecer
 * a escolha sem mentir.
 *
 * ## Por que TRÊS estados
 *
 * `null` é "esta organização não escolheu", e aí vale o ambiente. Colapsar isso
 * num booleano com default `false` desligaria as duas camadas de toda instalação
 * que as tinha ligadas, no dia do deploy, em silêncio.
 *
 * É a mesma armadilha de "ausente ≠ vazio" que a declaração do turno tomou o
 * cuidado de não cair — e a razão de a precedência ser uma função pura com teste
 * próprio: ela cabe numa linha, e é a linha que decide se a tela grava algo que o
 * motor honra.
 */
import { describe, expect, it } from "vitest";

import {
  camadaLigada,
  CAMADAS_SEMANTICAS,
  SEM_ESCOLHA,
} from "@/lib/agent-engine/guardrails/camadas-da-org";

describe("camadaLigada — a precedência entre a organização e o ambiente", () => {
  it("sem escolha, vale o ambiente — nos DOIS sentidos", () => {
    // As duas direções importam: se só a primeira valesse, aplicar a migration
    // ligaria a camada para quem a tinha desligada no `.env`; se só a segunda,
    // desligaria para quem a tinha ligada. As duas em silêncio.
    expect(camadaLigada(null, true)).toBe(true);
    expect(camadaLigada(null, false)).toBe(false);
  });

  it("a escolha da organização VENCE o ambiente — nos dois sentidos", () => {
    expect(camadaLigada(true, false)).toBe(true);
    expect(camadaLigada(false, true)).toBe(false);
  });

  it("`false` escolhido não se confunde com `null` — é o coração da regra", () => {
    // Se `?? ` virasse `||`, um `false` escolhido cairia no ambiente e a tela
    // gravaria um desligamento que o motor ignora: exatamente o defeito de
    // "controle decorativo" que este trabalho existe para não cometer.
    expect(camadaLigada(false, true)).not.toBe(camadaLigada(null, true));
  });

  it("nenhuma organização nasce escolhendo", () => {
    for (const camada of CAMADAS_SEMANTICAS) {
      expect(SEM_ESCOLHA[camada], `${camada} nasce com escolha`).toBeNull();
    }
  });

  it("o vocabulário tem as três camadas, e só elas", () => {
    // A lista é o contrato com o banco (coluna `layer`, sem CHECK de propósito) e
    // com a tela. Crescer aqui sem crescer lá dos dois lados é como a lista da
    // tela passa a divergir do que roda.
    // A terceira (`afirmacao_clinica`) entrou com o `clinical_claim` da cadeia, e a tela
    // ganhou o item no mesmo PR — os dois lados de que o comentário acima fala.
    expect([...CAMADAS_SEMANTICAS]).toEqual(["promessa_semantica", "jailbreak", "afirmacao_clinica"]);
  });
});
