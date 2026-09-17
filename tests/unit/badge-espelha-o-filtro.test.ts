import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  contagemSoNaoLidas,
  filtrosAuxiliaresDaContagem,
} from "@/app/api/v1/conversations/counts/route";

/**
 * O BADGE CONTA O MESMO QUE A LISTA MOSTRA.
 *
 * Medido na tela de uma instalação real: com "Não lidos" ligado, a lista mostrava
 * ZERO linhas e a aba continuava estampando "Todas 2".
 *
 * A regra já estava escrita dentro da própria rota — "um badge que conta o que a
 * aba não mostra manda o atendente procurar trabalho que não existe". A regra
 * estava certa; a COBERTURA parou no predicado da aba e nunca alcançou os filtros
 * ao lado dela.
 */
const sp = (s: string) => new URLSearchParams(s);

describe("quais filtros a contagem aplica", () => {
  it("tag e canal viram predicado", () => {
    expect(filtrosAuxiliaresDaContagem(sp("tag=urgente"))).toContainEqual(["tag", "urgente"]);
    expect(filtrosAuxiliaresDaContagem(sp("channel_session_id=abc"))).toContainEqual([
      "channel_session_id",
      "abc",
    ]);
  });

  it("não lidos é lido à parte, porque não é igualdade e sim `> 0`", () => {
    expect(contagemSoNaoLidas(sp("unread=true"))).toBe(true);
    expect(contagemSoNaoLidas(sp(""))).toBe(false);
  });

  it("CONTROLE: sem filtro na URL, nenhum predicado extra", () => {
    // Sem este caso, uma implementação que devolvesse sempre um filtro passaria
    // nos de cima — e a contagem passaria a mentir para baixo, em vez de para cima.
    expect(filtrosAuxiliaresDaContagem(sp(""))).toEqual([]);
    expect(filtrosAuxiliaresDaContagem(sp("tag="))).toEqual([]);
  });

  it("a busca NÃO entra, e isso é decisão declarada", () => {
    // `search` casa contato por uma consulta auxiliar em `contacts`. Repetir
    // aquela lógica aqui criaria uma SEGUNDA régua de busca, e a segunda régua
    // sempre diverge. O badge sob busca fica maior que a lista — declarado.
    expect(filtrosAuxiliaresDaContagem(sp("search=paulo"))).toEqual([]);
  });
});

/**
 * ⭐ A GUARDA QUE TORNA A SABOTAGEM POSSÍVEL.
 *
 * Os filtros são aplicados DENTRO de `countExact()`, então toda contagem os herda
 * por construção. Isso é melhor que um teste — mas some no dia em que alguém
 * montar uma contagem por fora da fábrica, que é a única forma de o defeito
 * voltar. É isso que este caso vigia.
 */
describe("nenhuma contagem é montada por fora da fábrica", () => {
  const fonte = readFileSync("app/api/v1/conversations/counts/route.ts", "utf8");

  it("toda contagem sai de `countExact()`", () => {
    const dentroDoPromiseAll = fonte.slice(
      fonte.indexOf("await Promise.all(["),
      fonte.indexOf("]);", fonte.indexOf("await Promise.all([")),
    );
    expect(dentroDoPromiseAll).not.toBe("");
    const linhasDeContagem = dentroDoPromiseAll
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("supabase") || l.includes(".from(\"conversations\")"));
    expect(
      linhasDeContagem,
      "contagem montada direto no supabase, por fora de countExact() — ela não herda nem a organização nem os filtros",
    ).toEqual([]);
  });

  it("a fábrica aplica os auxiliares E o não-lidas", () => {
    const fabrica = fonte.slice(
      fonte.indexOf("const countExact = () =>"),
      fonte.indexOf("await Promise.all(["),
    );
    expect(fabrica).toContain("organization_id");
    expect(fabrica, "os filtros auxiliares não entram na fábrica").toContain("auxiliares");
    expect(fabrica, "o filtro de não lidas não entra na fábrica").toContain("soNaoLidas");
  });

  it("a aba Fechadas TEM contagem — o concorrente mostra 8067 e nós mostrávamos nada", () => {
    expect(fonte).toContain("closed: closed.count");
  });

  it("o comentário não cita arquivo de teste que não existe", () => {
    // A linha 69 citava `tests/unit/badge-espelha-a-aba.test.ts`, que NUNCA existiu
    // — medido com `find` e com `git log`. Citação falsa dentro do código é pior
    // que comentário nenhum: quem confia nela não procura o gate de verdade.
    expect(fonte).not.toContain("badge-espelha-a-aba");
  });
});
