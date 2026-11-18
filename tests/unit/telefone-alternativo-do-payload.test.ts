import { describe, expect, it } from "vitest";

import { resolveWahaChatId } from "@/lib/waha/send";
import { telefoneAlternativoDe, type WahaPayload } from "@/lib/waha/ingest";

/**
 * O TELEFONE QUE SEMPRE CHEGOU (spec 17 passo 2), e o canal que não pode mudar.
 *
 * Os payloads abaixo são TRANSCRIÇÕES de `webhook_events_log` da produção
 * (2026-08-06), não invenções — é a diferença entre medir o WhatsApp e medir a
 * imaginação de quem escreveu o teste. Foi assim que se descobriu que
 * `remoteJidAlt` existe: ninguém teria inventado esse nome.
 */

const REAL_INBOUND: WahaPayload = {
  id: "false_100000000000001@lid_3A60443E83484256AF03",
  from: "100000000000001@lid",
  fromMe: false,
  body: "oi, tudo bem?",
  timestamp: 1_760_000_000,
  _data: {
    pushName: "Cliente Real",
    key: {
      id: "3A60443E83484256AF03",
      fromMe: false,
      remoteJid: "100000000000001@lid",
      participant: "",
      remoteJidAlt: "5511900000001@s.whatsapp.net",
      addressingMode: "lid",
    },
  },
};

/** ACK: o WAHA manda sem `_data` nenhum — 95 dos 438 eventos medidos. */
const REAL_ACK: WahaPayload = {
  id: "true_95163607199919@lid_3BDA5A2ABBE52C8B0D27",
  from: "95163607199919@lid",
  fromMe: true,
  ack: 2,
  ackName: "DEVICE",
};

describe("telefoneAlternativoDe", () => {
  it("tira o telefone de um chat @lid — o achado que destravou o passo 2", () => {
    expect(telefoneAlternativoDe(REAL_INBOUND)).toBe("+5511900000001");
  });

  it("payload sem `_data` devolve null em vez de estourar", () => {
    // 95 de 438 eventos reais são assim. Um throw aqui derrubaria a ingestão da
    // mensagem inteira por causa de um campo opcional.
    expect(telefoneAlternativoDe(REAL_ACK)).toBeNull();
  });

  it("em GRUPO usa participantAlt — o remetente não é o chat", () => {
    expect(
      telefoneAlternativoDe({
        from: "1203630@g.us",
        _data: { key: { remoteJid: "1203630@g.us", participantAlt: "5511999998888@s.whatsapp.net" } },
      }),
    ).toBe("+5511999998888");
  });

  it("RECUSA um `@lid` no campo alternativo — seria a identidade opaca repetida, não um telefone", () => {
    // Aceitar aqui gravaria o Linked ID dentro de `phone_number`, que é chave de
    // reencontro E endereço de envio. O contato passaria a "ter telefone" sendo
    // um número que não disca.
    expect(
      telefoneAlternativoDe({ _data: { key: { remoteJidAlt: "100000000000001@lid" } } }),
    ).toBeNull();
  });

  it("RECUSA grupo e valores fora da faixa E.164", () => {
    expect(telefoneAlternativoDe({ _data: { key: { remoteJidAlt: "1203630@g.us" } } })).toBeNull();
    expect(telefoneAlternativoDe({ _data: { key: { remoteJidAlt: "12@s.whatsapp.net" } } })).toBeNull();
    expect(
      telefoneAlternativoDe({ _data: { key: { remoteJidAlt: "1234567890123456789@s.whatsapp.net" } } }),
      "acima de 15 dígitos não é E.164",
    ).toBeNull();
  });

  it("entrada HOSTIL não trava o processo — ReDoS apontado pelo CodeQL", () => {
    // A versão anterior usava `/@(s\.whatsapp\.net|c\.us)$/`, e o motor de
    // regex tenta casar a partir de CADA `@` da string: um payload com milhares
    // deles fazia o tempo explodir e travava a ingestão de mensagens de TODO
    // mundo. O valor vem de webhook — é entrada de fora, não dado nosso.
    const hostil = "@".repeat(50_000) + "x";
    const inicio = Date.now();
    expect(telefoneAlternativoDe({ _data: { key: { remoteJidAlt: hostil } } })).toBeNull();
    // Linear: comparação de sufixo + teto de tamanho. Um segundo é folga
    // enorme para 50k caracteres, e a versão com regex não terminava.
    expect(Date.now() - inicio, "a checagem tem de ser linear").toBeLessThan(1000);
  });

  it("aceita a variante @c.us, que o WEBJS usa no lugar de @s.whatsapp.net", () => {
    expect(telefoneAlternativoDe({ _data: { key: { remoteJidAlt: "5531988887777@c.us" } } })).toBe(
      "+5531988887777",
    );
  });
});

