import { describe, expect, it } from "vitest";

import { lerPlanilha } from "./planilha";

/**
 * A COLUNA DE FOTO DA PLANILHA (#3587, fatia 1).
 *
 * A revenda publica o estoque com as fotos como URLs públicas; a planilha é o
 * caminho para colocar isso no catálogo sem 185 envios manuais. O que este
 * arquivo prende é só o CONTRATO DE LEITURA: uma coluna, até 5 links na ordem
 * em que aparecem (a primeira é a capa), e o resto do comportamento intocado.
 */
const URL_A = "https://cdn.revenda.com.br/carro-1/frente.jpg";
const URL_B = "https://cdn.revenda.com.br/carro-1/painel.jpg";
const URL_C = "https://cdn.revenda.com.br/carro-1/interior.jpg";

function ler(csv: string) {
  const resultado = lerPlanilha(csv);
  if ("erro" in resultado) throw new Error(`não deveria ser erro de planilha: ${resultado.erro}`);
  return resultado;
}

describe("lerPlanilha — coluna de foto por URL", () => {
  it("reconhece a coluna `foto` e entrega a lista na ordem da planilha", () => {
    const { produtos, erros, colunasIgnoradas } = ler(
      `codigo,nome,preco,foto\nIP15,iPhone 15,5499,${URL_A}|${URL_B}|${URL_C}\n`,
    );

    expect(colunasIgnoradas).toEqual([]);
    expect(erros).toEqual([]);
    expect(produtos[0]!.fotos).toEqual([URL_A, URL_B, URL_C]);
  });

  it("linha sem a coluna de foto continua entrando exatamente como hoje", () => {
    const { produtos } = ler("codigo,nome,preco\nIP15,iPhone 15,5499\n");

    // A chave nem aparece: é o que mantém o upsert de quem não declara foto no
    // shape de antes — sem `fotos`, sem tocar no que a tela gravou.
    expect(produtos[0]).not.toHaveProperty("fotos");
  });

  it("célula vazia também não declara foto — reimportar lista de preço não apaga a foto da tela", () => {
    const { produtos, erros } = ler("codigo,nome,preco,foto\nIP15,iPhone 15,5499,\n");

    expect(erros).toEqual([]);
    expect(produtos[0]).not.toHaveProperty("fotos");
  });

  it("cabeçalho em espanhol também casa a coluna", () => {
    const { produtos } = ler("codigo,nombre,precio,fotos\nIP15,iPhone 15,5499," + URL_A + "\n");

    expect(produtos[0]!.fotos).toEqual([URL_A]);
  });

  it("mais de 5 fotos recusa a linha em vez de descartar link em silêncio", () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://cdn.revenda.com.br/c/f${i + 1}.jpg`);
    const { produtos, erros } = ler(`codigo,nome,preco,foto\nIP15,iPhone 15,5499,${urls.join("|")}\n`);

    expect(produtos).toEqual([]);
    expect(erros).toHaveLength(1);
    expect(erros[0]!.linha).toBe(2);
    expect(erros[0]!.motivo).toBe(
      "a linha traz 6 fotos — o produto aceita até 5. Deixe as 5 primeiras na coluna.",
    );
  });

  it("endereço que não é link http(s) recusa a linha, com o valor cru na mensagem", () => {
    const { produtos, erros } = ler(
      "codigo,nome,preco,foto\nIP15,iPhone 15,5499,www.cdn.revenda.com.br/frente.jpg\n",
    );

    expect(produtos).toEqual([]);
    expect(erros[0]!.motivo).toBe(
      'foto não reconhecida ("www.cdn.revenda.com.br/frente.jpg") — use o endereço completo, começando com http:// ou https://',
    );
  });

  it("esquema que não é http(s) recusa a linha", () => {
    const { produtos, erros } = ler("codigo,nome,preco,foto\nIP15,iPhone 15,5499,ftp://cdn/f.jpg\n");

    expect(produtos).toEqual([]);
    expect(erros).toHaveLength(1);
  });

  it("a linha ruim não derruba as outras: o resto da planilha entra", () => {
    const { produtos, erros } = ler(
      `codigo,nome,preco,foto\nP1,Um,10,${URL_A}\nP2,Dois,20,nao-e-url\nP3,Tres,30,\n`,
    );

    expect(produtos.map((p) => p.codigo)).toEqual(["P1", "P3"]);
    expect(erros).toHaveLength(1);
    expect(erros[0]!.linha).toBe(3);
  });
});
