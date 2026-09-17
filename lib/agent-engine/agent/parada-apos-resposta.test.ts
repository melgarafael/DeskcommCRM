import { describe, expect, it } from "vitest";

import {
  contarEnviosAutorizados,
  envioFoiAutorizado,
  maxEnviosDoTurno,
  pararAposRespostaTerminal,
} from "./parada-apos-resposta";

const sendOk = {
  toolCalls: [{ toolName: "send_message" }],
  toolResults: [{ toolName: "send_message", output: { ok: true, status: "enviada" } }],
};

const sendVeto = {
  toolCalls: [{ toolName: "send_message" }],
  toolResults: [
    {
      toolName: "send_message",
      output: { ok: false, error: { code: "internal_vocabulary_leak", message: "reescreva" } },
    },
  ],
};

const consulta = {
  toolCalls: [{ toolName: "search_knowledge" }],
  toolResults: [{ toolName: "search_knowledge", output: { ok: true, results: [] } }],
};

describe("parada após send_message terminal", () => {
  it("consulta simples: encerra na primeira send_message autorizada e não pede step extra", () => {
    const parar = pararAposRespostaTerminal({ maxEnviosAutorizados: 1 });
    expect(parar({ steps: [sendOk] })).toBe(true);
  });

  it("ferramenta de consulta antes da resposta não encerra o loop", () => {
    const parar = pararAposRespostaTerminal({ maxEnviosAutorizados: 1 });
    expect(parar({ steps: [consulta] })).toBe(false);
    expect(parar({ steps: [consulta, sendOk] })).toBe(true);
  });

  it("send_message rejeitada por guardrail não encerra como sucesso", () => {
    const parar = pararAposRespostaTerminal({ maxEnviosAutorizados: 1 });
    expect(envioFoiAutorizado({ ok: false, error: { code: "stop" } })).toBe(false);
    expect(parar({ steps: [sendVeto] })).toBe(false);
    expect(parar({ steps: [sendVeto, sendOk] })).toBe(true);
  });

  it("várias mensagens curtas: permite o teto e para depois dele", () => {
    expect(maxEnviosDoTurno({ splitMessages: false, maxSendsPerTurn: 3 })).toBe(1);
    expect(maxEnviosDoTurno({ splitMessages: true, maxSendsPerTurn: 3 })).toBe(3);
    const parar = pararAposRespostaTerminal({ maxEnviosAutorizados: 2 });
    expect(parar({ steps: [sendOk] })).toBe(false);
    expect(parar({ steps: [sendOk, sendOk] })).toBe(true);
    expect(contarEnviosAutorizados([sendOk, sendOk, sendOk])).toBe(3);
  });

  it("não serializa corpo, prompt nem argumento", () => {
    const passo = {
      toolCalls: [{ toolName: "send_message", args: { body: "segredo-do-cliente" } }],
      toolResults: [
        {
          toolName: "send_message",
          output: { ok: true, status: "enviada", message: "Resposta proposta. Nenhuma mensagem enviada." },
        },
      ],
    };
    const parar = pararAposRespostaTerminal({ maxEnviosAutorizados: 1 });
    expect(parar({ steps: [passo] })).toBe(true);
    expect(JSON.stringify({ ok: parar({ steps: [passo] }) })).not.toContain("segredo");
  });
});