describe("resolveWahaChatId — o canal de uma conversa viva não muda", () => {
  it("contato @lid QUE GANHOU TELEFONE continua recebendo por @lid", () => {
    // Este é o caso que a 0122 cria e que ninguém tinha antes: até ela, contato
    // @lid nunca tinha `phone_number`. Se a ordem fosse "telefone primeiro",
    // toda conversa @lid viva mudaria de endereço no envio seguinte — e para
    // contato em modo privacidade o `@c.us` frequentemente não é endereçável.
    // O sintoma seria pior que um erro: mensagem marcada como enviada, cliente
    // sem resposta.
    expect(
      resolveWahaChatId({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+5511900000001",
        waIdentity: "phone:+5511900000001", // já virou phone: — a coluna é gerada
        waLid: "100000000000001",
      }),
    ).toBe("100000000000001@lid");
  });

  it("contato SEM lid continua indo por @c.us", () => {
    expect(
      resolveWahaChatId({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+5531988887777",
        waIdentity: "phone:+5531988887777",
        waLid: null,
      }),
    ).toBe("5531988887777@c.us");
  });

  it("sem waLid, ainda cai no lid de `wa_identity` — retaguarda para quem não lê a coluna nova", () => {
    expect(
      resolveWahaChatId({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "lid:100000000000001",
      }),
    ).toBe("100000000000001@lid");
  });

  it("grupo vence tudo", () => {
    expect(
      resolveWahaChatId({
        isGroup: true,
        groupChatId: "1203630@g.us",
        phoneNumber: "+5531988887777",
        waIdentity: "phone:+5531988887777",
        waLid: "100000000000001",
      }),
    ).toBe("1203630@g.us");
  });
});

describe("resolveWahaChatId — ficha com telefone extra (Spec 31 B1)", () => {
  const FICHA_COM_LID = {
    isGroup: false,
    groupChatId: null,
    phoneNumber: "+5515999998888",
    waIdentity: null,
    waLid: "100000000000001",
  };

  it("a última mensagem recebida vence o wa_lid do principal", () => {
    // A pessoa escreveu pelo extra (@c.us). Responder pelo `wa_lid` do principal
    // mandaria a resposta ao número que ela não usou nesta conversa.
    expect(
      resolveWahaChatId({ ...FICHA_COM_LID, ultimoRecebidoChatId: "5515999998888@c.us" }),
    ).toBe("5515999998888@c.us");
    // Sabotagem: pôr o `wa_lid` antes do `ultimoRecebidoChatId` devolve
    // "100000000000001@lid" e deixa este teste vermelho.
  });

  it("grupo continua vencendo a última mensagem recebida", () => {
    expect(
      resolveWahaChatId({
        ...FICHA_COM_LID,
        isGroup: true,
        groupChatId: "1203630@g.us",
        ultimoRecebidoChatId: "5515999998888@c.us",
      }),
    ).toBe("1203630@g.us");
    // Sabotagem: pôr a última recebida antes do grupo devolve o chat individual e deixa vermelho.
  });

  it("sem ultimoRecebidoChatId (ou nulo), a resposta segue exatamente como hoje", () => {
    expect(resolveWahaChatId(FICHA_COM_LID)).toBe("100000000000001@lid");
    expect(resolveWahaChatId({ ...FICHA_COM_LID, ultimoRecebidoChatId: null })).toBe("100000000000001@lid");
    expect(
      resolveWahaChatId({ ...FICHA_COM_LID, waLid: null, ultimoRecebidoChatId: null }),
    ).toBe("5515999998888@c.us");
    // Sabotagem: exigir o campo (lançar sem ele) muda o envio de quem não tem extra e deixa vermelho.
  });
});
