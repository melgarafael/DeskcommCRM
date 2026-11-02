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
