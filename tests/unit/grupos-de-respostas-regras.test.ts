/**
 * AS REGRAS DO AGRUPAMENTO (#3245) — a régua pura, sem DOM.
 *
 * `secoesDeRespostas` decide DUAS coisas que a tela e o Inbox não podem decidir
 * cada um do seu jeito: (1) se há agrupamento (sem grupo, `null` = lista plana
 * de hoje) e (2) em que ordem as seções aparecem. `filtrarRespostas` decide a
 * terceira: a busca do atendente ATRAVESSA os grupos.
 *
 * Os casos de borda são os que a tela não tem como provar sozinha: grupo que a
 * lista não conhece (vínculo velho), empate de `ordem` (dois grupos criados no
 * mesmo instante) e busca vazia (o menu abre mostrando tudo, como antes).
 */
import { describe, expect, it } from "vitest";

import { filtrarRespostas } from "@/components/inbox/composer/TemplateMenu";
import { grupoDaResposta, secoesDeRespostas } from "@/lib/templates/grupos";

const GRUPOS = [
  { id: "g2", name: "Objeção", ordem: 2000 },
  { id: "g1", name: "Abordagem", ordem: 1000 },
  { id: "g3", name: "Fechamento", ordem: 3000 },
];

const RESPOSTAS = [
  { id: "r1", title: "Prazo de entrega", body: "Chega em 5 dias.", shortcut: "prazo", grupo_id: "g1", owner_user_id: null },
  { id: "r2", title: "Desconto", body: "Consigo 10%.", shortcut: null, grupo_id: "g3", owner_user_id: null },
  { id: "r3", title: "Sem grupo, de sempre", body: "Oi!", shortcut: null, grupo_id: null, owner_user_id: null },
  { id: "r4", title: "Preço", body: "O valor é X.", shortcut: "preco", grupo_id: "g2", owner_user_id: null },
  { id: "r5", title: "Vínculo velho", body: "Grupo apagado.", shortcut: null, grupo_id: "g-nao-existe", owner_user_id: null },
] as const;

describe("#3245 — secoesDeRespostas", () => {
  it("sem grupo nenhum devolve `null` — a instrução de desenhar a lista de hoje", () => {
    expect(secoesDeRespostas(RESPOSTAS, [])).toBeNull();
    expect(secoesDeRespostas(RESPOSTAS, null)).toBeNull();
    expect(secoesDeRespostas(RESPOSTAS, undefined)).toBeNull();
  });

  it("as seções seguem a `ordem` do grupo, não a ordem de chegada da lista", () => {
    const secoes = secoesDeRespostas(RESPOSTAS, GRUPOS)!;
    expect(secoes.map((secao) => secao.grupo?.id ?? null)).toEqual(["g1", "g2", "g3", null]);
  });

  it("a ordem DAS RESPOSTAS dentro da seção é a que veio do servidor", () => {
    const respostas = [
      { id: "a", grupo_id: "g1" },
      { id: "b", grupo_id: "g1" },
      { id: "c", grupo_id: "g1" },
    ];
    const [secao] = secoesDeRespostas(respostas, [{ id: "g1", name: "Abordagem", ordem: 0 }])!;
    expect(secao!.respostas.map((resposta) => resposta.id)).toEqual(["a", "b", "c"]);
  });

  it("'Sem grupo' é a ÚLTIMA seção, e só existe quando há resposta sem grupo", () => {
    const comSemGrupo = secoesDeRespostas(RESPOSTAS, GRUPOS)!;
    expect(comSemGrupo.at(-1)!.grupo).toBeNull();
    expect(comSemGrupo.at(-1)!.respostas.map((resposta) => resposta.id)).toEqual(["r3", "r5"]);

    const todasComGrupo = RESPOSTAS.filter((resposta) => resposta.grupo_id && resposta.grupo_id !== "g-nao-existe");
    const secoes = secoesDeRespostas(todasComGrupo, GRUPOS)!;
    expect(secoes.some((secao) => secao.grupo === null)).toBe(false);
  });

  it("grupo VAZIO aparece (é onde a primeira resposta vai ser solta)", () => {
    const secoes = secoesDeRespostas([], GRUPOS)!;
    expect(secoes).toHaveLength(3);
    expect(secoes.every((secao) => secao.respostas.length === 0)).toBe(true);
    // Sem resposta nenhuma não há seção "Sem grupo" vazia.
    expect(secoes.some((secao) => secao.grupo === null)).toBe(false);
  });

  it("vínculo com grupo que a lista não conhece cai em 'Sem grupo' — a resposta não some", () => {
    const secoes = secoesDeRespostas(RESPOSTAS, GRUPOS)!;
    const semGrupo = secoes.at(-1)!;
    expect(semGrupo.respostas.map((resposta) => resposta.id)).toContain("r5");
  });

  it("empate de `ordem` desempata pelo nome (a lista não troca entre duas aberturas)", () => {
    const empatados = [
      { id: "gb", name: "B", ordem: 1000 },
      { id: "ga", name: "A", ordem: 1000 },
    ];
    expect(secoesDeRespostas([], empatados)!.map((secao) => secao.grupo!.id)).toEqual(["ga", "gb"]);
  });

  it("`grupoDaResposta` devolve o grupo só quando ele está na lista", () => {
    expect(grupoDaResposta({ id: "x", grupo_id: "g2" }, GRUPOS)!.name).toBe("Objeção");
    expect(grupoDaResposta({ id: "x", grupo_id: "g-nao-existe" }, GRUPOS)).toBeNull();
    expect(grupoDaResposta({ id: "x", grupo_id: null }, GRUPOS)).toBeNull();
    expect(grupoDaResposta({ id: "x" }, GRUPOS)).toBeNull();
  });
});

