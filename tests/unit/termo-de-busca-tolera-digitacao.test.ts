import { describe, expect, it } from "vitest";

import {
  PISO_DA_BUSCA,
  buscaValeConsulta,
  normalizarTermoDeBusca,
} from "@/lib/inbox/termo-de-busca";

/**
 * Medido na tela de uma instalação real, com o contato "Paulo Lima Jr" no banco:
 *
 *   "Paulo  Lima" (espaço duplo)          → 0 resultados
 *   "Paulo Jr"    (palavras não adjacentes) → 0 resultados
 *   "Paulo, Jr"   (as MESMAS, com vírgula)  → 1  ← funciona por ACIDENTE
 *
 * A terceira acha porque o saneamento troca a vírgula por `*`, e o PostgREST
 * converte `*` em `%`. Ou seja: pontuar o nome faz a busca funcionar melhor — um
 * recurso real, poderoso e invisível, que ninguém descobre sozinho.
 */
describe("o termo de busca tolera como gente digita", () => {
  it("espaço simples vira curinga", () => {
    expect(normalizarTermoDeBusca("Paulo Jr")).toBe("Paulo*Jr");
  });

  it("espaço DUPLO não vira dois curingas nem quebra", () => {
    expect(normalizarTermoDeBusca("Paulo  Lima")).toBe("Paulo*Lima");
  });

  it("vírgula e espaço juntos colapsam num curinga só", () => {
    expect(normalizarTermoDeBusca("Paulo, Jr")).toBe("Paulo*Jr");
  });

  it("as três formas produzem O MESMO termo, E ele é o curinga", () => {
    const a = normalizarTermoDeBusca("Paulo Jr");
    expect(normalizarTermoDeBusca("Paulo  Jr")).toBe(a);
    expect(normalizarTermoDeBusca("Paulo, Jr")).toBe(a);
    expect(normalizarTermoDeBusca("Paulo;Jr")).toBe(a);
    // A segunda metade não é zelo: MEDIDA numa sabotagem. Trocando `join("*")`
    // por `join(" ")`, as três continuam iguais entre si — e este caso passava
    // verde enquanto o recurso estava destruído. Concordar não basta: elas têm de
    // concordar NO CURINGA, que é o que faz a busca achar.
    expect(a).toContain("*");
  });

  it("CONTROLE: o termo continua FILTRANDO — não vira curinga universal", () => {
    // Sem este par, "troque tudo por *" passaria em todos os casos acima.
    const s = normalizarTermoDeBusca("Paulo, Jr");
    expect(s).toContain("Paulo");
    expect(s).toContain("Jr");
    expect(s.replace(/\*/g, "").trim()).not.toBe("");
  });

  it("CONTROLE: uma palavra só não ganha curinga nenhum", () => {
    expect(normalizarTermoDeBusca("Paulo")).toBe("Paulo");
  });

  it("bordas são aparadas, não viram curinga", () => {
    expect(normalizarTermoDeBusca("  Paulo Jr  ")).toBe("Paulo*Jr");
  });
});

/**
 * ⛔ O caso que a normalização CRIA, e que o teste da função pura não pegaria.
 *
 * Colapsar separadores faz um termo feito só de pontuação virar string VAZIA — e
 * string vazia no `ilike` vira `%%`, que casa TUDO. Seria a lista inteira de volta:
 * exatamente o defeito que o piso de caracteres acabou de consertar, reintroduzido
 * por outra porta.
 *
 * O piso sozinho não pega: `", ,"` tem 3 caracteres e passa por ele.
 *
 * Por isso quem decide se a busca vale consulta é `buscaValeConsulta`, medindo o
 * termo DEPOIS de normalizado — e é ela que o schema e a tela consultam, para os
 * dois não divergirem.
 */
