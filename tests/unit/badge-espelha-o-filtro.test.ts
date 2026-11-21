import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  contagemSoNaoLidas,
  filtrosAuxiliaresDaContagem,
} from "@/app/api/v1/conversations/counts/route";
import { aplicarMarcador, predicadoDoMarcador } from "@/lib/inbox/marcador-da-conversa";

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

const CONTAGEM = "app/api/v1/conversations/counts/route.ts";
const LISTA = "app/api/v1/conversations/_handler.ts";
const REGUA = "lib/inbox/marcador-da-conversa.ts";

/** O predicado do marcador escrito à mão — o que só a régua pode escrever. */
const PREDICADO_A_MAO = /tags\.cs\.|tags_do_contato\.cs\./;

/** Comentário não filtra nada: quem decide é o código. */
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

type ConsultaFalsa = { or: (filtro: string) => ConsultaFalsa };

/** Uma consulta falsa: registra os `or=` aplicados e devolve ela mesma, como o builder do supabase-js. */
function consultaQueRegistra(): { consulta: ConsultaFalsa; ors: string[] } {
  const ors: string[] = [];
  const consulta: ConsultaFalsa = {
    or: (filtro) => {
      ors.push(filtro);
      return consulta;
    },
  };
  return { consulta, ors };
}

describe("quais filtros a contagem aplica", () => {
  it("o canal vira igualdade — ele é coluna de verdade", () => {
    expect(filtrosAuxiliaresDaContagem(sp("channel_session_id=abc"))).toContainEqual([
      "channel_session_id",
      "abc",
    ]);
  });

  it("o marcador NÃO vira igualdade numa coluna que não existe (#1223)", () => {
    // `conversations` não tem coluna `tag` — `tag` é o nome do parâmetro da URL.
    // O marcador mora em `conversations.tags` (text[], migration 0033) e no campo
    // calculado `tags_do_contato` (migration 0323), e por isso não é igualdade: é
    // um `or=` sobre as duas caixas. Enquanto ele entrava nesta lista, a contagem
    // pedia `.eq("tag", valor)`, o PostgREST devolvia 42703 (`undefined_column`) e
    // a rota INTEIRA respondia 500 — com um marcador filtrado, toda aba do Inbox
    // ficava sem número, a "Fechadas" inclusive.
    expect(filtrosAuxiliaresDaContagem(sp("tag=urgente"))).toEqual([]);
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
 * ⭐ A RÉGUA DO MARCADOR É UMA SÓ.
 *
 * A lista e a contagem respondem à MESMA pergunta ("esta conversa tem o marcador
 * X?"), então têm de perguntá-la do MESMO jeito. Duas implementações divergem — e
 * divergiram: a contagem pediu `tag`, uma coluna que não existe, e derrubou a
 * rota inteira com ela. Aqui o predicado é medido onde ele nasce
 * (`lib/inbox/marcador-da-conversa.ts`), e os dois consumidores ficam proibidos de
 * escrevê-lo à mão.
 */
describe("o marcador da contagem é o da lista — uma régua só", () => {
  it("a régua casa as DUAS caixas onde se marca", () => {
    expect(predicadoDoMarcador("urgente")).toBe(
      'tags.cs."{\\"urgente\\"}",tags_do_contato.cs."{\\"urgente\\"}"',
    );
  });

  it("marcador com `,` e `}` chega inteiro — o `or=` não vira outra árvore", () => {
    // Marcador é texto livre. Dentro de um `or=`, `,` e `)` são gramática do
    // PostgREST, e `{`/`}` desligam o literal de array: o valor tem de viajar
    // entre aspas, com as aspas internas escapadas por barra.
    expect(predicadoDoMarcador("vip,ouro}")).toBe(
      'tags.cs."{\\"vip,ouro}\\"}",tags_do_contato.cs."{\\"vip,ouro}\\"}"',
    );
  });

  it("a régua aplica o `or=` e devolve a MESMA consulta", () => {
    const { consulta, ors } = consultaQueRegistra();
    expect(aplicarMarcador(consulta, "urgente")).toBe(consulta);
    expect(ors).toEqual([predicadoDoMarcador("urgente")]);
  });

  it("sem marcador, nenhum `or=` — e a consulta volta intacta", () => {
    const { consulta, ors } = consultaQueRegistra();
    expect(aplicarMarcador(consulta, "")).toBe(consulta);
    expect(aplicarMarcador(consulta, null)).toBe(consulta);
    expect(ors).toEqual([]);
  });

  it.each([CONTAGEM, LISTA])("%s consome a régua", (caminho) => {
    // ⚠️ `aplicarMarcadores` (o PLURAL) desde #1274: quem lista e quem conta
    // precisam aplicar a MESMA função, e a plural é a que sabe o E/OU e o caso
    // de uma etiqueta só. Se a cerca aceitasse as duas, uma rota que voltasse
    // ao singular passaria aqui e perderia o E/OU — que é o filtro inteiro.
    const src = readFileSync(caminho, "utf8");
    expect(src).toContain("aplicarMarcadores(");
    expect(
      src,
      "a rota voltou ao caminho singular — o filtro de VÁRIAS etiquetas (E/OU) seria ignorado",
    ).not.toMatch(/aplicarMarcador\((?!s)/);
  });

  it.each([CONTAGEM, LISTA])("%s não escreve o predicado à mão", (caminho) => {
    expect(
      semComentarios(readFileSync(caminho, "utf8")),
      `${caminho}: predicado de marcador escrito fora da régua — a segunda régua sempre diverge`,
    ).not.toMatch(PREDICADO_A_MAO);
  });

  it("CONTROLE: a cerca enxerga o predicado que ela proíbe", () => {
    // Cerca que não morde dá sensação de guarda, e isso é pior que cerca nenhuma:
    // este caso é o que separa as duas.
    expect(semComentarios('q = q.or("tags.cs.{a},tags_do_contato.cs.{a}");')).toMatch(
      PREDICADO_A_MAO,
    );
    expect(
      semComentarios(readFileSync(REGUA, "utf8")),
      "a régua é o único lugar onde o predicado pode aparecer",
    ).toMatch(PREDICADO_A_MAO);
  });
});

/**
 * ⭐ A GUARDA QUE TORNA A SABOTAGEM POSSÍVEL.
 *
 * Os filtros são aplicados DENTRO da fábrica (`countCom()`, exposta como
 * `countExact()`/`countPlanejado()` — #4325), então toda contagem os herda
 * por construção. Isso é melhor que um teste — mas some no dia em que alguém
 * montar uma contagem por fora da fábrica, que é a única forma de o defeito
 * voltar. É isso que este caso vigia.
 */
describe("nenhuma contagem é montada por fora da fábrica", () => {
  const fonte = readFileSync("app/api/v1/conversations/counts/route.ts", "utf8");

  it("toda contagem sai da fábrica (`countExact`/`countPlanejado`)", () => {
    const dentroDoPromiseAll = fonte.slice(
      fonte.indexOf("await Promise.all(["),
      fonte.indexOf("]);", fonte.indexOf("await Promise.all([")),
    );
    expect(dentroDoPromiseAll).not.toBe("");
    const linhasDeContagem = dentroDoPromiseAll
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("supabase") || l.includes('.from("conversations")'));
    expect(
      linhasDeContagem,
      "contagem montada direto no supabase, por fora de countExact() — ela não herda nem a organização nem os filtros",
    ).toEqual([]);
  });

  it("a fábrica aplica os auxiliares E o não-lidas", () => {
    const fabrica = fonte.slice(
      fonte.indexOf("const countCom = ("),
      fonte.indexOf("await Promise.all(["),
    );
    expect(fabrica).toContain("organization_id");
    expect(fabrica, "os filtros auxiliares não entram na fábrica").toContain("auxiliares");
    expect(fabrica, "o filtro de não lidas não entra na fábrica").toContain("soNaoLidas");
  });

  it("a fábrica aplica a régua do marcador (#1223)", () => {
    // O defeito morava aqui: a fábrica pedia `.eq("tag", valor)`. Sem esta linha,
    // a contagem ignora o marcador em silêncio — e o badge passa a contar o que a
    // aba não mostra, que é o defeito que este arquivo existe para pegar.
    const fabrica = fonte.slice(
      fonte.indexOf("const countCom = ("),
      fonte.indexOf("await Promise.all(["),
    );
    expect(fabrica, "o marcador não entra na fábrica").toContain("aplicarMarcadores(");
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
