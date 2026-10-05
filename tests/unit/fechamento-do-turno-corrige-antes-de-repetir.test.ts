/**
 * O FECHAMENTO DO TURNO pede UMA correção antes de a fila re-tentar o turno inteiro.
 *
 * Medido em produção (27/09/2026): com um modelo barato no ponto `checkpoint`, a
 * declaração voltava às vezes com uma chave a mais (`declaracao: unrecognized_keys`),
 * o job falhava e a fila repetia o TURNO — a chamada principal do agente incluída:
 * até 30¢ numa mensagem para economizar ~1¢ no fechamento.
 *
 * O que este arquivo prende:
 * - fechamento válido: uma chamada só, sem correção;
 * - recusado e corrigido: a 2ª chamada leva a resposta recusada e o PROBLEMA (caminho
 *   e código do Zod, nunca o texto do modelo), e o conteúdo corrigido vale;
 * - recusado duas vezes: sobe o mesmo erro de antes, e a fila re-tenta como sempre;
 * - falha do fornecedor não é recusa: sobe na hora, sem 2ª chamada;
 * - a correção nomeia os campos que não existem e lista os certos, tirados do schema;
 * - o `.strict()` da declaração continua valendo — a correção não apaga campo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CHECKPOINT_INSTRUCTION,
  checkpointContentSchema,
  correcaoDoFechamento,
  fecharOTurno,
  FechamentoRecusado,
  parseCheckpointText,
} from "@/lib/agent-engine/agent/abertura/checkpoint";
import { declaracaoDoTurnoSchema } from "@/lib/agent-engine/agent/declaracao";

const VALIDO = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: "confirmar a entrega",
  rolling_summary: "Cliente pediu o producto y pasó la ubicación.",
  declaracao: { intencoes: [], promessas: [], nada_a_declarar: true },
});

// O defeito medido: uma chave que o contrato não tem, dentro da declaração.
const COM_CHAVE_A_MAIS = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "resumo",
  declaracao: { intencoes: [], promessas: [], nada_a_declarar: true, observacoes: "x" },
});

type Extra = Array<{ role: "assistant" | "user"; content: string }>;

function modelo(...respostas: string[]) {
  const chamadas: Extra[] = [];
  const pedir = vi.fn(async (extra: Extra) => {
    chamadas.push(extra);
    const text = respostas[chamadas.length - 1];
    if (text === undefined) throw new Error("chamada a mais do que o esperado");
    return { text, callId: `call-${chamadas.length}` };
  });
  return { pedir, chamadas };
}

describe("o fechamento do turno corrige antes de repetir o turno", () => {
  it("válido de primeira: uma chamada só, sem correção", async () => {
    const m = modelo(VALIDO);
    const r = await fecharOTurno({ pedir: m.pedir });
    expect(m.pedir).toHaveBeenCalledTimes(1);
    expect(m.chamadas[0]).toEqual([]);
    expect(r.corrigido).toBe(false);
    expect(r.resposta.callId).toBe("call-1");
    expect(r.content.next_action).toBe("confirmar a entrega");
  });

  it("⭐ chave a mais na declaração: a 2ª chamada leva a resposta recusada e o problema — e o conteúdo corrigido vale", async () => {
    const m = modelo(COM_CHAVE_A_MAIS, VALIDO);
    const log = { warn: vi.fn() };
    const r = await fecharOTurno({ pedir: m.pedir, log });

    expect(m.pedir).toHaveBeenCalledTimes(2);
    const [assistente, correcao] = m.chamadas[1]!;
    expect(assistente).toEqual({ role: "assistant", content: COM_CHAVE_A_MAIS });
    expect(correcao!.role).toBe("user");
    expect(correcao!.content).toContain("declaracao: unrecognized_keys (campos que não existem: observacoes)");
    // E diz os nomes CERTOS — medido com GPT-5.6 Luna: o erro é traduzir "intencoes"
    // para "intenciones"; a correção genérica corrigiu 1 de 5, esta 14 de 14.
    expect(correcao!.content).toContain(
      "dentro de declaracao: intencoes (cada item com o_que e evidencia), promessas (cada item com o_que e prazo) e nada_a_declarar",
    );
    expect(r.corrigido).toBe(true);
    expect(r.resposta.callId).toBe("call-2");
    expect(r.content.declaracao).toEqual({ intencoes: [], promessas: [], nada_a_declarar: true });

    // O log diz O QUE falhou — nunca o texto do modelo (pode carregar PII da conversa).
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls[0])).not.toContain("resumo");
    expect(JSON.stringify(log.warn.mock.calls[0])).not.toContain("observacoes");
  });

  it("recusado duas vezes: sobe o mesmo erro de antes, e a fila re-tenta o turno como sempre", async () => {
    const m = modelo(COM_CHAVE_A_MAIS, "sem json nenhum");
    await expect(fecharOTurno({ pedir: m.pedir })).rejects.toThrow(
      "fechamento do turno sem JSON de checkpoint — run re-tentado pela fila",
    );
    expect(m.pedir).toHaveBeenCalledTimes(2);
  });

  it("falha do fornecedor não é recusa: sobe na hora, sem 2ª chamada", async () => {
    const pedir = vi.fn(async () => {
      throw new Error("provider 503");
    });
    await expect(fecharOTurno({ pedir })).rejects.toThrow("provider 503");
    expect(pedir).toHaveBeenCalledTimes(1);
  });

  it("o ajuste (link da reunião) vale nas duas tentativas", async () => {
    const comLink = VALIDO.replace("confirmar a entrega", "entrar em https://meet.google.com/abc-defg-hij");
    const m = modelo(COM_CHAVE_A_MAIS, comLink);
    const r = await fecharOTurno({ pedir: m.pedir, ajustar: (t) => t.replace(/https:\/\/meet\.google\.com\/[a-z-]+/g, "[link]") });
    expect(r.content.next_action).toBe("entrar em [link]");
  });

  it("os nomes da correção saem do schema: campo novo no contrato aparece na correção sem editar o texto", () => {
    const texto = correcaoDoFechamento("x");
    for (const campo of Object.keys(checkpointContentSchema.shape)) expect(texto).toContain(campo);
    for (const campo of Object.keys(declaracaoDoTurnoSchema.shape)) expect(texto).toContain(campo);
  });

  it("o .strict() continua valendo: o parse segue recusando campo a mais (a correção ensina, não apaga)", () => {
    expect(() => parseCheckpointText(COM_CHAVE_A_MAIS)).toThrow(FechamentoRecusado);
    expect(correcaoDoFechamento("declaracao: unrecognized_keys")).toMatch(/com estes nomes e nenhum outro/);
  });

  it("o turno fecha por aqui — e com a instrução de sempre como primeira pergunta", () => {
    const fonte = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");
    expect(fonte).toContain("await fecharOTurno({");
    expect(fonte).toMatch(/\{ role: 'user', content: CHECKPOINT_INSTRUCTION \},\s*\.\.\.correcao,/);
    expect(CHECKPOINT_INSTRUCTION).toContain("Sem texto fora do JSON.");
  });
});
