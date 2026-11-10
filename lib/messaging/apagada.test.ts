import { describe, expect, it } from "vitest";

import { marcadorDaApagada, textoDaApagadaApareceNaInbox } from "./apagada";

/**
 * A RÉGUA DA MENSAGEM APAGADA — o contrato, num lugar só.
 *
 * A bolha da Inbox consulta estes dois helpers. Se a régua mudar de ideia,
 * muda AQUI, e é este arquivo que diz o que o produto decidiu mostrar.
 */
describe("na Inbox, o texto da apagada aparece?", () => {
  it("apagada pelo CONTATO: não aparece — é o que ele pediu para tirar do ar", () => {
    expect(textoDaApagadaApareceNaInbox("inbound")).toBe(false);
  });

  it("apagada pelo ATENDENTE: aparece — o gerente segue vendo o que foi mandado", () => {
    expect(textoDaApagadaApareceNaInbox("outbound")).toBe(true);
  });
});

describe("o marcador da bolha diz QUEM apagou", () => {
  it("recebida é o contato; enviada é a equipe", () => {
    expect(marcadorDaApagada("inbound")).toBe("Esta mensagem foi apagada pelo contato");
    expect(marcadorDaApagada("outbound")).toBe("Esta mensagem foi apagada pelo atendente");
  });
});
