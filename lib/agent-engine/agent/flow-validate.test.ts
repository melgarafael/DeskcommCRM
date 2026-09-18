import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

vi.mock("../edge/llm/run-model-call", () => ({ runModelCall: vi.fn() }));

import { runModelCall } from "../edge/llm/run-model-call";
import {
  montarMensagemDoValidador,
  parseLeituraDoValidador,
  validarRespostaDoFluxo,
  type PerguntaDoFluxo,
} from "./flow-validate";

const runModelCallMock = vi.mocked(runModelCall);
const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;
const db = {} as pg.Pool;
const cfg = {} as never;

const PERGUNTA: PerguntaDoFluxo = { key: "troca_ano", label: "Ano", type: "number" };

describe("montarMensagemDoValidador", () => {
  it("traz a pergunta, o tipo e as últimas mensagens com o papel", () => {
    const msg = montarMensagemDoValidador(PERGUNTA, [
      { de: "loja", texto: "De que ano ela é?" },
      { de: "cliente", texto: "é 2019" },
    ]);
    expect(msg).toContain("Ano");
    expect(msg).toContain("tipo: number");
    expect(msg).toContain("LOJA: De que ano ela é?");
    expect(msg).toContain("CLIENTE: é 2019");
  });

  it("select lista as opções", () => {
    const msg = montarMensagemDoValidador(
      { key: "cor", label: "Cor", type: "select", options: ["Azul", "Vermelha"] },
      [],
    );
    expect(msg).toContain("uma de: Azul, Vermelha");
  });
});

describe("parseLeituraDoValidador", () => {
  it("lê o JSON mesmo com prosa/cerca em volta", () => {
    expect(parseLeituraDoValidador('```json\n{"respondeu": true, "valor": "2019"}\n```')).toEqual({
      respondeu: true,
      valor: "2019",
    });
  });

  it("saída sem JSON/ sem `respondeu` booleano vira null", () => {
    expect(parseLeituraDoValidador("não sei")).toBeNull();
    expect(parseLeituraDoValidador('{"valor":"x"}')).toBeNull();
  });
});

describe("validarRespostaDoFluxo", () => {
  it("respondeu com valor válido → respondeu", async () => {
    runModelCallMock.mockResolvedValue({ result: { text: '{"respondeu":true,"valor":"2019"}' } } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      { pergunta: PERGUNTA, mensagens: [] },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "respondeu", valor: "2019" });
  });

  it("valor incompatível com o tipo vira nao_respondeu (não grava lixo)", async () => {
    runModelCallMock.mockResolvedValue({ result: { text: '{"respondeu":true,"valor":"ok"}' } } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      { pergunta: PERGUNTA, mensagens: [] },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "nao_respondeu" });
  });

  it("respondeu=false → nao_respondeu", async () => {
    runModelCallMock.mockResolvedValue({ result: { text: '{"respondeu":false,"valor":""}' } } as never);
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      { pergunta: PERGUNTA, mensagens: [] },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "nao_respondeu" });
  });

  it("falha do modelo → indefinido (o turno segue)", async () => {
    runModelCallMock.mockRejectedValue(new Error("sem chave"));
    const r = await validarRespostaDoFluxo(
      db,
      cfg,
      { tenantId: "o", leadId: "l", jobId: "j" },
      { pergunta: PERGUNTA, mensagens: [] },
      { log: logger },
    );
    expect(r).toEqual({ resultado: "indefinido" });
  });
});
