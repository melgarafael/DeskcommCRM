import { generateText, stepCountIs, tool, type StopCondition, type ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createFakeRegistry } from "../edge/llm/providers";
import {
  CAMPO_ENCERRA_TURNO,
  criarParadaAposEnvioFinal,
  envioAnunciaAcaoSeguinte,
} from "./parada-apos-envio";

/**
 * A PARADA DO LAÇO DEPOIS DO ENVIO FINAL DECLARADO — o predicado puro.
 *
 * O que ele protege é o valor do turno: o laço só para quando parar não perde
 * nada que o modelo ainda faria. Os casos "NÃO PARA" são a metade que importa —
 * em especial a TRAVA, que segura o envio que anuncia uma ação ainda não feita
 * mesmo quando o modelo o marcou como final (com `cases_enabled=false`, que é o
 * padrão do clone, essa promessa passa pela cadeia `before_send`).
 */

interface Chamada {
  toolName: string;
  input: Record<string, unknown>;
  /** Ausente = a chamada não tem resultado (lançou ou veio com argumento inválido). */
  output?: unknown;
}

function passo(chamadas: Chamada[]) {
  return {
    toolCalls: chamadas.map((c, i) => ({ toolCallId: `c${i}`, toolName: c.toolName, input: c.input })),
    toolResults: chamadas
      .filter((c) => "output" in c)
      .map((c, i) => ({ toolCallId: `c${i}`, toolName: c.toolName, input: c.input, output: c.output })),
  };
}

const ENVIADA = { ok: true, status: "enviada", message_id: "m1" };
const NEUTRO = "Funcionamos de segunda a sexta, das 9h às 18h.";
const PROMESSA_DE_HUMANO = "Vou chamar alguém da equipe para te atender.";
const PROMESSA_DE_RETORNO = "Combinado, retomamos amanhã às 9h.";

const envio = (body: string, extra: Record<string, unknown> = {}, output: unknown = ENVIADA): Chamada => ({
  toolName: "send_message",
  input: { body, ...extra },
  output,
});
const final = (body: string, output: unknown = ENVIADA) => envio(body, { encerra_turno: true }, output);

function para(
  passos: ReturnType<typeof passo>[],
  opcoes: { casoAberto?: boolean; retornoAgendado?: boolean; keywords?: string[] } = {},
): boolean {
  const parada = criarParadaAposEnvioFinal({
    handoffKeywords: opcoes.keywords ?? [],
    casoAbertoNesteTurno: () => opcoes.casoAberto ?? false,
    retornoAgendadoNesteTurno: () => opcoes.retornoAgendado ?? false,
  });
  return parada({ steps: passos as never }) as boolean;
}

describe("PARA — envio aceito, marcado como final e sem ação anunciada", () => {
  it("envio único 'enviada' com encerra_turno e corpo neutro", () => {
    expect(para([passo([final(NEUTRO)])])).toBe(true);
  });

  it("'aceita_aguardando_canal' também é envio aceito", () => {
    expect(para([passo([final(NEUTRO, { ok: true, status: "aceita_aguardando_canal" })])])).toBe(true);
  });

  it("dois envios aceitos no passo, um deles marcado", () => {
    expect(para([passo([envio("Oi, tudo bem?"), final(NEUTRO)])])).toBe(true);
  });

  it("promessa de humano com request_human_handoff ok num passo anterior", () => {
    const handoff: Chamada = { toolName: "request_human_handoff", input: {}, output: { ok: true, status: "handed_off" } };
    expect(para([passo([handoff]), passo([final(PROMESSA_DE_HUMANO)])])).toBe(true);
  });

  it("promessa de humano com caso aberto neste turno", () => {
    expect(para([passo([final(PROMESSA_DE_HUMANO)])], { casoAberto: true })).toBe(true);
  });

  it("promessa de retorno com follow-up agendado neste turno", () => {
    expect(para([passo([final(PROMESSA_DE_RETORNO)])], { retornoAgendado: true })).toBe(true);
  });
});

