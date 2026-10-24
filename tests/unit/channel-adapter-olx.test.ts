import { describe, expect, it } from "vitest";

import {
  corpoDeEnvioOlx,
  ehEcoDaConta,
  lerEntradaOlx,
  olxAdapter,
} from "@/lib/channels/adapters/olx";
import type { OutboundEnvelope } from "@/lib/channels/types";

/**
 * Adapter do canal OLX (issue #2927) — CONTRATO da fatia 1.
 *
 * O que dá para provar sem credencial: a tradução de formato (entrada e corpo de
 * envio) e o fail-closed do envio. O que NÃO dá: o OAuth contra
 * `auth.olx.com.br`, o registro do webhook e a resposta 200 do envio — ficam
 * como CONTRATO PENDENTE, e é por isso que `send` desiste com motivo nomeado em
 * vez de inventar endpoint.
 */
function envelope(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    organizationId: "org-1",
    sessionRef: "seller-42",
    to: "5531999998888",
    kind: "text",
    body: "olá",
    ...over,
  };
}

const RECIPIENTE = { isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: null };

describe("adapter olx — endereçamento", () => {
  it("telefone em dígitos quando há; id opaco quando só há identidade da plataforma", () => {
    expect(
      olxAdapter.resolveRecipient({ ...RECIPIENTE, phoneNumber: "+55 (31) 99999-8888" }),
    ).toBe("5531999998888");
    // Sem telefone, devolve o id opaco em vez de null: para este canal o
    // telefone não endereça nada.
    expect(
      olxAdapter.resolveRecipient({ ...RECIPIENTE, waIdentity: "lid:998877" }),
    ).toBe("998877");
    expect(olxAdapter.resolveRecipient({ ...RECIPIENTE })).toBeNull();
  });

  it("recusa grupo — este chat não tem grupos (a capability diz 'none')", () => {
    expect(
      olxAdapter.resolveRecipient({ ...RECIPIENTE, isGroup: true, groupChatId: "g", phoneNumber: "+5511" }),
    ).toBeNull();
  });
});

describe("adapter olx — ENTRADA (tradução de formato)", () => {
  // O payload que a OLX empurra, com TODOS os campos que a issue #2927 lista.
  const PAYLOAD = JSON.stringify({
    chatId: "chat-abc",
    messageId: "msg-1",
    message: "Olá, tenho interesse",
    senderType: "user",
    email: "cliente@exemplo.com",
    name: "Fulana",
    phone: "+55 31 99999-8888",
    messageTimestamp: "2026-10-22T12:00:00Z",
    origin: "buyer",
    listId: "listing-9",
  });

  it("lê o payload documentado no vocabulário neutro", () => {
    const r = lerEntradaOlx(PAYLOAD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mensagem).toEqual({
      chatId: "chat-abc",
      messageId: "msg-1",
      message: "Olá, tenho interesse",
      origin: "buyer",
      senderType: "user",
      name: "Fulana",
      email: "cliente@exemplo.com",
      phone: "+55 31 99999-8888",
      messageTimestamp: "2026-10-22T12:00:00Z",
      listId: "listing-9",
    });
    expect(ehEcoDaConta(r.mensagem)).toBe(false);
  });

  it("aceita origin 'seller' e o marca como ECO (não vira mensagem nova)", () => {
    const r = lerEntradaOlx(JSON.stringify({ chatId: "c", messageId: "m", message: "oi", origin: "seller" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mensagem.origin).toBe("seller");
    expect(ehEcoDaConta(r.mensagem)).toBe(true);
    // Campos ausentes viram null, não quebram a leitura.
    expect(r.mensagem.listId).toBeNull();
    expect(r.mensagem.senderType).toBeNull();
  });

  it("fail-closed no contrato: JSON inválido e campo obrigatório ausente", () => {
    expect(lerEntradaOlx("{não é json")).toEqual({ ok: false, motivo: "json_invalido", campos: [] });

    const r = lerEntradaOlx(JSON.stringify({ chatId: "c", message: "oi", origin: "buyer" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("contrato_violado");
    // Nomeia o CAMPO que falta, nunca o valor (que é dado de cliente).
    expect(r.campos).toEqual(["messageId"]);

    const originInvalido = lerEntradaOlx(
      JSON.stringify({ chatId: "c", messageId: "m", message: "oi", origin: "robot" }),
    );
    expect(originInvalido.ok).toBe(false);
    if (originInvalido.ok) return;
    expect(originInvalido.campos).toContain("origin");
  });
});

describe("adapter olx — CONTRATO do envio (pendente: sem fonte pública, sem credencial)", () => {
  it("monta o corpo que a issue documenta: {textMessage, messageId, chatId}", () => {
    // Este é o contrato que a fatia fixa. O endpoint de envio da OLX NÃO tem
    // fonte pública (a própria issue registra a divergência da doc), e a
    // chamada real exige OAuth — por isso o corpo é testado puro.
    const corpo = corpoDeEnvioOlx(
      envelope({ providerConversationId: "chat-abc", replyToExternalId: "msg-in" }),
    );
    expect(corpo).toEqual({ chatId: "chat-abc", textMessage: "olá", messageId: "msg-in" });
  });

  it("omite messageId quando não há citação", () => {
    const corpo = corpoDeEnvioOlx(envelope({ providerConversationId: "chat-abc" }));
    expect(corpo).toEqual({ chatId: "chat-abc", textMessage: "olá" });
    expect(corpo).not.toHaveProperty("messageId");
  });

  it("não está configurado nesta instalação (não há caminho de credencial)", () => {
    expect(olxAdapter.isConfigured()).toBe(false);
  });

  it("desiste NOMEANDO o motivo — nunca um sent sem id", async () => {
    // Sem thread: requisito estrutural do canal.
    await expect(olxAdapter.send(envelope())).rejects.toThrow(/^olx_no_conversation/);
    // Com thread, mas sem OAuth implementado: não inventa endpoint nem resposta.
    await expect(
      olxAdapter.send(envelope({ providerConversationId: "chat-abc" })),
    ).rejects.toThrow(/^olx_not_configured/);
  });

  it("checkHealth é honesto: não deu para perguntar ≠ canal caído", async () => {
    const saude = await olxAdapter.checkHealth!({ organizationId: "org-1", sessionRef: "seller-42" });
    expect(saude).toEqual({ reachable: false, status: null, detail: "sem_credencial_para_a_sessao" });
  });
});
