import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

/**
 * Entrada do canal intermediado.
 *
 * Este é o módulo que DESTRAVA o envio: o `conversationId` do provider não se
 * deriva do contato — ele o inventa e o entrega aqui. Sem lê-lo e gravá-lo,
 * responder dentro da janela de 24h fica impossível.
 *
 * Metade dos casos abaixo prova o que o parser tem que RECUSAR. Um webhook que
 * aceita o que não devia escreve lixo no banco de quem instalou, e ninguém
 * descobre até a conversa errada aparecer no inbox.
 */
import { extrairAtribuicaoMeta } from "@/lib/channels/atribuicao-de-anuncio-oficial";
import {
  parseZernioInbound,
  resolveZernioIdentity,
  verifyZernioSignature,
  zernioMediaFetchInit,
} from "@/lib/channels/zernio/webhook";

const SECRET = "s3cr3t";
const firmar = (corpo: string) => createHmac("sha256", SECRET).update(corpo, "utf8").digest("hex");

const payload = (over: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) => ({
  id: "evt_1",
  event: "message.received",
  account: { id: "6a3572a15f7d1751ab117832" },
  message: {
    id: "m_1",
    conversationId: "6a76a2dc4b8fe115e5f6c300",
    platform: "whatsapp",
    platformMessageId: "wamid.ABC",
    direction: "incoming",
    text: "hola",
    attachments: [],
    sender: { phoneNumber: "+595991733685", name: "Marcelo" },
    sentAt: "2026-08-08T01:00:00.000Z",
    isRead: false,
    ...msg,
  },
  ...over,
});

describe("assinatura", () => {
  const corpo = JSON.stringify(payload());

  it("aceita a assinatura correta", () => {
    expect(verifyZernioSignature(corpo, firmar(corpo), SECRET)).toBe(true);
  });

  it("aceita o prefixo sha256=", () => {
    expect(verifyZernioSignature(corpo, `sha256=${firmar(corpo)}`, SECRET)).toBe(true);
  });

  it("recusa corpo adulterado — é o ponto inteiro da assinatura", () => {
    expect(verifyZernioSignature(corpo + " ", firmar(corpo), SECRET)).toBe(false);
  });

  it("recusa assinatura de outro segredo", () => {
    const outra = createHmac("sha256", "outro").update(corpo).digest("hex");
    expect(verifyZernioSignature(corpo, outra, SECRET)).toBe(false);
  });

  it("SEM segredo configurado recusa — não é 'passa', é 'não dá para verificar'", () => {
    // Deixar passar transformaria a rota num endpoint público que escreve no
    // banco de quem instalou.
    expect(verifyZernioSignature(corpo, firmar(corpo), "")).toBe(false);
  });

  it("sem header recusa", () => {
    expect(verifyZernioSignature(corpo, null, SECRET)).toBe(false);
  });

  it("assinatura de tamanho errado devolve false em vez de lançar", () => {
    // `timingSafeEqual` lança com buffers de tamanhos diferentes, e um throw
    // aqui viraria 500 em vez de 401 — o atacante aprenderia pelo status.
    expect(() => verifyZernioSignature(corpo, "abcd", SECRET)).not.toThrow();
    expect(verifyZernioSignature(corpo, "abcd", SECRET)).toBe(false);
    expect(verifyZernioSignature(corpo, "", SECRET)).toBe(false);
  });
});

describe("parse — o que ACEITA", () => {
  it("lê a thread do provider, que é o que destrava o envio livre", () => {
    expect(parseZernioInbound(payload())?.conversationId).toBe("6a76a2dc4b8fe115e5f6c300");
  });

  it("usa o platformMessageId (wamid) como chave de idempotência", () => {
    expect(parseZernioInbound(payload())?.externalId).toBe("wamid.ABC");
  });

  it("cai no id do provider quando não há wamid", () => {
    expect(parseZernioInbound(payload({}, { platformMessageId: null }))?.externalId).toBe("m_1");
  });

  it("lê a conta que recebeu — casa com a sessão", () => {
    expect(parseZernioInbound(payload())?.accountId).toBe("6a3572a15f7d1751ab117832");
  });

  it("descarta anexo sem url em vez de guardar entrada quebrada", () => {
    const r = parseZernioInbound(
      payload({}, { attachments: [{ type: "image", url: "https://x/1" }, { type: "image" }, null] }),
    );
    expect(r?.attachments).toEqual([{ type: "image", url: "https://x/1" }]);
  });
});