describe("NÃO PARA — sem marca, sem envio aceito, ou passo misto", () => {
  it("sem a marca", () => {
    expect(para([passo([envio(NEUTRO)])])).toBe(false);
  });

  it("encerra_turno: false", () => {
    expect(para([passo([envio(NEUTRO, { encerra_turno: false })])])).toBe(false);
  });

  it.each([
    ["corpo_vazio"],
    ["duplicate_suppressed"],
    ["case_promise_without_case"],
    ["circuit_breaker_blocked"],
  ])("envio recusado (%s) volta ao modelo", (code) => {
    expect(para([passo([final(NEUTRO, { ok: false, error: { code, message: "x" } })])])).toBe(false);
  });

  it("'enviada' com `aviso` (foto que faltou) volta ao modelo", () => {
    expect(para([passo([final(NEUTRO, { ...ENVIADA, aviso: "1 foto(s) não puderam ser enviadas" })])])).toBe(false);
  });

  it("status 'simulated' (prévia) não é envio aceito", () => {
    expect(para([passo([final(NEUTRO, { ok: true, status: "simulated" })])])).toBe(false);
  });

  it("passo com send_message + update_lead_state", () => {
    const estado: Chamada = { toolName: "update_lead_state", input: { stage: "contacted" }, output: { ok: true } };
    expect(para([passo([final(NEUTRO), estado])])).toBe(false);
  });

  it("chamada sem resultado (toolResults < toolCalls)", () => {
    expect(para([passo([final(NEUTRO), { toolName: "send_message", input: { body: "x" } }])])).toBe(false);
  });

  it("dois envios marcados, um recusado", () => {
    const recusado = final("Outra coisa", { ok: false, error: { code: "spinning", message: "x" } });
    expect(para([passo([final(NEUTRO), recusado])])).toBe(false);
  });

  it("passo sem chamadas", () => {
    expect(para([passo([])])).toBe(false);
  });

  it("nenhum passo", () => {
    expect(para([])).toBe(false);
  });
});

describe("NÃO PARA — a TRAVA: o corpo anuncia uma ação que ainda falta", () => {
  it("'Vou chamar alguém da equipe…' sem passagem nem caso", () => {
    expect(para([passo([final(PROMESSA_DE_HUMANO)])])).toBe(false);
  });

  it("o mesmo corpo com request_human_handoff RECUSADO antes (payload inválido)", () => {
    const recusada: Chamada = {
      toolName: "request_human_handoff",
      input: {},
      output: { ok: false, error: { code: "invalid_payload", message: "x" } },
    };
    expect(para([passo([recusada]), passo([final(PROMESSA_DE_HUMANO)])])).toBe(false);
  });

  it("'retomamos amanhã às 9h' sem follow-up", () => {
    expect(para([passo([final(PROMESSA_DE_RETORNO)])])).toBe(false);
  });

  it("promessa de HUMANO só com follow-up agendado — o follow-up não libera humano", () => {
    expect(para([passo([final(PROMESSA_DE_HUMANO)])], { retornoAgendado: true })).toBe(false);
  });

  it("'vou confirmar com o Fulano' com handoff_keywords ['Fulano']", () => {
    const corpo = "Vou confirmar com o Fulano e te falo.";
    expect(para([passo([final(corpo)])], { keywords: ["Fulano"] })).toBe(false);
    // Controle: sem a palavra-chave o nome próprio não é alvo humano.
    expect(para([passo([final(corpo)])])).toBe(true);
  });

  it("'Vou verificar os horários de quinta e já te aviso' (enrolação de agenda)", () => {
    expect(para([passo([final("Vou verificar os horários de quinta e já te aviso.")])])).toBe(false);
  });

  it("a trava olha TODOS os envios do passo, não só o marcado", () => {
    expect(para([passo([envio(PROMESSA_DE_HUMANO), final(NEUTRO)])])).toBe(false);
  });

  it("promessa de humano no passo 1 sem marca, corpo neutro marcado no passo 2", () => {
    expect(para([passo([envio(PROMESSA_DE_HUMANO)]), passo([final(NEUTRO)])])).toBe(false);
    // Controle: a passagem com ok entre os dois cumpre a promessa, e aí para.
    const handoff: Chamada = { toolName: "request_human_handoff", input: {}, output: { ok: true } };
    expect(
      para([passo([envio(PROMESSA_DE_HUMANO)]), passo([handoff]), passo([final(NEUTRO)])]),
    ).toBe(true);
  });

  it("promessa de retorno num passo anterior também segura", () => {
    expect(para([passo([envio(PROMESSA_DE_RETORNO)]), passo([final(NEUTRO)])])).toBe(false);
  });

  it("envio RECUSADO num passo anterior não conta: o corpo não saiu", () => {
    const recusado = envio(PROMESSA_DE_HUMANO, {}, { ok: false, error: { code: "spinning", message: "x" } });
    expect(para([passo([recusado]), passo([final(NEUTRO)])])).toBe(true);
  });
});