describe("#3245 — a busca do atendente ATRAVESSA os grupos", () => {
  it("quem digita 'prazo' acha a resposta do grupo Abordagem — sem lembrar do grupo", () => {
    expect(filtrarRespostas(RESPOSTAS, "prazo", GRUPOS).map((r) => r.id)).toEqual(["r1"]);
  });

  it("acha por resposta em grupos DIFERENTES na mesma consulta", () => {
    // 'e' aparece no título/atalho de respostas de três grupos distintos: o
    // filtro não abre escopo por seção.
    const achados = filtrarRespostas(RESPOSTAS, "e", GRUPOS).map((r) => r.id);
    expect(achados).toContain("r1");
    expect(achados).toContain("r4");
  });

  it("acha pelo NOME do grupo: quem lembra da etapa e não do título", () => {
    expect(filtrarRespostas(RESPOSTAS, "objeção", GRUPOS).map((r) => r.id)).toEqual(["r4"]);
  });

  it("resposta SEM grupo continua achável pelo título e pelo atalho", () => {
    expect(filtrarRespostas(RESPOSTAS, "sempre", GRUPOS).map((r) => r.id)).toEqual(["r3"]);
    expect(filtrarRespostas(RESPOSTAS, "preco", GRUPOS).map((r) => r.id)).toEqual(["r4"]);
  });

  it("consulta vazia devolve a lista inteira, na ordem — o menu abre como antes", () => {
    expect(filtrarRespostas(RESPOSTAS, "", GRUPOS).map((r) => r.id)).toEqual([
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
    ]);
  });

  it("sem grupo cadastrado a busca é a de sempre (título/atalho) e não quebra", () => {
    expect(filtrarRespostas(RESPOSTAS, "prazo", []).map((r) => r.id)).toEqual(["r1"]);
    expect(filtrarRespostas([], "prazo", GRUPOS)).toEqual([]);
  });
});

/**
 * A BUSCA DAS RESPOSTAS RÁPIDAS IGNORA ACENTO (#4070) — nos três campos, nos
 * dois sentidos.
 *
 * ─── O defeito, medido na tela ──────────────────────────────────────────────
 *
 * Quem digitava `/orcamento` não achava a resposta "Orçamento": o filtro fazia
 * `title.toLowerCase().includes(q)`, e `'orçamento'.includes('orcamento')` é
 * falso — acento é OUTRA letra para `includes`, e `toLowerCase` só resolve
 * caixa. O atendente digitando rápido concluía que a resposta não existia.
 *
 * ─── O que este bloco prende, além dos dois sentidos ────────────────────────
 *
 * - o ATALHO (`shortcut`, o `/preco` de sempre) e o NOME DO GRUPO também são
 *   comparados sem acento, porque é por eles que boa parte das pessoas busca;
 * - o TÍTULO EXIBIDO continua o do cadastro, com acento — a correção é na
 *   comparação, nunca no texto que a tela mostra;
 * - consulta vazia devolve a lista inteira na ordem, termo que não casa devolve
 *   vazio, e o filtro não reordena nem fatia.
 *
 * A regra é a do repo — `termoSemAcento` (`lib/inbox/termo-de-busca.ts`), a
 * mesma dos outros dois pontos da família (#4071 e #4072) e a que o banco
 * espelha em `f_unaccent` — e não um `normalize("NFD")` novo neste arquivo.
 */
