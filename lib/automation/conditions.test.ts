import { describe, it, expect } from "vitest";
import {
  OPERADORES_SEM_VALOR,
  contarCondicoes,
  evaluateConditions,
  resolveField,
} from "@/lib/automation/conditions";

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
   * de campo ausente logo abaixo.
   *
   * A expectativa antiga (`→ true`) veio da main e é a ÚNICA contradição entre
   * os dois lados deste merge: ela foi substituída por esta, não removida para
   * o conflito sumir — está declarada no PR.
   */
  it("campo ausente com neq → false (neq exige valor presente)", () =>
    expect(evaluateConditions([{ field: "lead.ghost", op: "neq", value: "x" }], ctx)).toBe(false));

  /**
   * #2973: a comparação sem caixa já existia; sem ACENTO e sem PONTUAÇÃO não.
   * O lead escreve a mesma frase com um acento a mais ou a menos e a regra não
   * dispara — sem erro e sem aviso —, e o operador passa a ler a automação como
   * aleatória. Os casos abaixo prendem a forma NOVA nos dois lados (o valor da
   * condição e o texto recebido); os controles fecham a porta para "afrouxou
   * demais" — inclusive o `eq`, que continua comparação EXATA.
   */
  const comTexto = (texto: string) => ({ event: { body_preview: texto } });

  it("contém em texto: casa com e sem acento, nos DOIS sentidos", () => {
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "contains", value: "anúncio" }],
        comTexto("vi o anuncio de voces"),
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "contains", value: "anuncio" }],
        comTexto("vi o anúncio de vocês"),
      ),
    ).toBe(true);
  });

  it("contém em texto: Olá casa Ola e olá!", () => {
    for (const escrito of ["Ola", "olá!", "OLÁ", "olá,"]) {
      expect(
        evaluateConditions(
          [{ field: "event.body_preview", op: "contains", value: "Olá" }],
          comTexto(`Oi, tudo bem? ${escrito}`),
        ),
        `"Olá" tinha de casar "${escrito}"`,
      ).toBe(true);
    }
  });

  it("contém em texto: o que é OUTRA coisa continua não casando", () => {
    // Sem estes dois, "ignora acento e pontuação" ficaria indistinguível de
    // "casa tudo", e o verde não provaria nada.
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "contains", value: "anúncio" }],
        comTexto("quero uma proposta comercial"),
      ),
    ).toBe(false);
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "contains", value: "olá" }],
        comTexto("bom dia, tudo certo?"),
      ),
    ).toBe(false);
  });

  it("eq continua EXATO: acento e caixa ainda decidem (só o contains dobra a grafia)", () => {
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "eq", value: "anúncio" }],
        comTexto("anuncio"),
      ),
    ).toBe(false);
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "eq", value: "anuncio" }],
        comTexto("Anuncio"),
      ),
    ).toBe(false);
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "eq", value: "anuncio" }],
        comTexto("anuncio"),
      ),
    ).toBe(true);
  });

  it("contém em lista: a mesma grafia dobra, a pertinência (tag inteira) NÃO", () => {
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: "tráfego" }], comTags(["trafego"])),
    ).toBe(true);
    // #956 continua de pé: tag inteira, nunca o pedaço — nem depois de dobrar a grafia.
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: "trafego" }], comTags(["trafego pago"])),
    ).toBe(false);
  });

  /**
   * Doc 161 (16/10), opção D: a pontuação vira ESPAÇO, não some. O caso que
   * motivou a #2973 é a mensagem pronta do anúncio que o lead edita. Os casos
   * acima passam só com o acento; este é o que prende a pontuação.
   */
  it("contém em texto: a mensagem do anúncio casa mesmo sem a pontuação", () => {
    for (const recebido of ["ola vi o anuncio", "ola, vi o anuncio", "Olá!! Vi o anúncio."]) {
      expect(
        evaluateConditions(
          [{ field: "event.body_preview", op: "contains", value: "Olá! vi o anúncio" }],
          comTexto(recebido),
        ),
        `"Olá! vi o anúncio" tinha de casar "${recebido}"`,
      ).toBe(true);
    }
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "contains", value: "pré-venda" }],
        comTexto("quero entrar na pre venda"),
      ),
    ).toBe(true);
  });

  it("contém em texto: pontuação vira espaço e não junta números nem endereços", () => {
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "contains", value: "10,00" }],
        comTexto("o plano custa 1.000"),
      ),
    ).toBe(false);
    expect(
      evaluateConditions(
        [{ field: "event.body_preview", op: "contains", value: "@gmail.com" }],
        comTexto("meu email é fulanogmailcom"),
      ),
    ).toBe(false);
  });

  it("contém em texto: regra só de pontuação não casa toda mensagem", () => {
    // "?" normalizado fica vazio, e "contém vazio" casaria tudo: uma regra que
    // manda WhatsApp passaria a disparar para todo mundo. Ela compara como antes.
    expect(
      evaluateConditions([{ field: "event.body_preview", op: "contains", value: "?" }], comTexto("bom dia")),
    ).toBe(false);
    expect(
      evaluateConditions([{ field: "event.body_preview", op: "contains", value: "?" }], comTexto("tudo bem?")),
    ).toBe(true);
    expect(
      evaluateConditions([{ field: "event.added_tags", op: "contains", value: "!" }], comTags(["vip"])),
    ).toBe(false);
  });
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

/**
 * #2727 — a CONTAGEM que a tela de operação mostra. Contar `conditions.length`
 * devolvia 0 para `{any:[…]}` (um objeto não tem comprimento) e a tela dizia
 * "sem condições" para uma regra com duas — `lib/operacao/regras-automaticas.ts`.
 */
describe("contarCondicoes (#2727)", () => {
  const linha = { field: "a", op: "eq" as const, value: "1" };

  it("conta a lista simples como sempre contou", () => {
    expect(contarCondicoes([])).toBe(0);
    expect(contarCondicoes([linha])).toBe(1);
    expect(contarCondicoes([linha, linha, linha])).toBe(3);
  });

  it("conta as folhas do grupo do topo — o caso que dava 0", () => {
    expect(contarCondicoes({ any: [linha, linha] })).toBe(2);
    expect(contarCondicoes({ all: [linha] })).toBe(1);
    expect(contarCondicoes({ any: [] })).toBe(0);
  });

  it("conta através de grupo dentro de grupo", () => {
    expect(contarCondicoes({ all: [linha, { any: [linha, { all: [linha] }] }] })).toBe(3);
  });

  it("o que não é lista nem grupo conta 0, sem estourar", () => {
    expect(contarCondicoes(null as unknown as Parameters<typeof contarCondicoes>[0])).toBe(0);
    expect(contarCondicoes("lixo" as unknown as Parameters<typeof contarCondicoes>[0])).toBe(0);
  });
});

describe("OPERADORES_SEM_VALOR (#2727)", () => {
  it("é exatamente is_empty/is_not_empty — os que não pedem valor", () => {
    expect([...OPERADORES_SEM_VALOR].sort()).toEqual(["is_empty", "is_not_empty"]);
    expect(OPERADORES_SEM_VALOR.has("eq")).toBe(false);
    expect(OPERADORES_SEM_VALOR.has("is_empty")).toBe(true);
  });
});