import { describe, it, expect } from "vitest";
import { evaluateConditions, resolveField } from "@/lib/automation/conditions";

const ctx = {
  event: { to_stage_id: "s2", added_tags: ["vip", "novo"] },
  lead: { title: "Ana", custom_fields: { utm_source: "instagram" }, value_cents: 5000 },
};

describe("resolveField", () => {
  it("path aninhado", () => expect(resolveField(ctx, "lead.custom_fields.utm_source")).toBe("instagram"));
  it("path ausente → undefined", () => expect(resolveField(ctx, "lead.nope.x")).toBeUndefined());
});

describe("evaluateConditions", () => {
  it("lista vazia → true (regra sem condição dispara sempre)", () =>
    expect(evaluateConditions([], ctx)).toBe(true));
  it("eq string", () =>
    expect(evaluateConditions([{ field: "event.to_stage_id", op: "eq", value: "s2" }], ctx)).toBe(true));
  it("eq com coerção numérica (valor sempre chega como string da UI)", () =>
    expect(evaluateConditions([{ field: "lead.value_cents", op: "eq", value: "5000" }], ctx)).toBe(true));
  it("neq", () =>
    expect(evaluateConditions([{ field: "event.to_stage_id", op: "neq", value: "s1" }], ctx)).toBe(true));
  it("contains em array", () =>
    expect(evaluateConditions([{ field: "event.added_tags", op: "contains", value: "vip" }], ctx)).toBe(true));
  it("contains em string (case-insensitive)", () =>
    expect(evaluateConditions([{ field: "lead.custom_fields.utm_source", op: "contains", value: "INSTA" }], ctx)).toBe(true));

  /**
   * #956: em lista, `contains` exigia a tag IDÊNTICA, com caixa. Quem escreve a
   * regra digita "Google"; a tag guardada é `google` (o editor de tags do
   * contato no Inbox grava em minúsculas) ou `google ads`. O rótulo na tela é
   * "contém" — e em texto ele já era "contém" sem caixa.
   */
  const comTags = (tags: string[]) => ({ event: { added_tags: tags } });
  it("contém em lista: casa a tag de caixa diferente", () =>
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: "Google" }], comTags(["google"])),
    ).toBe(true));
  // Os dois casos abaixo eram POSITIVOS na primeira versão do #957 ("pedaço da
  // tag"). O dono escolheu pertinência: a regra que o operador escreveu para
  // `Google` não passa a alcançar quem tem `Google Ads`. São o controle que
  // separa a decisão (B) da (A) — sem eles, "casa a caixa diferente" sozinho é
  // satisfeito pelas duas.
  it("contém em lista: NÃO casa pedaço de tag", () =>
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: "Google" }], comTags(["Google Ads"])),
    ).toBe(false));
  it("contém em lista: NÃO casa o texto no meio da tag", () =>
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: "google" }], comTags(["tráfego google"])),
    ).toBe(false));
  it("contém em lista: NÃO casa prefixo de outra tag", () =>
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: "vip" }], comTags(["vip ouro"])),
    ).toBe(false));
  it("contém em TEXTO continua sendo contém", () =>
    expect(
      evaluateConditions(
        [{ field: "event.event_type_name", op: "contains", value: "manutenção" }],
        { event: { event_type_name: "Manutenção preventiva" } },
      ),
    ).toBe(true));
  it("contém em lista: NÃO casa tag sem relação", () =>
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: "Google" }], comTags(["indicação", "vip"])),
    ).toBe(false));
  it("E entre múltiplas: uma falsa derruba", () =>
    expect(
      evaluateConditions(
        [
          { field: "event.to_stage_id", op: "eq", value: "s2" },
          { field: "lead.title", op: "eq", value: "Bia" },
        ],
        ctx,
      ),
    ).toBe(false));
  it("campo ausente → condição falsa, não erro", () =>
    expect(evaluateConditions([{ field: "lead.ghost", op: "eq", value: "x" }], ctx)).toBe(false));
  /**
   * #2727 — MUDANÇA DELIBERADA. Antes: `neq` em campo AUSENTE devolvia `true`
   * ("ausente ≠ valor"), e era o defeito medido na issue: "crianças ≠ 0"
   * disparava para quem nem preencheu o campo. Agora `neq` exige valor presente
   * — quem quer "não preenchido" escreve `is_empty`. Ver o bloco de semântica
   * de campo ausente abaixo.
   */
  it("campo ausente com neq → false (neq exige valor presente)", () =>
    expect(evaluateConditions([{ field: "lead.ghost", op: "neq", value: "x" }], ctx)).toBe(false));
});