describe("#4070 — a busca das respostas rápidas ignora acento", () => {
  const COM_ACENTO = [
    // a1 tem o ACENTO só no TÍTULO (sem atalho): é o caso que a issue relata.
    { id: "a1", title: "Orçamento", body: "Segue o orçamento.", shortcut: null, grupo_id: "g-obj", owner_user_id: null },
    { id: "a2", title: "Orcamento simples", body: "Versão sem acento.", shortcut: null, grupo_id: null, owner_user_id: null },
    { id: "a3", title: "Prazo", body: "Chega em 5 dias.", shortcut: "prazo", grupo_id: "g-prazo", owner_user_id: null },
  ] as const;

  const GRUPOS_ACENTO = [
    { id: "g-obj", name: "Objeção", ordem: 1000 },
    { id: "g-prazo", name: "Fechamento", ordem: 2000 },
  ];

  const ids = (query: string) => filtrarRespostas(COM_ACENTO, query, GRUPOS_ACENTO).map((r) => r.id);

  it("⭐ '/orcamento' acha a resposta 'Orçamento' — e o título exibido mantém o acento", () => {
    const achados = filtrarRespostas(COM_ACENTO, "orcamento", GRUPOS_ACENTO);

    // No RED, só a2 (título sem acento) aparecia: o título "Orçamento" da a1
    // não casa com `orcamento` por `includes`. Aqui o que importa é que a1 está
    // lá — e que o texto que a tela mostra continua sendo o do cadastro.
    expect(achados.map((r) => r.id)).toContain("a1");
    expect(achados.find((r) => r.id === "a1")!.title).toBe("Orçamento");
  });

  it("⭐ 'Orçamento' (com acento digitado) acha a resposta cadastrada SEM acento", () => {
    expect(ids("Orçamento")).toEqual(["a1", "a2"]);
    // E a grafia do cadastro não foi tocada: a2 continua sem acento na tela.
    expect(filtrarRespostas(COM_ACENTO, "Orçamento", GRUPOS_ACENTO)[1]!.title).toBe("Orcamento simples");
  });

  it("caixa e acento somados: '/orcamento', '/Orçamento' e '/ORCAMENTO' caem no mesmo lugar", () => {
    const esperado = ids("orcamento");
    for (const grafia of ["orcamento", "Orçamento", "ORCAMENTO", "ORÇAMENTO"]) {
      expect(ids(grafia), `"${grafia}" não achou as mesmas respostas`).toEqual(esperado);
    }
  });

  it("o ATALHO também casa sem acento — '/orçamento' acha a resposta de atalho 'orcamento'", () => {
    // Recorte só com o atalho: sem ele, este caso passaria pelo título e não
    // provaria nada sobre o `shortcut`.
    const soAtalho = [
      { id: "s1", title: "Mensagem comercial", body: "…", shortcut: "orcamento", grupo_id: null, owner_user_id: null },
    ] as const;
    expect(filtrarRespostas(soAtalho, "orçamento", []).map((r) => r.id)).toEqual(["s1"]);
    expect(filtrarRespostas(soAtalho, "ORCAMENTO", []).map((r) => r.id)).toEqual(["s1"]);
    // E o `/` que a pessoa digita não atrapalha: quem resolve a barra é o
    // `resolveSlash`, que entrega a consulta sem ela.
    expect(filtrarRespostas(soAtalho, "orcamento", []).map((r) => r.id)).toEqual(["s1"]);
  });

  it("o NOME DO GRUPO também casa sem acento — 'objecao' acha o grupo 'Objeção'", () => {
    const soGrupo = [
      { id: "g1-item", title: "Texto qualquer", body: "…", shortcut: null, grupo_id: "g-obj", owner_user_id: null },
    ] as const;
    expect(filtrarRespostas(soGrupo, "objecao", GRUPOS_ACENTO).map((r) => r.id)).toEqual(["g1-item"]);
    expect(filtrarRespostas(soGrupo, "OBJEÇÃO", GRUPOS_ACENTO).map((r) => r.id)).toEqual(["g1-item"]);
  });

  it("consulta VAZIA devolve a lista inteira, na ordem — o menu abre como antes", () => {
    expect(ids("")).toEqual(["a1", "a2", "a3"]);
    expect(ids("   ")).toEqual(["a1", "a2", "a3"]);
  });

  it("termo que não casa continua devolvendo VAZIO — a busca não virou 'mostra tudo'", () => {
    expect(ids("zzz")).toEqual([]);
    expect(ids("orcamentozzz")).toEqual([]);
  });

  it("a ORDEM é a da lista que chegou, não a do acerto", () => {
    // "a" casa a1 e a3 (títulos) e não casa a2 ("Orcamento simples" também tem
    // 'a'…). O que se prova: a saída segue COM_ACENTO, sem reordenar.
    expect(ids("prazo")).toEqual(["a3"]);
    expect(ids("o")).toEqual(["a1", "a2", "a3"]);
  });
});