describe("termo que não sobra nada depois de normalizado não vale consulta", () => {
  it("só pontuação NÃO vale consulta, mesmo passando do piso em caracteres", () => {
    expect(", ,".length).toBeGreaterThan(PISO_DA_BUSCA);
    expect(normalizarTermoDeBusca(", ,")).toBe("");
    expect(buscaValeConsulta(", ,")).toBe(false);
  });

  it("só espaço não vale consulta", () => {
    expect(buscaValeConsulta("     ")).toBe(false);
  });

  it("abaixo do piso não vale consulta", () => {
    expect(buscaValeConsulta("a")).toBe(false);
  });

  it("CONTROLE: termo de verdade VALE consulta", () => {
    // Sem este caso, uma implementação que recusasse tudo passaria nos de cima.
    expect(buscaValeConsulta("Paulo Jr")).toBe(true);
    expect(buscaValeConsulta("ab")).toBe(true);
  });

  it("CONTROLE: telefone com pontuação continua valendo", () => {
    // A busca por telefone é o caminho que esta instalação mediu como o mais
    // certeiro. Ele não pode ser vítima da normalização.
    expect(buscaValeConsulta("(15) 99259-4261")).toBe(true);
    expect(buscaValeConsulta("+55 15 99259-4261")).toBe(true);
  });
});

/**
 * O parêntese (#1895): a lista inteira de volta pela porta do `termoSeguroParaOr`.
 *
 * Medido na instalação real (vira `%` no PostgREST): `buscaValeConsulta("()")`
 * passava no piso — `normalizarTermoDeBusca` não colapsa `()`, então o termo vira
 * 2 caracteres; `termoSeguroParaOr` troca `()` por `**`; e o `or=` vira `%%%%`,
 * que casa TUDO. `"(a"` vira `%a%`, igualmente amplíssimo.
 *
 * A régua agora tira os parênteses ANTES de medir o piso — dentro de
 * `buscaValeConsulta`. Se alguém remover o `replace`, estes dois casos ficam
 * VERMELHOS (a sabotagem da #1895 prevê exatamente isso).
 */
describe("termo de busca não devolve a lista inteira pelo parêntese (#1895)", () => {
  it("'()' NÃO vale consulta", () => {
    expect(buscaValeConsulta("()")).toBe(false);
  });

  it("parêntese aberto não vale consulta", () => {
    expect(buscaValeConsulta("((")).toBe(false);
    expect(buscaValeConsulta("(a")).toBe(false);
  });

  it("CONTROLE: parêntese com conteúdo real continua valendo", () => {
    // Sem estes, uma implementação que recusasse qualquer parêntese passaria.
    expect(buscaValeConsulta("paulo (jr)")).toBe(true);
    expect(buscaValeConsulta("(15) 99259")).toBe(true);
  });
});

/**
 * O asterisco (#1935): a lista inteira de volta por quem digita curinga.
 *
 * Medido na main: `buscaValeConsulta("**") === true` porque `normalizarTermoDeBusca`
 * não colapsa `*` (não é separador), então `"**"` vira 2 caracteres e passa o piso;
 * `termoSeguroParaOr` NÃO escapa `*`, e no `or=` do PostgREST `*` vira `%` — `**`
 * casa quase tudo. É o mesmo defeito do parêntese, pela porta do usuário que digita
 * `*` pensando em curinga.
 *
 * A régua tira o `*` ANTES de medir o piso, junto do parêntese. Se alguém remover
 * o `*` do `replace`, estes casos ficam VERMELHOS (a sabotagem da #1935 prevê isso).
 */
describe("termo de busca não devolve a lista inteira pelo asterisco (#1935)", () => {
  it("'**' NÃO vale consulta", () => {
    expect(buscaValeConsulta("**")).toBe(false);
  });

  it("asterisco com conteúdo mínimo por baixo não vale", () => {
    expect(buscaValeConsulta("s*")).toBe(false);
    expect(buscaValeConsulta("*")).toBe(false);
  });

  it("CONTROLE: nome com conteúdo real continua valendo", () => {
    // Sem estes, uma implementação que recusasse qualquer termo passaria.
    expect(buscaValeConsulta("sabrina")).toBe(true);
    expect(buscaValeConsulta("paulo jr")).toBe(true);
  });
});
