/**
 * O PADRÃO DO CAMPO (#2730) — a régua ÚNICA que o formulário, a API e a
 * gravação pela IA compartilham.
 *
 * A issue pede `"padrao"` + `"mensagem_padrao"` num campo personalizado, com a
 * mesma regra nos três pontos. Se cada ponto fizer sua própria conta, os três
 * divergem no dia em que a regra mudar — então a conta é UMA função pura, aqui,
 * e os três só a chamam.
 *
 * Os casos que este arquivo mede são os seis critérios da issue:
 *
 *  1. sem `padrao` o campo continua LIVRE (o valor de hoje passa byte a byte);
 *  2. valor que casa passa; valor que não casa é recusado com o MOTIVO, e a
 *     frase que o usuário vê é a DO CAMPO (`mensagem_padrao`);
 *  3. regex inválida configurada fecha a porta de forma legível — não lança,
 *     não derruba o form e NÃO vira "aceita tudo": um regex quebrado jamais é
 *     interpretado como se casasse com qualquer coisa;
 *  4. `padrao` em branco também fecha: `new RegExp("")` casa com tudo, e é
 *     exatamente o "aceita tudo silencioso" que a issue descarta;
 *  5. valor em branco continua livre — obrigatoriedade é OUTRA régua
 *     (`obrigatorio_em`, issue #1536), não a do formato;
 *  6. não é texto (objeto, lista) a porta fecha: formato de texto não se cumpre
 *     com estrutura.
 */
import { describe, expect, it } from "vitest";

import {
  camposQueMudaram,
  defsDoPadraoDoFunil,
  MENSAGEM_DE_FORA_DO_PADRAO,
  MENSAGEM_DE_PADRAO_INVALIDO,
  mensagemDaRecusa,
  recusasDePadrao,
  validaPadraoDoCampo,
} from "@/lib/leads/padrao-do-campo";

/** O campo do exemplo da issue: "Idades das crianças" = `2,9`. */
const IDADES = {
  key: "idades",
  label: "Idades das crianças",
  type: "text",
  padrao: "^\\d{1,2}(,\\d{1,2})*$",
  mensagem_padrao: "Use só números separados por vírgula, ex.: 2,9",
};

describe("validaPadraoDoCampo — sem padrão, o campo é o de sempre", () => {
  it("ausência de `padrao` deixa o valor livre, seja ele qual for", () => {
    expect(
      validaPadraoDoCampo({ key: "obs", label: "Observações" }, "qualquer coisa digitada"),
    ).toEqual({
      ok: true,
    });
    expect(validaPadraoDoCampo({ key: "obs", padrao: undefined }, 42)).toEqual({ ok: true });
    // O `mensagem_padrao` sozinho não restringe nada: ele só EXPLICA a regra.
    expect(
      validaPadraoDoCampo({ key: "obs", mensagem_padrao: "só números" }, "texto livre"),
    ).toEqual({ ok: true });
  });

  it("o exemplo da issue: `2,9` casa, `dois` e `123` não casam", () => {
    expect(validaPadraoDoCampo(IDADES, "2,9")).toEqual({ ok: true });
    expect(validaPadraoDoCampo(IDADES, "2")).toEqual({ ok: true });
    // `1,2,3,4` CASA, e é bom saber: cada segmento tem até 2 dígitos e o `*`
    // deixa passar quantos forem. Quem cai fora é o número de 3 dígitos, o
    // texto e o espaço nas pontas.
    expect(validaPadraoDoCampo(IDADES, "1,2,3,4")).toEqual({ ok: true });
    expect(validaPadraoDoCampo(IDADES, "123")).toEqual({ ok: false, motivo: "fora_do_padrao" });
    expect(validaPadraoDoCampo(IDADES, "dois")).toEqual({ ok: false, motivo: "fora_do_padrao" });
    expect(validaPadraoDoCampo(IDADES, " 2,9 ")).toEqual({ ok: false, motivo: "fora_do_padrao" });
  });

  it("valor em branco ou nulo continua livre: obrigatoriedade é outra régua", () => {
    expect(validaPadraoDoCampo(IDADES, "")).toEqual({ ok: true });
    expect(validaPadraoDoCampo(IDADES, "   ")).toEqual({ ok: true });
    expect(validaPadraoDoCampo(IDADES, null)).toEqual({ ok: true });
    expect(validaPadraoDoCampo(IDADES, undefined)).toEqual({ ok: true });
  });

  it("número e booleano são validados como texto; objeto e lista FECHAM", () => {
    expect(validaPadraoDoCampo(IDADES, 29)).toEqual({ ok: true });
    expect(validaPadraoDoCampo({ key: "x", padrao: "^(sim|nao)$" }, true)).toEqual({
      ok: false,
      motivo: "fora_do_padrao",
    });
    // Não há como casar formato de texto com estrutura: recusa, nunca "deixa
    // passar porque não deu para testar".
    expect(validaPadraoDoCampo(IDADES, ["2", "9"])).toEqual({
      ok: false,
      motivo: "fora_do_padrao",
    });
    expect(validaPadraoDoCampo(IDADES, { valor: "2,9" })).toEqual({
      ok: false,
      motivo: "fora_do_padrao",
    });
  });
});

