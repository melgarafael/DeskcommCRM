/**
 * Tests for EPIC-05 contact schemas (Wave 1).
 *
 * Covers:
 *  - E.164 phone validator (accept/reject)
 *  - Email parsing
 *  - CPF check-digit (valid, invalid, repeated digits)
 *  - lgpdAnonymizeSchema requires justification ≥ 10 chars
 *  - contactListQuerySchema coerces `limit` and clamps boundaries
 */
import { describe, expect, it } from "vitest";
import {
  contactCreateSchema,
  contactListQuerySchema,
  contactPatchSchema,
  isValidCpf,
  lgpdAnonymizeSchema,
} from "./contacts";
import { campoVisivel, camposVisiveis, mostrarQuandoSchema } from "./mostrar-quando";
import { customFieldSchema } from "./settings";

describe("isValidCpf", () => {
  it("accepts a known-valid CPF", () => {
    // Generated valid CPFs (algorithm verified).
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("11144477735")).toBe(true);
  });

  it("rejects repeated-digit CPFs", () => {
    expect(isValidCpf("00000000000")).toBe(false);
    expect(isValidCpf("11111111111")).toBe(false);
    expect(isValidCpf("99999999999")).toBe(false);
  });

  it("rejects invalid check digits", () => {
    expect(isValidCpf("52998224726")).toBe(false);
    expect(isValidCpf("12345678900")).toBe(false);
  });

  it("rejects wrong length / non-digits", () => {
    expect(isValidCpf("123")).toBe(false);
    expect(isValidCpf("abcdefghijk")).toBe(false);
    expect(isValidCpf("")).toBe(false);
  });

  it("normalizes formatting (dots/dashes)", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
  });
});