describe("mensagem de SAÍDA — enviada de fora do CRM", () => {
  // A primeira versão descartava tudo que era `outgoing` para não duplicar os
  // envios do próprio CRM. O efeito colateral: mensagem mandada do celular do
  // operador, ou por outra plataforma na mesma conta, NUNCA aparecia — e o
  // histórico do cliente ficava pela metade sem nada avisando. A duplicação já
  // estava resolvida pelo unique de `external_id`.
  const saida = (extra: Record<string, unknown> = {}) =>
    payload(
      {
        event: "message.sent",
        conversation: { id: "conv", participantId: "595985321822", participantName: "Cliente" },
        ...extra,
      },
      {
        direction: "outgoing",
        // No payload REAL de saída o `sender` é a EMPRESA.
        sender: { id: "1228579850334037", name: "MP wp", phoneNumber: "+1 939-230-1037" },
      },
    );

  it("é aceita, com direção outbound", () => {
    expect(parseZernioInbound(saida())?.direction).toBe("outbound");
  });

  it("o contato é o PARTICIPANTE, não o remetente — que na saída somos nós", () => {
    // Usar o `sender` criaria um contato com o número da própria empresa, e
    // toda conversa de saída viraria conversa com a gente mesmo.
    const r = parseZernioInbound(saida());
    expect(r?.identity.anchor).toEqual({ kind: "phone", value: "+595985321822" });
    expect(r?.identity.phone).not.toBe("+1 939-230-1037");
  });

  it("normaliza o telefone do participante — senão o MESMO cliente vira dois contatos", () => {
    // A entrada traz `+595991733685`; a conversa traz o MESMO número sem o `+`.
    // Sem normalizar, uma âncora seria `phone:+595…` e a outra `phone:595…`.
    const entrada = parseZernioInbound(
      payload({}, { sender: { phoneNumber: "+595985321822", name: "Cliente" } }),
    );
    const saidaR = parseZernioInbound(saida());
    expect(saidaR?.identity.anchor?.value).toBe(entrada?.identity.anchor?.value);
    expect(saidaR?.identity.anchor?.value).toBe("+595985321822");
  });
});

describe("eventos de DESFECHO", () => {
  const status = (event: string, over: Record<string, unknown> = {}) =>
    parseZernioInbound(payload({ event, ...over }, { direction: "outgoing" }));

  it("delivered e read viram atualização, não mensagem nova", () => {
    expect(status("message.delivered")).toMatchObject({ kind: "status", status: "delivered" });
    expect(status("message.read")).toMatchObject({ kind: "status", status: "read" });
  });

  it("failed carrega a explicação da plataforma — é o que diz o que fazer", () => {
    const r = status("message.failed", {
      error: { code: 131047, title: "Re-engagement message", explanation: "A janela fechou." },
    });
    expect(r?.status).toBe("failed");
    expect(r?.errorReason).toContain("131047");
    expect(r?.errorReason).toContain("A janela fechou.");
  });

  it("message.sent é mensagem NOVA, não só desfecho — é o que faz o envio externo aparecer", () => {
    expect(status("message.sent")?.kind).toBe("message");
  });

  it("carrega a HORA do desfecho (statusAt), não a de chegada do webhook", () => {
    expect(
      status("message.read", { statusAt: "2026-09-24T14:24:23.000Z", timestamp: "2026-09-24T14:24:30.706Z" })
        ?.statusAt,
    ).toBe("2026-09-24T14:24:23.000Z");
    // sem statusAt, o carimbo do evento é a melhor aproximação que existe
    expect(status("message.delivered", { timestamp: "2026-09-24T16:10:38.088Z" })?.statusAt).toBe(
      "2026-09-24T16:10:38.088Z",
    );
    expect(parseZernioInbound(payload())?.statusAt).toBeUndefined();
  });
});

describe("clique em anúncio (Clique para o WhatsApp)", () => {
  // A FORMA do evento real (24/09/2026): o `referral` mora em `metadata`, no nível
  // do evento — não na mensagem. Valores sintéticos; as chaves são as que chegaram.
  const referral = {
    body: "Frete grátis para todo o país",
    headline: "FRETE GRÁTIS",
    ctwa_clid: "ARAkZ_sintetico",
    source_id: "120200000000000001",
    source_type: "ad",
    source_url: "https://fb.me/sintetico",
    media_type: "video",
    video_url: "https://video.example/v.mp4",
    thumbnail_url: "https://video.example/t.jpg",
    welcome_message: { text: "Olá" },
  };

  it("lê o referral de metadata — é onde o Zernio o entrega", () => {
    const r = parseZernioInbound(payload({ metadata: { referral } }));
    expect(r?.referral).toEqual(referral);
    expect(extrairAtribuicaoMeta(r?.referral)).toMatchObject({
      sourceId: "ARAkZ_sintetico",
      adId: "120200000000000001",
      titulo: "FRETE GRÁTIS",
    });
  });

  it("segue lendo as posições da Cloud API (mensagem e raiz) quando metadata não traz", () => {
    expect(parseZernioInbound(payload({}, { referral }))?.referral).toEqual(referral);
    expect(parseZernioInbound(payload({ referral }))?.referral).toEqual(referral);
  });

  it("mensagem que não veio de anúncio segue sem referral", () => {
    expect(parseZernioInbound(payload({ metadata: {} }))?.referral).toBeNull();
  });
});