describe("regex inválida configurada — falha FECHADA e legível", () => {
  const QUEBRADO = { key: "idades", label: "Idades", padrao: "^\\d{1,2(" };

  it("não lança: a porta fecha com motivo, o form não derruba", () => {
    expect(() => validaPadraoDoCampo(QUEBRADO, "2,9")).not.toThrow();
    expect(validaPadraoDoCampo(QUEBRADO, "2,9")).toEqual({ ok: false, motivo: "padrao_invalido" });
  });

  it("não vira 'aceita tudo': o regex quebrado recusa, não aprova", () => {
    expect(validaPadraoDoCampo(QUEBRADO, "qualquer coisa")).toEqual({
      ok: false,
      motivo: "padrao_invalido",
    });
    // O campo fica BLOQUEADO até a correção — inclusive para valor em branco:
    // falha fechada é falha fechada, não "só para o que eu não gostei".
    expect(validaPadraoDoCampo(QUEBRADO, "")).toEqual({ ok: false, motivo: "padrao_invalido" });
    expect(validaPadraoDoCampo(QUEBRADO, null)).toEqual({ ok: false, motivo: "padrao_invalido" });
  });

  it('`padrao` em branco também fecha: `new RegExp("")` casa com tudo', () => {
    expect(validaPadraoDoCampo({ key: "x", padrao: "" }, "qualquer coisa")).toEqual({
      ok: false,
      motivo: "padrao_invalido",
    });
    expect(validaPadraoDoCampo({ key: "x", padrao: "   " }, "qualquer coisa")).toEqual({
      ok: false,
      motivo: "padrao_invalido",
    });
  });
});

describe("mensagemDaRecusa — a frase é DO CAMPO, nunca a genérica", () => {
  it("fora do padrão: a `mensagem_padrao` do campo", () => {
    const [recusa] = recusasDePadrao([IDADES], { idades: "dois" });
    expect(recusa).toBeDefined();
    expect(mensagemDaRecusa(recusa!)).toBe(IDADES.mensagem_padrao);
    expect(mensagemDaRecusa(recusa!)).not.toBe(MENSAGEM_DE_FORA_DO_PADRAO);
  });

  it("sem `mensagem_padrao`, a genérica — e ela existe nos três catálogos", () => {
    const [recusa] = recusasDePadrao([{ key: "idades", padrao: "^\\d+$" }], { idades: "abc" });
    expect(mensagemDaRecusa(recusa!)).toBe(MENSAGEM_DE_FORA_DO_PADRAO);
  });

  it("regex quebrada usa a frase de CONFIGURAÇÃO, não a de formato", () => {
    const [recusa] = recusasDePadrao(
      [{ key: "idades", padrao: "^\\d{1,2(", mensagem_padrao: IDADES.mensagem_padrao }],
      { idades: "2,9" },
    );
    expect(recusa?.motivo).toBe("padrao_invalido");
    expect(mensagemDaRecusa(recusa!)).toBe(MENSAGEM_DE_PADRAO_INVALIDO);
    expect(mensagemDaRecusa(recusa!)).not.toBe(IDADES.mensagem_padrao);
  });
});

