/**
 * Teste unitário dos motivos de `validarFixosDaReceita` (sem MySQL e sem rede).
 *
 * Prova o que a tela precisa: o motivo do Zod vem pelo CAMINHO INTEIRO do
 * campo que falhou ("categorias.0.taxonomia", "esconder.meta_key"), e não
 * pelo último pedaço ("taxonomia", "campo"). Com o pedaço, dois campos
 * diferentes caíam no mesmo rótulo na tela — e ninguém sabia o que corrigir.
 */
import { describe, expect, it } from "vitest";

import { ErroDeFixosInvalidos, validarFixosDaReceita } from "./instancias";

/** Os "fixos" que passam, para o teste mexer só no que quer testar. */
const FIXOS_OK = {
  prefixo: "wp_",
  post_type: "imovel",
  campos: [
    { chave: "preco", rotulo: "Preço de venda", meta_key: "preco", tipo: "preco", filtro: "maximo" },
  ],
  categorias: [],
};

/** Valida e devolve os motivos por caminho (ou falha o teste se não lançar). */
function motivosDe(fixos: unknown): Record<string, string[]> {
  try {
    validarFixosDaReceita("wordpress-conteudo", fixos);
  } catch (err) {
    expect(err, "validarFixosDaReceita não lançou").toBeInstanceOf(ErroDeFixosInvalidos);
    return (err as ErroDeFixosInvalidos).fieldErrors;
  }
  throw new Error("validarFixosDaReceita devia ter lançado (o Zod recusou)");
}

describe("validarFixosDaReceita — o motivo vem pelo caminho inteiro", () => {
  it("o slug inválido da categoria vem em categorias.0.taxonomia", () => {
    const motivos = motivosDe({
      ...FIXOS_OK,
      categorias: [
        {
          chave: "bairro",
          rotulo: "Bairro",
          taxonomia: "Localizacao",
          nivel: "filho",
          filtro: "contem",
        },
      ],
    });

    expect(Object.keys(motivos)).toContain("categorias.0.taxonomia");
    expect(motivos["categorias.0.taxonomia"]?.[0]).toContain("nome da categoria");
    // E o pedaço sozinho NÃO aparece: ele não diz onde falhou.
    expect(motivos["taxonomia"]).toBeUndefined();
  });

  it("o campo escondido vem em esconder.meta_key, e os valores em esconder.valores", () => {
    const campo = motivosDe({
      ...FIXOS_OK,
      esconder: { meta_key: "situação do imóvel", valores: ["vendido"] },
    });
    expect(Object.keys(campo)).toContain("esconder.meta_key");
    expect(campo["esconder.meta_key"]?.[0]).toContain("nome do campo");

    const ocultar = motivosDe({
      ...FIXOS_OK,
      esconder: { meta_key: "status_imovel", valores: [] },
    });
    expect(Object.keys(ocultar)).toContain("esconder.valores");
    expect(ocultar["esconder.valores"]?.[0]).toContain("pelo menos um valor");
  });

  it("a chave repetida vem em campos.0.chave (e o caminho diz qual linha)", () => {
    const motivos = motivosDe({
      ...FIXOS_OK,
      campos: [
        ...FIXOS_OK.campos,
        { chave: "preco", rotulo: "Outro", meta_key: "preco2", tipo: "texto", filtro: "nenhum" },
      ],
    });

    expect(Object.keys(motivos)).toContain("campos.1.chave");
    expect(motivos["campos.1.chave"]?.[0]).toContain("chave só");
  });

  it("a chave reservada vem em campos.0.chave", () => {
    const motivos = motivosDe({
      ...FIXOS_OK,
      campos: [
        { chave: "id", rotulo: "Identificador", meta_key: "identificador", tipo: "texto", filtro: "nenhum" },
      ],
    });

    expect(Object.keys(motivos)).toContain("campos.0.chave");
    expect(motivos["campos.0.chave"]?.[0]).toContain("reservada");
  });

  it("o filtro que não cabe no tipo vem em campos.0.filtro", () => {
    const motivos = motivosDe({
      ...FIXOS_OK,
      campos: [
        { chave: "ano", rotulo: "Ano", meta_key: "ano", tipo: "numero", filtro: "contem" },
      ],
    });

    expect(Object.keys(motivos)).toContain("campos.0.filtro");
    expect(motivos["campos.0.filtro"]?.[0]).toContain("texto");
  });

  it("sem campos vem em campos, e o tipo de post vazio vem em post_type", () => {
    const semCampos = motivosDe({ ...FIXOS_OK, campos: [] });
    expect(Object.keys(semCampos)).toContain("campos");
    expect(semCampos["campos"]?.[0]).toContain("pelo menos um campo");

    const semTipo = motivosDe({ ...FIXOS_OK, post_type: "" });
    expect(Object.keys(semTipo)).toContain("post_type");
  });

  it("a mensagem de erro crua leva o caminho (para o log de quem lê o erro)", () => {
    try {
      validarFixosDaReceita("wordpress-conteudo", {
        ...FIXOS_OK,
        esconder: { meta_key: "situação do imóvel", valores: ["vendido"] },
      });
      throw new Error("devia ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(ErroDeFixosInvalidos);
      expect((err as Error).message).toContain("fixos_invalidos:wordpress-conteudo");
      expect((err as Error).message).toContain("esconder.meta_key");
    }
  });
});
