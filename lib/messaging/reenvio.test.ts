import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reenvioDaMensagem, type MensagemDoReenvio } from "./reenvio";

const AGORA = new Date("2026-10-21T12:00:00.000Z");
const minutosAtras = (n: number) => new Date(AGORA.getTime() - n * 60_000).toISOString();

function msg(over: Partial<MensagemDoReenvio> = {}): MensagemDoReenvio {
  return {
    organization_id: "org",
    conversation_id: "conv",
    direction: "outbound",
    sent_via: "user",
    sent_by_user_id: "eu",
    type: "text",
    body: "oi",
    status: "failed",
    error_code: "canal_x_error",
    media_storage_path: null,
    metadata: {},
    updated_at: minutosAtras(1),
    ...over,
  };
}

const agente = { userId: "eu", podeReenviarDeOutros: false };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
});
afterEach(() => vi.useRealTimers());

describe("reenvioDaMensagem", () => {
  it.each([
    ["storage_sign_failed", "seguro"],
    ["channel_disabled", "seguro"],
    ["131047", "seguro"],
    ["131053", "seguro"],
    ["131026", "nenhum"],
    ["131049", "nenhum"],
    ["131056", "nenhum"],
    ["130429", "nenhum"],
    ["368", "nenhum"],
    ["131999", "confirmar"],
    ["channel_archived", "nenhum"],
    ["missing_phone_number", "nenhum"],
    ["pre_go_live", "nenhum"],
    ["pre_go_live_indisponivel", "nenhum"],
    ["canal_x_error", "confirmar"],
    ["canal_y_error", "confirmar"],
    ["send_timeout", "confirmar"],
    ["codigo_que_ninguem_conhece", "confirmar"],
    [null, "confirmar"],
  ])("failed com %s dá %s", (codigo, esperado) => {
    expect(reenvioDaMensagem(msg({ error_code: codigo }), agente)).toBe(esperado);
  });

  it("queued com motivo nunca chegou ao canal: seguro", () => {
    expect(reenvioDaMensagem(msg({ status: "queued", error_code: null, metadata: { queued_reason: "channel_session_not_working" } }), agente)).toBe("seguro");
  });

  it("queued sem motivo: em voo até 5 min pelo updated_at, depois pede confirmação", () => {
    const base = { status: "queued", error_code: null } as const;
    expect(reenvioDaMensagem(msg({ ...base, updated_at: minutosAtras(4) }), agente)).toBe("nenhum");
    expect(reenvioDaMensagem(msg({ ...base, updated_at: minutosAtras(6) }), agente)).toBe("confirmar");
    expect(reenvioDaMensagem(msg({ ...base, updated_at: null }), agente)).toBe("nenhum");
  });

  it("o relógio é o updated_at, não o created_at", () => {
    // Uma linha antiga que acabou de ser reenviada está em voo de novo.
    const m = { ...msg({ status: "queued", error_code: null, updated_at: minutosAtras(1) }), created_at: minutosAtras(120) };
    expect(reenvioDaMensagem(m, agente)).toBe("nenhum");
  });

  it.each(["sending", "sent", "delivered", "read"])("%s está em voo ou saiu: nenhum", (status) => {
    expect(reenvioDaMensagem(msg({ status, updated_at: minutosAtras(60) }), agente)).toBe("nenhum");
  });

  it("mensagem de outro autor: nenhum para agent, seguro para manager", () => {
    const alheia = msg({ sent_by_user_id: "colega", error_code: "channel_disabled" });
    expect(reenvioDaMensagem(alheia, agente)).toBe("nenhum");
    expect(reenvioDaMensagem(alheia, { userId: "eu", podeReenviarDeOutros: true })).toBe("seguro");
  });

  it.each(["ai", "automation", "system", "external_device"] as const)("sent_via=%s: nenhum", (via) => {
    expect(reenvioDaMensagem(msg({ sent_via: via, error_code: "channel_disabled" }), { userId: "eu", podeReenviarDeOutros: true })).toBe("nenhum");
  });

  it("recebida: nenhum", () => {
    expect(reenvioDaMensagem(msg({ direction: "inbound" }), agente)).toBe("nenhum");
  });

  it("mídia: só a do Storage e não expirada", () => {
    const midia = { type: "image", body: null, error_code: "channel_disabled" };
    expect(reenvioDaMensagem(msg({ ...midia, media_storage_path: "org/conv/a.jpg" }), agente)).toBe("seguro");
    expect(reenvioDaMensagem(msg({ ...midia, media_storage_path: null }), agente)).toBe("nenhum");
    expect(reenvioDaMensagem(msg({ ...midia, media_storage_path: "org/conv/a.jpg", metadata: { media_status: "expired" } }), agente)).toBe("nenhum");
  });

  it("mídia fora da pasta da conversa (ex.: PDF de proposta, `${orgId}/${propostaId}.pdf`): nenhum, porque o envio a recusaria", () => {
    const midia = { type: "document", body: null, error_code: "channel_disabled" };
    expect(reenvioDaMensagem(msg({ ...midia, media_storage_path: "org/proposta-1.pdf" }), agente)).toBe("nenhum");
    expect(reenvioDaMensagem(msg({ ...midia, media_storage_path: "org/outra-conv/a.pdf" }), agente)).toBe("nenhum");
    expect(reenvioDaMensagem(msg({ ...midia, media_storage_path: "org/conv/a.pdf" }), agente)).toBe("seguro");
  });

  it.each(["template", "contact", "location"])("tipo %s: nenhum", (type) => {
    expect(reenvioDaMensagem(msg({ type, error_code: "channel_disabled" }), agente)).toBe("nenhum");
  });

  it("texto vazio: nenhum", () => {
    expect(reenvioDaMensagem(msg({ body: null, error_code: "channel_disabled" }), agente)).toBe("nenhum");
  });

  it("sem saber quem lê: nenhum", () => {
    expect(reenvioDaMensagem(msg({ error_code: "channel_disabled" }), { userId: null, podeReenviarDeOutros: false })).toBe("nenhum");
  });
});
