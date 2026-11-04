import { describe, expect, it } from "vitest";

import {
  LIMITES_DO_MODELO,
  numerosDoCorpo,
  problemasDoModelo,
  textoDoProblema,
  variaveisSemExemplo,
} from "@/lib/channels/limites-do-modelo";

/**
 * OS LIMITES DO MODELO, MEDIDOS ANTES DO ENVIO (#3635, fatia 2).
 *
 * ─── O que não existia ───────────────────────────────────────────────────────
 *
 * O formulário deixava digitar qualquer tamanho e qualquer variável sem
 * amostra, e quem reprovava era a Meta — horas depois, com um erro genérico que
 * não dizia QUAL campo estourou. Aqui os limites são declarados uma vez, com a
 * fonte ao lado, e devolvidos campo a campo.
 *
 * ─── A fonte dos números ─────────────────────────────────────────────────────
 *
 * Meta, "Template components" (documentação do WhatsApp Business Platform):
 * corpo até 1024 caracteres, cabeçalho de texto e rodapé até 60, texto de botão
 * até 25, URL de botão até 2000, até 10 botões por modelo. A imagem do cabeçalho
 * segue o limite de mídia da plataforma: 5 MB, JPG/PNG.
 *
 * Nenhum deles é número redondo escolhido a dedo, e é por isso que estão todos
 * no mesmo lugar: um limite copiado para a tela e para a rota envelhece
 * separado da fonte, e o lado que envelhece passa a recusar o que a Meta aceita.
 */
const t = (texto: string) => texto;

describe("os limites do modelo, com a fonte declarada", () => {
  it("corpo 1024, cabeçalho e rodapé 60, botão 25 — os números da plataforma", () => {
    expect(LIMITES_DO_MODELO).toEqual({
      corpo: 1024,
      cabecalhoTexto: 60,
      rodape: 60,
      textoDoBotao: 25,
      urlDoBotao: 2000,
      botoes: 10,
      imagemDoCabecalho: 5 * 1024 * 1024,
    });
  });

  it("no limite EXATO não há excesso — a fronteira é inclusiva", () => {
    expect(
      problemasDoModelo({
        corpo: "a".repeat(1024),
        cabecalhoTexto: "b".repeat(60),
        rodape: "c".repeat(60),
        botoes: [{ texto: "d".repeat(25), url: `https://x.test/${"e".repeat(2000 - 15)}` }],
      }),
    ).toEqual([]);
  });

  it("um caractere além vira UMA linha, com o campo culpado e o excesso", () => {
    expect(problemasDoModelo({ corpo: "a".repeat(1025) })).toEqual([
      { campo: "corpo", atual: 1025, limite: 1024, excesso: 1 },
    ]);
  });

  it("cabeçalho, rodapé e texto de botão têm o seu próprio culpado", () => {
    const problemas = problemasDoModelo({
      cabecalhoTexto: "a".repeat(61),
      rodape: "b".repeat(62),
      botoes: [{ texto: "ok" }, { texto: "c".repeat(30) }],
    });
    expect(problemas).toContainEqual({ campo: "cabecalhoTexto", atual: 61, limite: 60, excesso: 1 });
    expect(problemas).toContainEqual({ campo: "rodape", atual: 62, limite: 60, excesso: 2 });
    // O botão é apontado pelo ÍNDICE (1-based): "o segundo botão" é o que o
    // operador vê na tela, não uma posição de array.
    expect(problemas).toContainEqual({
      campo: "textoDoBotao",
      atual: 30,
      limite: 25,
      excesso: 5,
      botao: 2,
    });
  });

  it("URL longa e botões demais também são excesso declarado", () => {
    const onze = Array.from({ length: 11 }, () => ({ texto: "ok" }));
    expect(problemasDoModelo({ botoes: onze })).toContainEqual({
      campo: "botoes",
      atual: 11,
      limite: 10,
      excesso: 1,
    });
    expect(problemasDoModelo({ botoes: [{ texto: "ok", url: `https://x.test/${"a".repeat(2000)}` }] })).toContainEqual(
      { campo: "urlDoBotao", atual: 2015, limite: 2000, excesso: 15, botao: 1 },
    );
  });

  it("imagem do cabeçalho: 5 MB é o teto", () => {
    expect(problemasDoModelo({ cabecalhoImagemBytes: 5 * 1024 * 1024 })).toEqual([]);
    expect(problemasDoModelo({ cabecalhoImagemBytes: 5 * 1024 * 1024 + 1 })).toEqual([
      { campo: "imagemDoCabecalho", atual: 5 * 1024 * 1024 + 1, limite: 5 * 1024 * 1024, excesso: 1 },
    ]);
  });
});