describe("contactCreateSchema", () => {
  it("accepts minimal valid payload (defaults source=manual)", () => {
    const parsed = contactCreateSchema.parse({ name: "Ana" });
    expect(parsed.source).toBe("manual");
  });

  it("rejects non-E.164 phones", () => {
    const r = contactCreateSchema.safeParse({ phone_number: "11999998888" });
    expect(r.success).toBe(false);
  });

  it("accepts E.164 phones", () => {
    const r = contactCreateSchema.safeParse({ phone_number: "+5511999998888" });
    expect(r.success).toBe(true);
  });

  it("rejects malformed emails", () => {
    const r = contactCreateSchema.safeParse({ email: "not-an-email" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid CPF", () => {
    const r = contactCreateSchema.safeParse({ cpf: "12345678900" });
    expect(r.success).toBe(false);
  });

  it("accepts valid CPF", () => {
    const r = contactCreateSchema.safeParse({ cpf: "52998224725" });
    expect(r.success).toBe(true);
  });

  it("rejects malformed birthdate", () => {
    const r = contactCreateSchema.safeParse({ birthdate: "01/01/1990" });
    expect(r.success).toBe(false);
  });

  it("aceita campos personalizados como objeto JSON", () => {
    const r = contactCreateSchema.safeParse({
      custom_fields: { segmento: "vip", score: 10, consentiu: true },
    });
    expect(r.success).toBe(true);
  });

  it("recusa campos personalizados acima de 32 KB", () => {
    // O CHECK do banco só garante que é OBJETO. Sem teto de tamanho, um cliente
    // da API escreveria megabytes numa coluna que a listagem de contatos traz
    // inteira — e o custo apareceria como "a tela ficou lenta", longe da causa.
    const r = contactCreateSchema.safeParse({
      custom_fields: { observacao: "x".repeat(33_000) },
    });
    expect(r.success).toBe(false);
  });

  it("recusa chave vazia em campos personalizados", () => {
    const r = contactCreateSchema.safeParse({ custom_fields: { "": "valor" } });
    expect(r.success).toBe(false);
  });
});

describe("contactPatchSchema", () => {
  it("não materializa source=manual quando PATCH omite source", () => {
    const parsed = contactPatchSchema.parse({ tags: ["vip"] });

    expect(parsed).toEqual({ tags: ["vip"] });
    expect("source" in parsed).toBe(false);
  });
});

describe("contactListQuerySchema", () => {
  it("defaults limit to 50", () => {
    const r = contactListQuerySchema.parse({});
    expect(r.limit).toBe(50);
  });

  it("coerces limit string", () => {
    const r = contactListQuerySchema.parse({ limit: "25" });
    expect(r.limit).toBe(25);
  });

  it("rejects limit > 100", () => {
    const r = contactListQuerySchema.safeParse({ limit: "500" });
    expect(r.success).toBe(false);
  });

  it("defaults order_by and order_dir", () => {
    const r = contactListQuerySchema.parse({});
    expect(r.order_by).toBe("last_activity_at");
    expect(r.order_dir).toBe("desc");
  });

  it("accepts valid order_by", () => {
    const r = contactListQuerySchema.parse({ order_by: "display_name", order_dir: "asc" });
    expect(r.order_by).toBe("display_name");
    expect(r.order_dir).toBe("asc");
  });
});

describe("lgpdAnonymizeSchema", () => {
  it("requires justification with at least 10 chars", () => {
    const r = lgpdAnonymizeSchema.safeParse({
      contact_id: "00000000-0000-0000-0000-000000000000",
      justification: "curto",
    });
    expect(r.success).toBe(false);
  });

  it("requires uuid contact_id", () => {
    const r = lgpdAnonymizeSchema.safeParse({
      contact_id: "not-a-uuid",
      justification: "Solicitação formal LGPD do titular.",
    });
    expect(r.success).toBe(false);
  });

  it("accepts well-formed payload", () => {
    const r = lgpdAnonymizeSchema.safeParse({
      contact_id: "11111111-1111-4111-8111-111111111111",
      justification: "Solicitação formal LGPD do titular do dado.",
    });
    expect(r.success).toBe(true);
  });
});

/**
 * CAMPOS PERSONALIZADOS CONDICIONAIS (issue #2728) — "mostrar o campo X só
 * quando o campo Y = valor".
 *
 * Duas promessas, e as duas precisam de prova:
 *
 *   1. DÁ PARA DECLARAR a condição: `customFieldSchema` a aceita. Sem isto o
 *      zod descarta a chave como desconhecida, `camposDoFunil` nem vê o
 *      `mostrar_quando` e a tela continua mostrando tudo — a feature existiria
 *      só no PR.
 *   2. ESCONDER NÃO É LIMPAR: quem decide o que aparece é a LISTA que a tela
 *      renderiza (`camposVisiveis`), nunca o objeto `custom_fields`. O valor
 *      gravado no registro sobrevive ao campo sumir da tela.
 *
 * Os operadores são os três que a issue pede: `igual`, `contem`, `maior_que`.
 */
describe("mostrar_quando — a condição do campo (issue #2728)", () => {
  it("customFieldSchema aceita o campo declarado com condição", () => {
    const r = customFieldSchema.safeParse({
      key: "outro_servico",
      label: "Outro serviço (qual?)",
      type: "text",
      mostrar_quando: { campo: "tipo_servico", contem: "Outro" },
    });
    expect(r.success).toBe(true);
  });

  it("controlo: o campo SEM condição continua sendo aceito como sempre", () => {
    const r = customFieldSchema.safeParse({ key: "segmento", label: "Segmento", type: "text" });
    expect(r.success).toBe(true);
  });

  it("mostrarQuandoSchema aceita os três operadores, na forma da issue e na forma par", () => {
    // A forma da issue: o operador É a chave.
    expect(
      mostrarQuandoSchema.safeParse({ campo: "tipo_servico", contem: "Outro" }).success,
    ).toBe(true);
    expect(mostrarQuandoSchema.safeParse({ campo: "tipo_servico", igual: "VIP" }).success).toBe(true);
    expect(mostrarQuandoSchema.safeParse({ campo: "criancas", maior_que: 0 }).success).toBe(true);
    // A forma par `{campo, operador, valor}`, que o editor monta ao digitar.
    expect(
      mostrarQuandoSchema.safeParse({ campo: "criancas", operador: "maior_que", valor: 1 })
        .success,
    ).toBe(true);
  });

  it("recusa condição sem operador, com operador desconhecido ou com valor em branco", () => {
    expect(mostrarQuandoSchema.safeParse({ campo: "tipo_servico" }).success).toBe(false);
    expect(
      mostrarQuandoSchema.safeParse({ campo: "tipo_servico", operador: "contem" }).success,
    ).toBe(false);
    expect(
      mostrarQuandoSchema.safeParse({ campo: "tipo_servico", diferente: "Outro" }).success,
    ).toBe(false);
    expect(mostrarQuandoSchema.safeParse({ campo: "tipo_servico", contem: "   " }).success).toBe(
      false,
    );
    expect(mostrarQuandoSchema.safeParse({ operador: "igual", valor: "Outro" }).success).toBe(false);
  });

  it("sem condição o campo aparece — o funil de sempre não muda um byte", () => {
    expect(campoVisivel(undefined, {})).toBe(true);
    expect(campoVisivel(null, { segmento: "vip" })).toBe(true);
  });

  it("igual: casa com o valor gravado, sem importar caixa nem acento", () => {
    const condicao = { campo: "tipo_servico", igual: "Internacional" };
    expect(campoVisivel(condicao, { tipo_servico: "Internacional" })).toBe(true);
    expect(campoVisivel(condicao, { tipo_servico: "  INTERNACIONAL " })).toBe(true);
    expect(campoVisivel(condicao, { tipo_servico: "Local" })).toBe(false);
  });

  it("contem: casa dentro do texto e dentro da lista de um multiselect", () => {
    const texto = { campo: "tipo_servico", contem: "Outro" };
    expect(campoVisivel(texto, { tipo_servico: "Outro (especifique)" })).toBe(true);
    expect(campoVisivel(texto, { tipo_servico: "Limpeza" })).toBe(false);

    const lista = { campo: "servicos", contem: "Montagem" };
    expect(campoVisivel(lista, { servicos: ["Desmontagem", "Montagem"] })).toBe(true);
    expect(campoVisivel(lista, { servicos: ["Desmontagem"] })).toBe(false);
  });

  it("maior_que: compara número — e 0 é valor preenchido, não ausência", () => {
    const condicao = { campo: "criancas", maior_que: 0 };
    expect(campoVisivel(condicao, { criancas: 2 })).toBe(true);
    expect(campoVisivel(condicao, { criancas: "3" })).toBe(true);
    expect(campoVisivel(condicao, { criancas: 0 })).toBe(false);
    expect(campoVisivel(condicao, { criancas: -1 })).toBe(false);
  });

  it("sem valor no campo que manda, o condicional fica escondido", () => {
    const condicao = { campo: "tipo_servico", contem: "Outro" };
    expect(campoVisivel(condicao, {})).toBe(false);
    expect(campoVisivel(condicao, { tipo_servico: null })).toBe(false);
    expect(campoVisivel(condicao, { tipo_servico: "   " })).toBe(false);
    expect(campoVisivel(condicao, { tipo_servico: [] })).toBe(false);
  });

  it("condição ilegível mostra o campo: esconder dado por lixo no jsonb seria pior", () => {
    expect(campoVisivel({ campo: "tipo_servico" }, { tipo_servico: "Outro" })).toBe(true);
    expect(campoVisivel("x", {})).toBe(true);
    expect(campoVisivel({ campo: "", igual: "Outro" }, {})).toBe(true);
  });
});

describe("camposVisiveis — some da tela e preserva o registro (issue #2728)", () => {
  const campos = [
    { key: "tipo_servico", label: "Tipo de serviço", type: "select" as const },
    {
      key: "outro_servico",
      label: "Outro serviço (qual?)",
      type: "text" as const,
      mostrar_quando: { campo: "tipo_servico", contem: "Outro" },
    },
    { key: "criancas", label: "Crianças", type: "number" as const },
    {
      key: "idade_1",
      label: "Idade da 1ª criança",
      type: "number" as const,
      mostrar_quando: { campo: "criancas", maior_que: 0 },
    },
  ];

  it("CASO: condição não atendida → o campo não aparece e o valor gravado continua no registro", () => {
    const registro = {
      tipo_servico: "Limpeza",
      outro_servico: "Piscina",
      criancas: 0,
      idade_1: 7,
    };
    const antes = JSON.stringify(registro);

    const visiveis = camposVisiveis(campos, registro).map((c) => c.key);

    expect(visiveis).not.toContain("outro_servico");
    expect(visiveis).not.toContain("idade_1");
    // O controle: os campos sem condição (e o que dispara a condição) continuam.
    expect(visiveis).toEqual(["tipo_servico", "criancas"]);

    // Esconder não é limpar: a chave gravada segue no registro, byte a byte.
    expect(JSON.stringify(registro)).toBe(antes);
    expect(registro).toEqual({
      tipo_servico: "Limpeza",
      outro_servico: "Piscina",
      criancas: 0,
      idade_1: 7,
    });
  });

  it("condição atendida → os dois campos condicionais voltam", () => {
    const visiveis = camposVisiveis(campos, {
      tipo_servico: "Outro",
      criancas: 2,
    }).map((c) => c.key);
    expect(visiveis).toEqual(["tipo_servico", "outro_servico", "criancas", "idade_1"]);
  });

  it("a lista de definições também não é reescrita pelo filtro", () => {
    const antes = JSON.stringify(campos);
    camposVisiveis(campos, {});
    expect(JSON.stringify(campos)).toBe(antes);
  });

  it("a API grava o valor do campo oculto — o que some da tela não some do registro", () => {
    const r = contactCreateSchema.safeParse({
      name: "Ana",
      custom_fields: { tipo_servico: "Limpeza", outro_servico: "Piscina" },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.custom_fields).toEqual({
      tipo_servico: "Limpeza",
      outro_servico: "Piscina",
    });
  });
});

describe("camposVisiveis olha a LISTA — apagado, laço e quem manda escondido", () => {
  const texto = (key: string, mostrar_quando?: unknown) => ({
    key,
    label: key,
    type: "text" as const,
    ...(mostrar_quando ? { mostrar_quando } : {}),
  });

  it("campo que manda apagado/renomeado: a condição é ilegível e o dependente APARECE", () => {
    const campos = [texto("outro", { campo: "tipo_apagado", contem: "Outro" })];
    expect(camposVisiveis(campos, { outro: "valor antigo" }).map((c) => c.key)).toEqual(["outro"]);
  });

  it("laço A↔B (e A→B→C→A): ninguém do laço fica preso escondido", () => {
    const dois = [texto("a", { campo: "b", igual: "x" }), texto("b", { campo: "a", igual: "y" })];
    expect(camposVisiveis(dois, {}).map((c) => c.key)).toEqual(["a", "b"]);
    const tres = [
      texto("a", { campo: "c", igual: "1" }),
      texto("b", { campo: "a", igual: "1" }),
      texto("c", { campo: "b", igual: "1" }),
      texto("d", { campo: "a", igual: "1" }),
    ];
    // d depende de um membro do laço (que aparece) e a própria condição de d decide.
    expect(camposVisiveis(tres, {}).map((c) => c.key)).toEqual(["a", "b", "c"]);
    expect(camposVisiveis(tres, { a: "1" }).map((c) => c.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("quem manda escondido esconde o dependente, mesmo com valor antigo que casaria", () => {
    const campos = [
      texto("tipo"),
      texto("detalhe", { campo: "tipo", igual: "Outro" }),
      texto("sub", { campo: "detalhe", contem: "piscina" }),
    ];
    const registro = { tipo: "Limpeza", detalhe: "piscina grande" };
    expect(camposVisiveis(campos, registro).map((c) => c.key)).toEqual(["tipo"]);
    expect(camposVisiveis(campos, { ...registro, tipo: "Outro" }).map((c) => c.key)).toEqual([
      "tipo",
      "detalhe",
      "sub",
    ]);
  });
});
