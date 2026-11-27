/**
 * #5259 — anunciar a transferência para uma pessoa da equipe NÃO é promessa
 * comercial (Pergunta 1 do classificador).
 *
 * "vou transferir você para a Andreia, que continua seu atendimento por aqui" era
 * barrada como `promise_semantic`: a lista de "NÃO é promessa" não trazia o
 * anúncio de passagem, e o "continua seu atendimento" era lido como compromisso.
 * O exemplo entra na Pergunta 1 dos DOIS caminhos (com e sem evidências). A
 * Pergunta 2 (retorno humano, que alimenta o `casePromiseGate`) não muda.
 */
import type pg from "pg";
import { beforeEach, expect, it, vi } from "vitest";

import { PROMISE_SEMANTIC_INSTRUCTION, classifyPromise } from "./semantic";
import { runModelCall } from "../../edge/llm/run-model-call";
import { createLogger } from "../../obs/logger";

vi.mock("../../edge/llm/run-model-call", () => ({ runModelCall: vi.fn() }));
const call = vi.mocked(runModelCall);

const EXEMPLO = "vou transferir você para a Andreia, que continua seu atendimento por aqui";

/** O trecho da Pergunta 1: do título dela ao título da Pergunta 2. */
function perguntaUm(instrucao: string): string {
  const inicio = instrucao.indexOf("## Pergunta 1");
  const fim = instrucao.indexOf("## Pergunta 2");
  expect(inicio).toBeGreaterThan(-1);
  expect(fim).toBeGreaterThan(inicio);
  return instrucao.slice(inicio, fim);
}

/** A frase de exemplo está na lista do "NÃO é promessa", e não na do "É PROMESSA". */
function esperaNaListaDoNao(trecho: string) {
  const nao = trecho.indexOf("NÃO é promessa (isPromise=false)");
  expect(nao).toBeGreaterThan(-1);
  expect(trecho.indexOf(EXEMPLO), "o anúncio de transferência não está no 'NÃO é promessa'").toBeGreaterThan(nao);
}

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({
    result: { text: '{"isPromise":false,"suspectPhrase":null}' },
  } as Awaited<ReturnType<typeof runModelCall>>);
});

it("sem evidências: o anúncio de transferência está no 'NÃO é promessa' da Pergunta 1", () => {
  esperaNaListaDoNao(perguntaUm(PROMISE_SEMANTIC_INSTRUCTION));
});

it("com evidências: o mesmo exemplo está na Pergunta 1 da instrução de sistema", async () => {
  await classifyPromise(
    {} as pg.Pool,
    {},
    { tenantId: "org-5259", jobId: "turno-5259" },
    {
      candidate: `Perfeito! Já registrei tudo e ${EXEMPLO}.`,
      commercialEvidence: [
        { origem: "conhecimento", referencia: "fonte:trecho", titulo: "Atendimento", conteudo: "Horário: 8h às 18h." },
      ],
    },
    { log: createLogger() },
  );
  const system = call.mock.calls[0]![2].system as string;
  esperaNaListaDoNao(perguntaUm(system));
});

it("a Pergunta 2 segue tratando 'vou passar para o setor X' como promessa de retorno", () => {
  const dois = PROMISE_SEMANTIC_INSTRUCTION.slice(PROMISE_SEMANTIC_INSTRUCTION.indexOf("## Pergunta 2"));
  expect(dois).toContain('"vou passar para o ');
  expect(dois).not.toContain(EXEMPLO);
});