describe("recusasDePadrao — o lote que a API e a IA mandam", () => {
  it("só as chaves ESCREVÍDAS e COM definição são avaliadas", () => {
    expect(recusasDePadrao([], { idades: "dois" })).toEqual([]);
    expect(recusasDePadrao([{ key: "outro", label: "Outro" }], { idades: "dois" })).toEqual([]);
    expect(recusasDePadrao([IDADES], { outro: "dois" })).toEqual([]);
    // Chave sem valor na escrita não é avaliada (o PATCH manda só o que mudou).
    expect(recusasDePadrao([IDADES], {})).toEqual([]);
    expect(recusasDePadrao([IDADES], undefined)).toEqual([]);
  });

  it("carrega campo, rótulo, motivo e a mensagem configurada", () => {
    expect(recusasDePadrao([IDADES], { idades: "dois" })).toEqual([
      {
        campo: "idades",
        rotulo: "Idades das crianças",
        motivo: "fora_do_padrao",
        mensagemPadrao: IDADES.mensagem_padrao,
      },
    ]);
    // Sem rótulo lido, a própria chave serve de rótulo.
    expect(recusasDePadrao([{ key: "idades", padrao: "^\\d+$" }], { idades: "x" })).toEqual([
      { campo: "idades", rotulo: "idades", motivo: "fora_do_padrao" },
    ]);
  });

  it("o mesmo campo em dois funis: o valor tem de casar TODOS os padrões", () => {
    const doisFunis = [
      { key: "idades", label: "Idades", padrao: "^\\d{1,2}$" },
      { key: "idades", label: "Idades (import)", padrao: "^\\d{1,2},\\d{1,2}$" },
    ];
    // "2,9" casa o segundo mas não o primeiro → recusa, com o rótulo de quem
    // recusou.
    expect(recusasDePadrao(doisFunis, { idades: "2,9" })).toEqual([
      { campo: "idades", rotulo: "Idades", motivo: "fora_do_padrao" },
    ]);
    // "2" casa o primeiro mas não o segundo → recusa pelo segundo.
    expect(recusasDePadrao(doisFunis, { idades: "2" })).toEqual([
      { campo: "idades", rotulo: "Idades (import)", motivo: "fora_do_padrao" },
    ]);
  });

  it("vários campos fora do padrão saem todos, na ordem dos valores", () => {
    const defs = [IDADES, { key: "localizador", label: "Localizador", padrao: "^[A-Z0-9]{6}$" }];
    expect(
      recusasDePadrao(defs, { idades: "dois", localizador: "abc" }).map((r) => r.campo),
    ).toEqual(["idades", "localizador"]);
    expect(recusasDePadrao(defs, { idades: "2,9", localizador: "ABC123" })).toEqual([]);
  });
});

// ─── O CR do #2814: julgar o que MUDOU, e cada ficha com os seus campos ─────

describe("camposQueMudaram — o mapa que o PATCH manda contra o que está gravado", () => {
  it("chave com o MESMO valor fica fora do julgamento", () => {
    // O caso medido: o diálogo manda o mapa inteiro, `idades` já estava "dois".
    expect(camposQueMudaram({ tem_criancas: "nao", idades: "dois" }, { tem_criancas: "nao", idades: "dois" })).toEqual({});
  });

  it("a chave que mudou entra, com o valor novo", () => {
    expect(camposQueMudaram({ idades: "x" }, { idades: "2,9" })).toEqual({ idades: "x" });
  });

  it("campo novo entra; campo que sumiu não vira recusa", () => {
    expect(camposQueMudaram({ entrega: "15 dias" }, {})).toEqual({ entrega: "15 dias" });
    // O mapa do PATCH é substituição: a chave ausente será APAGADA, e não há
    // formato a cobrar de um valor que deixa de existir.
    expect(camposQueMudaram({}, { idades: "dois" })).toEqual({});
  });

  it("sem estado anterior legível tudo é novidade — o comportamento antigo", () => {
    expect(camposQueMudaram({ idades: "dois" }, null)).toEqual({ idades: "dois" });
    expect(camposQueMudaram({ idades: "dois" }, "lixo")).toEqual({ idades: "dois" });
    expect(camposQueMudaram(undefined, { idades: "dois" })).toEqual({});
  });
});

describe("defsDoPadraoDoFunil — o escopo separa as duas fichas (#2852)", () => {
  const settings = {
    fields: [
      { key: "idades", label: "Idades", type: "text", padrao: "^\\d+$" },
      { key: "aniversario", label: "Aniversário", type: "text", padrao: "^\\d{1,2}/\\d{1,2}$", escopo: "contato" },
    ],
  };

  it("sem escopo declarado, o padrão vale para o NEGÓCIO — o de sempre", () => {
    expect(defsDoPadraoDoFunil(settings).map((d) => d.key)).toEqual(["idades"]);
    expect(defsDoPadraoDoFunil(settings, "negocio").map((d) => d.key)).toEqual(["idades"]);
  });

  it("na ficha do contato só entram os campos `contato`", () => {
    expect(defsDoPadraoDoFunil(settings, "contato").map((d) => d.key)).toEqual(["aniversario"]);
  });

  it("leitura torta continua fail-open", () => {
    expect(defsDoPadraoDoFunil(null, "contato")).toEqual([]);
    expect(defsDoPadraoDoFunil({ fields: "x" }, "contato")).toEqual([]);
  });
});