/**
 * #2727 — a tabela de verdade dos operadores NOVOS e a semântica de campo
 * AUSENTE. Cada operador é medido nos três estados: valor presente, valor
 * vazio (string `""` / lista `[]`) e campo que NÃO existe.
 */
describe("operadores novos (#2727)", () => {
  const contexto = {
    lead: {
      nome: "Ana",
      obs: "",
      tags: ["vip"],
      vazias: [] as string[],
      idade: 30,
      nascimento: "1996-03-10",
      valor_cents: 5000,
      ativo: false,
    },
    contato: {},
  };

  const com = (cond: Parameters<typeof evaluateConditions>[0]) => evaluateConditions(cond, contexto);

  it("not_contains em texto é o inverso de contains", () => {
    expect(com([{ field: "lead.nome", op: "not_contains", value: "Bia" }])).toBe(true);
    expect(com([{ field: "lead.nome", op: "not_contains", value: "AN" }])).toBe(false);
  });

  it("not_contains em lista é a NÃO pertinência (mesma regra de item do contains)", () => {
    expect(com([{ field: "lead.tags", op: "not_contains", value: "vip" }])).toBe(false);
    expect(com([{ field: "lead.tags", op: "not_contains", value: "vip ouro" }])).toBe(true);
  });

  it("is_empty: verdadeiro em campo ausente, string vazia e lista vazia", () => {
    expect(com([{ field: "lead.ghost", op: "is_empty", value: "" }])).toBe(true);
    expect(com([{ field: "lead.obs", op: "is_empty", value: "" }])).toBe(true);
    expect(com([{ field: "lead.vazias", op: "is_empty", value: "" }])).toBe(true);
  });

  it("is_empty: FALSO em valor presente — inclusive 0 e false (não são vazios)", () => {
    expect(com([{ field: "lead.nome", op: "is_empty", value: "" }])).toBe(false);
    expect(com([{ field: "lead.valor_cents", op: "is_empty", value: "" }])).toBe(false);
    expect(com([{ field: "lead.ativo", op: "is_empty", value: "" }])).toBe(false);
  });

  it("is_not_empty é o espelho exato de is_empty", () => {
    expect(com([{ field: "lead.ghost", op: "is_not_empty", value: "" }])).toBe(false);
    expect(com([{ field: "lead.obs", op: "is_not_empty", value: "" }])).toBe(false);
    expect(com([{ field: "lead.nome", op: "is_not_empty", value: "" }])).toBe(true);
    expect(com([{ field: "lead.valor_cents", op: "is_not_empty", value: "" }])).toBe(true);
  });

  it("comparadores de número: gt/gte/lt/lte", () => {
    expect(com([{ field: "lead.idade", op: "gt", value: "18" }])).toBe(true);
    expect(com([{ field: "lead.idade", op: "gt", value: "30" }])).toBe(false);
    expect(com([{ field: "lead.idade", op: "gte", value: "30" }])).toBe(true);
    expect(com([{ field: "lead.idade", op: "lt", value: "40" }])).toBe(true);
    expect(com([{ field: "lead.idade", op: "lte", value: "30" }])).toBe(true);
  });

  it("comparadores de data ISO-8601 ordenam como texto", () => {
    expect(com([{ field: "lead.nascimento", op: "gte", value: "1996-01-01" }])).toBe(true);
    expect(com([{ field: "lead.nascimento", op: "lt", value: "1996-01-01" }])).toBe(false);
    expect(com([{ field: "lead.nascimento", op: "lte", value: "1996-03-10" }])).toBe(true);
  });

  it("campo AUSENTE deixa FALSO todo operador que compara valor", () => {
    const operadores = ["eq", "neq", "contains", "not_contains", "gt", "gte", "lt", "lte"] as const;
    for (const op of operadores) {
      expect(com([{ field: "lead.ghost", op, value: "x" }]), op).toBe(false);
    }
  });

  it("campo AUSENTE é decidido SÓ por is_empty/is_not_empty", () => {
    expect(com([{ field: "lead.ghost", op: "is_empty", value: "" }])).toBe(true);
    expect(com([{ field: "lead.ghost", op: "is_not_empty", value: "" }])).toBe(false);
  });
});