describe("as variáveis do corpo exigem exemplo", () => {
  it("conta as variáveis DISTINTAS, pelo maior índice", () => {
    expect(numerosDoCorpo("")).toEqual([]);
    expect(numerosDoCorpo("Oi {{1}}, oi de novo {{1}}")).toEqual([1]);
    expect(numerosDoCorpo("Oi {{1}} e {{2}}")).toEqual([1, 2]);
  });

  it("variável sem exemplo é apontada pelo NÚMERO", () => {
    expect(variaveisSemExemplo("Olá {{1}}, pedido {{2}}", ["Ana"])).toEqual([2]);
    expect(problemasDoModelo({ corpo: "Olá {{1}}, pedido {{2}}", exemplos: ["Ana"] })).toEqual([
      { campo: "exemploDaVariavel", atual: 0, limite: 1, excesso: 1, variavel: 2 },
    ]);
  });

  it("exemplo em branco conta como ausente — a revisão recusa amostra vazia", () => {
    expect(variaveisSemExemplo("Olá {{1}} e {{2}}", ["Ana", "   "])).toEqual([2]);
    expect(variaveisSemExemplo("Olá {{1}} e {{2}}", ["Ana", ""])).toEqual([2]);
  });

  it("sem exemplo nenhum, todas faltam", () => {
    expect(variaveisSemExemplo("Olá {{1}} e {{2}}", [])).toEqual([1, 2]);
    expect(variaveisSemExemplo("Olá {{1}} e {{2}}", undefined)).toEqual([1, 2]);
  });

  it("a variável SALTEADA é apontada — {{1}} e {{3}} deixa o 2 sem amostra", () => {
    expect(variaveisSemExemplo("Olá {{1}} e {{3}}", ["Ana", "", "Carlos"])).toEqual([2]);
  });

  it("texto sem variável não pede exemplo", () => {
    expect(variaveisSemExemplo("Só texto", [])).toEqual([]);
  });
});

describe("a mensagem diz QUAL campo e QUAL número", () => {
  it("nomeia o campo do excesso, com o atual e o limite", () => {
    const texto = textoDoProblema({ campo: "corpo", atual: 1500, limite: 1024, excesso: 476 }, t);
    expect(texto).toContain("corpo");
    expect(texto).toContain("1500");
    expect(texto).toContain("1024");
  });

  it("no botão, diz o número do botão", () => {
    const texto = textoDoProblema(
      { campo: "textoDoBotao", atual: 30, limite: 25, excesso: 5, botao: 2 },
      t,
    );
    expect(texto).toContain("2");
    expect(texto).toContain("25");
  });

  it("na variável, diz o número da variável", () => {
    const texto = textoDoProblema(
      { campo: "exemploDaVariavel", atual: 0, limite: 1, excesso: 1, variavel: 3 },
      t,
    );
    expect(texto).toContain("3");
    expect(texto.toLowerCase()).toContain("exemplo");
  });

  it("a tradução recebida é a que sai — a chave é o texto em português", () => {
    const espanhol = (chave: string) => `ES:${chave}`;
    expect(textoDoProblema({ campo: "corpo", atual: 2, limite: 1, excesso: 1 }, espanhol)).toContain("ES:");
  });
});
