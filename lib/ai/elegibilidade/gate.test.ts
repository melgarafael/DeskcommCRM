import { describe, expect, it } from "vitest";

import {
  AI_ALLOWLIST_TTL_DAYS_DEFAULT,
  decidirElegibilidade,
  lerModoDoGate,
  ttlDaAutorizacaoMs,
  type EstadoDeElegibilidade,
} from "./gate";

const AGORA = new Date("2026-08-27T12:00:00Z");
const DIA = 24 * 60 * 60 * 1000;

const base: EstadoDeElegibilidade = {
  modo: "open",
  forceHuman: false,
  botSilencedUntil: null,
  assigneeKind: "ai",
  aiAuthorizedAt: null,
  agora: AGORA,
  ttlMs: 21 * DIA,
};

describe("lerModoDoGate", () => {
  it("só 'allowlist' liga o modo; resto (ausente/null/lixo) é 'open'", () => {
    expect(lerModoDoGate("allowlist")).toBe("allowlist");
    expect(lerModoDoGate("open")).toBe("open");
    expect(lerModoDoGate(undefined)).toBe("open");
    expect(lerModoDoGate(null)).toBe("open");
    expect(lerModoDoGate("ALLOWLIST")).toBe("open");
    expect(lerModoDoGate(42)).toBe("open");
  });
});

describe("decidirElegibilidade — gate 'open' (comportamento de hoje)", () => {
  it("mensagem genérica sem autorização: PERMITE (nada muda para quem não configurou)", () => {
    const d = decidirElegibilidade({ ...base, modo: "open" });
    expect(d.permite).toBe(true);
    expect(d.motivo).toBe("gate_aberto");
  });

  it("force_human bloqueia mesmo com gate aberto", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", forceHuman: true });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("force_human");
    expect(d.bloqueioPorAllowlist).toBe(false);
  });

  it("conversa com dono humano bloqueia mesmo com gate aberto", () => {
    const d = decidirElegibilidade({ ...base, modo: "open", assigneeKind: "user" });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("conversa_de_humano");
  });

  it("bot silenciado até o futuro bloqueia; silêncio no passado não", () => {
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: new Date(AGORA.getTime() + DIA) }).permite,
    ).toBe(false);
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: new Date(AGORA.getTime() - DIA) }).permite,
    ).toBe(true);
    expect(
      decidirElegibilidade({ ...base, modo: "open", botSilencedUntil: Number.POSITIVE_INFINITY }).permite,
    ).toBe(false);
  });
});

describe("decidirElegibilidade — gate 'allowlist' (deny by default)", () => {
  it("teste 1/3/4/9: mensagem comum de contato NÃO autorizado → NÃO responde", () => {
    const d = decidirElegibilidade({ ...base, modo: "allowlist", aiAuthorizedAt: null });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("sem_autorizacao");
    expect(d.bloqueioPorAllowlist).toBe(true);
  });

  it("teste 6/7: contato autorizado dentro da janela → responde", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      aiAuthorizedAt: new Date(AGORA.getTime() - 3 * DIA),
    });
    expect(d.permite).toBe(true);
    expect(d.motivo).toBe("autorizado");
  });

  it("submissão antiga (fora da janela) NÃO reativa a IA", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      aiAuthorizedAt: new Date(AGORA.getTime() - 30 * DIA),
      ttlMs: 21 * DIA,
    });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("autorizacao_expirada");
    expect(d.bloqueioPorAllowlist).toBe(true);
  });

  it("teste 10: conversa marcada human_only (force_human) → nunca responde, mesmo autorizada", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      forceHuman: true,
      aiAuthorizedAt: new Date(AGORA.getTime() - DIA),
    });
    expect(d.permite).toBe(false);
    expect(d.motivo).toBe("force_human");
  });

  it("teste 2: conversa aberta e autorizada → responde (estado da conversa não pesa)", () => {
    const d = decidirElegibilidade({
      ...base,
      modo: "allowlist",
      assigneeKind: "ai",
      aiAuthorizedAt: new Date(AGORA.getTime() - DIA),
    });
    expect(d.permite).toBe(true);
  });
});

describe("ttlDaAutorizacaoMs", () => {
  it("default quando ausente/vazio/inválido/zero/negativo", () => {
    const esperado = AI_ALLOWLIST_TTL_DAYS_DEFAULT * DIA;
    expect(ttlDaAutorizacaoMs({})).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "abc" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "0" })).toBe(esperado);
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "-5" })).toBe(esperado);
  });
  it("respeita o valor configurado", () => {
    expect(ttlDaAutorizacaoMs({ AI_ALLOWLIST_TTL_DAYS: "7" })).toBe(7 * DIA);
  });
});