/**
 * #2727 — os GRUPOS `{all}` / `{any}` e a compatibilidade: a LISTA SIMPLES
 * (formato guardado antes desta mudança) tem de continuar avaliando IGUAL,
 * valendo como `all`.
 */
describe("grupos all/any e compatibilidade (#2727)", () => {
  const ctx = { a: 1, b: 2, c: 3, va: "10", vb: "5" };

  it("REG RESSÃO: lista simples ≡ {all:[…]} — mesma verdade, caso a caso", () => {
    const regraAntiga = [
      { field: "a", op: "eq" as const, value: "1" },
      { field: "c", op: "gt" as const, value: "2" },
    ];
    const comoGrupo = { all: regraAntiga };
    for (const cenario of [ctx, { a: 1, b: 2, c: 0 }, { a: 9, b: 2, c: 3 }]) {
      expect(evaluateConditions(regraAntiga, cenario)).toBe(
        evaluateConditions(comoGrupo, cenario),
      );
    }
    expect(evaluateConditions(regraAntiga, ctx)).toBe(true);
  });

  it("any: verdadeiro quando ALGUM filho casa", () => {
    expect(
      evaluateConditions(
        { any: [
          { field: "a", op: "eq", value: "999" },
          { field: "b", op: "eq", value: "2" },
        ] },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        { any: [
          { field: "a", op: "eq", value: "999" },
          { field: "b", op: "eq", value: "888" },
        ] },
        ctx,
      ),
    ).toBe(false);
  });

  it("all: falso quando algum filho falha", () => {
    expect(
      evaluateConditions(
        { all: [
          { field: "a", op: "eq", value: "1" },
          { field: "b", op: "eq", value: "999" },
        ] },
        ctx,
      ),
    ).toBe(false);
  });

  it("aninhado: any dentro de all, e vice-versa", () => {
    const aninhado = {
      all: [
        { field: "a", op: "eq" as const, value: "1" },
        {
          any: [
            { field: "b", op: "eq" as const, value: "2" },
            { field: "c", op: "eq" as const, value: "999" },
          ],
        },
      ],
    };
    expect(evaluateConditions(aninhado, ctx)).toBe(true);
    expect(evaluateConditions(aninhado, { a: 1, b: 0, c: 0 })).toBe(false);

    const outro = {
      any: [
        { field: "a", op: "eq" as const, value: "999" },
        { all: [{ field: "b", op: "eq" as const, value: "2" }, { field: "c", op: "eq" as const, value: "3" }] },
      ],
    };
    expect(evaluateConditions(outro, ctx)).toBe(true);
    expect(evaluateConditions(outro, { a: 0, b: 2, c: 0 })).toBe(false);
  });

  it("grupo vazio: all → true (vacuidade), any → false", () => {
    expect(evaluateConditions({ all: [] }, ctx)).toBe(true);
    expect(evaluateConditions({ any: [] }, ctx)).toBe(false);
  });
});
