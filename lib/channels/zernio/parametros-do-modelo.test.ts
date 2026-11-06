/**
 * O contrato do parceiro (docs.zernio.com/messages/create-inbox-conversation,
 * lido em 15/10/2026): `templateParams` é UMA lista plana — texto do cabeçalho,
 * depois o corpo, depois um valor por botão de link dinâmico —; a mídia do
 * cabeçalho vai em `headerMedia`; o cupom, em `templateButtonParams`.
 *
 * Até aqui o adapter mandava só as chaves numéricas do corpo: o texto do
 * cabeçalho, a imagem trocada e o sufixo do link se perdiam sem aviso, e um
 * modelo NOMEADO saía sem valor nenhum.
 */
import { describe, expect, it } from "vitest";

import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";

import { parametrosDoParceiro } from "./parametros-do-modelo";

function contrato(components: unknown[], parameter_format = "POSITIONAL") {
  return deriveTemplateContract({ name: "m", language: "pt_BR", parameter_format, components: components as never });
}

describe("parametrosDoParceiro", () => {
  it("ordena cabeçalho de texto, corpo e sufixo do link — nessa ordem, mesmo que as chaves venham embaralhadas", () => {
    const c = contrato([
      { type: "HEADER", format: "TEXT", text: "Oferta {{1}}" },
      { type: "BODY", text: "Olá {{1}}, sua {{2}} está esperando" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sim" }, { type: "URL", text: "Ver", url: "https://x.com/{{1}}" }] },
    ]);
    const r = parametrosDoParceiro(c, { "button1:1": "cafeteira", "2": "encomenda", "header:1": "Liquidação", "1": "Maria" });
    expect(r.templateParams).toEqual(["Liquidação", "Maria", "encomenda", "cafeteira"]);
    expect(r.headerMedia).toBeUndefined();
    expect(r.templateButtonParams).toBeUndefined();
  });

  it("a imagem do cabeçalho vai em headerMedia, com o tipo do modelo — e sem link o parceiro usa a amostra aprovada", () => {
    const c = contrato([
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Olá {{1}}" },
    ]);
    expect(parametrosDoParceiro(c, { "header:1": "https://cdn.x/p.jpg", "1": "Ana" })).toEqual({
      templateParams: ["Ana"],
      headerMedia: { type: "image", link: "https://cdn.x/p.jpg" },
    });
    expect(parametrosDoParceiro(c, { "1": "Ana" })).toEqual({ templateParams: ["Ana"] });
  });

  it("cupom de copiar vai em templateButtonParams, pelo índice do botão", () => {
    const c = contrato([
      { type: "BODY", text: "Seu cupom" },
      { type: "BUTTONS", buttons: [{ type: "COPY_CODE", text: "Copiar" }] },
    ]);
    expect(parametrosDoParceiro(c, { "button0:1": "CAFE10" })).toEqual({
      templateParams: [],
      templateButtonParams: [{ index: 0, subType: "copy_code", value: "CAFE10" }],
    });
  });

  it("modelo NOMEADO: os valores seguem a ordem de aparição — antes saíam todos de fora", () => {
    const c = contrato([{ type: "BODY", text: "Olá {{nome}}, sua {{produto}}" }], "NAMED");
    expect(parametrosDoParceiro(c, { produto: "Cafeteira", nome: "Ana" }).templateParams).toEqual(["Ana", "Cafeteira"]);
  });

  it("sem contrato (modelo fora do espelho): a regra antiga — só chaves numéricas, em ordem numérica", () => {
    expect(parametrosDoParceiro(null, { "10": "j", "2": "b", "1": "a", nome: "x" }).templateParams).toEqual(["a", "b", "j"]);
  });
});