describe("pino de localização — as coordenadas vêm no webhook", () => {
  // A FORMA medida em 27/10/2026 no log de entregas do provedor (30 dias, 50
  // pinos): `metadata.location` no nível do EVENTO, ao lado do `referral`, com
  // `latitude`/`longitude` numéricos — 43 só com eles, 7 também com `name` e
  // `address`. Valores públicos aqui, nunca o pino de um cliente.
  const pino = (location: unknown, texto = "📍 Location") =>
    payload({ metadata: { location } }, { text: texto });

  it("⭐ lê latitude e longitude de metadata.location", () => {
    const r = parseZernioInbound(pino({ latitude: -23.5855, longitude: -46.6094 }));
    expect(r?.location).toEqual({ latitude: -23.5855, longitude: -46.6094 });
  });

  it("lugar com nome: nome e endereço viram `nome` e `endereco`", () => {
    const r = parseZernioInbound(
      pino({ latitude: -23.5855, longitude: -46.6094, name: "Museu do Ipiranga", address: "Ipiranga, São Paulo, SP" }, "📍 Museu do Ipiranga"),
    );
    expect(r?.location).toEqual({
      latitude: -23.5855,
      longitude: -46.6094,
      nome: "Museu do Ipiranga",
      endereco: "Ipiranga, São Paulo, SP",
    });
  });

  it("o eco de saída com o pino em message.metadata também é lido", () => {
    const r = parseZernioInbound(
      payload({ event: "message.sent" }, { direction: "outgoing", metadata: { location: { latitude: 1.5, longitude: 2.5 } } }),
    );
    expect(r?.location).toEqual({ latitude: 1.5, longitude: 2.5 });
  });

  it("sem pino, sem coordenadas inválidas e sem evento de desfecho: a chave nem aparece", () => {
    expect(parseZernioInbound(payload())).not.toHaveProperty("location");
    expect(parseZernioInbound(pino({ latitude: 0, longitude: 0 }))).not.toHaveProperty("location");
    expect(parseZernioInbound(pino({ latitude: "x", longitude: null }))).not.toHaveProperty("location");
    expect(
      parseZernioInbound(payload({ event: "message.delivered", metadata: { location: { latitude: 1, longitude: 2 } } })),
    ).not.toHaveProperty("location");
  });
});

describe("parse — o que RECUSA", () => {
  const recusa = (p: unknown) => expect(parseZernioInbound(p)).toBeNull();

  it("evento que não é de mensagem nem de desfecho", () => recusa(payload({ event: "post.published" })));
  it("outra plataforma — DM de outra rede não é conversa de WhatsApp", () =>
    recusa(payload({}, { platform: "instagram" })));
  it("sem conversationId — sem thread não há o que endereçar depois", () =>
    recusa(payload({}, { conversationId: null })));
  it("sem nenhum id de mensagem — não há chave de idempotência", () =>
    recusa(payload({}, { platformMessageId: null, id: null })));
  it("payload que não é objeto", () => {
    recusa(null);
    recusa("texto");
    recusa([1, 2]);
  });
});

describe("identidade — o rollout que quebra quem só lê telefone", () => {
  it("prefere o BSUID: é a âncora que sobrevive a trocar de número", () => {
    const i = resolveZernioIdentity({ phoneNumber: "+595991733685", businessScopedUserId: "BS_1" });
    expect(i.anchor).toEqual({ kind: "bsuid", value: "BS_1" });
  });

  it("cai no telefone quando não há BSUID — o caso comum hoje", () => {
    const i = resolveZernioIdentity({ phoneNumber: "+595991733685" });
    expect(i.anchor).toEqual({ kind: "phone", value: "+595991733685" });
  });

  it("quem usa username SEM telefone continua identificável pelo BSUID", () => {
    // A doc é explícita: desde abril/2026 há quem escreva sem expor telefone.
    // Ler só o telefone funcionaria hoje e criaria contato órfão amanhã.
    const i = resolveZernioIdentity({ whatsappUsername: "@jane", businessScopedUserId: "BS_2" });
    expect(i.phone).toBeNull();
    expect(i.anchor).toEqual({ kind: "bsuid", value: "BS_2" });
  });

  it("username NUNCA vira âncora — a própria doc avisa que não é estável", () => {
    const i = resolveZernioIdentity({ whatsappUsername: "@jane" });
    expect(i.username).toBe("@jane");
    expect(i.anchor).toBeNull();
  });

  it("sem identidade utilizável devolve anchor null, não um contato anônimo", () => {
    expect(resolveZernioIdentity({}).anchor).toBeNull();
    expect(resolveZernioIdentity(null).anchor).toBeNull();
  });
});

describe("mídia", () => {
  it("a url do anexo é endpoint AUTENTICADO — sem Bearer devolve 401", () => {
    const init = zernioMediaFetchInit("sk_x") as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer sk_x");
  });
});
