import type { FinishReason } from "ai";
import { describe, expect, it } from "vitest";

import { previaPedeCorrecaoDoTurnoMudo } from "./desfecho-da-previa";
import {
  INSTRUCAO_DO_PEDIDO_HUMANO,
  previaContinuaAtePropor,
  type SinaisDoPedidoHumano,
} from "./proposta-sob-pedido";

const sinais = (over: Partial<SinaisDoPedidoHumano> = {}) =>
  previaContinuaAtePropor({
    candidatos: 0,
    propostas: 0,
    impedimentos: [],
    tentativasDeEnvio: 0,
    textoEscrito: "",
    inboundsSemResposta: 2,
    finishReason: "stop",
    saidaTruncada: false,
    tetoDePassosAtingido: false,
    ...over,
  });

describe("pedido humano: uma recuperação só para silêncio inicial sem oferta nem veto", () => {
  it("o silêncio inicial do caso3281 permite pedir o texto", () => {
    expect(sinais()).toBe(true);
    expect(sinais({ textoEscrito: " \n " })).toBe(true);
  });

  it.each([
    "contato_bloqueado",
    "messaging_window_closed",
    "outside_window",
    "warmup_cap",
    "daily_cap",
    "commercial_requires_human",
    "promise_out_of_table",
    "promise_semantic",
    "case_promise_without_case",
    "clinical_claim",
    "internal_vocabulary_leak",
    "lgpd_anonymized",
    "lgpd_missing_legal_basis",
    "contato_interno",
    "disclosure_required",
    "agenda_stall_sem_ferramenta",
    "midia_sem_fotos",
    "gate_novo_ainda_nao_classificado",
  ])("não paga nova geração depois do impedimento %s", (codigo) => {
    expect(sinais({ impedimentos: [codigo] })).toBe(false);
  });

  it("candidato aceito já é uma oferta, sem chamada extra", () => {
    expect(sinais({ candidatos: 1 })).toBe(false);
  });

  it("proposta de ação sem corpo continua oferta legítima do3093", () => {
    expect(sinais({ propostas: 1 })).toBe(false);
  });

  it("uma tentativa de envio não é silêncio inicial", () => {
    expect(sinais({ tentativasDeEnvio: 1 })).toBe(false);
  });

  it("texto solto mantém a correção canônica, sem fase humana posterior", () => {
    const texto = "Bom dia! Posso ajudar com o seu pedido?";
    expect(sinais({ textoEscrito: texto })).toBe(false);
    expect(previaPedeCorrecaoDoTurnoMudo({
      textoEscrito: texto,
      candidatos: 0,
      tentativasDeEnvio: 0,
    })).toBe(true);
  });

  it("não inventa assunto quando não há inbound sem resposta", () => {
    expect(sinais({ inboundsSemResposta: 0 })).toBe(false);
  });

  it("truncamento e teto de passos continuam falha de geração", () => {
    expect(sinais({ saidaTruncada: true })).toBe(false);
    expect(sinais({ tetoDePassosAtingido: true })).toBe(false);
  });

  it.each<FinishReason | undefined>([
    "content-filter", "error", "other", "length", "tool-calls", undefined,
  ])("não confunde término %s com silêncio normal confirmado", (finishReason) => {
    expect(sinais({ finishReason })).toBe(false);
  });
});

describe("a instrução pede somente a mensagem destinada ao cliente", () => {
  it("identifica o clique e conserva as regras de conteúdo e a aprovação", () => {
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toContain("Sugerir resposta");
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toContain("pediu um texto para esta conversa");
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toMatch(/regras de conteúdo/);
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toMatch(/cadeia de envio/);
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toMatch(/aprovação/);
  });

  it("não pede justificativa privada no corpo que poderá ser aprovado", () => {
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).not.toMatch(/diga|explique|motivo|para quem vai revisar/i);
    expect(INSTRUCAO_DO_PEDIDO_HUMANO).toContain("somente a mensagem destinada ao cliente");
  });
});