describe("envioAnunciaAcaoSeguinte — a regra de liberação do casePromiseGate", () => {
  const nada = { humanoAcionado: false, retornoGarantido: false };

  it("corpo neutro não anuncia nada", () => {
    expect(envioAnunciaAcaoSeguinte(NEUTRO, [], nada)).toBe(false);
  });

  it("humano acionado libera a promessa de humano", () => {
    expect(envioAnunciaAcaoSeguinte(PROMESSA_DE_HUMANO, [], nada)).toBe(true);
    expect(envioAnunciaAcaoSeguinte(PROMESSA_DE_HUMANO, [], { humanoAcionado: true, retornoGarantido: true })).toBe(false);
  });

  it("retorno garantido libera a promessa de retorno, e só ela", () => {
    expect(envioAnunciaAcaoSeguinte(PROMESSA_DE_RETORNO, [], { humanoAcionado: false, retornoGarantido: true })).toBe(false);
    expect(envioAnunciaAcaoSeguinte(PROMESSA_DE_HUMANO, [], { humanoAcionado: false, retornoGarantido: true })).toBe(true);
  });

  it("agenda nunca é liberada: a ação anunciada é do próprio laço", () => {
    const agenda = "Vou verificar os horários de quinta e já te aviso.";
    expect(envioAnunciaAcaoSeguinte(agenda, [], { humanoAcionado: true, retornoGarantido: true })).toBe(true);
  });
});

/**
 * GUARDA DE CONTRATO DO SDK (não é RED): o predicado só funciona se o `stopWhen`
 * do AI SDK entregar `{ steps }` com `toolResults[i].input`. Roda o `generateText`
 * de verdade, com o modelo fake do repo e o predicado de produção.
 */
describe("contrato do AI SDK — stopWhen recebe os steps com input e output", () => {
  const USO = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };

  async function rodar(pararQuando: StopCondition<ToolSet> | undefined): Promise<number> {
    let chamadas = 0;
    const factory = createFakeRegistry(async () => {
      chamadas += 1;
      if (chamadas === 1) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "c1",
              toolName: "send_message",
              input: JSON.stringify({ body: NEUTRO, encerra_turno: true }),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: USO,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "terminei" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }).anthropic;
    if (!factory) throw new Error("o provedor fake não existe");
    // `ToolSet`, como o seam (`runModelCall`) tipa as ferramentas do turno.
    const tools: ToolSet = {
      send_message: tool({
        inputSchema: z.object({ body: z.string() }).extend(CAMPO_ENCERRA_TURNO),
        execute: async () => ENVIADA,
      }),
    };
    await generateText({
      model: factory("k", "m"),
      prompt: "oi",
      tools,
      stopWhen: pararQuando === undefined ? stepCountIs(5) : [stepCountIs(5), pararQuando],
    });
    return chamadas;
  }

  it("com o predicado, o laço para depois do envio final: 1 chamada ao modelo", async () => {
    const parada = criarParadaAposEnvioFinal({
      handoffKeywords: [],
      casoAbertoNesteTurno: () => false,
      retornoAgendadoNesteTurno: () => false,
    });
    expect(await rodar(parada)).toBe(1);
  });

  it("sem o predicado, o modelo é chamado de novo só para encerrar: 2 chamadas", async () => {
    expect(await rodar(undefined)).toBe(2);
  });
});
