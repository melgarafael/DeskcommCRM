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
  id: "false_70192801575156@lid_3A60443E83484256AF03",
  from: "70192801575156@lid",
  fromMe: false,
  body: "oi, tudo bem?",
  timestamp: 1_760_000_000,
  _data: {
    pushName: "Cliente Real",
    key: {
      id: "3A60443E83484256AF03",
      fromMe: false,
      remoteJid: "70192801575156@lid",
      participant: "",
      remoteJidAlt: "558183647258@s.whatsapp.net",
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
    expect(telefoneAlternativoDe(REAL_INBOUND)).toBe("+558183647258");
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
      telefoneAlternativoDe({ _data: { key: { remoteJidAlt: "70192801575156@lid" } } }),
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

// Estrutura do webhook GOWS observado; identificadores sintéticos.
const GOWS: WahaPayload = {
  from: "70000000000001@lid", fromMe: false,
  _data: { Info: { Chat: "70000000000001@lid", Sender: "70000000000001@lid",
    SenderAlt: "551198765432@s.whatsapp.net", IsFromMe: false, IsGroup: false,
    PushName: "Cliente de teste" } },
};
describe("identidade GOWS", () => {
  it("recupera o telefone do remetente de entrada", () => {
    expect(telefoneAlternativoDe(GOWS)).toBe("+551198765432");
  });
  it.each([
    { IsFromMe: true }, { IsGroup: true }, { Sender: "70000000000002@lid" },
    { Chat: "70000000000002@lid" }, { SenderAlt: "70000000000001@lid" },
    { SenderAlt: "55abc1198765432@s.whatsapp.net" },
  ])("não associa identidade incoerente: %j", (change) => {
    expect(telefoneAlternativoDe({ ...GOWS, _data: { Info: { ...GOWS._data!.Info!, ...change } } })).toBeNull();
  });
  it("saída não usa o telefone do operador como destinatário", () => {
    expect(telefoneAlternativoDe({ ...GOWS, fromMe: true })).toBeNull();
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
        phoneNumber: "+558183647258",
        waIdentity: "phone:+558183647258", // já virou phone: — a coluna é gerada
        waLid: "70192801575156",
      }),
    ).toBe("70192801575156@lid");
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
        waIdentity: "lid:70192801575156",
      }),
    ).toBe("70192801575156@lid");
  });

  it("grupo vence tudo", () => {
    expect(
      resolveWahaChatId({
        isGroup: true,
        groupChatId: "1203630@g.us",
        phoneNumber: "+5531988887777",
        waIdentity: "phone:+5531988887777",
        waLid: "70192801575156",
      }),
    ).toBe("1203630@g.us");
  });
});
